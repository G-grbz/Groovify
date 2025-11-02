import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import multer from "multer";

import { sendOk, sendError, ERR, isDirectMediaUrl } from "../modules/utils.js";
import { jobs, spotifyMapTasks } from "../modules/store.js";
import { processJob } from "../modules/processor.js";
import { isSpotifyUrl, resolveSpotifyUrl } from "../modules/spotify.js";
import { idsToMusicUrls, searchYtmBestId } from "../modules/sp.js";
import { resolveMarket } from "../modules/market.js";

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

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) =>
    cb(null, `${crypto.randomBytes(8).toString("hex")}_${file.originalname}`)
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
    "Content-Type": "text/event-stream",
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
    if (job.status === "completed" || job.status === "error") {
      clearInterval(interval);
      res.end();
    }
  }, 1000);

  req.on("close", () => clearInterval(interval));
});

router.post("/api/jobs", upload.single("file"), async (req, res) => {
  try {
    const {
      url,
      format = "mp3",
      bitrate = "192k",
      isPlaylist = false,
      selectedIndices,
      clientBatch,
      spotifyMapId
    } = req.body || {};

    const supported = ["mp3","flac","wav","ogg","mp4"];
    if (!supported.includes(format)) {
      return sendError(res, ERR.INVALID_FORMAT, "Unsupported format", 400);
    }

    const metadata = {};
    let inputPath = null;

    if (req.file) {
      inputPath = req.file.path;
      metadata.originalName = req.file.originalname;
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

    const jobId = crypto.randomBytes(8).toString("hex");
    const job = {
      id: jobId,
      status: "queued",
      progress: 0,
      format,
      bitrate,
      metadata,
      createdAt: new Date(),
      resultPath: null,
      error: null,
      clientBatch: clientBatch || null,
    };
    jobs.set(jobId, job);

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


export default router;
