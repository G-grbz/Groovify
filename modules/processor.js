import path from "path";
import fs from "fs";
import archiver from "archiver";
import { resolveId3StrictForYouTube } from "./tags.js";
import { resolveMarket } from "./market.js";
import { jobs } from "./store.js";
import { sendError, sanitizeFilename, toNFC } from "./utils.js";
import { processYouTubeVideoJob } from "./video.js";
import { isYouTubeAutomix, fetchYtMetadata, downloadYouTubeVideo, buildEntriesMap, parsePlaylistIndexFromPath } from "./yt.js";

import {
  convertMedia,
  downloadThumbnail,
} from "./media.js";

const OUTPUT_DIR = path.resolve(process.cwd(), "outputs");
const TEMP_DIR   = path.resolve(process.cwd(), "temp");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

export async function processJob(jobId, inputPath, format, bitrate) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    job.status = "running";
    job.progress = 0;
    job.downloadProgress = 0;
    job.convertProgress = 0;
    job.currentPhase = "preparing";

    if (format === "mp4" && job.metadata?.source === "youtube") {
      await processYouTubeVideoJob(job, { OUTPUT_DIR, TEMP_DIR });
      try {
        if (Array.isArray(job.resultPath)) {
          const titleHint = job.metadata?.frozenTitle ||
                            job.metadata?.extracted?.title ||
                            job.metadata?.extracted?.playlist_title ||
                            (job.metadata?.isAutomix ? "YouTube Automix" : "Playlist");
          job.zipPath = await makeZipFromOutputs(jobId, job.resultPath, titleHint || "playlist");
        }
      } catch {}
      cleanupTempFiles(jobId, inputPath, /* downloadedPath */ null);
      return;
    }

    let actualInputPath = inputPath;
    let coverPath = null;

    if (job.metadata.source === "spotify") {
      job.currentPhase = "downloading";
      job.downloadProgress = 5;

      const selectedIds = Array.isArray(job.metadata.selectedIds) ? job.metadata.selectedIds : [];
      if (!selectedIds.length) {
        throw new Error("Spotify URL listesi boş");
      }

      const files = await downloadYouTubeVideo(
        job.metadata.spotifyTitle || "Spotify",
        jobId,
        true,
        null,
        false,
        selectedIds,
        TEMP_DIR,
        (progress) => {
          job.downloadProgress = 20 + (progress * 0.8);
          job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
        },
        {
          video: (format === "mp4"),
          maxHeight: (format === "mp4") ? qualityToHeight(bitrate) : undefined
        }
      );

      job.downloadProgress = 100;
      job.currentPhase = "converting";
      job.convertProgress = 0;

      if (!Array.isArray(files) || !files.length) throw new Error("Spotify indirildi ama dosya bulunamadı");

      const frozen = Array.isArray(job.metadata.frozenEntries) ? job.metadata.frozenEntries : [];
      const byId = new Map(); for (const e of frozen) if (e?.id) byId.set(e.id, e);
      const sorted = files.map((fp, i) => ({ fp, auto: i+1 })).sort((a,b)=> a.auto - b.auto);
      const results = [];
      job.playlist = { total: sorted.length, done: 0 };

      for (let i = 0; i < sorted.length; i++) {
        const { fp: filePath, auto } = sorted[i];
        const pinnedId = selectedIds[auto - 1];
        const entry = (pinnedId ? byId.get(pinnedId) : null) || {};

        const fallbackTitle = path.basename(filePath, path.extname(filePath)).replace(/^\d+\s*-\s*/, "");
        const title = toNFC(entry.title || fallbackTitle);

        const fileMeta = {
          title,
          track: title,
          uploader: entry.uploader || "",
          artist: entry.artist || entry.uploader || "",
          album: entry.album || "",
          playlist_title: job.metadata.spotifyTitle || "Spotify Playlist",
          webpage_url: entry.webpage_url || "",
          release_year: entry.year || "",
          release_date: entry.date || "",
          track_number: entry.track_number,
          disc_number:  entry.disc_number,
          track_total:  entry.track_total,
          disc_total:   entry.disc_total,
          isrc:         entry.isrc
        };

        let itemCover = null;
        const baseNoExt = filePath.replace(/\.[^.]+$/, "");
        const sidecarJpg = `${baseNoExt}.jpg`;
        if (fs.existsSync(sidecarJpg)) itemCover = sidecarJpg;

        const existingOut = findExistingOutput(`${jobId}_${i}`, format, OUTPUT_DIR);
        let r;
        if (existingOut) {
          r = { outputPath: `/download/${encodeURIComponent(path.basename(existingOut))}` };
          const fileProgress = (i / sorted.length) * 100;
          job.convertProgress = Math.floor(fileProgress + (100 / sorted.length));
          job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
        } else {
          r = await convertMedia(
            filePath, format, bitrate, `${jobId}_${i}`,
            (progress)=>{
              const fileProgress = (i / sorted.length) * 100;
              const cur = (progress / 100) * (100 / sorted.length);
              job.convertProgress = Math.floor(fileProgress + cur);
              job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
            },
            fileMeta, itemCover, (format === "mp4"),
            OUTPUT_DIR, TEMP_DIR
          );
        }
        results.push(r);
        job.playlist.done = i + 1;
      }

      job.resultPath = results;
      try {
        const zipTitle = job.metadata.spotifyTitle || "Spotify Playlist";
        job.zipPath = await makeZipFromOutputs(jobId, results, zipTitle);
      } catch(e){}

      job.status = "completed";
      job.progress = 100;
      job.downloadProgress = 100;
      job.convertProgress = 100;
      job.currentPhase = "completed";
      cleanupTempFiles(jobId, inputPath, files);
      return;
    }

    if (job.metadata.source === "youtube") {
      job.currentPhase = "downloading";
      job.downloadProgress = 5;

      let isAutomix = !!job.metadata.isAutomix;
      if (!isAutomix) {
        isAutomix = isYouTubeAutomix(job.metadata.url);
        job.metadata.isAutomix = isAutomix;
      }

      let ytMeta = null;
      if (isAutomix) {
        ytMeta = { title: "YouTube Automix", uploader: "YouTube", playlist_title: "Automix" };
      } else {
        ytMeta = await fetchYtMetadata(job.metadata.url, job.metadata.isPlaylist);
      }

      const flat = {
        title:   toNFC(ytMeta?.title || ""),
        uploader:toNFC(ytMeta?.uploader || ytMeta?.channel || ""),
        artist:  toNFC(ytMeta?.artist || ytMeta?.creator || ytMeta?.uploader || ytMeta?.channel || ""),
        track: ytMeta?.track || "",
        album: toNFC(ytMeta?.album || ""),
        release_year: (ytMeta?.release_year && String(ytMeta.release_year)) ||
                      (ytMeta?.release_date && String(ytMeta.release_date).slice(0,4)) || "",
        upload_date: ytMeta?.upload_date || "",
        webpage_url: ytMeta?.webpage_url || job.metadata.url,
        thumbnail: (ytMeta?.thumbnails && ytMeta.thumbnails.length
          ? ytMeta.thumbnails[ytMeta.thumbnails.length - 1].url
          : ytMeta?.thumbnail) || "",
        playlist_title: toNFC(ytMeta?.playlist_title || ""),
      };
      job.metadata.extracted = flat;

      if (flat.thumbnail && !isAutomix) {
        const thumbBase = path.join(TEMP_DIR, `${jobId}.cover`);
        coverPath = await downloadThumbnail(flat.thumbnail, thumbBase);
      }

      if (job.metadata.isPlaylist || isAutomix) {
        job.downloadProgress = 10;

        const selected = job.metadata.selectedIndices;
        const indices = (selected === "all" || !selected) ? null : selected;
        const selectedIds = Array.isArray(job.metadata.selectedIds) ? job.metadata.selectedIds : null;
        const files = await downloadYouTubeVideo(
          job.metadata.url,
          jobId,
          true,
          indices,
          isAutomix,
          selectedIds,
          TEMP_DIR,
          (progress) => {
            job.downloadProgress = 10 + (progress * 0.9);
            job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
          },
        {
          video: (format === "mp4"),
          maxHeight: (format === "mp4") ? qualityToHeight(bitrate) : undefined
        }
        );

        job.downloadProgress = 100;
        job.currentPhase = "converting";
        job.convertProgress = 0;

        if (!Array.isArray(files) || !files.length) throw new Error("Playlist/Automix dosyaları bulunamadı.");

        const entryById = new Map();
        if (Array.isArray(job.metadata.frozenEntries)) {
          for (const e of job.metadata.frozenEntries) if (e?.id) entryById.set(e.id, e);
        }
        if (!Array.isArray(job.metadata.frozenEntries) || job.metadata.frozenEntries.length === 0) {
          const fe = [];
          const byIndex = buildEntriesMap(ytMeta);
          const byId = new Map();
          const metaEntries = Array.isArray(ytMeta?.entries) ? ytMeta.entries : [];
          for (const e of metaEntries) {
            if (e?.id) byId.set(e.id, e);
          }
          for (let i = 0; i < files.length; i++) {
            const filePath = files[i];
            const idxFromName = parsePlaylistIndexFromPath(filePath);
            let src = null;
            if (Number.isFinite(idxFromName) && byIndex.has(idxFromName)) {
              src = byIndex.get(idxFromName);
            } else if (Array.isArray(selectedIds) && selectedIds[i] && byId.has(selectedIds[i])) {
              src = byId.get(selectedIds[i]);
            }
            const title = (src?.title || src?.alt_title || path.basename(filePath, path.extname(filePath)).replace(/^\d+\s*-\s*/, "") || "").toString();
            const uploader = (src?.uploader || src?.channel || ytMeta?.uploader || ytMeta?.channel || "").toString();
            const id = (src?.id || (Array.isArray(selectedIds) ? selectedIds[i] : null) || "").toString();
            const webpage_url = (src?.webpage_url || src?.url || job.metadata.url || "").toString();
            const index = Number.isFinite(idxFromName) ? idxFromName : (i + 1);
            fe.push({ index, id, title, uploader, webpage_url });
            if (id) entryById.set(id, fe[fe.length - 1]);
          }
          job.metadata.frozenEntries = fe;
          job.metadata.frozenTitle = job.metadata.frozenTitle || ytMeta?.title || ytMeta?.playlist_title || (isAutomix ? "YouTube Automix" : "");
        }

        const sorted = files
          .map((fp, i) => ({ fp, auto: i+1 }))
          .sort((a,b)=> a.auto - b.auto);

        const results = [];
        job.playlist = { total: sorted.length, done: 0 };

        for (let i = 0; i < sorted.length; i++) {
          const { fp: filePath, auto } = sorted[i];
          let entry = {};
          if (Array.isArray(selectedIds) && selectedIds.length) {
            const pinnedId = selectedIds[(auto-1)];
            entry = (pinnedId ? entryById.get(pinnedId) : null) || {};
          }

          const fallbackTitle = path.basename(filePath, path.extname(filePath)).replace(/^\d+\s*-\s*/, "");
          const title = toNFC(entry.title || fallbackTitle);

          let fileMeta = {
            ...flat,
            title,
            track: title,
            uploader: toNFC(entry.uploader || flat.uploader),
            artist: toNFC(entry.artist || entry.uploader || flat.artist || flat.uploader),
            album: flat.album || (ytMeta?.title || ytMeta?.playlist_title || job.metadata.frozenTitle || ""),
            webpage_url: entry.webpage_url || entry.url || flat.webpage_url
          };

          if (/^(youtube|youtube\s+mix)$/i.test((fileMeta.artist||"").trim())) {
            fileMeta.artist = "";
          }

          let itemCover = null;
          const baseNoExt = filePath.replace(/\.[^.]+$/, "");
          const sidecarJpg = `${baseNoExt}.jpg`;
          if (fs.existsSync(sidecarJpg)) itemCover = sidecarJpg;
          else if (coverPath && fs.existsSync(coverPath)) itemCover = coverPath;

          try {
            const strictMeta = await resolveId3StrictForYouTube(
              {
                title: fileMeta.title,
                uploader: fileMeta.artist || fileMeta.uploader,
                thumbnail: itemCover ? null : flat.thumbnail,
                webpage_url: fileMeta.webpage_url
              },
              { market: resolveMarket(), isPlaylist: true }
            );
            if (strictMeta) {
              fileMeta = {
                ...fileMeta,
                ...strictMeta,
                webpage_url: strictMeta.spotifyUrl || fileMeta.webpage_url
              };
            }
          } catch {}

          const existingOut = findExistingOutput(`${jobId}_${i}`, format, OUTPUT_DIR);
          let r;
          if (existingOut) {
            r = { outputPath: `/download/${encodeURIComponent(path.basename(existingOut))}` };
            const fileProgress = (i / sorted.length) * 100;
            job.convertProgress = Math.floor(fileProgress + (100 / sorted.length));
            job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
          } else {
            r = await convertMedia(
              filePath, format, bitrate, `${jobId}_${i}`,
              (progress)=>{
                const fileProgress = (i / sorted.length) * 100;
                const cur = (progress / 100) * (100 / sorted.length);
                job.convertProgress = Math.floor(fileProgress + cur);
                job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
              },
              fileMeta, itemCover, (format === "mp4"),
              OUTPUT_DIR, TEMP_DIR
            );
          }
          results.push(r);
          job.playlist.done = i + 1;
        }

        job.resultPath = results;
        try {
          const zipTitle = ytMeta?.title || ytMeta?.playlist_title || (isAutomix ? "YouTube Automix" : "Playlist");
          job.zipPath = await makeZipFromOutputs(jobId, results, zipTitle);
        } catch(e){}

        job.status = "completed";
        job.progress = 100;
        job.downloadProgress = 100;
        job.convertProgress = 100;
        job.currentPhase = "completed";
        cleanupTempFiles(jobId, inputPath, files);
        return;
      }

      const filePath = await downloadYouTubeVideo(
        job.metadata.url,
        jobId,
        false,
        null,
        false,
        null,
        TEMP_DIR,
        (progress) => {
          job.downloadProgress = progress;
          job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
        },
        {
          video: (format === "mp4"),
          maxHeight: (format === "mp4") ? qualityToHeight(bitrate) : undefined
        }
      );

      job.downloadProgress = 100;
      job.currentPhase = "converting";
      actualInputPath = filePath;
    }

    const isVideo = format === "mp4";
    if (!coverPath && typeof actualInputPath === "string") {
      const baseNoExt = actualInputPath.replace(/\.[^.]+$/, "");
      const sidecar = `${baseNoExt}.jpg`;
      if (fs.existsSync(sidecar)) coverPath = sidecar;
    }

    const existingSingle = findExistingOutput(jobId, format, OUTPUT_DIR);
    const r = existingSingle
      ? { outputPath: `/download/${encodeURIComponent(path.basename(existingSingle))}` }
      : await convertMedia(
          actualInputPath, format, bitrate, jobId,
          (p)=>{
            job.convertProgress = Math.floor(p);
            job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
          },
          {
            ...(job.metadata.extracted || {}),
            __maxHeight: (format === "mp4") ? qualityToHeight(bitrate) : undefined
          },
          coverPath, isVideo,
          OUTPUT_DIR, TEMP_DIR
        );

    job.resultPath = r.outputPath;
    job.status = "completed";
    job.progress = 100;
    job.downloadProgress = 100;
    job.convertProgress = 100;
    job.currentPhase = "completed";
    cleanupTempFiles(jobId, inputPath, actualInputPath);
  } catch (error) {
    const job = jobs.get(jobId);
    if (job) {
      job.status = "error";
      job.error = error.message;
      job.currentPhase = "error";
    }
    console.error("Job error:", error);
    cleanupTempFiles(jobId, inputPath);
  }
}

function findExistingOutput(idPrefix, format, outDir) {
  try {
    const exts = {
      mp3: ["mp3"], flac:["flac"], wav:["wav"], ogg:["ogg","oga"], mp4:["mp4","m4a"]
    }[format] || [format];
    const files = fs.readdirSync(outDir);
    const hit = files.find(f => f.startsWith(`${idPrefix}.`) && exts.some(e => f.toLowerCase().endsWith(`.${e}`)));
    return hit ? path.join(outDir, hit) : null;
  } catch { return null; }
}

async function makeZipFromOutputs(jobId, outputs, titleHint = "playlist") {
  const safeBase = sanitizeFilename(`${titleHint || 'playlist'}_${jobId}`).normalize("NFC");
  const zipName = `${safeBase}.zip`;
  const zipAbs  = path.join(OUTPUT_DIR, zipName);

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipAbs);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve(`/download/${encodeURIComponent(zipName)}`));
    archive.on("error", err => reject(err));

    archive.pipe(output);

    for (const r of outputs) {
      if (!r?.outputPath) continue;
      const rel = decodeURIComponent(r.outputPath.replace(/^\/download\//, ""));
      const abs = path.join(OUTPUT_DIR, rel);
      if (fs.existsSync(abs)) {
        const nfcName = path.basename(abs).normalize("NFC");
        archive.file(abs, { name: nfcName });
      }
    }

    archive.finalize();
  });
}

function cleanupTempFiles(jobId, originalInputPath, downloadedPath = null) {
  try {
    if (typeof originalInputPath === "string" &&
        fs.existsSync(originalInputPath) &&
        originalInputPath.includes(path.resolve(process.cwd(),"uploads"))) {
      try { fs.unlinkSync(originalInputPath); } catch {}
    }

    if (Array.isArray(downloadedPath)) {
      downloadedPath.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
      const playlistDir = path.join(TEMP_DIR, jobId);
      if (fs.existsSync(playlistDir)) {
        try { fs.rmSync(playlistDir, { recursive: true, force: true }); } catch {}
      }
    } else if (typeof downloadedPath === "string" && fs.existsSync(downloadedPath)) {
      try { fs.unlinkSync(downloadedPath); } catch {}
    }

    try {
      const files = fs.readdirSync(TEMP_DIR);
      files.forEach((f)=>{
        if (f.startsWith(jobId)) {
          try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch {}
        }
      });
    } catch {}
  } catch (e) {
    console.warn("Temizleme uyarısı:", e.message);
  }
}

function qualityToHeight(q) {
  const v = String(q||"").toLowerCase();
  if (v.includes("1080")) return 1080;
  if (v.includes("720"))  return 720;
  if (v.includes("480"))  return 480;
  if (v.includes("360"))  return 360;
  return 1080;
}
