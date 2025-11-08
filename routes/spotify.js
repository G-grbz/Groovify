import express from "express";
import path from "path";
import fs from "fs";
import { sendOk, sendError, uniqueId } from "../modules/utils.js";
import { idsToMusicUrls, mapSpotifyToYtm, downloadMatchedSpotifyTracks, createDownloadQueue } from "../modules/sp.js";
import { isSpotifyUrl, resolveSpotifyUrl } from "../modules/spotify.js";
import { spotifyMapTasks, spotifyDownloadTasks, jobs, killJobProcesses, createJob } from "../modules/store.js";
import { processJob } from "../modules/processor.js";
import { convertMedia, downloadThumbnail } from "../modules/media.js";
import archiver from "archiver";
import { resolveMarket } from "../modules/market.js";

const router = express.Router();

function makeMapId() { return uniqueId("map"); }

router.post("/api/spotify/process/start", async (req, res) => {
  try {
    const { url, format = "mp3", bitrate = "192k", sampleRate = "48000", market: marketIn, includeLyrics } = req.body || {};
    if (!url || !isSpotifyUrl(url)) return sendError(res, 'UNSUPPORTED_URL_FORMAT', "Spotify URL gerekli", 400);

    let sp;
    try {
      sp = await resolveSpotifyUrl(url, { market: resolveMarket(marketIn) });
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.startsWith("SPOTIFY_MIX_UNSUPPORTED")) {
        return sendError(res, 'SPOTIFY_MIX_UNSUPPORTED', "Bu link kişiselleştirilmiş bir Spotify Mix. Spotify Web API bu içerikleri sağlamıyor (404). Lütfen Mix'teki parçaları Spotify uygulamasında yeni bir oynatma listesine kopyalayıp o URL'yi gönderin.", 400);
      }
      throw e;
    }

    const job = createJob({
      status: "running",
      progress: 0,
      format,
      bitrate,
      sampleRate: parseInt(sampleRate) || 48000,
      metadata: {
        source: "spotify",
        spotifyUrl: url,
        spotifyKind: sp.kind,
        spotifyTitle: sp.title,
        isPlaylist: sp.kind === "playlist",
        isAlbum: sp.kind === "album",
        isAutomix: false,
        includeLyrics: (includeLyrics === true || includeLyrics === "true")
      },
      resultPath: null,
      error: null,
      playlist: { total: sp.items?.length || 1, done: 0 },
      phase: "mapping",
      currentPhase: "mapping",
      lastLog: "",
      lastLogKey: null,
      lastLogVars: null
    });
    const jobId = job.id;

    sendOk(res, {
      jobId,
      id: jobId,
      title: sp.title,
      total: sp.items?.length || 1,
      message: "Spotify işlemi başlatıldı"
    });

    processSpotifyIntegrated(jobId, sp, format, bitrate);

  } catch (e) {
    return sendError(res, 'PROCESS_FAILED', e.message || "Spotify işlem hatası", 400);
  }
});

async function processSpotifyIntegrated(jobId, sp, format, bitrate) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    job.phase = "mapping"; job.currentPhase = "mapping"; job.currentPhase = "mapping";
    job.progress = 5;
    job.downloadProgress = 0;
    job.convertProgress = 0;
    job.metadata.selectedIds   = job.metadata.selectedIds   || [];
    job.metadata.frozenEntries = job.metadata.frozenEntries || [];
    job.metadata.frozenTitle   = job.metadata.frozenTitle   || job.metadata.spotifyTitle;

    if (sp.kind === "track") {
      await processSingleTrack(jobId, sp, format, bitrate);
      return;
    }

    const dlQueue = createDownloadQueue(jobId, {
      concurrency: 4,
      onProgress: (done, total) => {
        job.playlist.done = done;
        job.downloadProgress = Math.floor((done / total) * 100);
        job.lastLogKey = 'log.downloading.progress';
        job.lastLogVars = { done, total };
        job.lastLog = `📥 İndiriliyor: ${done}/${total}`;
        const dlPct = total > 0 ? (done / total) : 0;
        if (job.phase === "downloading") {
          job.progress = Math.max(job.progress, Math.floor(30 + dlPct * 40));
        }
      },
      onLog: (payload) => {
        const { logKey, logVars, fallback } = (typeof payload === 'string') ? { logKey:null, logVars:null, fallback:payload } : payload;
        job.lastLogKey = logKey || null;
        job.lastLogVars = logVars || null;
        job.lastLog = fallback || '';
        console.log(`[Spotify ${jobId}] ${fallback || job.lastLogKey || ''}`);
      }
    });

    let matchedCount = 0;
    const totalItems = sp.items.length;
    job.playlist.total = totalItems;
    job.playlist.done = 0;

      const shouldCancel = () => {
      const j = jobs.get(jobId);
      return !!(j && (j.canceled || j.status === "canceled"));
    };

    await mapSpotifyToYtm(sp, (idx, item) => {
      if (shouldCancel()) return;
      job.progress = 5 + Math.floor(((idx + 1) / totalItems) * 25);
      job.lastLogKey = 'log.searchingTrack';
      job.lastLogVars = { artist: item.uploader, title: item.title };
      job.lastLog = `🔍 Aranıyor: ${item.uploader} - ${item.title}`;

      if (item.id) {
        matchedCount++;
        if (job.phase !== "downloading") {
          job.phase = "downloading"; job.currentPhase = "downloading";
          job.lastLogKey = 'log.downloading.startShort';
          job.lastLogVars = {};
          job.lastLog = `📥 İndirme başlatıldı`;
        }
        job.metadata.selectedIds.push(item.id);
        job.metadata.frozenEntries.push({
          index: item.index,
          id: item.id,
          title: item.title,
          uploader: item.uploader,
          webpage_url: item.webpage_url
        });
        if (shouldCancel()) return;
        dlQueue.enqueue({
          index: item.index,
          id: item.id,
          title: item.title,
          uploader: item.uploader,
          webpage_url: item.webpage_url
        }, idx);
      }
    }, {
      concurrency: 3,
      shouldCancel,
      onLog: (payload) => {
        const { logKey, logVars, fallback } =
          (typeof payload === 'string')
            ? { logKey: null, logVars: null, fallback: payload }
            : payload;
        job.lastLogKey  = logKey || null;
        job.lastLogVars = logVars || null;
        job.lastLog     = fallback || '';
        console.log(`[Spotify ${jobId}] ${fallback || job.lastLogKey || ''}`);
      }
    });

    if (shouldCancel()) { throw new Error("CANCELED"); }

    if (matchedCount === 0) {
      throw new Error("Hiç eşleşen parça bulunamadı");
    }

    dlQueue.end();
    job.phase = "downloading"; job.currentPhase = "downloading";
    job.lastLogKey = 'log.downloading.waitAll';
    job.lastLogVars = {};
    job.lastLog = `⏳ Eşleştirmeler tamamlandı. Tüm indirmelerin bitmesi bekleniyor...`;
    await dlQueue.waitForIdle();
    if (shouldCancel()) { throw new Error("CANCELED"); }

    const downloadResults = dlQueue.getResults();
    const successfulDownloads = downloadResults.filter(r => r.filePath);
    if (successfulDownloads.length === 0) {
      throw new Error("Hiçbir parça indirilemedi");
    }

    job.phase = "converting"; job.currentPhase = "converting";
    job.progress = 70;
    job.downloadProgress = 100;
    job.convertProgress = 0;
    job.playlist.total = successfulDownloads.length;
    job.playlist.done = 0;
    job.lastLogKey = 'log.converting.batch';
    job.lastLogVars = { total: successfulDownloads.length };
    job.lastLog = `⚙️ ${successfulDownloads.length} parça dönüştürülüyor...`;

    const postIds = successfulDownloads.map(r => r.item?.id).filter(Boolean);
    const postEntries = successfulDownloads.map(r => r.item).filter(Boolean);
    const idSet = new Set(job.metadata.selectedIds);
    for (const pid of postIds) if (!idSet.has(pid)) job.metadata.selectedIds.push(pid);
    const keyed = new Map(job.metadata.frozenEntries.map(e => [e.id, e]));
    for (const it of postEntries) {
      if (it?.id && !keyed.has(it.id)) {
        keyed.set(it.id, {
          index: it.index,
          id: it.id,
          title: it.title,
          uploader: it.uploader,
          webpage_url: it.webpage_url
        });
      }
    }
    job.metadata.frozenEntries = Array.from(keyed.values());
    job.metadata.frozenTitle = job.metadata.frozenTitle || job.metadata.spotifyTitle;

    const files = successfulDownloads.map(r => r.filePath);
    const results = [];

    for (let i = 0; i < files.length; i++) {
      if (shouldCancel()) { throw new Error("CANCELED"); }
      const filePath = files[i];
      const entry = successfulDownloads[i].item;

      const preferSpotify = process.env.PREFER_SPOTIFY_TAGS === "1";
      let spInfo = null;
      if (Array.isArray(sp.items) && sp.items.length) {
        spInfo = sp.items.find(x =>
          x.title?.toLowerCase() === entry.title?.toLowerCase() &&
          (x.artist||"").toLowerCase().includes((entry.uploader||"").toLowerCase())
        ) || null;
      }

      const fileMeta = (preferSpotify && spInfo) ? {
        title: spInfo.title,
        track: spInfo.title,
        artist: spInfo.artist,
        uploader: spInfo.artist,
        album: spInfo.album || "",
        playlist_title: job.metadata.spotifyTitle,
        webpage_url: spInfo.spUrl || entry.webpage_url,
        release_year: spInfo.year || "",
        release_date: spInfo.date || "",
        track_number: spInfo.track_number,
        disc_number:  spInfo.disc_number,
        track_total:  spInfo.track_total,
        disc_total:   spInfo.disc_total,
        isrc:         spInfo.isrc,
        album_artist: spInfo.album_artist || "",
        genre:        spInfo.genre || "",
        label:        spInfo.label || "",
        publisher:    spInfo.label || "",
        copyright:    spInfo.copyright || ""
      } : {
        title: entry.title,
        track: entry.title,
        uploader: entry.uploader,
        artist: entry.uploader,
        album: job.metadata.spotifyTitle,
        playlist_title: job.metadata.spotifyTitle,
        webpage_url: entry.webpage_url
      };

          let itemCover = null;
          const baseNoExt = filePath.replace(/\.[^.]+$/, "");
          const coverExts = [".jpg", ".jpeg", ".png", ".webp"];
          for (const ext of coverExts) {
            const cand = `${baseNoExt}${ext}`;
            if (fs.existsSync(cand)) { itemCover = cand; break; }
          }
          if (!itemCover && preferSpotify && spInfo?.coverUrl) {
            try {
              const dl = await downloadThumbnail(spInfo.coverUrl, `${baseNoExt}.spotify_cover`);
              if (dl) itemCover = dl;
            } catch {}
          }

      try {
        if (shouldCancel()) { throw new Error("CANCELED"); }
        job.lastLogKey = 'log.converting.single';
        job.lastLogVars = { title: entry.title };
        job.lastLog = `⚙️ Dönüştürülüyor: ${entry.title}`;

        const result = await convertMedia(
          filePath, format, bitrate, `${jobId}_${i}`,
          (progress) => {
            const fileProgress = (i / files.length) * 25;
            const cur = (progress / 100) * (25 / files.length);
            job.convertProgress = Math.floor(70 + fileProgress + cur);
            job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
          },
          fileMeta, itemCover, (format === "mp4"),
          path.resolve(process.cwd(), "outputs"),
          path.resolve(process.cwd(), "temp"),
          {
            onProcess: (child) => { try { registerJobProcess(jobId, child); } catch {} },
            includeLyrics: !!job.metadata.includeLyrics,
            sampleRate: job.sampleRate || 48000,
            onLyricsStats: (delta) => {
              if (!delta) return;
              const m = job.metadata || (job.metadata = {});
              const cur = m.lyricsStats || { found: 0, notFound: 0 };
              cur.found += Number(delta.found || 0);
              cur.notFound += Number(delta.notFound || 0);
              m.lyricsStats = cur;
            }
          }
        );

        if (job.metadata.includeLyrics) {
          if (result && result.lyricsPath) {
            job.lastLog = `🎼 Şarkı sözü eklendi: ${path.basename(result.lyricsPath)}`;
          } else {
            job.lastLog = `🎼 Şarkı sözü bulunamadı: ${entry.title}`;
          }
        }

        results.push(result);
        job.lastLogKey = 'log.converting.ok';
        job.lastLogVars = { title: entry.title };
        job.lastLog = `✅ Dönüştürüldü: ${entry.title}`;
      } catch (convertError) {
        console.error(`Dönüştürme hatası (${entry.title}):`, convertError);
        job.lastLogKey = 'log.converting.err';
        job.lastLogVars = { title: entry.title, err: convertError.message };
        job.lastLog = `❌ Dönüştürme hatası: ${entry.title} - ${convertError.message}`;
        results.push({ outputPath: null, error: convertError.message });
      }

      job.playlist.done = i + 1;
    }

    if (job.metadata.includeLyrics && job.metadata.lyricsStats) {
      const stats = job.metadata.lyricsStats;
      job.lastLog = `📊 Şarkı sözü özeti: ${stats.found} bulundu, ${stats.notFound} bulunamadı`;
    }

    const successfulResults = results.filter(r => r.outputPath && !r.error);
    if (successfulResults.length === 0) throw new Error("Hiçbir parça dönüştürülemedi");

    job.resultPath = successfulResults;
    if (shouldCancel()) { throw new Error("CANCELED"); }
    try {
      const zipTitle = job.metadata.spotifyTitle || "Spotify Playlist";
      job.lastLogKey = 'log.zip.creating';
      job.lastLogVars = {};
      job.lastLog = `📦 ZIP dosyası oluşturuluyor...`;
      job.zipPath = await makeZipFromOutputs(jobId, successfulResults, zipTitle, !!job.metadata.includeLyrics);
      job.lastLogKey = 'log.zip.ready';
      job.lastLogVars = { title: zipTitle };
      job.lastLog = `✅ ZIP dosyası hazır: ${zipTitle}`;
    } catch (e) {
      console.warn("ZIP oluşturma hatası:", e);
      job.lastLogKey = 'log.zip.error';
      job.lastLogVars = { err: e.message };
      job.lastLog = `❌ ZIP oluşturma hatası: ${e.message}`;
    }

    job.status = "completed";
    job.progress = 100;
    job.downloadProgress = 100;
    job.convertProgress = 100;
    job.phase = "completed"; job.currentPhase = "completed";
    job.lastLogKey = 'log.done';
    job.lastLogVars = { ok: successfulResults.length };
    job.lastLog = `🎉 Tüm işlemler tamamlandı! ${successfulResults.length} parça başarıyla dönüştürüldü.`;

    cleanupSpotifyTempFiles(jobId, files);
  } catch (error) {
    if (String(error?.message || "").toUpperCase() === "CANCELED") {
      job.status = "canceled";
      job.error = null;
      job.phase = "canceled"; job.currentPhase = "canceled";
      job.downloadProgress = 0;
      job.convertProgress = 0;
      job.lastLogKey = 'status.canceled';
      job.lastLogVars = {};
      job.lastLog = "⛔ İptal edildi";
      try { killJobProcesses(jobId); } catch {}
      try { cleanupSpotifyTempFiles(jobId); } catch {}
    } else {
      job.status = "error";
      job.error = error.message;
      job.phase = "error"; job.currentPhase = "error";
      job.downloadProgress = 0;
      job.convertProgress = 0;
      job.lastLogKey = 'log.error';
      job.lastLogVars = { err: error.message };
      job.lastLog = `❌ Hata: ${error.message}`;
      console.error("Spotify entegre işlem hatası:", error);
    }
  }
}

async function processSingleTrack(jobId, sp, format, bitrate) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    job.phase = "mapping"; job.currentPhase = "mapping";
    job.progress = 10;
    job.lastLogKey = 'log.searchingSingleTrack';
    job.lastLogVars = { artist: sp.items[0]?.artist, title: sp.items[0]?.title };
    job.lastLog = `🔍 Aranıyor: ${sp.items[0]?.artist} - ${sp.items[0]?.title}`;

    let matchedItem = null;
    const shouldCancel = () => {
      const j = jobs.get(jobId);
      return !!(j && (j.canceled || j.status === "canceled"));
    };

    await mapSpotifyToYtm(sp, (idx, item) => {
      if (shouldCancel()) return;
      if (item.id) {
        matchedItem = item;
        job.metadata.selectedIds = [item.id];
        job.metadata.frozenEntries = [{
          index: 1,
          id: item.id,
          title: item.title,
          uploader: item.uploader,
          webpage_url: item.webpage_url
        }];
      }
    }, {
      concurrency: 1,
      shouldCancel,
      onLog: (payload) => {
        const { logKey, logVars, fallback } = (typeof payload === 'string')
          ? { logKey: null, logVars: null, fallback: payload }
          : payload;
        job.lastLogKey = logKey || null;
        job.lastLogVars = logVars || null;
        job.lastLog = fallback || '';
      }
    });

    if (shouldCancel()) { throw new Error("CANCELED"); }
    if (!matchedItem) {
      throw new Error("Parça eşleştirilemedi");
    }

    job.phase = "downloading"; job.currentPhase = "downloading";
    job.progress = 30;
    job.lastLogKey = 'log.downloading.single';
    job.lastLogVars = { title: matchedItem.title };
    job.lastLog = `📥 İndiriliyor: ${matchedItem.title}`;

    const dlQueue = createDownloadQueue(jobId, {
      concurrency: 1,
      shouldCancel,
      onProgress: (done, total) => {
        job.playlist.done = done;
        job.progress = 30 + (done * 40);
      },
      onLog: (payload) => {
        const { logKey, logVars, fallback } = (typeof payload === 'string')
          ? { logKey: null, logVars: null, fallback: payload }
          : payload;
        job.lastLogKey = logKey || null;
        job.lastLogVars = logVars || null;
        job.lastLog = fallback || '';
      }
    });

    dlQueue.enqueue({
      index: 1,
      id: matchedItem.id,
      title: matchedItem.title,
      uploader: matchedItem.uploader,
      webpage_url: matchedItem.webpage_url
    }, 0);
    dlQueue.end();
    await dlQueue.waitForIdle();
    if (shouldCancel()) { throw new Error("CANCELED"); }

    const downloadResults = dlQueue.getResults();
    const successfulDownload = downloadResults.find(r => r.filePath);

    if (!successfulDownload) {
      const firstErr = downloadResults.find(r => r?.error)?.error || "bilinmeyen indirme hatası";
      job.lastLogKey  = 'log.downloading.err';
      job.lastLogVars = { err: firstErr };
      job.lastLog     = `❌ İndirme hatası: ${firstErr}`;
      throw new Error(`Parça indirilemedi: ${firstErr}`);
    }

    job.phase = "converting"; job.currentPhase = "converting";
    job.progress = 80;
    job.lastLogKey = 'log.converting.single';
    job.lastLogVars = { title: matchedItem.title };
    job.lastLog = `⚙️ Dönüştürülüyor: ${matchedItem.title}`;

    const filePath = successfulDownload.filePath;
    const preferSpotify = process.env.PREFER_SPOTIFY_TAGS === "1";
    const spInfo = sp.items[0];

    const fileMeta = preferSpotify ? {
      title: spInfo.title,
      track: spInfo.title,
      artist: spInfo.artist,
      uploader: spInfo.artist,
      album: spInfo.album || "",
      webpage_url: spInfo.spUrl || matchedItem.webpage_url,
      release_year: spInfo.year || "",
      release_date: spInfo.date || "",
      track_number: spInfo.track_number,
      disc_number: spInfo.disc_number,
      track_total: spInfo.track_total,
      disc_total: spInfo.disc_total,
      isrc: spInfo.isrc,
      album_artist: spInfo.album_artist || "",
      genre:        spInfo.genre || "",
      label:        spInfo.label || "",
      publisher:    spInfo.label || "",
      copyright:    spInfo.copyright || ""
    } : {
      title: matchedItem.title,
      track: matchedItem.title,
      uploader: matchedItem.uploader,
      artist: matchedItem.uploader,
      webpage_url: matchedItem.webpage_url
    };

    let itemCover = null;
    const baseNoExt = filePath.replace(/\.[^.]+$/, "");
    const coverExts = [".jpg", ".jpeg", ".png", ".webp"];
    for (const ext of coverExts) {
      const cand = `${baseNoExt}${ext}`;
      if (fs.existsSync(cand)) { itemCover = cand; break; }
    }
    if (!itemCover && preferSpotify && spInfo?.coverUrl) {
      try {
        const dl = await downloadThumbnail(spInfo.coverUrl, `${baseNoExt}.spotify_cover`);
        if (dl) itemCover = dl;
      } catch {}
    }

    const result = await convertMedia(
      filePath, format, bitrate, jobId,
      (progress) => {
        job.progress = 80 + Math.floor(progress * 0.2);
      },
      fileMeta, itemCover, (format === "mp4"),
      path.resolve(process.cwd(), "outputs"),
      path.resolve(process.cwd(), "temp"),
      {
        onProcess: (child) => { try { registerJobProcess(jobId, child); } catch {} },
        includeLyrics: !!job.metadata.includeLyrics,
        sampleRate: job.sampleRate || 48000,
        onLyricsStats: (delta) => {
          if (!delta) return;
          const m = job.metadata || (job.metadata = {});
          const cur = m.lyricsStats || { found: 0, notFound: 0 };
          cur.found += Number(delta.found || 0);
          cur.notFound += Number(delta.notFound || 0);
          m.lyricsStats = cur;
        }
      }
    );

    job.resultPath = result;
    job.status = "completed";
    job.progress = 100;
    job.phase = "completed"; job.currentPhase = "completed";
    job.playlist.done = 1;
    job.lastLogKey = 'log.done.single';
    job.lastLogVars = { title: matchedItem.title };
    job.lastLog = `🎉 İşlem tamamlandı: ${matchedItem.title}`;

    cleanupSpotifyTempFiles(jobId, [filePath]);

  } catch (error) {
    if (String(error?.message || "").toUpperCase() === "CANCELED") {
      job.status = "canceled";
      job.error = null;
      job.phase = "canceled"; job.currentPhase = "canceled";
      job.lastLogKey = 'status.canceled';
      job.lastLogVars = {};
      job.lastLog = "⛔ İptal edildi";
      try { killJobProcesses(jobId); } catch {}
      try { cleanupSpotifyTempFiles(jobId); } catch {}
    } else {
      job.status = "error";
      job.error = error.message;
      job.phase = "error"; job.currentPhase = "error";
      job.lastLogKey = 'log.error';
      job.lastLogVars = { err: error.message };
      job.lastLog = `❌ Hata: ${error.message}`;
      console.error("Tekli parça işlem hatası:", error);
    }
  }
}

async function makeZipFromOutputs(jobId, outputs, titleHint = "playlist", includeLyrics = false) {
  const outDir = path.resolve(process.cwd(), "outputs");
  fs.mkdirSync(outDir, { recursive: true });

  const safeBase = `${(titleHint || 'playlist')}_${jobId}`
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .slice(0, 200);

  const zipName = `${safeBase}.zip`;
  const zipAbs  = path.join(outDir, zipName);

  return new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(zipAbs);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve(`/download/${encodeURIComponent(zipName)}`));
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);

    for (const r of outputs) {
      if (!r?.outputPath) continue;
      const rel = decodeURIComponent(r.outputPath.replace(/^\/download\//, ""));
      const abs = path.join(outDir, rel);
      if (fs.existsSync(abs)) {
        archive.file(abs, { name: path.basename(abs).normalize("NFC") });
        if (includeLyrics) {
          const lrcPath = abs.replace(/\.[^/.]+$/, "") + ".lrc";
          if (fs.existsSync(lrcPath)) {
            archive.file(lrcPath, { name: path.basename(lrcPath).normalize("NFC") });
          }
        }
      }
    }

    archive.finalize();
  });
}

function cleanupSpotifyTempFiles(jobId, files) {
  try {
    if (Array.isArray(files)) {
      files.forEach(f => {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
      });
    }

    const tempDir = path.resolve(process.cwd(), "temp");
    const jobDir = path.join(tempDir, jobId);
    if (fs.existsSync(jobDir)) {
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
    }
  } catch (e) {
    console.warn("Temizleme hatası:", e);
  }
}

router.post("/api/spotify/preview/start", async (req, res) => {
  try {
    const { url, market: marketIn } = req.body || {};
    if (!url || !isSpotifyUrl(url)) return sendError(res, 'UNSUPPORTED_URL_FORMAT', "Spotify URL gerekli", 400);

    let sp;
    try {
      sp = await resolveSpotifyUrl(url, { market: resolveMarket(marketIn) });
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.startsWith("SPOTIFY_MIX_UNSUPPORTED")) {
        return sendError(res, 'SPOTIFY_MIX_UNSUPPORTED', "Bu link kişiselleştirilmiş bir Spotify Mix. Spotify Web API bu içerikleri sağlamıyor (404). Lütfen Mix'teki parçaları Spotify uygulamasında yeni bir oynatma listesine kopyalayıp o URL'yi gönderin.", 400);
      }
      throw e;
    }
    const id = makeMapId();
    const task = {
      id,
      url,
      status: "running",
      title: sp.title || (sp.kind === "track" ? "Spotify Track" : "Spotify Playlist"),
      total: (sp.items || []).length,
      done: 0,
      items: [],
      logs: [],
      createdAt: new Date(),
      validItems: [],
      jobId: null
    };
    spotifyMapTasks.set(id, task);

    mapSpotifyToYtm(sp, (idx, item) => {
      task.items[idx] = item;
      task.done++;
      if (item.id) task.validItems.push(item);
    }, {
      concurrency: Number(process.env.SPOTIFY_MAP_CONCURRENCY || 3),
      onLog: (log) => { task.logs.push({ time: new Date(), message: log }); console.log(`[Spotify ${id}] ${log}`); }
    }).then(() => {
      task.status = "completed";
      if (task.validItems.length > 0) {
        const urls = idsToMusicUrls(task.validItems.map(i => i.id));
        const TEMP_DIR = path.resolve(process.cwd(), "temp");
        fs.mkdirSync(TEMP_DIR, { recursive: true });
        const listFile = path.join(TEMP_DIR, `${task.id}.urls.txt`);
        fs.writeFileSync(listFile, urls.join("\n"), "utf8");
        task.urlListFile = listFile;
        console.log(`✅ Spotify URL listesi oluşturuldu: ${listFile}`);
      }
    }).catch((e) => { task.status = "error"; task.error = e.message; });

    return sendOk(res, { mapId: id, title: task.title, total: task.total });
  } catch (e) {
    return sendError(res, 'PREVIEW_FAILED', e.message || "Spotify başlatma hatası", 400);
  }
});

router.get("/api/spotify/preview/stream/:id", (req, res) => {
  const { id } = req.params || {};
  const task = spotifyMapTasks.get(id);
  if (!task) return sendError(res, 'JOB_NOT_FOUND', "Map task bulunamadı", 404);

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: "init", title: task.title, total: task.total, done: task.done, items: task.items || [] });
  let lastSent = task.items.length;
  const interval = setInterval(() => {
    while (lastSent < task.items.length) { const item = task.items[lastSent]; if (item) send({ type: "item", item }); lastSent++; }
    send({ type: "progress", done: task.done, total: task.total, status: task.status });
    if (task.status === "completed" || task.status === "error") { send({ type: "done", status: task.status, error: task.error || null }); clearInterval(interval); res.end(); }
  }, 800);
  req.on("close", () => clearInterval(interval));
});

router.get("/api/spotify/preview/stream-logs/:id", (req, res) => {
  const { id } = req.params || {};
  const task = spotifyMapTasks.get(id);
  if (!task) return sendError(res, 'JOB_NOT_FOUND', "Map task bulunamadı", 404);

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: "init", title: task.title, total: task.total, done: task.done, items: task.items || [] });
  let lastSent = task.items.length;
  const interval = setInterval(() => {
    while (lastSent < task.items.length) {
      const item = task.items[lastSent];
      if (item) send({
        type: "item",
        item,
        logKey: "log.matchFound",
        logVars: { artist: item.uploader, title: item.title },
        log: `✅ Eşleşme bulundu: ${item.uploader} - ${item.title}`
      });
      lastSent++;
    }
    send({ type: "progress", done: task.done, total: task.total, status: task.status });
    if (task.status === "completed" || task.status === "error") {
      send({
        type: "done",
        status: task.status,
        error: task.error || null,
        logKey: task.status === "completed" ? "status.allMatchesCompleted" : "log.error",
        logVars: task.status === "completed" ? {} : { err: task.error },
        log: task.status === "completed" ? "🎉 Tüm eşleştirmeler tamamlandı!" : `❌ Hata: ${task.error}`
      });
      clearInterval(interval); res.end();
    }
  }, 500);
  req.on("close", () => clearInterval(interval));
});

export default router;
