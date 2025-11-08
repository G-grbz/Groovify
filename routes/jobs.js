import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import multer from "multer";
import { sendOk, sendError, ERR, isDirectMediaUrl } from "../modules/utils.js";
import { jobs, spotifyMapTasks, killJobProcesses, createJob } from "../modules/store.js";
import { processJob } from "../modules/processor.js";
import { isSpotifyUrl, resolveSpotifyUrl } from "../modules/spotify.js";
import { idsToMusicUrls, searchYtmBestId } from "../modules/sp.js";
import { resolveMarket } from "../modules/market.js";
import { requireAuth } from "../modules/settings.js";
import { attachLyricsToMedia, lyricsFetcher } from "../modules/lyrics.js";
import {
  isYouTubeUrl,
  isYouTubePlaylist,
  isYouTubeAutomix,
  normalizeYouTubeUrl,
  resolvePlaylistSelectedIds,
  resolveAutomixSelectedIds,
  getPlaylistMetaLite,
  extractPlaylistPage,
  extractAutomixPage
} from "../modules/yt.js";

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const inFlightAutomix = new Map();

function toUtf8Filename(name) {
  try {
    return Buffer.from(name, "latin1").toString("utf8");
  } catch {
    return name;
  }
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const origUtf8 = toUtf8Filename(file.originalname);
    cb(null, `${crypto.randomBytes(8).toString("hex")}_${origUtf8}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

const router = express.Router();

router.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return sendError(res, ERR.JOB_NOT_FOUND, "Job not found", 404);
  return sendOk(res, job);
});

router.get("/api/stream/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "İş bulunamadı" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  res.flushHeaders?.();
  res.write(`: ping\n\n`);

  const sendUpdate = () => {
    try { res.write(`data: ${JSON.stringify(job)}\n\n`); } catch {}
  };

  sendUpdate();

  const interval = setInterval(() => {
    sendUpdate();
    if (job.status === "completed" || job.status === "error" || job.status === "canceled") {
      clearInterval(interval);
      res.end();
    }
  }, 1000);

  req.on("close", () => clearInterval(interval));
});

router.post("/api/jobs/:id/cancel", (req, res) => {
  const id = req.params.id;
  const job = jobs.get(id);
  if (!job) return sendError(res, ERR.JOB_NOT_FOUND, "Job not found", 404);

  if (job.status === "completed" || job.status === "error" || job.status === "canceled") {
    return sendOk(res, { id, status: job.status });
  }

  job.canceled = true;
  job.status = "canceled";
  job.currentPhase = "canceled";
  job.error = null;
  try { killJobProcesses(id); } catch {}

  try {
   const TEMP_DIR = path.resolve(process.cwd(), "temp");
   const jobDir = path.join(TEMP_DIR, id);
   if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
 } catch {}

  return sendOk(res, { id, status: "canceled" });
});

router.post("/api/debug/lyrics", async (req, res) => {
  try {
    const { artist, title } = req.body;

    if (!artist || !title) {
      return res.status(400).json({ error: "Artist ve title gerekli" });
    }

    console.log(`🔍 Test şarkı sözü araması: "${artist}" - "${title}"`);

    const lyricsPath = await lyricsFetcher.downloadLyrics(
      artist,
      title,
      null,
      path.join(process.cwd(), "test_output")
    );

    if (lyricsPath) {
      const content = fs.readFileSync(lyricsPath, 'utf8');
      return res.json({
        success: true,
        path: lyricsPath,
        content: content.substring(0, 500) + "..."
      });
    } else {
      return res.json({ success: false, message: "Şarkı sözü bulunamadı" });
    }
  } catch (error) {
    console.error("Test şarkı sözü hatası:", error);
    return res.status(500).json({ error: error.message });
  }
});

router.post("/api/jobs", upload.single("file"), async (req, res) => {
  try {
    const {
      url,
      format = "mp3",
      bitrate = "192k",
      sampleRate = "48000",
      sampleRateHz,
      isPlaylist = false,
      selectedIndices,
      clientBatch,
      spotifyMapId,
      includeLyrics = false
    } = req.body || {};

    const parseSR = (v) => {
      if (v == null) return NaN;
      const s = String(v).trim().toLowerCase();
      const m = s.match(/^(\d+(?:\.\d+)?)\s*k(?:hz)?$/i);
      if (m) return Math.round(parseFloat(m[1]) * 1000);
      const n = Number(s.replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) ? Math.round(n) : NaN;
    };
    const pickedSR = Number.isFinite(parseSR(sampleRate)) ? parseSR(sampleRate)
                     : Number.isFinite(parseSR(sampleRateHz)) ? parseSR(sampleRateHz)
                     : 48000;

    const supported = ["mp3","flac","wav","ogg","mp4"];
    if (!supported.includes(format)) {
      return sendError(res, ERR.INVALID_FORMAT, "Unsupported format", 400);
    }

    const metadata = {};
    let inputPath = null;

    if (req.file) {
    inputPath = req.file.path;
    const origUtf8 = (typeof toUtf8Filename === "function")
      ? toUtf8Filename(req.file.originalname)
      : req.file.originalname;
    metadata.originalName = origUtf8;
    metadata.source = "file";
  }

    if (!inputPath && url) {
      if (isSpotifyUrl(url)) {
        metadata.source = "spotify";
        metadata.isPlaylist = true;
        metadata.isAutomix = false;

        if (spotifyMapId) {
          const task = spotifyMapTasks.get(spotifyMapId);
          if (task && task.status === "completed" && task.validItems?.length) {
            metadata.spotifyKind = "playlist";
            metadata.spotifyTitle = task.title;
            metadata.spotifyMapId = spotifyMapId;

            const validItems = task.validItems;
            metadata.selectedIndices = selectedIndices || "all";
            metadata.selectedIds = validItems.map(i => i.id);
            metadata.frozenEntries = validItems;
            metadata.frozenTitle = task.title || "Spotify";
          } else {
            return sendError(res, ERR.PREVIEW_FAILED, "Önce Spotify eşleştirmesini tamamlayın", 400);
        }
        } else {
          let sp;
          try {
            sp = await resolveSpotifyUrl(url, { market: resolveMarket(req.body?.market) });
          } catch (e) {
            const msg = String(e?.message || "");
            if (msg.startsWith("SPOTIFY_MIX_UNSUPPORTED")) {
              return sendError(res, 'SPOTIFY_MIX_UNSUPPORTED', "Bu link kişiselleştirilmiş bir Spotify Mix. Spotify Web API bu içerikleri sağlamıyor (404). Lütfen Mix’teki parçaları Spotify uygulamasında yeni bir oynatma listesine kopyalayıp o URL’yi kullanın.", 400);
            }
            throw e;
          }
          metadata.spotifyKind = sp.kind;
          metadata.spotifyTitle = sp.title;
          const all = sp.items || [];

          let sel = null;
          const rawSel = req.body?.selectedIndices;
          if (rawSel === "all") sel = "all";
          else if (Array.isArray(rawSel)) sel = rawSel.map(Number).filter(n => Number.isFinite(n) && n > 0);
          else if (typeof rawSel === "string" && rawSel.trim()) {
            sel = rawSel.split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n>0);
            if (!sel.length) sel = null;
          }

          const itemsToUse = (sel && sel !== "all")
            ? sel.map(i => all[i-1]).filter(Boolean)
            : all;

          const ids = [];
          const frozen = [];
          for (let i = 0; i < itemsToUse.length; i++) {
            const it = itemsToUse[i];
            const vid = await searchYtmBestId(it.artist, it.title);
            if (!vid) continue;
            ids.push(vid);
            frozen.push({
              index: (sel && sel !== "all") ? sel[i] : (i+1),
              id: vid,
              title: it.title,
              uploader: it.artist,
              webpage_url: `https://music.youtube.com/watch?v=${vid}`,
              thumbnails: []
            });
          }

          if (!ids.length) return sendError(res, ERR.PREVIEW_FAILED, "Spotify eşleşme bulunamadı", 400);

          metadata.selectedIndices = sel || "all";
          metadata.selectedIds = ids;
          metadata.frozenEntries = frozen;
          metadata.frozenTitle = sp.title || "Spotify";
        }
      }

else if (isYouTubeUrl(url)) {
  const normalized = normalizeYouTubeUrl(url);
  metadata.source = "youtube";
  metadata.url = normalized;
  metadata.originalUrl = url;

  const playlistUrl = isYouTubePlaylist(normalized);
  const automixUrl  = isYouTubeAutomix(normalized);
  metadata.isPlaylist = playlistUrl || automixUrl || (isPlaylist === true || isPlaylist === "true");
  metadata.isAutomix  = automixUrl;

  let sel = null;
  if (selectedIndices === "all") sel = "all";
  else if (Array.isArray(selectedIndices)) {
    sel = selectedIndices.map(Number).filter(n => Number.isFinite(n) && n>0);
  } else if (typeof selectedIndices === "string" && selectedIndices.trim()) {
    sel = selectedIndices.split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n>0);
  } else {
    sel = metadata.isPlaylist ? "all" : null;
  }
  metadata.selectedIndices = sel;

  console.log("=== YOUTUBE AUTOMIX DEBUG ===");
  console.log("URL:", normalized);
  console.log("isAutomix:", metadata.isAutomix);
  console.log("selectedIndices:", sel);
  console.log("req.body.selectedIds:", req.body.selectedIds);
  console.log("==============================");

  if (metadata.isAutomix && Array.isArray(sel) && sel.length > 0 && sel !== "all") {
    try {
      console.log("Automix ID'leri çözümleniyor...");

      if (Array.isArray(req.body.selectedIds) && req.body.selectedIds.length > 0) {
        metadata.selectedIds = req.body.selectedIds;
        console.log("selectedIds req.body'den alındı:", metadata.selectedIds);
      } else {
        const automixData = await resolveAutomixSelectedIds(normalized, sel);
        if (automixData.ids && automixData.ids.length > 0) {
          metadata.selectedIds = automixData.ids;
          metadata.frozenEntries = automixData.entries;
          metadata.frozenTitle = automixData.title;
          console.log("selectedIds API'den alındı:", metadata.selectedIds);
        }
      }

      console.log("Final selectedIds:", metadata.selectedIds);

    } catch (error) {
      console.warn("Automix ID'leri alınamadı:", error.message);
    }
  }
}
      else if (isDirectMediaUrl(url)) {
        metadata.source = "direct_url";
        inputPath = url;
      } else {
        return sendError(res, ERR.UNSUPPORTED_URL_FORMAT, "Desteklenmeyen URL formatı", 400);
      }
    }

    if (!inputPath && !url) {
      return sendError(res, ERR.URL_OR_FILE_REQUIRED, "A valid URL or file is required", 400);
    }

    const job = createJob({
      status: "queued",
      progress: 0,
      format,
      bitrate,
      sampleRate: pickedSR,
      metadata: {
        ...metadata,
        includeLyrics: includeLyrics === true || includeLyrics === "true"
      },
      resultPath: null,
      error: null,
      clientBatch: clientBatch || null,
    });
    const jobId = job.id;

    let batchTotal = null;
    if (clientBatch && metadata.isPlaylist && metadata.selectedIndices && metadata.selectedIndices !== "all") {
      batchTotal = metadata.selectedIndices.length;
    }

    processJob(jobId, inputPath, format, bitrate)
      .catch((e) => console.error("Job processing error:", e));

    return sendOk(res, {
      id: jobId,
      status: job.status,
      format,
      bitrate,
      sampleRate: job.sampleRate,
      source: metadata.source,
      isPlaylist: metadata.isPlaylist,
      isAutomix: metadata.isAutomix,
      selectedIndices: metadata.selectedIndices ?? null,
      selectedIds: metadata.selectedIds ?? null,
      clientBatch: job.clientBatch,
      batchTotal,
    });
  } catch (error) {
    console.error("Job creation error:", error);
    return sendError(res, ERR.INTERNAL, error.message || "internal", 500);
  }
});

router.post("/api/playlist/preview", async (req, res) => {
  try {
    const { url, page = 1, pageSize = 50 } = req.body || {};
    if (!url) return res.status(400).json({ error: { code: "URL_REQUIRED", message: "URL gerekli" } });
    const meta = await getPlaylistMetaLite(url);
    const total = Math.max(1, Number(meta?.count || 50));
    const size = Math.min(100, Math.max(1, Number(pageSize) || 50));
    const maxPage = Math.max(1, Math.ceil(total / size));
    const curPage = Math.min(Math.max(1, Number(page) || 1), maxPage);
    const start = (curPage - 1) * size + 1;
    const end   = Math.min(start + size - 1, total);
    const isAutomix = isYouTubeAutomix(url);
    let pageData;
    if (isAutomix) {
      const existing = inFlightAutomix.get(url);
      const runner = (async () => {
        await ensureAutomixUpto(url, end, Math.max(100, size));
      })();
      inFlightAutomix.set(url, runner);
      try { await runner; } finally { if (existing === runner) inFlightAutomix.delete(url); }

      const c = getCache(url);
      if (c && Array.isArray(c.entries) && c.entries.length >= start) {
        pageData = { title: c.title || meta?.title || "YouTube Automix", items: c.entries.slice(start-1, end) };
      } else {
        pageData = await extractAutomixPage(url, start, end);
      }
    } else {
      pageData = await extractPlaylistPage(url, start, end);
    }

    return res.json({
      page: curPage,
      items: Array.isArray(pageData?.items) ? pageData.items : [],
      playlist: {
        title: pageData?.title || meta?.title || "",
        count: total
      }
    });
  } catch (e) {
    return res.status(500).json({
      error: { code: "PREVIEW_FAILED", message: e?.message || "Preview başarısız" }
    });
  }
});

router.get("/api/jobs", requireAuth, (req, res) => {
  try {
    const status = (req.query.status || "active").toLowerCase();
    const all = Array.from(jobs.values());
    const pick = (j) => ({
      id: j.id,
      status: j.status,
      progress: j.progress,
      downloadProgress: j.downloadProgress ?? 0,
      convertProgress: j.convertProgress ?? 0,
      currentPhase: j.currentPhase || "queued",
      format: j.format,
      bitrate: j.bitrate,
      createdAt: j.createdAt,
      resultPath: j.resultPath || null,
      zipPath: j.zipPath || null,
      playlist: j.playlist || null,
      skippedCount: j.skippedCount || 0,
      errorsCount: j.errorsCount || 0,
      lastLog: j.lastLog || null,
      metadata: {
        source: j.metadata?.source,
        isPlaylist: !!j.metadata?.isPlaylist,
        isAutomix: !!j.metadata?.isAutomix,
        frozenTitle: j.metadata?.frozenTitle || null,
        extracted: j.metadata?.extracted || null,
        skipStats: j.metadata?.skipStats || { skippedCount: 0, errorsCount: 0 },
        spotifyTitle: j.metadata?.spotifyTitle || null,
        originalName: j.metadata?.originalName || null,
        includeLyrics: !!j.metadata?.includeLyrics,
        lyricsStats: j.metadata?.lyricsStats || null,
        frozenEntries: Array.isArray(j.metadata?.frozenEntries)
          ? j.metadata.frozenEntries.map(e => ({
              index: e.index,
              title: e.title,
              hasLyrics: !!e.hasLyrics
            })).slice(0, 500)
          : null,
        lyricsStats: j.metadata?.lyricsStats || { found: 0, notFound: 0 },
      },
    });
    let items = all.map(pick);
    if (status === "active")      items = items.filter(j => j.status!=="completed" && j.status!=="error");
    else if (status === "error")  items = items.filter(j => j.status==="error");
    else if (status === "completed") items = items.filter(j => j.status==="completed");
    items.sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error:{ code:"LIST_FAIL", message:e.message || "list failed" }});
  }
});

router.get("/api/stream", requireAuth, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const payload = () => {
    const items = Array.from(jobs.values()).map(j => ({
      id: j.id,
      status: j.status,
      progress: j.progress,
      downloadProgress: j.downloadProgress ?? 0,
      convertProgress: j.convertProgress ?? 0,
      currentPhase: j.currentPhase || "queued",
      format: j.format,
      bitrate: j.bitrate,
      resultPath: j.resultPath || null,
      zipPath: j.zipPath || null,
      createdAt: j.createdAt,
      skippedCount: j.skippedCount || 0,
      errorsCount: j.errorsCount || 0,
      playlist: j.playlist || null,
      lastLog: j.lastLog || null,
      metadata: {
        source: j.metadata?.source,
        isPlaylist: !!j.metadata?.isPlaylist,
        isAutomix: !!j.metadata?.isAutomix,
        frozenTitle: j.metadata?.frozenTitle || null,
        extracted: j.metadata?.extracted || null,
        skipStats: j.metadata?.skipStats || { skippedCount: 0, errorsCount: 0 },
        spotifyTitle: j.metadata?.spotifyTitle || null,
        originalName: j.metadata?.originalName || null,
        includeLyrics: !!j.metadata?.includeLyrics,
        lyricsStats: j.metadata?.lyricsStats || null,
        frozenEntries: Array.isArray(j.metadata?.frozenEntries)
          ? j.metadata.frozenEntries.map(e => ({
              index: e.index,
              title: e.title,
              hasLyrics: !!e.hasLyrics
            })).slice(0, 500)
          : null,
        lyricsStats: j.metadata?.lyricsStats || { found: 0, notFound: 0 },
      },
    }));
    return `data: ${JSON.stringify({ items })}\n\n`;
  };
  res.write(`: ping\n\n`);
  const iv = setInterval(()=>{ try{ res.write(payload()); }catch{} }, 1000);
  req.on("close", ()=> clearInterval(iv));
});

export default router;
