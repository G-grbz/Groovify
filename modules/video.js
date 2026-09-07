import path from "path";
import fs from "fs";
import {
  downloadYouTubeVideo,
  buildEntriesMap,
  parsePlaylistIndexFromPath,
  isYouTubeAutomix,
  idsToMusicUrls
} from "./yt.js";
import { sanitizeFilename, normalizeTitle, parseIdFromPath } from "./utils.js"
import { convertMedia } from "./media.js";
import "dotenv/config";
import { spawnSafe } from "./safeProcess.js";
import { jobs, registerJobProcess, markJobCompleted } from "./store.js";
import { toDownloadPath } from "./outputPaths.js";
import { ensureOwnership } from "./fsOwnership.js";

function isMappedMusicSource(source = "") {
  const value = String(source || "").toLowerCase();
  return value === "spotify" || value === "apple_music" || value === "deezer" || value === "tidal" || value === "soundcloud";
}

function mappedMusicLabel(source = "") {
  const value = String(source || "").toLowerCase();
  if (value === "apple_music") return "Apple Music";
  if (value === "deezer") return "Deezer";
  if (value === "tidal") return "TIDAL";
  if (value === "soundcloud") return "SoundCloud";
  return "Spotify";
}

function mappedMusicPlaylistTitle(job) {
  const source = job?.metadata?.source || "";
  const value = String(source).toLowerCase();
  const fallback = value === "apple_music"
    ? "Apple Music Playlist"
    : value === "deezer"
    ? "Deezer Playlist"
    : value === "tidal"
    ? "TIDAL Playlist"
    : value === "soundcloud"
    ? "SoundCloud Playlist"
    : "Spotify Playlist";
  return job?.metadata?.spotifyTitle || fallback;
}

// Handles safe rm in core application logic.
function safeRm(pathLike) {
  try {
    if (!pathLike || !fs.existsSync(pathLike)) return;
    const stat = fs.statSync(pathLike);
    if (stat.isDirectory()) {
      fs.rmSync(pathLike, { recursive: true, force: true });
    } else {
      fs.unlinkSync(pathLike);
    }
  } catch {}
}

// Cleans up temp for job state for core application logic.
function cleanupTempForJob(TEMP_DIR, jobId) {
  const playlistDir = path.join(TEMP_DIR, jobId);
  safeRm(playlistDir);
  safeRm(path.join(TEMP_DIR, `${jobId}.urls.txt`));
  try {
    const files = fs.readdirSync(TEMP_DIR);
    for (const f of files) {
      if (f.startsWith(jobId)) {
        safeRm(path.join(TEMP_DIR, f));
      }
    }
  } catch {}
}

// Handles safe move sync in core application logic.
function safeMoveSync(src, dest) {
  try {
    fs.renameSync(src, dest);
    return;
  } catch (e) {
    if (!e || e.code !== "EXDEV") throw e;
    try {
      const flags = fs.constants?.COPYFILE_FICLONE || 0;
      fs.copyFileSync(src, dest, flags);
    } catch {
      fs.copyFileSync(src, dest);
    }
    try {
      const s1 = fs.statSync(src).size;
      const s2 = fs.statSync(dest).size;
      if (s1 !== s2) throw new Error("copy size mismatch");
    } catch (verifyErr) {
      try { fs.unlinkSync(dest); } catch {}
      throw verifyErr;
    }
    try { fs.unlinkSync(src); } catch {}
  }
}

// Handles strip leading prefix in core application logic.
function stripLeadingPrefix(basename, jobId) {
  const noJob = basename.replace(new RegExp(`^${jobId}\\s*-\\s*`), "");
  return noJob.replace(/^(\d+)\s*-\s*/, "");
}

// Handles media probe data video height in core application logic.
async function probeVideoHeight(inputPath) {
  return await new Promise((resolve) => {
    try {
      const p = spawnSafe("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=height",
        "-of",
        "csv=p=0",
        inputPath
      ]);

      let out = "";
      p.stdout.on("data", (d) => {
        out += d.toString();
      });

      p.on("close", () => {
        const h = parseInt(out.trim(), 10);
        resolve(Number.isFinite(h) ? h : 0);
      });

      p.on("error", () => resolve(0));
    } catch {
      resolve(0);
    }
  });
}

// Handles unique out path in core application logic.
function uniqueOutPath(dir, base, ext) {
  let name = `${base}${ext}`;
  let out = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(out)) {
    name = `${base} (${i++})${ext}`;
    out = path.join(dir, name);
  }
  return out;
}

// Formats fps for live conversion logs in core application logic.
function formatLiveFps(fps) {
  const n = Number(fps);
  if (!Number.isFinite(n) || n <= 0) return "--";
  return n.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

// Builds live conversion text in core application logic.
function buildLiveConvertLog(progress, details = {}, label = "") {
  const pct = Math.max(0, Math.min(100, Math.floor(Number(progress) || 0)));
  const elapsed = details?.elapsedText || "--:--:--";
  const duration = details?.durationText || "--:--:--";
  const fps = formatLiveFps(details?.fps);
  const suffix = label ? `: ${label}` : "";
  return `⚙️ Converting ${pct}% (${elapsed}/${duration} • ${fps} FPS)${suffix}`;
}

// Handles quality to height in core application logic.
export function qualityToHeight(q) {
  const v = String(q || "").toLowerCase();
  if (v.includes("2160") || v.includes("4k")) return 2160;
  if (v.includes("1440")) return 1440;
  if (v.includes("1080")) return 1080;
  if (v.includes("720"))  return 720;
  if (v.includes("480"))  return 480;
  if (v.includes("360"))  return 360;
  return 1080;
}

// Processes you tube video job state in core application logic.
export async function processYouTubeVideoJob(job, {
  OUTPUT_DIR = path.resolve(process.cwd(), "outputs"),
  OUTPUT_ROOT_DIR = path.resolve(process.env.DATA_DIR || process.cwd(), "outputs"),
  TEMP_DIR   = path.resolve(process.cwd(), "temp"),
}) {
  const TARGET_H = qualityToHeight(job.bitrate);
  const format = job.format || "mp4";
  const videoSettings = job.videoSettings || {};
  const transcodeEnabled = videoSettings.transcodeEnabled === true;
  const sourceLabel = isMappedMusicSource(job.metadata?.source)
    ? mappedMusicLabel(job.metadata?.source)
    : "YouTube";
  const youtubeConcurrency =
    Number(job.metadata?.youtubeConcurrency) || undefined;

  console.log(`🎬 Video job settings:`, {
   jobId: job.id,
   format: format,
   targetHeight: TARGET_H,
   transcodeEnabled,
   videoSettings: job.videoSettings,
   source: job.metadata?.source
 });

  if (isMappedMusicSource(job.metadata?.source)) {
    console.log(`🎬 ${mappedMusicLabel(job.metadata?.source)} video processing: ${job.metadata.spotifyTitle}`);
    await processSpotifyVideoJob(job, { OUTPUT_DIR, OUTPUT_ROOT_DIR, TEMP_DIR, TARGET_H, format, videoSettings });
    return;
  }

  job.counters = job.counters || { dlTotal: 0, dlDone: 0, cvTotal: 0, cvDone: 0 };
  job.currentPhase = "downloading";
  job.downloadProgress = 5;

  const isAutomix = job.metadata.isAutomix || isYouTubeAutomix(job.metadata.url);
  const flat = {
    title: job.metadata?.extracted?.title || "",
    uploader: job.metadata?.extracted?.uploader || "",
    album: job.metadata?.extracted?.album || "",
    webpage_url: job.metadata?.extracted?.webpage_url || job.metadata.url,
    playlist_title: job.metadata?.extracted?.playlist_title || "",
  };

  const isPl = !!job.metadata.isPlaylist || isAutomix;

  if (isPl) {
    const selected = job.metadata.selectedIndices;
    const indices = (selected === "all" || !selected) ? null : selected;
    const selectedIds = Array.isArray(job.metadata.selectedIds) ? job.metadata.selectedIds : null;
    const metaEntries = Array.isArray(job.metadata?.extracted?.entries)
      ? job.metadata.extracted.entries
      : [];

    let totalTracks = 0;

    if (Array.isArray(indices) && indices.length) {
      totalTracks = indices.length;
    } else if (Array.isArray(selectedIds) && selectedIds.length) {
      totalTracks = selectedIds.length;
    } else if (metaEntries.length) {
      totalTracks = metaEntries.length;
    }

    if (totalTracks > 0) {
      job.playlist = job.playlist || { total: totalTracks, done: 0, current: 0 };
      job.counters.dlTotal = totalTracks;
      job.counters.cvTotal = totalTracks;
    }
  }

  // Handles on progress in core application logic.
  const onProgress = (p) => {
    if (p && typeof p === "object" && p.__event) {
      if ((isPl || isAutomix) && p.type === "file-done" && job.counters) {
        const total =
          Number(p.total || job.counters.dlTotal || job.playlist?.total || 0) || 0;

        if (total > 0) {
          job.counters.dlTotal = total;
          if (job.playlist && !job.playlist.total) {
            job.playlist.total = total;
          }
        }

        const done = Number(p.downloaded || job.counters.dlDone || 0) || 0;
        job.counters.dlDone = Math.max(0, done);

        if (job.playlist) {
          job.playlist.done = job.counters.dlDone;
          job.playlist.current = Math.max(0, job.counters.dlDone - 1);
        }
      }
      return;
    }

    const pct = Number(p) || 0;
    job.downloadProgress = Math.max(
      job.downloadProgress,
      Math.min(100, Math.floor(pct))
    );
    job.progress = Math.floor(
      (job.downloadProgress + (job.convertProgress || 0)) / 2
    );

    if (!isPl && job.counters) {
      const total = job.counters.dlTotal || 1;
      job.counters.dlDone = Math.floor((pct / 100) * total);
    }
  };

  if (isPl) {
    const selected = job.metadata.selectedIndices;
    const indices = (selected === "all" || !selected) ? null : selected;
    const selectedIds = Array.isArray(job.metadata.selectedIds) ? job.metadata.selectedIds : null;

    const dlUrlPl = (job.metadata.url || "").replace("music.youtube.com", "www.youtube.com");
    const files = await downloadYouTubeVideo(
      dlUrlPl,
      job.id,
      true,
      indices,
      isAutomix,
      selectedIds,
      TEMP_DIR,
      onProgress,
      {
        video: true,
        maxHeight: TARGET_H,
        youtubeConcurrency,
      }
    );

    const VIDEO_EXTS = new Set([".mp4", ".m4v", ".mov", ".mkv", ".webm"]);
    const mediaFiles = files.filter(fp =>
      VIDEO_EXTS.has(path.extname(fp).toLowerCase())
    );

    if (!Array.isArray(mediaFiles) || !mediaFiles.length) {
      throw new Error("Playlist/Automix video files not found.");
    }

    job.downloadProgress = 100;
    job.currentPhase = "converting";
    job.convertProgress = 0;

    if (
      !Array.isArray(job.metadata.frozenEntries) ||
      job.metadata.frozenEntries.length === 0
    ) {
      const fe = [];
      const byIndex = buildEntriesMap(job.metadata.extracted);
      const metaEntries = Array.isArray(job.metadata?.extracted?.entries)
        ? job.metadata.extracted.entries
        : [];

      for (let i = 0; i < mediaFiles.length; i++) {
        const filePath = mediaFiles[i];
        const idxFromName = parsePlaylistIndexFromPath(filePath);
        const fileId = parseIdFromPath(filePath);
        let src = null;

        if (Number.isFinite(idxFromName) && byIndex.has(idxFromName)) {
          src = byIndex.get(idxFromName);
        } else if (Array.isArray(selectedIds) && selectedIds[i]) {
          src = (fileId ? metaEntries.find(e => e?.id === fileId) : null) || null;
          if (!src) src = metaEntries.find(e => e?.id === selectedIds[i]) || null;
        }

        const title = (src?.title || src?.alt_title ||
          path.basename(filePath, path.extname(filePath)).replace(/^\d+\s*-\s*/, "") || ""
        ).toString();
        const uploader = (src?.uploader || src?.channel || flat.uploader || "").toString();
        const id = (src?.id || fileId || (Array.isArray(selectedIds) ? selectedIds[i] : null) || "").toString();
        const webpage_url = (src?.webpage_url || src?.url || flat.webpage_url || "").toString();
        const index = Number.isFinite(idxFromName) ? idxFromName : (i + 1);

        fe.push({ index, id, title, uploader, webpage_url });
      }

    job.metadata.frozenEntries = fe;
    job.metadata.frozenTitle =
    job.metadata.frozenTitle ||
    flat.title ||
    flat.playlist_title ||
    (isAutomix ? "YouTube Automix" : "");
    }
    const frozenEntries = Array.isArray(job.metadata.frozenEntries) ? job.metadata.frozenEntries : [];
    const frozenById = new Map();
    const frozenByIndex = new Map();
    for (const e of frozenEntries) {
      if (!e) continue;
      if (e.id) frozenById.set(e.id, e);
      const idx = Number(e.index);
      if (Number.isFinite(idx)) frozenByIndex.set(idx, e);
    }

    const selectedIdToPos = new Map();
    if (Array.isArray(selectedIds) && selectedIds.length) {
      selectedIds.forEach((id, i) => {
        if (id) selectedIdToPos.set(id, i);
      });
    }
    job.counters.dlTotal = mediaFiles.length;
    job.counters.dlDone  = mediaFiles.length;
    job.counters.cvTotal = mediaFiles.length;
    job.counters.cvDone  = 0;

    const sorted  = mediaFiles
      .map((fp, i) => ({ fp, auto: i + 1 }))
      .sort((a, b) => a.auto - b.auto);
    const results = [];

    if (!job.playlist) {
      job.playlist = { total: sorted.length, done: 0, current: 0 };
    } else {
      job.playlist.total   = sorted.length;
      job.playlist.done    = 0;
      job.playlist.current = 0;
    }

    for (let i = 0; i < sorted.length; i++) {
      const { fp: filePath } = sorted[i];

      job.playlist.current = i;

      const ext = path.extname(filePath);
      const rawBase = path.basename(filePath);
      const cleaned = stripLeadingPrefix(rawBase, job.id).replace(ext, "").trim();

      const fromParser = parsePlaylistIndexFromPath(rawBase);
      const regexMatch = rawBase.match(/^(\d+)\s*-\s*/);
      const playlistIndex = Number.isFinite(fromParser)
        ? fromParser
        : (regexMatch ? Number(regexMatch[1]) : null);

      const fileId = parseIdFromPath(filePath);

      let feEntry = null;

      if (fileId && frozenById.has(fileId)) {
        feEntry = frozenById.get(fileId);
      } else if (fileId && selectedIdToPos.has(fileId)) {
        const pos = selectedIdToPos.get(fileId);
        const pinnedId = selectedIds?.[pos];
        if (pinnedId && frozenById.has(pinnedId)) feEntry = frozenById.get(pinnedId);
      }

      if (!feEntry && Number.isFinite(playlistIndex)) {
        feEntry = frozenByIndex.get(playlistIndex) || null;
      }

      const artistRaw =
        feEntry?.uploader ||
        flat.uploader ||
        "";

      let titleRaw =
        feEntry?.title ||
        cleaned ||
        "video";

      if (artistRaw && titleRaw) {
        const core = normalizeTitle(titleRaw, artistRaw);
        if (core) titleRaw = core;
      }

      const baseTitle = artistRaw
        ? `${artistRaw} - ${titleRaw}`
        : titleRaw;

      const cleanTitle = sanitizeFilename(baseTitle) || "video";
      console.log(`🎧 ${sourceLabel} cleanTitle:`, { cleanTitle, artistRaw, titleRaw });

      if (!transcodeEnabled) {
        const targetAbs = uniqueOutPath(OUTPUT_DIR, cleanTitle, ext);
        console.log(`🎬 Transcode DISABLED - direct move: ${filePath} -> ${targetAbs}`);
        safeMoveSync(filePath, targetAbs);
        await ensureOwnership(targetAbs);
        const downloadPath =
          toDownloadPath(targetAbs, OUTPUT_ROOT_DIR) ||
          `/download/${encodeURIComponent(path.basename(targetAbs))}`;

        results.push({
          outputPath: downloadPath,
          fileSize: fs.statSync(targetAbs).size
        });

        job.playlist.done   = i + 1;
        job.counters.cvDone = i + 1;

        const overallConv = ((i + 1) / sorted.length) * 100;
        job.convertProgress = Math.floor(overallConv);
        job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
      } else {
        const srcHeight = await probeVideoHeight(filePath);
        const meta = {
          title: cleanTitle,
          track: cleanTitle,
          artist: artistRaw,
          album: flat.playlist_title || flat.title || "",
          album_artist: artistRaw,
          webpage_url: feEntry?.webpage_url || flat.webpage_url || "",
          __maxHeight: TARGET_H,
          __srcHeight: srcHeight
        };

        const convJobId = `${job.id}_v${i + 1}`;

        console.log(`🎬 ConvertMedia called:`, {
        inputPath: filePath,
        format: format,
        bitrate: job.bitrate || "auto",
        isVideo: true,
        videoSettings: videoSettings
      });

        const convResult = await convertMedia(
          filePath,
          format,
          job.bitrate || "auto",
          convJobId,
          (p, details) => {
            const overallConv = ((i + p / 100) / sorted.length) * 100;
            job.convertProgress = Math.max(
              job.convertProgress || 0,
              Math.floor(overallConv)
            );
            job.progress = Math.floor(
              (job.downloadProgress + (job.convertProgress || 0)) / 2
            );

            if (isVideoFormat(format)) {
              const label = [artistRaw, titleRaw]
                .map((s) => String(s || "").trim())
                .filter(Boolean)
                .join(" - ");
              job.lastLog = buildLiveConvertLog(p, details, label);
              job.lastLogKey = null;
              job.lastLogVars = null;
            }
          },
          meta,
          null,
          true,
          OUTPUT_DIR,
          TEMP_DIR,
          {
            includeLyrics: false,
            isCanceled: () => !!jobs.get(job.id)?.canceled,
            volumeGain: job.metadata?.volumeGain ?? job.videoSettings?.volumeGain ?? null,
            loudnorm: !!(job.metadata?.loudnorm ?? job.videoSettings?.loudnorm),
            loudnormMode: job.metadata?.loudnormMode || job.videoSettings?.loudnormMode || "ebu_r128",
            outputRootDir: OUTPUT_ROOT_DIR,
            videoSettings: videoSettings,
            onProcess: (child) => {
              try {
                registerJobProcess(job.id, child);
              } catch (_) {}
            }
          }
        );

        results.push(convResult);

        job.playlist.done   = i + 1;
        job.counters.cvDone = i + 1;
      }
    }

    job.counters.cvDone = sorted.length;
    job.resultPath = results;
    markJobCompleted(job);
    job.progress = 100;
    job.downloadProgress = 100;
    job.convertProgress = 100;
    job.currentPhase = "completed";
    cleanupTempForJob(TEMP_DIR, job.id);
    return;
  }

  const dlUrlSingle = (job.metadata.url || "").replace("music.youtube.com", "www.youtube.com");
  const filePath = await downloadYouTubeVideo(
    dlUrlSingle,
    job.id,
    false,
    null,
    false,
    null,
    TEMP_DIR,
    onProgress,
    { video: true, maxHeight: TARGET_H }
  );

  job.downloadProgress = 100;
  job.currentPhase = "converting";
  job.convertProgress = 0;

  const ext = path.extname(filePath);
  const rawBase = path.basename(filePath);
  const cleaned = stripLeadingPrefix(rawBase, job.id).replace(ext, "").trim();

  const artistRaw = flat.uploader || "";
  let titleRaw  = flat.title || cleaned || "video";

  if (artistRaw && titleRaw) {
    const core = normalizeTitle(titleRaw, artistRaw);
    if (core) titleRaw = core;
  }

  const baseTitle = artistRaw
    ? `${artistRaw} - ${titleRaw}`
    : titleRaw;

  const cleanTitle = sanitizeFilename(baseTitle) || "video";
  console.log(`🎧 ${sourceLabel} cleanTitle:`, { cleanTitle, artistRaw, titleRaw });

  if (!transcodeEnabled) {
    const targetAbs = uniqueOutPath(OUTPUT_DIR, cleanTitle, ext);
    safeMoveSync(filePath, targetAbs);
    await ensureOwnership(targetAbs);
    const downloadPath =
      toDownloadPath(targetAbs, OUTPUT_ROOT_DIR) ||
      `/download/${encodeURIComponent(path.basename(targetAbs))}`;

    job.convertProgress   = 100;
    job.counters.dlTotal  = 1;
    job.counters.dlDone   = 1;
    job.counters.cvTotal  = 1;
    job.counters.cvDone   = 1;
    job.resultPath        = downloadPath;
    markJobCompleted(job);
    job.progress          = 100;
    job.downloadProgress  = 100;
    job.convertProgress   = 100;
    job.currentPhase      = "completed";
    cleanupTempForJob(TEMP_DIR, job.id);
    } else {
    const srcHeight = await probeVideoHeight(filePath);

    const meta = {
      title: cleanTitle,
      track: cleanTitle,
      artist: artistRaw,
      album: flat.album || "",
      album_artist: artistRaw,
      webpage_url: flat.webpage_url || dlUrlSingle,
      __maxHeight: TARGET_H,
      __srcHeight: srcHeight
    };

    const convResult = await convertMedia(
      filePath,
      format,
      job.bitrate || "auto",
      `${job.id}_v1`,
      (p, details) => {
        job.convertProgress = Math.max(job.convertProgress || 0, Math.floor(p));
        job.progress = Math.floor(
          (job.downloadProgress + (job.convertProgress || 0)) / 2
        );

        if (isVideoFormat(format)) {
          const label = [artistRaw, titleRaw]
            .map((s) => String(s || "").trim())
            .filter(Boolean)
            .join(" - ");
          job.lastLog = buildLiveConvertLog(p, details, label);
          job.lastLogKey = null;
          job.lastLogVars = null;
        }
      },
      meta,
      null,
      true,
      OUTPUT_DIR,
      TEMP_DIR,
      {
        includeLyrics: false,
        isCanceled: () => !!jobs.get(job.id)?.canceled,
        volumeGain: job.metadata?.volumeGain ?? job.videoSettings?.volumeGain ?? null,
        loudnorm: !!(job.metadata?.loudnorm ?? job.videoSettings?.loudnorm),
        loudnormMode: job.metadata?.loudnormMode || job.videoSettings?.loudnormMode || "ebu_r128",
        outputRootDir: OUTPUT_ROOT_DIR,
        videoSettings: videoSettings,
        onProcess: (child) => {
          try {
            registerJobProcess(job.id, child);
          } catch (_) {}
        }
      }
    );

    job.counters.dlTotal  = 1;
    job.counters.dlDone   = 1;
    job.counters.cvTotal  = 1;
    job.counters.cvDone   = 1;
    job.resultPath = convResult.outputPath;
    markJobCompleted(job);
    job.progress = 100;
    job.downloadProgress = 100;
    job.convertProgress = 100;
    job.currentPhase = "completed";
    cleanupTempForJob(TEMP_DIR, job.id);
  }
}

// Processes Spotify metadata video job state in core application logic.
async function processSpotifyVideoJob(job, { OUTPUT_DIR, OUTPUT_ROOT_DIR, TEMP_DIR, TARGET_H, format, videoSettings }) {
  const sourceLabel = mappedMusicLabel(job.metadata?.source);
  const playlistTitle = mappedMusicPlaylistTitle(job);

  console.log(`🎬 Starting ${sourceLabel} video processing: ${job.metadata.spotifyTitle}`);

  job.counters = job.counters || { dlTotal: 0, dlDone: 0, cvTotal: 0, cvDone: 0 };
  job.currentPhase = "downloading";
  job.downloadProgress = 5;

  const selectedIds = Array.isArray(job.metadata.selectedIds) ? job.metadata.selectedIds : [];
  if (!selectedIds.length) {
    throw new Error(`${sourceLabel} URL list is empty`);
  }

  const transcodeEnabled = videoSettings.transcodeEnabled === true;

  job.lastLogKey = 'log.spotify.videoProcessingStart';
  job.lastLogVars = {
    title: playlistTitle,
    count: selectedIds.length
  };
  job.lastLog = `🎬 Starting ${sourceLabel} video processing: ${playlistTitle} (${selectedIds.length} tracks)`;

  // Handles on progress in core application logic.
  const onProgress = (p) => {
    if (p && typeof p === "object" && p.__event) {
      if (p.type === "file-done" && job.counters) {
        const total = Number(p.total || job.counters.dlTotal || selectedIds.length || 0) || 0;
        if (total > 0) {
          job.counters.dlTotal = total;
          if (job.playlist && !job.playlist.total) {
            job.playlist.total = total;
          }
        }

        const done = Number(p.downloaded || job.counters.dlDone || 0) || 0;
        job.counters.dlDone = Math.max(0, done);

        if (job.playlist) {
          job.playlist.done = job.counters.dlDone;
          job.playlist.current = Math.max(0, job.counters.dlDone - 1);
        }

        if (p.item && p.item.title) {
          job.lastLogKey = 'log.spotify.videoDownloaded';
          job.lastLogVars = {
            artist: p.item.uploader || `${sourceLabel} Artist`,
            title: p.item.title,
            done: done,
            total: total
          };
          job.lastLog = `📥 Downloaded: ${p.item.uploader} - ${p.item.title} (${done}/${total})`;
        }
      }
      return;
    }

    const pct = Number(p) || 0;
    job.downloadProgress = Math.max(
      job.downloadProgress,
      Math.min(100, Math.floor(pct))
    );
    job.progress = Math.floor(
      (job.downloadProgress + (job.convertProgress || 0)) / 2
    );

    if (job.counters) {
      const total = job.counters.dlTotal || 1;
      job.counters.dlDone = Math.floor((pct / 100) * total);
    }
  };

  const files = await downloadYouTubeVideo(
    playlistTitle,
    job.id,
    true,
    null,
    false,
    selectedIds,
    TEMP_DIR,
    onProgress,
    {
      video: true,
      maxHeight: TARGET_H,
      onSkipUpdate: (stats) => {
        job.skippedCount = stats.skippedCount || 0;
        job.errorsCount = stats.errorsCount || 0;
      }
    },
    {
      isCanceled: () => !!job.canceled,
      onItemProgress: (item, progress) => {
        if (item && progress > 0) {
          job.lastLogKey = 'log.spotify.videoDownloading';
          job.lastLogVars = {
            artist: item.uploader || `${sourceLabel} Artist`,
            title: item.title,
            progress: Math.floor(progress)
          };
          job.lastLog = `📥 Downloading (${Math.floor(progress)}%): ${item.uploader} - ${item.title}`;
        }
      }
    }
  );

  const VIDEO_EXTS = new Set([".mp4", ".m4v", ".mov", ".mkv", ".webm"]);
  const mediaFiles = files.filter(fp =>
    VIDEO_EXTS.has(path.extname(fp).toLowerCase())
  );

  if (!Array.isArray(mediaFiles) || !mediaFiles.length) {
    throw new Error(`${sourceLabel} video files not found.`);
  }

  job.downloadProgress = 100;
  job.currentPhase = "converting";
  job.convertProgress = 0;

  if (!Array.isArray(job.metadata.frozenEntries) || job.metadata.frozenEntries.length === 0) {
    const fe = [];
    const frozenEntries = Array.isArray(job.metadata.frozenEntries) ? job.metadata.frozenEntries : [];

    for (let i = 0; i < mediaFiles.length; i++) {
      const filePath = mediaFiles[i];
      const idxFromName = parsePlaylistIndexFromPath(filePath);

      const frozenEntry = frozenEntries[i] || {};
      const title = frozenEntry.title ||
                   path.basename(filePath, path.extname(filePath)).replace(/^\d+\s*-\s*/, "") ||
                   `Track ${i + 1}`;
      const uploader = frozenEntry.uploader || `${sourceLabel} Artist`;

      fe.push({
        index: Number.isFinite(idxFromName) ? idxFromName : (i + 1),
        id: selectedIds[i] || `spotify_${i + 1}`,
        title: title,
        uploader: uploader,
        webpage_url: frozenEntry.webpage_url || ""
      });
    }

  job.metadata.frozenEntries = fe;
  job.metadata.frozenTitle = playlistTitle;
}

  const frozenEntries = Array.isArray(job.metadata.frozenEntries)
    ? job.metadata.frozenEntries
    : [];
  const frozenById = new Map();
  frozenEntries.forEach(e => { if (e?.id) frozenById.set(e.id, e); });

  const selectedIdToPos = new Map();
  selectedIds.forEach((id, i) => id && selectedIdToPos.set(id, i));

  job.counters.dlTotal = mediaFiles.length;
  job.counters.dlDone  = mediaFiles.length;
  job.counters.cvTotal = mediaFiles.length;
  job.counters.cvDone  = 0;

  const sorted = mediaFiles
    .map((fp, i) => ({ fp, auto: i + 1 }))
    .sort((a, b) => a.auto - b.auto);
  const results = [];

  if (!job.playlist) {
    job.playlist = { total: sorted.length, done: 0, current: 0 };
  } else {
    job.playlist.total   = sorted.length;
    job.playlist.done    = 0;
    job.playlist.current = 0;
  }

  for (let i = 0; i < sorted.length; i++) {
    const { fp: filePath } = sorted[i];

    job.playlist.current = i;

    const fileId = parseIdFromPath(filePath);
    let feEntry = null;

    if (fileId && frozenById.has(fileId)) {
      feEntry = frozenById.get(fileId);
    }

    if (!feEntry && fileId && selectedIdToPos.has(fileId)) {
      const pos = selectedIdToPos.get(fileId);
      const pinnedId = selectedIds[pos];
      if (pinnedId && frozenById.has(pinnedId)) {
        feEntry = frozenById.get(pinnedId);
      }
    }

    if (!feEntry) {
      feEntry = frozenEntries[i] || null;
    }

    const ext = path.extname(filePath);
    const rawBase = path.basename(filePath);
    const cleaned = stripLeadingPrefix(rawBase, job.id).replace(ext, "").trim();
    const artistRaw = feEntry?.uploader || `${sourceLabel} Artist`;
    const titleRaw  =
      feEntry?.title ||
      cleaned ||
      `Track ${i + 1}`;

    const baseTitle = artistRaw
      ? `${artistRaw} - ${titleRaw}`
      : titleRaw;

    const cleanTitle = sanitizeFilename(baseTitle) || "video";

    job.lastLogKey = 'log.spotify.videoConverting';
    job.lastLogVars = {
      artist: artistRaw,
      title: titleRaw,
      current: i + 1,
      total: sorted.length
    };
    job.lastLog = `⚙️ Converting (${i + 1}/${sorted.length}): ${artistRaw} - ${titleRaw}`;

    console.log(`🎧 ${sourceLabel} cleanTitle:`, { cleanTitle, artistRaw, titleRaw });

    if (!transcodeEnabled) {
      const targetAbs = uniqueOutPath(OUTPUT_DIR, cleanTitle, ext);
      console.log(`🎬 ${sourceLabel} transcode DISABLED - direct move: ${filePath} -> ${targetAbs}`);
      safeMoveSync(filePath, targetAbs);
      await ensureOwnership(targetAbs);
      const downloadPath =
        toDownloadPath(targetAbs, OUTPUT_ROOT_DIR) ||
        `/download/${encodeURIComponent(path.basename(targetAbs))}`;

      results.push({
        outputPath: downloadPath,
        fileSize: fs.statSync(targetAbs).size
      });

      job.playlist.done   = i + 1;
      job.counters.cvDone = i + 1;
      const overallConv = ((i + 1) / sorted.length) * 100;
      job.convertProgress = Math.floor(overallConv);
      job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
      job.lastLogKey = 'log.spotify.videoConverted';
      job.lastLogVars = {
        artist: artistRaw,
        title: titleRaw,
        current: i + 1,
        total: sorted.length
      };
      job.lastLog = `✅ Converted (${i + 1}/${sorted.length}): ${artistRaw} - ${titleRaw}`;

    } else {
      const srcHeight = await probeVideoHeight(filePath);

      const meta = {
        title: cleanTitle,
        track: cleanTitle,
        artist: artistRaw,
        album: playlistTitle,
        album_artist: artistRaw,
        webpage_url: feEntry?.webpage_url || "",
        __maxHeight: TARGET_H,
        __srcHeight: srcHeight
      };

      const convJobId = `${job.id}_v${i + 1}`;

      console.log(`🎬 ${sourceLabel} ConvertMedia called:`, {
        inputPath: filePath,
        format: format,
        bitrate: job.bitrate || "auto",
        isVideo: true,
        videoSettings: videoSettings
      });

      const convResult = await convertMedia(
        filePath,
        format,
        job.bitrate || "auto",
        convJobId,
        (p, details) => {
          const overallConv = ((i + p / 100) / sorted.length) * 100;
          job.convertProgress = Math.max(
            job.convertProgress || 0,
            Math.floor(overallConv)
          );
          job.progress = Math.floor(
            (job.downloadProgress + (job.convertProgress || 0)) / 2
          );

          if (p > 0 && p < 100) {
            const elapsed = details?.elapsedText || "--:--:--";
            const duration = details?.durationText || "--:--:--";
            const fps = formatLiveFps(details?.fps);
            job.lastLogKey = 'log.spotify.videoConvertingProgress';
            job.lastLogVars = {
              artist: artistRaw,
              title: titleRaw,
              progress: Math.floor(p),
              elapsed,
              duration,
              fps,
              current: i + 1,
              total: sorted.length
            };
            job.lastLog = `⚙️ Converting (${Math.floor(p)}%) (${elapsed}/${duration} • ${fps} FPS) (${i + 1}/${sorted.length}): ${artistRaw} - ${titleRaw}`;
          }
        },
        meta,
        null,
        true,
        OUTPUT_DIR,
        TEMP_DIR,
        {
          includeLyrics: false,
          isCanceled: () => !!jobs.get(job.id)?.canceled,
          volumeGain: job.metadata?.volumeGain ?? job.videoSettings?.volumeGain ?? null,
          loudnorm: !!(job.metadata?.loudnorm ?? job.videoSettings?.loudnorm),
          loudnormMode: job.metadata?.loudnormMode || job.videoSettings?.loudnormMode || "ebu_r128",
          outputRootDir: OUTPUT_ROOT_DIR,
          videoSettings: videoSettings,
          onProcess: (child) => {
            try {
              registerJobProcess(job.id, child);
            } catch (_) {}
          }
        }
      );

      results.push(convResult);

      job.playlist.done   = i + 1;
      job.counters.cvDone = i + 1;
      job.lastLogKey = 'log.spotify.videoConverted';
      job.lastLogVars = {
        artist: artistRaw,
        title: titleRaw,
        current: i + 1,
        total: sorted.length
      };
      job.lastLog = `✅ Converted (${i + 1}/${sorted.length}): ${artistRaw} - ${titleRaw}`;
    }
  }

  job.counters.cvDone = sorted.length;
  job.resultPath = results;
  markJobCompleted(job);
  job.progress = 100;
  job.downloadProgress = 100;
  job.convertProgress = 100;
  job.currentPhase = "completed";
  job.lastLogKey = 'log.spotify.videoCompleted';
  job.lastLogVars = {
    title: playlistTitle,
    count: sorted.length
  };
  job.lastLog = `🎉 ${sourceLabel} video processing completed: ${playlistTitle} (${sorted.length} tracks)`;

  cleanupTempForJob(TEMP_DIR, job.id);
}

// Checks whether video format is valid for core application logic.
export function isVideoFormat(format) {
  const f = String(format || "").toLowerCase();
  return f === "mp4" || f === "mkv";
}

// Processes Spotify metadata video in core application logic.
export async function processSpotifyVideo(job, options = {}) {
  return processSpotifyVideoJob(job, options);
}
