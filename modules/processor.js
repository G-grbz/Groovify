import path from "path";
import fs from "fs";
import { ZipArchive } from "archiver";
import { resolveId3StrictForYouTube } from "./tags.js";
import { resolveMarket } from "./market.js";
import { jobs, registerJobProcess, killJobProcesses, markJobCompleted, getJobProcessCount } from "./store.js";
import { sanitizeFilename, toNFC, normalizeTitle, parseIdFromPath } from "./utils.js";
import { processYouTubeVideoJob, qualityToHeight } from "./video.js";
import {
  isYouTubeAutomix,
  fetchYtMetadata,
  downloadYouTubeVideo,
  isDailymotionUrl,
  buildEntriesMap,
  parsePlaylistIndexFromPath
} from "./yt.js";
import {
  normalizeYtMusicAlbumEntry,
  normalizeYtMusicAlbumMeta,
  normalizeYtMusicAlbumTitle,
  pickYtMusicAlbumArtist
} from "./ytMusicMetadata.js";
import { downloadThumbnail, convertMedia, maybeCleanTitle } from "./media.js";
import { buildId3FromYouTube } from "./tags.js";
import { probeYoutubeMusicMeta } from "./yt.js";
import { sanitizeLogValue, assertPathWithinAny, isPathInside } from "./security.js";
import { findSpotifyMetaByQuery } from "./spotify.js";
import { findAppleTrackMetaByQuery } from "./apple.js";
import { findDeezerTrackMetaByQuery } from "./deezer.js";
import { downloadPlatformMedia } from "./platform.js";
import {
  resolveJobOutputDir,
  toDownloadPath,
  resolveDownloadPathToAbs,
  pickPlaylistOutputName
} from "./outputPaths.js";
import { queueOwnershipFix } from "./fsOwnership.js";
import {
  resolveSpotifyConcurrency
} from "./concurrency.js";

const BASE_DIR = process.env.DATA_DIR || process.cwd();
const OUTPUT_DIR = path.resolve(BASE_DIR, "outputs");
const TEMP_DIR = path.resolve(BASE_DIR, "temp");
const UPLOAD_DIR = path.resolve(BASE_DIR, "uploads");
const LOCAL_INPUT_DIR = path.resolve(BASE_DIR, process.env.LOCAL_INPUT_DIR || "local-inputs");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

// Checks whether the source is a mapped music provider in core application logic.
function isMappedMusicSource(source = "") {
  const value = String(source || "").toLowerCase();
  return value === "spotify" || value === "apple_music" || value === "deezer" || value === "tidal" || value === "soundcloud";
}

// Builds the display label for mapped music providers in core application logic.
function mappedMusicLabel(source = "") {
  const value = String(source || "").toLowerCase();
  if (value === "apple_music") return "Apple Music";
  if (value === "deezer") return "Deezer";
  if (value === "tidal") return "TIDAL";
  if (value === "soundcloud") return "SoundCloud";
  return "Spotify";
}

// Builds playlist fallback titles for mapped music providers in core application logic.
function mappedMusicPlaylistTitle(source = "", title = "") {
  const value = String(source || "").toLowerCase();
  const fallback = value === "apple_music"
    ? "Apple Music Playlist"
    : value === "deezer"
    ? "Deezer Playlist"
    : value === "tidal"
    ? "TIDAL Playlist"
    : value === "soundcloud"
    ? "SoundCloud Playlist"
    : "Spotify Playlist";
  return toNFC(title || fallback);
}

// Converts absolute output path to public download path with safe fallback.
function toDownloadPathSafe(absPath) {
  return (
    toDownloadPath(absPath, OUTPUT_DIR) ||
    `/download/${encodeURIComponent(path.basename(absPath || ""))}`
  );
}

// Handles clamp int in core application logic.
function clampInt(v, min, max) {
  v = Math.round(v || 0);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

// Handles clean title like in core application logic.
function cleanTitleLike(s) {
  if (!s) return s;
  let out = String(s);
  out = maybeCleanTitle(out);
  out = cleanNameDynamic(out);
  return out;
}

// Handles apply global meta cleaning in core application logic.
function applyGlobalMetaCleaning(meta) {
  if (!meta) return meta;
  const m = { ...meta };

  if (m.title) m.title = cleanTitleLike(m.title);
  if (m.track) m.track = cleanTitleLike(m.track);
  if (m.playlist_title) m.playlist_title = cleanTitleLike(m.playlist_title);
  if (m.artist) m.artist = cleanNameDynamic(m.artist);
  if (m.album_artist) m.album_artist = cleanNameDynamic(m.album_artist);
  if (m.uploader) m.uploader = cleanNameDynamic(m.uploader);
  return m;
}

// Handles bump in core application logic.
function bump(obj, key, inc = 1) {
  obj[key] = (obj[key] || 0) + inc;
}

// Tracks aggregate conversion progress for concurrently processed playlist items.
// Playlist item indexes are not completion order, so deriving progress from an
// item's stable index can jump forward when a later track finishes first.
function updateParallelConversionProgress(job, progressByIndex, index, itemProgress, totalItems) {
  const total = Math.max(1, Number(totalItems) || 1);
  const idx = Math.max(0, Number(index) || 0);
  const pct = Math.max(0, Math.min(100, Number(itemProgress) || 0));

  progressByIndex.set(idx, pct);

  let sum = 0;
  for (const value of progressByIndex.values()) {
    sum += Math.max(0, Math.min(100, Number(value) || 0));
  }

  job.convertProgress = Math.max(0, Math.min(100, Math.floor(sum / total)));
  job.progress = Math.floor(
    (Math.max(0, Math.min(100, Number(job.downloadProgress) || 0)) + job.convertProgress) / 2
  );
}

// Handles clean name dynamic in core application logic.
function cleanNameDynamic(name) {
  if (!name) return "";
  let s = String(name).trim().replace(/\s+/g, " ");

  const suffixes = (process.env.CLEAN_SUFFIXES || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);

  const phrases = (process.env.CLEAN_PHRASES || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);

  const parens = (process.env.CLEAN_PARENS || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);

  if (suffixes.length) {
    const sufRegex = new RegExp(`\\s*-\\s*(${suffixes.join("|")})\\s*$`, "i");
    s = s.replace(sufRegex, "");
  }

  if (suffixes.length) {
    const sufEndRegex = new RegExp(`\\s+(${suffixes.join("|")})\\s*$`, "i");
    s = s.replace(sufEndRegex, "");
  }

  if (phrases.length) {
    const phrRegex = new RegExp(
      `\\s*-?\\s*(${phrases.map(x => x.replace(/\s+/g, "\\s+")).join("|")})\\s*$`,
      "i"
    );
    s = s.replace(phrRegex, "");
  }

  if (parens.length) {
    const parRegex = new RegExp(
      `\\s*\\((${parens.join("|")})\\)\\s*$`,
      "i"
    );
    s = s.replace(parRegex, "");
  }
  return s.trim();
}

// Handles refine you tube standalone title in core application logic.
function refineYouTubeStandaloneTitle(rawTitle = "") {
  let s = String(rawTitle || "").trim();
  if (!s) return "";

  s = s.replace(/\s*[|｜]\s*/g, " • ");
  s = s.replace(/\s+/g, " ").trim();

  s = s.replace(
    /\s*[–—-]\s*(cover|official\s*video|official\s*audio|audio|mv|hd|4k|lyrics?|lyric|visualizer|remaster(?:ed)?)\b.*$/i,
    ""
  ).trim();

  const lParts = s
    .split(/\s+\bl\b\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);

  if (lParts.length >= 3) {
    const head = lParts[0];
    const tailMatch = s.match(/[–—-]\s*([^–—-]+)$/);
    const tail = tailMatch ? tailMatch[1].trim() : "";

    if (head && tail) {
      s = `${head} - ${tail}`;
    } else if (head) {
      s = head;
    }
  }

  s = s.replace(/\s*(?:[-–—•]\s*)+$/, "").trim();
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

// Derives title from URL slug for output naming in core application logic.
function deriveTitleFromUrl(inputUrl = "") {
  try {
    const u = new URL(String(inputUrl || ""));
    const rawParts = u.pathname
      .split("/")
      .map((p) => decodeURIComponent(p || "").trim())
      .filter(Boolean);

    if (!rawParts.length) return "";

    const stop = new Set([
      "watch",
      "video",
      "videos",
      "reel",
      "reels",
      "shorts",
      "p",
      "tv",
      "status"
    ]);

    const candidates = rawParts
      .filter((p) => {
        const low = p.toLowerCase();
        if (stop.has(low)) return false;
        if (/^\d+$/.test(p)) return false;
        if (!/[A-Za-z]/.test(p) && !/[^\u0000-\u007F]/.test(p)) return false;
        return p.length >= 3;
      })
      .map((p) =>
        p
          .replace(/[-_]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter(Boolean);

    if (!candidates.length) return "";
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0];
  } catch {
    return "";
  }
}

// Checks whether likely platform shortcode is valid for output naming in core application logic.
function looksLikePlatformShortCode(name = "") {
  const s = String(name || "").trim();
  if (!s) return false;
  if (s.length < 8 || s.length > 32) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return false;
  const compact = s.replace(/[-_]/g, "");
  if (compact.length < 8) return false;
  return /[A-Z]/.test(s) && /[a-z]/.test(s);
}

// Extracts instagram handle from URL for output naming in core application logic.
function deriveInstagramHandleFromUrl(inputUrl = "") {
  try {
    const u = new URL(String(inputUrl || ""));
    if (!/(\.|^)instagram\.com$/i.test(u.hostname)) return "";
    const parts = u.pathname
      .split("/")
      .map((p) => decodeURIComponent(p || "").trim())
      .filter(Boolean);
    if (!parts.length) return "";

    const reserved = new Set([
      "reel",
      "reels",
      "p",
      "tv",
      "stories",
      "explore",
      "accounts",
      "direct"
    ]);
    const first = String(parts[0] || "");
    if (!first || reserved.has(first.toLowerCase())) return "";
    if (!/^[A-Za-z0-9._]{1,30}$/.test(first)) return "";
    return `@${first}`;
  } catch {
    return "";
  }
}

// Checks whether generic naming token is valid for output naming in core application logic.
function isGenericNamingToken(name = "") {
  const s = String(name || "").trim().toLowerCase();
  if (!s) return true;
  return (
    s === "vimeo" ||
    s === "dailymotion" ||
    s === "twitter" ||
    s === "x" ||
    s === "facebook" ||
    s === "instagram" ||
    s === "reel" ||
    s === "video"
  );
}

// Handles merge meta in core application logic.
function mergeMeta(base, extra) {
  if (!extra) return base;
  for (const [k, v] of Object.entries(extra)) {
    if (v == null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (base[k] == null || base[k] === "") base[k] = v;
  }
  return base;
}

function normalizeYouTubeAlbumTitleForJob(title = "", job = null, parentMeta = {}) {
  return normalizeYtMusicAlbumTitle(title, {
    meta: {
      ...(parentMeta || {}),
      title,
      playlist_title: parentMeta?.playlist_title || title,
      url: job?.metadata?.url || "",
      webpage_url: job?.metadata?.url || ""
    },
    sourceUrl: job?.metadata?.url || ""
  });
}

// Enriches generic metadata from Apple Music with Deezer fallback in core application logic.
async function enrichMetaFromApple(base, {
  artist = "",
  title = "",
  market = "",
  preferCover = false,
  preferTrackNumber = false,
  preferTrackTotal = false,
  preferDiscNumber = false,
  preferDiscTotal = false
} = {}) {
  if (process.env.APPLE_TAG_FALLBACK === "0") return base;

  const artistSafe = String(base?.artist || base?.album_artist || artist || "").trim();
  const titleSafe = String(base?.track || base?.title || title || "").trim();
  if (!titleSafe) return base;

  try {
    const appleMeta = await findAppleTrackMetaByQuery(artistSafe, titleSafe, {
      album: base?.album || "",
      market,
      targetDurationMs: Number(base?.duration_ms || 0) || null
    });
    let fallbackMeta = appleMeta;
    if (!fallbackMeta) {
      try {
        fallbackMeta = await findDeezerTrackMetaByQuery(artistSafe, titleSafe, {
          album: base?.album || "",
          targetDurationMs: Number(base?.duration_ms || 0) || null
        });
      } catch {}
    }

    const merged = mergeMeta(base, fallbackMeta);
    if (preferTrackNumber && Number(fallbackMeta?.track_number) > 0) {
      merged.track_number = Number(fallbackMeta.track_number);
    }
    if (preferTrackTotal && Number(fallbackMeta?.track_total) > 0) {
      merged.track_total = Number(fallbackMeta.track_total);
    }
    if (preferDiscNumber && Number(fallbackMeta?.disc_number) > 0) {
      merged.disc_number = Number(fallbackMeta.disc_number);
    }
    if (preferDiscTotal && Number(fallbackMeta?.disc_total) > 0) {
      merged.disc_total = Number(fallbackMeta.disc_total);
    }
    const preferredAppleCoverUrl = String(
      fallbackMeta?.coverUrl || fallbackMeta?.imageUrl || fallbackMeta?.thumbnailUrl || ""
    ).trim();
    if (preferCover && preferredAppleCoverUrl) {
      merged.__applePreferredCoverUrl = preferredAppleCoverUrl;
    }
    return merged;
  } catch {
    return base;
  }
}

// Resolves the preferred cover art path from provider and fallback sources in core application logic.
async function resolvePreferredCoverPath(meta, {
  baseNoExt = "",
  fallbackSidecarPath = null,
  fallbackCoverPath = null
} = {}) {
  const appleCoverUrl = String(meta?.__applePreferredCoverUrl || "").trim();
  if (appleCoverUrl && baseNoExt) {
    try {
      const dl = await downloadThumbnail(
        appleCoverUrl,
        `${baseNoExt}.apple_cover`
      );
      if (dl && fs.existsSync(dl)) return dl;
    } catch {}
  }

  if (fallbackSidecarPath && fs.existsSync(fallbackSidecarPath)) {
    return fallbackSidecarPath;
  }

  if (fallbackCoverPath && fs.existsSync(fallbackCoverPath)) {
    return fallbackCoverPath;
  }

  const metaCoverUrl = String(meta?.coverUrl || "").trim();
  if (metaCoverUrl && metaCoverUrl !== appleCoverUrl && baseNoExt) {
    try {
      const dl = await downloadThumbnail(
        metaCoverUrl,
        `${baseNoExt}.cover`
      );
      if (dl && fs.existsSync(dl)) return dl;
    } catch {}
  }

  return null;
}

// Checks whether video format is valid for core application logic.
function isVideoFormat(fmt) {
  const f = String(fmt || "").toLowerCase();
  return f === "mp4" || f === "mkv";
}

// Builds unique output path for core application logic.
function buildUniqueOutputPath(dir, fileName) {
  let target = path.join(dir, fileName);
  if (!fs.existsSync(target)) return target;

  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let i = 1;
  while (fs.existsSync(target) && i < 1000) {
    target = path.join(dir, `${stem} (${i++})${ext}`);
  }
  return target;
}

function sanitizePlaylistFolderName(value, fallback = "playlist") {
  const src = String(value || "").trim();
  const cleaned = src
    .replace(/[<>:"|?*\\/]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^[-_.\s]+|[-_.\s]+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}

async function maybeRenamePlaylistOutputDir(job, currentDir, outputRootDir = OUTPUT_DIR) {
  if (!job?.metadata?.isPlaylist || !currentDir) return currentDir;

  const root = path.resolve(outputRootDir || OUTPUT_DIR);
  const currentAbs = path.resolve(currentDir);
  if (currentAbs !== root && !currentAbs.startsWith(root + path.sep)) return currentDir;
  if (!fs.existsSync(currentAbs)) return currentDir;

  try {
    if (fs.readdirSync(currentAbs).length > 0) return currentDir;
  } catch {
    return currentDir;
  }

  const desiredName = sanitizePlaylistFolderName(pickPlaylistOutputName(job), "");
  if (!desiredName) return currentDir;

  const currentRelFs = path.relative(root, currentAbs);
  const currentRel = currentRelFs.replace(/\\/g, "/");
  const parentRel = path.posix.dirname(currentRel);
  const safeParentRel = parentRel && parentRel !== "." ? parentRel : "";
  const currentBase = path.basename(currentAbs);
  if (sanitizePlaylistFolderName(currentBase, "") === desiredName) return currentDir;

  let candidateRel = safeParentRel
    ? path.posix.join(safeParentRel, desiredName)
    : desiredName;
  let candidateAbs = path.resolve(root, candidateRel);
  let index = 2;

  while (
    fs.existsSync(candidateAbs) &&
    path.resolve(candidateAbs) !== currentAbs &&
    index < 1000
  ) {
    const uniqueName = sanitizePlaylistFolderName(`${desiredName} (${index})`, `${desiredName}_${index}`);
    candidateRel = safeParentRel
      ? path.posix.join(safeParentRel, uniqueName)
      : uniqueName;
    candidateAbs = path.resolve(root, candidateRel);
    index += 1;
  }

  if (candidateAbs !== root && !candidateAbs.startsWith(root + path.sep)) return currentDir;
  if (path.resolve(candidateAbs) === currentAbs) return currentDir;

  try {
    fs.renameSync(currentAbs, candidateAbs);
    job.metadata.outputSubdir = candidateRel;
    await queueOwnershipFix(candidateAbs, { recursive: true });
    return candidateAbs;
  } catch (error) {
    console.warn("Playlist output directory rename warning:", error?.message || error);
    return currentDir;
  }
}

// Handles safe move file sync in core application logic.
function safeMoveFileSync(src, dest) {
  const safeSrc = assertPathWithinAny(path.resolve(String(src || "")), [TEMP_DIR, OUTPUT_DIR, UPLOAD_DIR, LOCAL_INPUT_DIR]);
  const safeDest = assertPathWithinAny(path.resolve(String(dest || "")), [TEMP_DIR, OUTPUT_DIR, LOCAL_INPUT_DIR]);
  try {
    fs.renameSync(safeSrc, safeDest);
    return;
  } catch (e) {
    if (!e || e.code !== "EXDEV") throw e;
  }

  try {
    const flags = fs.constants?.COPYFILE_FICLONE || 0;
    fs.copyFileSync(safeSrc, safeDest, flags);
  } catch {
    fs.copyFileSync(safeSrc, safeDest);
  }

  try {
    const srcSize = fs.statSync(safeSrc).size;
    const destSize = fs.statSync(safeDest).size;
    if (srcSize !== destSize) throw new Error("copy size mismatch");
  } catch (verifyErr) {
    try {
      fs.rmSync(safeDest, { force: true });
    } catch {}
    throw verifyErr;
  }

  try {
    fs.rmSync(safeSrc, { force: true });
  } catch {}
}

// Creates limiter for core application logic.
function createLimiter(max) {
  let active = 0;
  const queue = [];

  const run = (fn) =>
    new Promise((resolve, reject) => {
      const task = () => {
        active++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            if (queue.length > 0) {
              const next = queue.shift();
              next();
            }
          });
      };

      if (active < max) {
        task();
      } else {
        queue.push(task);
      }
    });

  return run;
}

function scheduleTempCleanupAfterJobProcesses(jobId, originalInputPath, downloadedPath = null) {
  let attemptsLeft = 15;
  let finalized = false;
  const tick = () => {
    const activeCount = Number(getJobProcessCount(jobId) || 0) || 0;
    attemptsLeft -= 1;
    if (activeCount <= 0) {
      try { cleanupTempFiles(jobId, originalInputPath, downloadedPath); } catch {}
      if (!finalized) {
        finalized = true;
        const finalTimer = setTimeout(() => {
          try { cleanupTempFiles(jobId, originalInputPath, downloadedPath); } catch {}
        }, 350);
        finalTimer.unref?.();
      }
      return;
    }
    if (attemptsLeft <= 0) return;

    const timer = setTimeout(tick, 1000);
    timer.unref?.();
  };

  const timer = setTimeout(tick, 0);
  timer.unref?.();
}

// Processes job state in core application logic.
export async function processJob(jobId, inputPath, format, bitrate) {
  try {
    killJobProcesses(jobId);
  } catch {}

  const job = jobs.get(jobId);
  if (!job) return;

  console.log("🧊 job.metadata.frozenEntries snapshot:",
    Array.isArray(job.metadata?.frozenEntries)
      ? { len: job.metadata.frozenEntries.length,
          sample: job.metadata.frozenEntries.slice(0, 3) }
      : job.metadata?.frozenEntries
  );

  const selectedStreams = job.metadata?.selectedStreams || {};

  const effectiveVolumeGain =
    job.metadata?.volumeGain != null
      ? job.metadata.volumeGain
      : job.videoSettings?.volumeGain != null
      ? job.videoSettings.volumeGain
      : null;
  const effectiveLoudnorm =
    job.metadata?.loudnorm === true ||
    job.metadata?.loudnorm === "true" ||
    job.videoSettings?.loudnorm === true ||
    job.videoSettings?.loudnorm === "true";
  const effectiveLoudnormMode =
    String(
      job.metadata?.loudnormMode ||
      job.videoSettings?.loudnormMode ||
      "ebu_r128"
    )
      .trim()
      .toLowerCase();

  job.canceled = false;

  let skippedCount = 0;
  let errorsCount = 0;
  let lyricsFound = 0;
  let lyricsMiss = 0;

  // Updates lyrics metadata stats live for core application logic.
  const updateLyricsStatsLive = (doneCount = 0, totalCount = null) => {
    if (!job?.metadata?.includeLyrics) return;

    const usedDone = Math.max(0, Number(doneCount || 0));
    let foundSafe = Number(lyricsFound || 0);
    if (Number.isFinite(totalCount) && totalCount != null) {
      foundSafe = Math.min(foundSafe, Number(totalCount));
    }

    const notFoundLive = Math.max(0, usedDone - foundSafe);
    const prev = job.metadata.lyricsStats || { found: 0, notFound: 0 };
    const target = { found: foundSafe, notFound: notFoundLive };

    if (Number.isFinite(totalCount) && totalCount != null) {
      target.notFound = Math.max(
        notFoundLive,
        Math.max(0, Number(totalCount) - foundSafe)
      );
    }

    if (prev.found !== target.found || prev.notFound !== target.notFound) {
      job.metadata.lyricsStats = target;
    }
  };

  // Handles handle skip update in core application logic.
  const handleSkipUpdate = (stats) => {
    skippedCount = stats.skippedCount || 0;
    errorsCount = stats.errorsCount || 0;
    job.skippedCount = skippedCount;
    job.errorsCount = errorsCount;
    job.metadata = job.metadata || {};
    job.metadata.skipStats = { skippedCount, errorsCount };
  };

  // Handles handle lyrics metadata log in core application logic.
  const handleLyricsLog = (payload) => {
    if (!payload) return;
    const text =
      typeof payload === "string"
        ? payload
        : payload?.fallback
        ? String(payload.fallback)
        : payload?.message
        ? String(payload.message)
        : "";
    if (!text) return;
    job.lastLog = text;
    job.lastLogKey = null;
    job.lastLogVars = null;
  };
  // Builds live conversion log with elapsed/duration and real fps.
  const buildLiveVideoConvertLog = (progress, details = {}, label = "") => {
    const pct = Math.max(0, Math.min(100, Math.floor(Number(progress) || 0)));
    const elapsed = details?.elapsedText || "--:--:--";
    const duration = details?.durationText || "--:--:--";
    const fpsNum = Number(details?.fps);
    const fpsText =
      Number.isFinite(fpsNum) && fpsNum > 0
        ? fpsNum.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")
        : "--";
    const suffix = label ? `: ${label}` : "";
    return `⚙️ Dönüştürülüyor ${pct}% (${elapsed}/${duration} • ${fpsText} FPS)${suffix}`;
  };
  // Handles handle lyrics metadata stats in core application logic.
  const handleLyricsStats = (delta) => {
    if (!delta) return;
    lyricsFound += Number(delta.found || 0);
    lyricsMiss += Number(delta.notFound || 0);
    job.metadata = job.metadata || {};
    const doneNow = (job.playlist && Number(job.playlist.done)) || 0;
    updateLyricsStatsLive(doneNow);
  };

  const sampleRate = job.sampleRate || 48000;

  try {
    job.status = "processing";
    job.progress = 0;
    job.downloadProgress = 0;
    job.convertProgress = 0;
    job.currentPhase = "preparing";
    job.metadata = job.metadata || {};
    job.counters = job.counters || {
      dlTotal: 0,
      dlDone: 0,
      cvTotal: 0,
      cvDone: 0
    };
    let outputDir = resolveJobOutputDir(job, OUTPUT_DIR);
    const isVideoFormatFlag = isVideoFormat(format);

    if (isVideoFormatFlag && job.metadata?.source === "youtube") {
      await processYouTubeVideoJob(job, { OUTPUT_DIR: outputDir, OUTPUT_ROOT_DIR: OUTPUT_DIR, TEMP_DIR });

      try {
        if (
          Array.isArray(job.resultPath) &&
          job.resultPath.length > 1 &&
          !job.clientBatch &&
          format !== "mp4"
        ) {
          const titleHint =
            job.metadata?.frozenTitle ||
            job.metadata?.extracted?.title ||
            job.metadata?.extracted?.playlist_title ||
            (job.metadata?.isAutomix ? "YouTube Automix" : "Playlist");
          job.zipPath = await makeZipFromOutputs(
            jobId,
            job.resultPath,
            titleHint || "playlist",
            job.metadata?.includeLyrics,
            outputDir
          );
        }
      } catch {}

      cleanupTempFiles(jobId, inputPath, null);
      return;
    }

    let actualInputPath = inputPath;
    let coverPath = null;

    if (isMappedMusicSource(job.metadata.source)) {
      const sourceLabel = mappedMusicLabel(job.metadata.source);
      job.currentPhase = "downloading";
      job.downloadProgress = 5;
      job.metadata.extracted = job.metadata.extracted || {
        title: mappedMusicPlaylistTitle(job.metadata.source, job.metadata.spotifyTitle),
        uploader: sourceLabel,
        playlist_title: mappedMusicPlaylistTitle(job.metadata.source, job.metadata.spotifyTitle)
      };

      const selectedIds = Array.isArray(job.metadata.selectedIds)
        ? job.metadata.selectedIds
        : [];
      if (!selectedIds.length) {
        throw new Error(`${sourceLabel} URL list is empty`);
      }

      job.counters = job.counters || {};
      job.counters.dlTotal = Number(selectedIds.length);
      job.counters.cvTotal = Number(selectedIds.length);
      job.counters.dlDone = job.counters.dlDone || 0;
      job.counters.cvDone = job.counters.cvDone || 0;

      const frozen = Array.isArray(job.metadata.frozenEntries)
        ? job.metadata.frozenEntries
        : [];
      const byId = new Map();
      for (const e of frozen) if (e?.id) byId.set(e.id, e);

      const spotifyConcurrency = resolveSpotifyConcurrency(job.metadata?.spotifyConcurrency);
      const spotifyLimiter = createLimiter(spotifyConcurrency);
      const selectedIdToPos = new Map();
      selectedIds.forEach((id, index) => {
        if (id) selectedIdToPos.set(String(id), index);
      });

      const results = new Array(selectedIds.length);
      job.playlist = { total: selectedIds.length, done: 0 };
      job.counters.cvTotal = selectedIds.length;
      const convertPromisesSpotify = [];
      const scheduledMappedFiles = new Set();
      const mappedConvertProgressByIndex = new Map();

      const resolveMappedStableIndex = (filePath, playlistIndex = null, fileId = null, fallbackIndex = null) => {
        const id = fileId || parseIdFromPath(filePath);
        if (id && selectedIdToPos.has(String(id))) {
          return selectedIdToPos.get(String(id));
        }
        if (Number.isFinite(Number(playlistIndex)) && Number(playlistIndex) > 0) {
          return Number(playlistIndex) - 1;
        }
        const parsedIndex = parsePlaylistIndexFromPath(filePath);
        if (Number.isFinite(parsedIndex) && parsedIndex > 0) {
          return parsedIndex - 1;
        }
        if (Number.isFinite(Number(fallbackIndex)) && Number(fallbackIndex) >= 0) {
          return Number(fallbackIndex);
        }
        return Math.max(0, scheduledMappedFiles.size - 1);
      };

      const enqueueMappedMusicConversion = (filePath, playlistIndex = null, fileId = null, fallbackIndex = null) => {
        if (!filePath) return null;
        const fileKey = path.resolve(filePath);
        if (scheduledMappedFiles.has(fileKey)) return null;
        scheduledMappedFiles.add(fileKey);

        const i = Math.max(0, resolveMappedStableIndex(filePath, playlistIndex, fileId, fallbackIndex));
        const totalForConvert = Math.max(1, job.playlist?.total || selectedIds.length || 1);

        const promise = spotifyLimiter(async () => {
          const pinnedId = selectedIds[i];
          const entry = (pinnedId ? byId.get(pinnedId) : null) || {};
          const fallbackTitle = path
            .basename(filePath, path.extname(filePath))
            .replace(/^\d+\s*-\s*/, "");
          const title = toNFC(entry.title || fallbackTitle);
          let fileMeta = {
            title,
            track: title,
            uploader: entry.uploader || "",
            artist: entry.artist || entry.uploader || "",
            album: entry.album || "",
            album_artist:
              entry.album_artist || entry.artist || entry.uploader || "",
            playlist_title: mappedMusicPlaylistTitle(job.metadata.source, job.metadata.spotifyTitle),
            webpage_url: entry.webpage_url || "",
            release_year: entry.year || "",
            release_date: entry.date || "",
            track_number: entry.track_number,
            disc_number: entry.disc_number,
            track_total: entry.track_total,
            disc_total: entry.disc_total,
            isrc: entry.isrc,
            genre: entry.genre || "",
            label: entry.label || null,
            publisher: entry.label || null,
            copyright: entry.copyright || ""
          };

          fileMeta = applyGlobalMetaCleaning(fileMeta);
          fileMeta = await enrichMetaFromApple(fileMeta, {
            artist: fileMeta.artist || fileMeta.uploader,
            title: fileMeta.track || fileMeta.title,
            market: job?.metadata?.market
          });

          let itemCover = null;
          const baseNoExt = filePath.replace(/\.[^.]+$/, "");
          const sidecarJpg = `${baseNoExt}.jpg`;
          if (fs.existsSync(sidecarJpg)) itemCover = sidecarJpg;
          else if (fileMeta?.coverUrl) {
            try {
              const dl = await downloadThumbnail(
                fileMeta.coverUrl,
                `${baseNoExt}.cover`
              );
              if (dl) itemCover = dl;
            } catch {}
          }

          if (job.currentPhase !== "converting") {
            job.currentPhase = "converting";
            job.convertProgress = job.convertProgress || 0;
          }

          const existingOut = findExistingOutput(
            `${jobId}_${i}`,
            format,
            outputDir
          );
          let r;
          if (existingOut) {
            r = {
              outputPath: toDownloadPathSafe(existingOut)
            };
            updateParallelConversionProgress(
              job,
              mappedConvertProgressByIndex,
              i,
              100,
              totalForConvert
            );
          } else {
            r = await convertMedia(
              filePath,
              format,
              bitrate,
              `${jobId}_${i}`,
              (progress, details) => {
                updateParallelConversionProgress(
                  job,
                  mappedConvertProgressByIndex,
                  i,
                  progress,
                  totalForConvert
                );

                if (job.playlist) {
                  job.playlist.current = i;
                }

                if (isVideoFormat(format)) {
                  const label = [entry?.uploader || entry?.artist || "", title]
                    .map((s) => String(s || "").trim())
                    .filter(Boolean)
                    .join(" - ");
                  job.lastLog = buildLiveVideoConvertLog(progress, details, label);
                  job.lastLogKey = null;
                  job.lastLogVars = null;
                }
              },
              fileMeta,
              itemCover,
              isVideoFormat(format),
              outputDir,
              TEMP_DIR,
              {
                outputRootDir: OUTPUT_DIR,
                onProcess: (child) => {
                  try {
                    registerJobProcess(jobId, child);
                  } catch {}
                },
                includeLyrics: job.metadata.includeLyrics,
                embedLyrics: !!job.metadata.embedLyrics,
                sampleRate: sampleRate,
                bitDepth: job.bitDepth || null,
                compressionLevel: job.metadata?.compressionLevel ?? null,
                isCanceled: () => !!jobs.get(jobId)?.canceled,
                onLog: handleLyricsLog,
                volumeGain: effectiveVolumeGain,
                loudnorm: effectiveLoudnorm,
                loudnormMode: effectiveLoudnormMode,
                onLyricsStats: handleLyricsStats,
                ringtone: job.metadata?.ringtone || null,
                stereoConvert: job.metadata?.stereoConvert || "auto",
                atempoAdjust: job.metadata?.atempoAdjust || "none",
                selectedStreams: job.metadata.selectedStreams,
                videoSettings: job.videoSettings || {}
              }
            );
          }

          const hasLrc = !!r?.lyricsPath;
          if (Array.isArray(job.metadata.frozenEntries)) {
            const fe = job.metadata.frozenEntries.find((x) =>
              x?.id === pinnedId || Number(x?.index) === i + 1
            );
            if (fe) fe.hasLyrics = hasLrc;
          }

          results[i] = r;
          updateParallelConversionProgress(
            job,
            mappedConvertProgressByIndex,
            i,
            100,
            totalForConvert
          );
          bump(job.counters, "cvDone", 1);
          if (job.playlist) job.playlist.done = job.counters.cvDone;
          updateLyricsStatsLive(job.playlist.done);

          return r;
        }).catch((error) => {
          console.error("[processor] mapped music conversion pipeline error:", error);
        });

        convertPromisesSpotify.push(promise);
        return promise;
      };

      const files = await downloadYouTubeVideo(
        job.metadata.spotifyTitle || sourceLabel,
        jobId,
        true,
        null,
        false,
        selectedIds,
        TEMP_DIR,
        (progress) => {
          if (
            progress &&
            typeof progress === "object" &&
            progress.__event &&
            progress.type === "file-done"
          ) {
            const t = Number(
              progress.total ||
                job.counters?.dlTotal ||
                selectedIds.length ||
                0
            );
            job.counters.dlTotal = t;
            job.counters.dlDone = Math.min(
              t,
              Number(progress.downloaded || 0)
            );
            job.downloadProgress = Math.floor(
              (job.counters.dlDone / Math.max(1, t)) * 100
            );
          } else {
            job.downloadProgress = 20 + Number(progress || 0) * 0.8;
            const t = Number(
              job.counters?.dlTotal || selectedIds.length || 0
            );
            if (t > 0) {
              const approx = clampInt(
                ((Number(progress || 0) / 100) * t) | 0,
                0,
                t
              );
              if ((job.counters.dlDone || 0) < approx)
                job.counters.dlDone = approx;
            }
          }
          job.progress = Math.floor(
            (job.downloadProgress + job.convertProgress) / 2
          );
        },
        {
          video: isVideoFormat(format),
          onSkipUpdate: handleSkipUpdate,
          youtubeConcurrency: spotifyConcurrency,
          sourceUrl: job.metadata?.url || job.metadata?.spotifyUrl || "",
          frozenEntries: frozen,
          maxHeight: isVideoFormat(format)
            ? qualityToHeight(bitrate)
            : undefined
        },
        { isCanceled: () => !!job.canceled }
      );

      job.counters.dlDone = job.counters.dlTotal;
      job.downloadProgress = 100;
      job.currentPhase = "converting";
      job.convertProgress = job.convertProgress || 0;

      if (!Array.isArray(files) || !files.length) {
        throw new Error(`${sourceLabel} download completed but no files were found`);
      }

      files.forEach((filePath, fallbackIndex) => {
        enqueueMappedMusicConversion(filePath, null, null, fallbackIndex);
      });

      await Promise.all(convertPromisesSpotify);

      const finalResults = results.filter((r) => r);

      if (finalResults.length === 1) {
        job.resultPath = finalResults[0]?.outputPath || null;
      } else {
        job.resultPath = finalResults;
        if (!job.clientBatch && job.metadata?.autoCreateZip !== false) {
          try {
            const zipTitle =
              mappedMusicPlaylistTitle(job.metadata.source, job.metadata.spotifyTitle);
            job.zipPath = await makeZipFromOutputs(
              jobId,
              finalResults,
              zipTitle,
              job.metadata.includeLyrics,
              outputDir
            );
          } catch (e) {}
        }
      }

      if (job.metadata?.includeLyrics) {
        updateLyricsStatsLive(
          job.playlist?.done || finalResults.length,
          job.playlist?.total || finalResults.length
        );
      }

      markJobCompleted(job);
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
        ytMeta = {
          title: "YouTube Automix",
          uploader: "YouTube",
          playlist_title: "Automix"
        };
      } else {
        ytMeta = await fetchYtMetadata(
          job.metadata.url,
          job.metadata.isPlaylist
        );
      }

      const ytMetaEntries = Array.isArray(ytMeta?.entries) ? ytMeta.entries : [];
      const ytAlbumArtistHint = pickYtMusicAlbumArtist(
        ytMeta || {},
        ...ytMetaEntries.slice(0, 12)
      );

      let flat = {
      title: toNFC(ytMeta?.title || ""),
      raw_title: toNFC(ytMeta?.title || ""),
      uploader: toNFC(ytMeta?.uploader || ytMeta?.channel || ""),
      artist: toNFC(
        ytMeta?.artist ||
          ytMeta?.creator ||
          ytMeta?.uploader ||
          ytMeta?.channel ||
          ""
      ),
      track: ytMeta?.track || "",
      album: toNFC(ytMeta?.album || ""),
      release_year:
        (ytMeta?.release_year && String(ytMeta.release_year)) ||
        (ytMeta?.release_date &&
          String(ytMeta.release_date).slice(0, 4)) ||
        "",
      release_date: ytMeta?.release_date || "",
      upload_year: ytMeta?.upload_date ? String(ytMeta.upload_date).slice(0, 4) : "",
      upload_date: ytMeta?.upload_date || "",
      track_number: Number(ytMeta?.track_number) || null,
      disc_number: Number(ytMeta?.disc_number) || null,
      track_total: Number(ytMeta?.track_total) || null,
      disc_total: Number(ytMeta?.disc_total) || null,
      genre:
        ytMeta?.genre ||
        (Array.isArray(ytMeta?.categories) ? ytMeta.categories[0] : "") ||
        "",
      copyright:
        ytMeta?.copyright ||
        ytMeta?.license ||
        ytMeta?.license_name ||
        "",
      webpage_url: ytMeta?.webpage_url || job.metadata.url,
      thumbnail:
        (ytMeta?.thumbnails && ytMeta.thumbnails.length
          ? ytMeta.thumbnails[ytMeta.thumbnails.length - 1].url
          : ytMeta?.thumbnail) || "",
      playlist_title: toNFC(ytMeta?.playlist_title || "")
    };
      flat = normalizeYtMusicAlbumMeta(flat, {
        parentMeta: ytMeta || {},
        sourceUrl: job.metadata.url,
        playlistTitle: ytMeta?.title || ytMeta?.playlist_title || job.metadata?.frozenTitle || "",
        albumArtist: ytAlbumArtistHint
      });
      flat = applyGlobalMetaCleaning(flat);
      job.metadata.extracted = flat;

      try {
        const id3Guess = buildId3FromYouTube({
          title: flat.title,
          uploader: flat.uploader,
          thumbnail: flat.thumbnail,
          webpage_url: flat.webpage_url,
          album: flat.album,
          release_year: flat.release_year,
          release_date: flat.release_date,
          upload_year: flat.upload_year,
          upload_date: flat.upload_date,
          track_number: flat.track_number,
          disc_number: flat.disc_number,
          track_total: flat.track_total,
          disc_total: flat.disc_total,
          genre: flat.genre,
          copyright: flat.copyright
        });
        if (id3Guess) {
          flat.artist = id3Guess.artist || flat.artist || "";
          flat.title = id3Guess.title || flat.title || "";
          flat.track = id3Guess.track || flat.title || "";
        }
      } catch {}
      flat = normalizeYtMusicAlbumMeta(flat, {
        parentMeta: ytMeta || {},
        sourceUrl: job.metadata.url,
        playlistTitle: ytMeta?.title || ytMeta?.playlist_title || job.metadata?.frozenTitle || "",
        albumArtist: ytAlbumArtistHint
      });
      if (flat.album_artist || flat.artist) {
        job.metadata.albumArtist = flat.album_artist || flat.artist;
        job.metadata.album_artist = flat.album_artist || flat.artist;
      }
      job.metadata.extracted = flat;
      if (job.metadata.isPlaylist && !isAutomix) {
        outputDir = await maybeRenamePlaylistOutputDir(job, outputDir, OUTPUT_DIR);
      }

      if (flat.thumbnail && !isAutomix) {
        const thumbBase = path.join(TEMP_DIR, `${jobId}.cover`);
        coverPath = await downloadThumbnail(flat.thumbnail, thumbBase);
      }

      if (job.metadata.isPlaylist || isAutomix) {
        job.downloadProgress = 10;

        const selectedIndicesVar =
          job.metadata.selectedIndices === "all" ||
          !job.metadata.selectedIndices
            ? null
            : job.metadata.selectedIndices;
        const selectedIdsVar = Array.isArray(job.metadata.selectedIds)
          ? job.metadata.selectedIds
          : null;

        const totalGuess =
          (selectedIdsVar && selectedIdsVar.length) ||
          (selectedIndicesVar && selectedIndicesVar.length) ||
          (Number.isFinite(ytMeta?.n_entries)
            ? ytMeta.n_entries
            : Number.isFinite(ytMeta?.playlist_count)
            ? ytMeta.playlist_count
            : Array.isArray(ytMeta?.entries)
            ? ytMeta.entries.length
            : null);

        if (Number.isFinite(totalGuess) && totalGuess > 0) {
          job.playlist = { total: totalGuess, done: 0 };
        }

        job.counters = job.counters || {};
        job.counters.dlTotal = Number(totalGuess || 0);
        job.counters.cvTotal = Number(totalGuess || 0);
        job.counters.dlDone = job.counters.dlDone || 0;
        job.counters.cvDone = job.counters.cvDone || 0;

        const indices = selectedIndicesVar;
        const selectedIds = selectedIdsVar;
        const metaEntries = Array.isArray(ytMeta?.entries)
          ? ytMeta.entries
          : [];
        const byIndex = buildEntriesMap(ytMeta);
        const byIdRaw = new Map();
        for (const e of metaEntries) {
          if (e?.id) byIdRaw.set(e.id, e);
        }
        const trackLyricsMap = new Map();
        const frozenByIndex = new Map();
        const frozenById = new Map();
        const selectedIdToPos = new Map();
          if (Array.isArray(selectedIds) && selectedIds.length) {
            selectedIds.forEach((id, i) => {
              if (id) selectedIdToPos.set(id, i);
            });
          }

        if (Array.isArray(job.metadata?.frozenEntries)) {
          job.metadata.frozenEntries = job.metadata.frozenEntries.map((entry) =>
            normalizeYtMusicAlbumEntry(entry, {
              parentMeta: ytMeta || flat || {},
              playlistTitle: job.metadata?.frozenTitle || flat.album || flat.title || "",
              sourceUrl: job.metadata.url,
              albumArtist: flat.album_artist || flat.artist || ""
            })
          );
          for (const e of job.metadata.frozenEntries) {
            if (!e) continue;
            const normalizedFrozen = e;

            const idx = Number(normalizedFrozen.index);
            if (Number.isFinite(idx)) {
              frozenByIndex.set(idx, { ...normalizedFrozen, index: idx });
            }

            if (normalizedFrozen.id) {
              frozenById.set(normalizedFrozen.id, { ...normalizedFrozen, index: Number.isFinite(idx) ? idx : normalizedFrozen.index });
            }
          }
        }

        const youtubeConcurrency = resolveSpotifyConcurrency(
          job.metadata?.youtubeConcurrency,
          job.metadata?.spotifyConcurrency
        );
        console.log("⚡ Processing with youtubeConcurrency:", youtubeConcurrency);
        const results = [];
        const youtubeConvertLimiter = createLimiter(youtubeConcurrency);
        const convertPromisesYouTube = [];
        const scheduledFilePaths = new Set();
        const youtubeConvertProgressByIndex = new Map();

        // Resolves playlist item slot for core application logic.
        function resolveYouTubePlaylistSlot(filePath, playlistIndex = null, fileId = null) {
          if (fileId && selectedIdToPos.has(fileId)) {
            return selectedIdToPos.get(fileId);
          }
          if (Number.isFinite(playlistIndex) && playlistIndex != null) {
            return Math.max(0, Number(playlistIndex) - 1);
          }

          const indexFromPath = parsePlaylistIndexFromPath(filePath);
          if (Number.isFinite(indexFromPath)) {
            return Math.max(0, Number(indexFromPath) - 1);
          }

          return 0;
        }

        // Enqueues playlist item conversion for core application logic.
        function enqueueYouTubeConversion(filePath, playlistIndex = null, fileId = null) {
          const fileKey = path.resolve(filePath);
          if (scheduledFilePaths.has(fileKey)) {
            return null;
          }
          scheduledFilePaths.add(fileKey);

          const stableIndex = resolveYouTubePlaylistSlot(
            filePath,
            playlistIndex,
            fileId
          );

          if (job.currentPhase !== "converting") {
            job.currentPhase = "converting";
            job.convertProgress = job.convertProgress || 0;
          }

          const promise = youtubeConvertLimiter(() =>
            convertPlaylistItem(
              stableIndex,
              filePath,
              playlistIndex,
              fileId
            )
          );

          convertPromisesYouTube.push(promise);
          return promise;
        }

        // Converts playlist data item for core application logic.
        async function convertPlaylistItem(
          stableIndex,
          filePath,
          explicitPlaylistIndex = null,
          fileIdHint = null
        ) {
          const baseName = path.basename(filePath);
          const fromParser = parsePlaylistIndexFromPath(baseName);
          const regexMatch = baseName.match(/^(\d+)\s*-\s*/);
          const indexFromName = Number.isFinite(fromParser)
            ? fromParser
            : (regexMatch ? Number(regexMatch[1]) : NaN);

          const fileId = fileIdHint || parseIdFromPath(filePath);

          let frozen = null;

          if (fileId) {
            if (frozenById.has(fileId)) {
              frozen = frozenById.get(fileId);
            } else if (selectedIdToPos.has(fileId)) {
              const pos = selectedIdToPos.get(fileId);
              const pinnedId = selectedIds?.[pos];
              if (pinnedId && frozenById.has(pinnedId)) frozen = frozenById.get(pinnedId);
            }
          }

          let playlistIndex = null;

          if (Number.isFinite(explicitPlaylistIndex)) playlistIndex = explicitPlaylistIndex;
          else if (Number.isFinite(indexFromName)) playlistIndex = indexFromName;

          if (!playlistIndex && !Array.isArray(selectedIds)) {
            playlistIndex = stableIndex + 1;
          }

          if (!frozen && Number.isFinite(playlistIndex)) {
            frozen = frozenByIndex.get(playlistIndex) || null;
          }

          let entry = {};

          if (frozen?.id && byIdRaw.has(frozen.id)) {
            entry = byIdRaw.get(frozen.id) || {};
          } else if (Number.isFinite(playlistIndex) && byIndex.has(playlistIndex)) {
            entry = byIndex.get(playlistIndex) || {};
          }

          if (frozen) {
            entry = {
              ...entry,
              id: frozen.id || entry.id,
              title: frozen.title || entry.title,
              uploader: frozen.uploader || entry.uploader,
              artist: frozen.artist || entry.artist,
              webpage_url: frozen.webpage_url || entry.webpage_url
            };
          }

          entry = normalizeYtMusicAlbumEntry(entry, {
            parentMeta: ytMeta || flat || {},
            playlistTitle: job.metadata?.frozenTitle || flat.album || flat.title || "",
            sourceUrl: job.metadata.url,
            albumArtist: flat.album_artist || flat.artist || ""
          });

          const fallbackTitle = path
            .basename(filePath, path.extname(filePath))
            .replace(/^\d+\s*-\s*/, "");
          let title = toNFC(entry?.title || fallbackTitle);
          const totalTracks = job.playlist?.total || totalGuess || 1;
          const nativeTrackNumber =
            Number(entry?.track_number) ||
            Number(flat?.track_number) ||
            null;
          const nativeTrackTotal =
            Number(entry?.track_total) ||
            Number(flat?.track_total) ||
            null;
          const nativeDiscNumber =
            Number(entry?.disc_number) ||
            Number(flat?.disc_number) ||
            null;
          const nativeDiscTotal =
            Number(entry?.disc_total) ||
            Number(flat?.disc_total) ||
            null;

          let fileMeta = {
            ...flat,
            title,
            track: title,
            uploader: toNFC(entry?.uploader || flat.uploader),
            artist: toNFC(
              entry?.artist ||
                entry?.uploader ||
                flat.artist ||
                flat.uploader
            ),
            album:
              flat.album ||
              normalizeYouTubeAlbumTitleForJob(
                ytMeta?.title ||
                  ytMeta?.playlist_title ||
                  job.metadata.frozenTitle ||
                  "",
                job,
                ytMeta || flat || {}
              ),
            release_year:
              (entry?.release_year && String(entry.release_year)) ||
              (entry?.release_date ? String(entry.release_date).slice(0, 4) : "") ||
              flat.release_year ||
              "",
            release_date:
              entry?.release_date ||
              flat.release_date ||
              entry?.upload_date ||
              "",
            upload_year:
              (entry?.upload_date ? String(entry.upload_date).slice(0, 4) : "") ||
              flat.upload_year ||
              "",
            upload_date: entry?.upload_date || flat.upload_date || "",
            track_number:
              nativeTrackNumber ||
              (Number.isFinite(playlistIndex) ? Number(playlistIndex) : null),
            disc_number: nativeDiscNumber,
            track_total:
              nativeTrackTotal ||
              (totalTracks > 0 ? Number(totalTracks) : null),
            disc_total: nativeDiscTotal,
            playlist_index:
              Number.isFinite(playlistIndex) ? Number(playlistIndex) : null,
            playlist_total: totalTracks > 0 ? Number(totalTracks) : null,
            webpage_url: entry?.webpage_url || entry?.url || flat.webpage_url,
            genre:
              entry?.genre ||
              (Array.isArray(entry?.categories) ? entry.categories[0] : "") ||
              flat.genre ||
              "",
            label: "",
            publisher: "",
            copyright:
              entry?.copyright ||
              entry?.license ||
              entry?.license_name ||
              flat.copyright ||
              "",
            album_artist: ""
          };
          fileMeta = applyGlobalMetaCleaning(fileMeta);
          fileMeta.album_artist = toNFC(
            (entry && entry.album_artist) || fileMeta.artist || ""
          );
          if (/^(youtube|youtube\s+mix)$/i.test((fileMeta.artist || "").trim())) {
            fileMeta.artist = "";
          }

          fileMeta.uploader = cleanNameDynamic(fileMeta.uploader);
          fileMeta.artist = cleanNameDynamic(fileMeta.artist);
          fileMeta.album_artist = cleanNameDynamic(fileMeta.album_artist);

          try {
            const ytMusic = await probeYoutubeMusicMeta(
              entry?.webpage_url || entry?.id
            );
            fileMeta = mergeMeta(fileMeta, ytMusic);
          } catch {}
          fileMeta = normalizeYtMusicAlbumMeta(fileMeta, {
            parentMeta: ytMeta || flat || {},
            playlistTitle: job.metadata?.frozenTitle || flat.album || flat.title || "",
            sourceUrl: job.metadata.url,
            albumArtist: flat.album_artist || flat.artist || ""
          });

          if (process.env.ENRICH_SPOTIFY_FOR_YT === "1") {
            try {
              const spMeta = await findSpotifyMetaByQuery(
                fileMeta.artist,
                fileMeta.track,
                job?.metadata?.market
              );
              if (spMeta) {
                fileMeta = {
                  ...fileMeta,
                  genre: spMeta.genre || fileMeta.genre,
                  label: spMeta.label || fileMeta.label,
                  publisher: spMeta.publisher || spMeta.label || fileMeta.publisher,
                  copyright: spMeta.copyright || fileMeta.copyright,
                  album_artist: spMeta.album_artist || fileMeta.album_artist,
                  album: spMeta.album || fileMeta.album,
                  release_year: spMeta.release_year || fileMeta.release_year,
                  release_date: spMeta.release_date || fileMeta.release_date,
                  isrc: spMeta.isrc || fileMeta.isrc
                };
              }
            } catch (error) {
              console.warn(
                `Spotify metadata enrichment error: ${error.message}`
              );
            }
          }

          fileMeta = await enrichMetaFromApple(fileMeta, {
            artist: fileMeta.artist || fileMeta.uploader,
            title: fileMeta.track || fileMeta.title,
            market: job?.metadata?.market,
            preferCover: true,
            preferTrackNumber: true,
            preferTrackTotal: true,
            preferDiscNumber: true,
            preferDiscTotal: true
          });

          let itemCover = null;
          const baseNoExt = filePath.replace(/\.[^.]+$/, "");
          const sidecarJpg = `${baseNoExt}.jpg`;
          itemCover = await resolvePreferredCoverPath(fileMeta, {
            baseNoExt,
            fallbackSidecarPath: sidecarJpg,
            fallbackCoverPath: coverPath
          });

          try {
            const strictMeta = await resolveId3StrictForYouTube(
              {
                title: fileMeta.title,
                uploader: fileMeta.artist || fileMeta.uploader,
                thumbnail: itemCover ? null : flat.thumbnail,
                webpage_url: fileMeta.webpage_url,
                album: fileMeta.album,
                release_year: fileMeta.release_year,
                release_date: fileMeta.release_date,
                upload_year: fileMeta.upload_year,
                upload_date: fileMeta.upload_date,
                track_number: fileMeta.track_number,
                disc_number: fileMeta.disc_number,
                track_total: fileMeta.track_total,
                disc_total: fileMeta.disc_total,
                playlist_index: fileMeta.playlist_index,
                playlist_total: fileMeta.playlist_total,
                genre: fileMeta.genre,
                copyright: fileMeta.copyright
              },
              { market: resolveMarket(), isPlaylist: true }
            );

            if (strictMeta) {
              fileMeta = {
                ...fileMeta,
                ...strictMeta,
                genre: fileMeta.genre || strictMeta.genre,
                label: fileMeta.label || strictMeta.label,
                publisher: fileMeta.publisher || strictMeta.publisher,
                copyright: fileMeta.copyright || strictMeta.copyright,
                album_artist: fileMeta.album_artist || strictMeta.album_artist,
                webpage_url: strictMeta.spotifyUrl || fileMeta.webpage_url
              };
              fileMeta.album_artist = toNFC(
                fileMeta.album_artist || fileMeta.artist || ""
              );
              if (strictMeta.label) {
                if (!fileMeta.label) fileMeta.label = strictMeta.label;
                if (!fileMeta.publisher) fileMeta.publisher = strictMeta.label;
              }
            } else {
              const guess = buildId3FromYouTube({
                title: fileMeta.title,
                uploader: fileMeta.artist || fileMeta.uploader,
                thumbnail: itemCover ? null : flat.thumbnail,
                webpage_url: fileMeta.webpage_url,
                album: fileMeta.album,
                release_year: fileMeta.release_year,
                release_date: fileMeta.release_date,
                upload_year: fileMeta.upload_year,
                upload_date: fileMeta.upload_date,
                track_number: fileMeta.track_number,
                disc_number: fileMeta.disc_number,
                track_total: fileMeta.track_total,
                disc_total: fileMeta.disc_total,
                playlist_index: fileMeta.playlist_index,
                playlist_total: fileMeta.playlist_total,
                genre: fileMeta.genre,
                copyright: fileMeta.copyright
              });

              if (guess) {
                fileMeta = {
                  ...fileMeta,
                  title: guess.title || fileMeta.title,
                  track: guess.track || fileMeta.track || guess.title || fileMeta.title,
                  artist: guess.artist || fileMeta.artist,
                  uploader: guess.uploader || fileMeta.uploader,
                  genre: fileMeta.genre,
                  label: fileMeta.label,
                  publisher: fileMeta.publisher,
                  copyright: fileMeta.copyright,
                  album_artist:
                    fileMeta.album_artist ||
                    guess.artist ||
                    fileMeta.artist
                };
                fileMeta.album_artist = toNFC(
                  fileMeta.album_artist || fileMeta.artist || ""
                );
              }
            }
          } catch (error) {
            console.warn(`ID3 strict resolution error: ${error.message}`);
          }
          fileMeta = normalizeYtMusicAlbumMeta(fileMeta, {
            parentMeta: ytMeta || flat || {},
            playlistTitle: job.metadata?.frozenTitle || flat.album || flat.title || "",
            sourceUrl: job.metadata.url,
            albumArtist: flat.album_artist || flat.artist || ""
          });
          fileMeta = applyGlobalMetaCleaning(fileMeta);
          if (isAutomix) {
            const automixAlbum = toNFC(fileMeta.track || fileMeta.title || "").trim();
            if (automixAlbum) fileMeta.album = automixAlbum;
          }

          const existingOut = findExistingOutput(
            `${jobId}_${stableIndex}`,
            format,
            outputDir
          );
          let r;
          if (existingOut) {
            r = {
              outputPath: toDownloadPathSafe(existingOut)
            };
            updateParallelConversionProgress(
              job,
              youtubeConvertProgressByIndex,
              stableIndex,
              100,
              totalTracks
            );
            if (job.canceled) throw new Error("CANCELED");
          } else {
            try {
              r = await convertMedia(
                filePath,
                format,
                bitrate,
                `${jobId}_${stableIndex}`,
                (progress, details) => {
                  updateParallelConversionProgress(
                    job,
                    youtubeConvertProgressByIndex,
                    stableIndex,
                    progress,
                    totalTracks
                  );
                  if (job.playlist) {
                    job.playlist.current = stableIndex;
                  }

                  if (isVideoFormat(format)) {
                    const label = [
                      fileMeta?.artist || fileMeta?.uploader || "",
                      fileMeta?.track || fileMeta?.title || ""
                    ]
                      .map((s) => String(s || "").trim())
                      .filter(Boolean)
                      .join(" - ");
                    job.lastLog = buildLiveVideoConvertLog(progress, details, label);
                    job.lastLogKey = null;
                    job.lastLogVars = null;
                  }
                },
                fileMeta,
                itemCover,
                isVideoFormat(format),
                outputDir,
                TEMP_DIR,
                {
                  outputRootDir: OUTPUT_DIR,
                  onProcess: (child) => {
                    try {
                      registerJobProcess(jobId, child);
                    } catch {}
                  },
                  includeLyrics: job.metadata.includeLyrics,
                  embedLyrics: !!job.metadata.embedLyrics,
                  sampleRate: sampleRate,
                  bitDepth: job.bitDepth || null,
                  compressionLevel: job.metadata?.compressionLevel ?? null,
                  isCanceled: () => !!jobs.get(jobId)?.canceled,
                  onLog: handleLyricsLog,
                  volumeGain: effectiveVolumeGain,
                  loudnorm: effectiveLoudnorm,
                  loudnormMode: effectiveLoudnormMode,
                  onLyricsStats: handleLyricsStats,
                  ringtone: job.metadata?.ringtone || null,
                  stereoConvert: job.metadata?.stereoConvert || "auto",
                  atempoAdjust: job.metadata?.atempoAdjust || "none"
                }
              );
            } catch (err) {
              if (String(err?.message || "").toUpperCase() === "CANCELED") {
                const jobRef = jobs.get(jobId);
                if (jobRef) {
                  jobRef.status = "canceled";
                  jobRef.currentPhase = "canceled";
                  jobRef.error = null;
                  jobRef.canceled = true;
                }
                return null;
              }
              throw err;
            }
          }

          const hasLrc = !!r?.lyricsPath;
          if (hasLrc && Number.isFinite(playlistIndex)) {
            trackLyricsMap.set(playlistIndex, true);
          }

          results[stableIndex] = r;
          updateParallelConversionProgress(
            job,
            youtubeConvertProgressByIndex,
            stableIndex,
            100,
            totalTracks
          );
          bump(job.counters, "cvDone", 1);
          if (job.playlist) {
            job.playlist.done = (job.playlist.done || 0) + 1;
          }
          updateLyricsStatsLive(job.playlist?.done || 0, totalTracks);

          return r;
        }

        const filesPromise = downloadYouTubeVideo(
        job.metadata.url,
        jobId,
        true,
        indices,
        isAutomix,
        selectedIds,
        TEMP_DIR,
          (progress) => {
            const tGuess = Number(
              job.counters?.dlTotal || job.playlist?.total || 0
            );
            if (
              progress &&
              typeof progress === "object" &&
              progress.__event &&
              progress.type === "file-done"
            ) {
              const t = Number(progress.total || tGuess || 0);
              job.counters.dlTotal = t || tGuess;
              job.counters.dlDone = Math.min(
                job.counters.dlTotal || t,
                Number(progress.downloaded || 0)
              );
              job.downloadProgress = Math.max(
              10,
              Math.min(
              100,
              10 +
                (job.counters.dlDone /
                  Math.max(1, job.counters.dlTotal || t || 1)) *
                  90
                )
              );
              if (job.playlist && job.currentPhase === "downloading") {
                job.playlist.current = Math.max(
                  0,
                  (job.counters.dlDone - 1) | 0
                );
              }
            } else {
              const pct = Number(progress || 0);
              job.downloadProgress = Math.max(
                10,
                Math.min(100, 10 + pct * 0.9)
              );
              const t = tGuess;
              if (t > 0) {
                const approx = clampInt((pct / 100) * t, 0, t);
                if ((job.counters.dlDone || 0) < approx)
                  job.counters.dlDone = approx;
                if (job.playlist && job.currentPhase === "downloading") {
                  job.playlist.current = Math.max(
                    0,
                    Math.min(t - 1, approx - 1)
                  );
                }
              }
            }
            job.progress = Math.floor(
              (job.downloadProgress + job.convertProgress) / 2
            );
          },
          {
            video: isVideoFormat(format),
            onSkipUpdate: handleSkipUpdate,
            maxHeight: isVideoFormat(format)
              ? qualityToHeight(bitrate)
              : undefined,
            youtubeConcurrency,
            sourceUrl: job.metadata?.url || "",
            frozenEntries: Array.isArray(job.metadata?.frozenEntries)
              ? job.metadata.frozenEntries
              : [],
            onFileDone: ({ filePath, playlistIndex }) => {
              const fileId = parseIdFromPath(filePath);
              enqueueYouTubeConversion(
                filePath,
                playlistIndex,
                fileId
              );
            }
          },
          { isCanceled: () => !!job.canceled }
        );

        const files = await filesPromise;

        job.counters.dlDone = job.counters.dlTotal;
        job.downloadProgress = 100;
        if (!job.currentPhase || job.currentPhase === "downloading") {
          job.currentPhase = "converting";
        }
        job.convertProgress = job.convertProgress || 0;

        if (!Array.isArray(files) || !files.length) {
          throw new Error("Playlist/Automix media files not found");
        }

        for (const filePath of files) {
          const fileId = parseIdFromPath(filePath);
          const playlistIndex = parsePlaylistIndexFromPath(filePath);
          const myIndex = resolveYouTubePlaylistSlot(
            filePath,
            playlistIndex,
            fileId
          );

          if (results[myIndex]) {
            scheduledFilePaths.add(path.resolve(filePath));
            continue;
          }

          enqueueYouTubeConversion(
            filePath,
            playlistIndex,
            fileId
          );
        }

        const entryById = new Map();
        if (Array.isArray(job.metadata.frozenEntries)) {
          for (const e of job.metadata.frozenEntries) {
            if (e?.id) entryById.set(e.id, e);
          }
        }
        if (
          !Array.isArray(job.metadata.frozenEntries) ||
          job.metadata.frozenEntries.length === 0
        ) {
          const fe = [];
          const byIdMeta = new Map();
          for (const e of metaEntries) {
            if (e?.id) byIdMeta.set(e.id, e);
          }
          for (let i = 0; i < files.length; i++) {
            const filePath = files[i];
            const idxFromName = parsePlaylistIndexFromPath(filePath);
            let src = null;
            if (Number.isFinite(idxFromName) && byIndex.has(idxFromName)) {
              src = byIndex.get(idxFromName);
            } else if (
              Array.isArray(selectedIds) &&
              selectedIds[i] &&
              byIdMeta.has(selectedIds[i])
            ) {
              src = byIdMeta.get(selectedIds[i]);
            }
            const title = (
              src?.title ||
              src?.alt_title ||
              path
                .basename(filePath, path.extname(filePath))
                .replace(/^\d+\s*-\s*/, "") ||
              ""
            ).toString();
            const uploader = (
              src?.uploader ||
              src?.channel ||
              ytMeta?.uploader ||
              ytMeta?.channel ||
              ""
            ).toString();
            const id = (
              src?.id ||
              (Array.isArray(selectedIds) ? selectedIds[i] : null) ||
              ""
            ).toString();
            const webpage_url = (
              src?.webpage_url ||
              src?.url ||
              job.metadata.url ||
              ""
            ).toString();
            const index = Number.isFinite(idxFromName)
              ? idxFromName
              : i + 1;
            const hasLyrics = !!trackLyricsMap.get(index);
            const entry = normalizeYtMusicAlbumEntry({
              index,
              id,
              title,
              uploader,
              webpage_url,
              hasLyrics
            }, {
              parentMeta: ytMeta || flat || {},
              playlistTitle: job.metadata?.frozenTitle || flat.album || flat.title || "",
              sourceUrl: job.metadata.url,
              albumArtist: flat.album_artist || flat.artist || ""
            });
            fe.push(entry);
            if (id) entryById.set(id, entry);
          }
          job.metadata.frozenEntries = fe;
          job.metadata.frozenTitle =
            job.metadata.frozenTitle ||
            normalizeYouTubeAlbumTitleForJob(
              ytMeta?.title ||
                ytMeta?.playlist_title ||
                "",
              job,
              ytMeta || flat || {}
            ) ||
            (isAutomix ? "YouTube Automix" : "");
        } else {
          for (const fe of job.metadata.frozenEntries) {
            if (!fe || typeof fe.index !== "number") continue;
            if (trackLyricsMap.has(fe.index)) {
              fe.hasLyrics = !!trackLyricsMap.get(fe.index);
            }
          }
        }

        await Promise.all(convertPromisesYouTube);
        const finalResults = results.filter(Boolean);

        if (finalResults.length === 1) {
          job.resultPath = finalResults[0]?.outputPath || null;
        } else {
          job.resultPath = finalResults;
          if (!job.clientBatch && job.metadata?.autoCreateZip !== false) {
            try {
              const zipTitle =
                normalizeYouTubeAlbumTitleForJob(
                  ytMeta?.title ||
                    ytMeta?.playlist_title ||
                    "",
                  job,
                  ytMeta || flat || {}
                ) ||
                (isAutomix ? "YouTube Automix" : "Playlist");
              job.zipPath = await makeZipFromOutputs(
                jobId,
                finalResults,
                zipTitle,
                job.metadata.includeLyrics,
                outputDir
              );
            } catch (e) {}
          }
        }

        if (job.metadata?.includeLyrics) {
          const doneCount = job.playlist?.done || finalResults.length;
          const totalCount = job.playlist?.total || totalGuess || finalResults.length;
          updateLyricsStatsLive(doneCount, totalCount);
        }

        markJobCompleted(job);
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
          job.counters = job.counters || {};
          job.counters.dlTotal = 1;
          const approx = progress >= 100 ? 1 : 0;
          if ((job.counters.dlDone || 0) < approx)
            job.counters.dlDone = approx;
          job.progress = Math.floor(
            (job.downloadProgress + job.convertProgress) / 2
          );
        },
        {
          video: isVideoFormat(format),
          onSkipUpdate: handleSkipUpdate,
          maxHeight: isVideoFormat(format)
            ? qualityToHeight(bitrate)
            : undefined
        },
        { isCanceled: () => !!job.canceled }
      );

      job.counters.dlTotal = 1;
      job.counters.dlDone = 1;
      job.downloadProgress = 100;
      job.currentPhase = "converting";
      actualInputPath = filePath;
    }

    if (job.metadata.source === "platform") {
      job.currentPhase = "downloading";
      job.downloadProgress = 5;

      const platformResult = await downloadPlatformMedia(
        job.metadata.url,
        jobId,
        TEMP_DIR,
        (progress) => {
          const p = Number(progress || 0);
          job.downloadProgress = Math.max(5, Math.min(100, p));
          job.progress = Math.floor(
            (job.downloadProgress + job.convertProgress) / 2
          );
          job.counters = job.counters || {};
          job.counters.dlTotal = 1;
          job.counters.dlDone = p >= 100 ? 1 : 0;
        },
        {
          video: isVideoFormat(format),
          maxHeight: isVideoFormat(format)
            ? qualityToHeight(bitrate)
            : undefined
        },
        { isCanceled: () => !!job.canceled }
      );

      job.metadata.extracted = applyGlobalMetaCleaning({
        ...(job.metadata.extracted || {}),
        ...(platformResult?.metadata || {}),
        webpage_url: platformResult?.metadata?.webpage_url || job.metadata.url
      });

      if (!coverPath && job.metadata.extracted?.thumbnail) {
        try {
          const thumbBase = path.join(TEMP_DIR, `${jobId}.cover`);
          coverPath = await downloadThumbnail(
            job.metadata.extracted.thumbnail,
            thumbBase
          );
        } catch {}
      }

      job.counters = job.counters || {};
      job.counters.dlTotal = 1;
      job.counters.dlDone = 1;
      job.downloadProgress = 100;
      job.currentPhase = "converting";
      actualInputPath = platformResult.filePath;
    }

    const isVideo = format === "mp4";
    const isEac3Ac3 =
      format === "eac3" || format === "ac3" || format === "aac";
    if (!coverPath && typeof actualInputPath === "string") {
      const safeInput = assertPathWithinAny(path.resolve(actualInputPath), [TEMP_DIR, OUTPUT_DIR, UPLOAD_DIR, LOCAL_INPUT_DIR]);
      const baseNoExt = safeInput.replace(/\.[^.]+$/, "");
      const sidecar = assertPathWithinAny(`${baseNoExt}.jpg`, [TEMP_DIR, OUTPUT_DIR, UPLOAD_DIR, LOCAL_INPUT_DIR]);
      if (fs.existsSync(sidecar)) coverPath = sidecar;
    }

    let singleMeta = normalizeYtMusicAlbumMeta({ ...(job.metadata.extracted || {}) }, {
      sourceUrl: job.metadata?.url || "",
      playlistTitle: job.metadata?.frozenTitle || job.metadata?.extracted?.playlist_title || ""
    });

    if (job.metadata.source === "youtube" || isMappedMusicSource(job.metadata.source)) {
      try {
        const ytMusicSingle = await probeYoutubeMusicMeta(
          singleMeta.webpage_url || job.metadata.url
        );
        singleMeta = mergeMeta(singleMeta, ytMusicSingle);
      } catch {}
      singleMeta = normalizeYtMusicAlbumMeta(singleMeta, {
        sourceUrl: job.metadata?.url || "",
        playlistTitle: job.metadata?.frozenTitle || singleMeta?.playlist_title || ""
      });
    }

    if (job.metadata.source === "youtube") {
      try {
        const strictSingle = await resolveId3StrictForYouTube(
          {
            title: singleMeta.title || singleMeta.track || "",
            uploader: singleMeta.artist || singleMeta.uploader || "",
            thumbnail: singleMeta.thumbnail || null,
            webpage_url: singleMeta.webpage_url || job.metadata.url,
            album: singleMeta.album,
            release_year: singleMeta.release_year,
            release_date: singleMeta.release_date,
            upload_year: singleMeta.upload_year,
            upload_date: singleMeta.upload_date,
            track_number: singleMeta.track_number,
            disc_number: singleMeta.disc_number,
            track_total: singleMeta.track_total,
            disc_total: singleMeta.disc_total,
            playlist_index: singleMeta.playlist_index,
            playlist_total: singleMeta.playlist_total,
            genre: singleMeta.genre,
            copyright: singleMeta.copyright
          },
          { market: resolveMarket(), isPlaylist: false }
        );

        if (strictSingle) {
          singleMeta = {
            ...singleMeta,
            ...strictSingle,
            genre: singleMeta.genre || strictSingle.genre,
            label: singleMeta.label || strictSingle.label,
            publisher: singleMeta.publisher || strictSingle.publisher || strictSingle.label,
            copyright: singleMeta.copyright || strictSingle.copyright,
            album_artist: singleMeta.album_artist || strictSingle.album_artist
          };
          if (strictSingle.spotifyUrl) {
            singleMeta.webpage_url = strictSingle.spotifyUrl;
          }
        }
      } catch (error) {
        console.warn(`Single ID3 strict resolution error: ${error.message}`);
      }
      singleMeta = normalizeYtMusicAlbumMeta(singleMeta, {
        sourceUrl: job.metadata?.url || "",
        playlistTitle: job.metadata?.frozenTitle || singleMeta?.playlist_title || ""
      });
    }

    if (job.metadata.source === "youtube" && process.env.ENRICH_SPOTIFY_FOR_YT === "1") {
      try {
        const spSingle = await findSpotifyMetaByQuery(
          singleMeta.artist,
          singleMeta.track || singleMeta.title,
          job?.metadata?.market
        );
        singleMeta = mergeMeta(singleMeta, spSingle);
        if (!singleMeta.publisher && spSingle?.label)
          singleMeta.publisher = spSingle.label;
      } catch {}
    }

    singleMeta = await enrichMetaFromApple(singleMeta, {
      artist: singleMeta.artist || singleMeta.album_artist || singleMeta.uploader,
      title: singleMeta.track || singleMeta.title,
      market: job?.metadata?.market,
      preferCover: job.metadata.source === "youtube"
    });

    singleMeta.album_artist =
    singleMeta.album_artist || singleMeta.artist || "";
    singleMeta = applyGlobalMetaCleaning(singleMeta);

    try {
      const artistForMeta =
        singleMeta?.artist ||
        singleMeta?.album_artist ||
        job.metadata?.artist ||
        job.metadata?.extracted?.artist ||
        "";

      if (job.metadata?.source === "youtube") {
        const ytRawTitle =
          singleMeta?.raw_title ||
          job.metadata?.extracted?.raw_title ||
          "";
        if (ytRawTitle) {
          const fromRaw = buildId3FromYouTube({
            title: ytRawTitle,
            uploader: singleMeta?.artist || singleMeta?.uploader || "",
            album: singleMeta?.album,
            release_year: singleMeta?.release_year,
            release_date: singleMeta?.release_date,
            upload_year: singleMeta?.upload_year,
            upload_date: singleMeta?.upload_date,
            track_number: singleMeta?.track_number,
            disc_number: singleMeta?.disc_number,
            track_total: singleMeta?.track_total,
            disc_total: singleMeta?.disc_total,
            playlist_index: singleMeta?.playlist_index,
            playlist_total: singleMeta?.playlist_total,
            genre: singleMeta?.genre,
            copyright: singleMeta?.copyright
          });
          const ytPreferredTitle = fromRaw?.title || "";
          if (ytPreferredTitle) {
            singleMeta.title = ytPreferredTitle;
            singleMeta.track = ytPreferredTitle;
          }
        }
      }

      if (singleMeta.title && artistForMeta) {
        const coreTitle = normalizeTitle(singleMeta.title, artistForMeta) || singleMeta.title;
        singleMeta.title = coreTitle;
        singleMeta.track = coreTitle;
      }
    } catch {}

    if (typeof actualInputPath === "string") {
      const baseNoExt = actualInputPath.replace(/\.[^.]+$/, "");
      coverPath = await resolvePreferredCoverPath(singleMeta, {
        baseNoExt,
        fallbackCoverPath: coverPath
      }) || coverPath;
    }

    job.counters = job.counters || {};

    const selectedAudioStreams = Array.isArray(selectedStreams.audio)
      ? selectedStreams.audio.filter(
          (idx) => Number.isInteger(idx) && idx >= 0
        )
      : [];

    const isAudioFormat = !isVideoFormatFlag;
    const multiAudioOutputs = isAudioFormat && selectedAudioStreams.length > 1;

    if (multiAudioOutputs) {
      const results = [];
      const total = selectedAudioStreams.length;

      job.counters.cvTotal = total;
      job.counters.cvDone = job.counters.cvDone || 0;

      for (let i = 0; i < total; i++) {
        const aIdx = selectedAudioStreams[i];
        const perStreamSelected = {
          ...(selectedStreams || {}),
          audio: [aIdx]
        };

        const perJobId = `${jobId}_a${i}`;
        const existingOut = findExistingOutput(
          perJobId,
          format,
          outputDir
        );
        // Handles progress for stream payload in core application logic.
        const progressForStream = (p) => {
          const base = (i / total) * 100;
          const cur = base + (Number(p || 0) / total);
          job.convertProgress = Math.floor(cur);
          job.progress = Math.floor(
            (job.downloadProgress + job.convertProgress) / 2
          );
        };

        let r;
        if (existingOut) {
          r = {
            outputPath: toDownloadPathSafe(existingOut)
          };
          progressForStream(100);
        } else {
          r = await convertMedia(
            actualInputPath,
            format,
            bitrate,
            perJobId,
            progressForStream,
            {
              ...singleMeta,
              __maxHeight: undefined
            },
            coverPath,
            false,
            outputDir,
            TEMP_DIR,
            {
              outputRootDir: OUTPUT_DIR,
              onProcess: (child) => {
                try {
                  registerJobProcess(jobId, child);
                } catch {}
              },
              includeLyrics: !!job.metadata.includeLyrics,
              embedLyrics: !!job.metadata.embedLyrics,
              sampleRate: sampleRate,
              compressionLevel: job.metadata?.compressionLevel ?? null,
              bitDepth: job.bitDepth || null,
              isCanceled: () => !!jobs.get(jobId)?.canceled,
              onLog: handleLyricsLog,
              onLyricsStats: handleLyricsStats,
              volumeGain: effectiveVolumeGain,
              loudnorm: effectiveLoudnorm,
              loudnormMode: effectiveLoudnormMode,
              ringtone: job.metadata?.ringtone || null,
              stereoConvert: job.metadata?.stereoConvert || "auto",
              selectedStreams: perStreamSelected,
              atempoAdjust: job.metadata?.atempoAdjust || "none",
              videoSettings: job.videoSettings || {}
            }
          );
        }

        results.push(r);
        bump(job.counters, "cvDone", 1);

        if (job.metadata?.includeLyrics) {
          updateLyricsStatsLive(job.counters.cvDone, total);
        }

        if (job.canceled) {
          throw new Error("CANCELED");
        }
      }

      job.resultPath = results.length === 1 ? results[0] : results;

      markJobCompleted(job);
      job.progress = 100;
      job.downloadProgress = 100;
      job.convertProgress = 100;
      job.currentPhase = "completed";
      cleanupTempFiles(jobId, inputPath, actualInputPath);
      return;
    }

    job.counters.cvTotal = 1;

    const transcodeEnabled = job.videoSettings?.transcodeEnabled === true;
    const directMoveCandidate =
      typeof actualInputPath === "string" ? path.resolve(actualInputPath) : "";
    const directMoveInputAbs = directMoveCandidate
      ? path.resolve(TEMP_DIR, path.basename(directMoveCandidate))
      : "";
    const directMoveRel = directMoveInputAbs
      ? path.relative(path.resolve(TEMP_DIR), directMoveInputAbs)
      : "";
    const directMoveInsideTemp =
      !!directMoveRel &&
      directMoveRel !== ".." &&
      !directMoveRel.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(directMoveRel) &&
      directMoveInputAbs === directMoveCandidate;
    const canDirectMovePlatformMp4 =
      isVideoFormatFlag &&
      format === "mp4" &&
      job.metadata?.source === "platform" &&
      !transcodeEnabled &&
      directMoveInsideTemp &&
      fs.existsSync(directMoveInputAbs);

    const existingSingle = findExistingOutput(jobId, format, outputDir);
    const r = existingSingle
      ? {
          outputPath: toDownloadPathSafe(existingSingle)
        }
      : canDirectMovePlatformMp4
      ? (() => {
          const extRaw = path.extname(directMoveInputAbs);
          const ext = extRaw ? extRaw.toLowerCase() : ".mp4";
          const baseRaw = path.basename(directMoveInputAbs, extRaw);
          const base = sanitizeFilename(baseRaw) || jobId;
          const targetAbs = buildUniqueOutputPath(outputDir, `${base}${ext}`);

          // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
          const directMoveLog = `🎬 Platform MP4 transcode disabled - direct move: ${sanitizeLogValue(directMoveInputAbs)} -> ${sanitizeLogValue(targetAbs)}`;
          console.log(directMoveLog);
          safeMoveFileSync(directMoveInputAbs, targetAbs);
          queueOwnershipFix(targetAbs);

          job.convertProgress = 100;
          job.progress = Math.floor(
            (job.downloadProgress + job.convertProgress) / 2
          );

          return {
            outputPath: toDownloadPathSafe(targetAbs),
            fileSize: fs.statSync(targetAbs).size
          };
        })()
      : await convertMedia(
          actualInputPath,
          format,
          bitrate,
          jobId,
          (p, details) => {
            job.convertProgress = Math.floor(p);
            job.progress = Math.floor(
              (job.downloadProgress + job.convertProgress) / 2
            );

            if (isVideoFormat(format)) {
              const label = [
                singleMeta?.artist || singleMeta?.uploader || "",
                singleMeta?.track || singleMeta?.title || ""
              ]
                .map((s) => String(s || "").trim())
                .filter(Boolean)
                .join(" - ");
              job.lastLog = buildLiveVideoConvertLog(p, details, label);
              job.lastLogKey = null;
              job.lastLogVars = null;
            }
          },
          {
            ...singleMeta,
            __maxHeight: isVideoFormatFlag
              ? qualityToHeight(bitrate)
              : undefined
          },
          coverPath,
          isVideoFormat(format),
          outputDir,
          TEMP_DIR,
          {
            outputRootDir: OUTPUT_DIR,
            onProcess: (child) => {
              try {
                registerJobProcess(jobId, child);
              } catch {}
            },
            includeLyrics: !!job.metadata.includeLyrics,
            embedLyrics: !!job.metadata.embedLyrics,
            sampleRate: sampleRate,
            compressionLevel: job.metadata?.compressionLevel ?? null,
            bitDepth: job.bitDepth || null,
            isCanceled: () => !!jobs.get(jobId)?.canceled,
            onLog: handleLyricsLog,
            onLyricsStats: handleLyricsStats,
            volumeGain: effectiveVolumeGain,
            loudnorm: effectiveLoudnorm,
            loudnormMode: effectiveLoudnormMode,
            ringtone: job.metadata?.ringtone || null,
            stereoConvert: job.metadata?.stereoConvert || "auto",
            selectedStreams: selectedStreams,
            atempoAdjust: job.metadata?.atempoAdjust || "none",
            videoSettings: job.videoSettings || {}
          }
        );

        job.resultPath = r;
    try {
      if (r?.outputPath) {
        const extMap = {
          mp3: ".mp3",
          flac: ".flac",
          wav: ".wav",
          ogg: ".ogg",
          mp4: ".mp4",
          dts: ".dts"
        };
        const desiredExt =
          extMap[format] || "." + String(format || "mp3");

        const ytRawTitleForName =
          (job.metadata?.source === "youtube" &&
            (singleMeta?.raw_title || job.metadata?.extracted?.raw_title))
            ? buildId3FromYouTube({
                title: singleMeta?.raw_title || job.metadata?.extracted?.raw_title || "",
                uploader: singleMeta?.artist || singleMeta?.uploader || ""
              })?.title || ""
            : "";

        const rawTitleCandidate =
          ytRawTitleForName ||
          singleMeta?.title ||
          job.metadata?.title ||
          job.metadata?.extracted?.title ||
          "";
        const titleCandidate =
          job.metadata?.source === "youtube"
            ? (refineYouTubeStandaloneTitle(rawTitleCandidate) || rawTitleCandidate)
            : rawTitleCandidate;

        const artistForName =
          singleMeta?.artist ||
          singleMeta?.album_artist ||
          job.metadata?.artist ||
          job.metadata?.extracted?.artist ||
          "";

        const titleForFilename = normalizeTitle(
          titleCandidate,
          artistForName
        );
        const keepStandaloneTitle =
          job.metadata?.source === "youtube" &&
          /(?:•|\s+\bl\b\s+)/i.test(String(titleCandidate || ""));
        const isInstagramPlatform =
          job.metadata?.source === "platform" &&
          String(job.metadata?.platform || "").toLowerCase() === "instagram";
        const isVimeoPlatform =
          job.metadata?.source === "platform" &&
          String(job.metadata?.platform || "").toLowerCase() === "vimeo";
        const isDailymotionSource = isDailymotionUrl(
          singleMeta?.webpage_url || job.metadata?.url || ""
        );

        const currentRel = decodeURIComponent(
          String(r.outputPath).replace(/^\/download\//, "")
        );
        const currentStem = path.basename(
          currentRel,
          path.extname(currentRel)
        );
        let stemFallback = String(currentStem || "");
        if (stemFallback.startsWith(jobId)) {
          stemFallback = stemFallback.slice(jobId.length);
        }
        stemFallback = stemFallback
          .replace(/^[._\-\s]+/, "")
          .replace(/[._]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (!/[A-Za-z]/.test(stemFallback) && !/[^\u0000-\u007F]/.test(stemFallback)) {
          stemFallback = "";
        }
        if (isGenericNamingToken(stemFallback)) {
          stemFallback = "";
        }
        if (/^output$/i.test(stemFallback)) {
          stemFallback = "";
        }
        if (isInstagramPlatform && looksLikePlatformShortCode(stemFallback)) {
          stemFallback = "";
        }

        const urlTitleFallback = deriveTitleFromUrl(
          singleMeta?.webpage_url || job.metadata?.url || ""
        );
        const safeUrlTitleFallback =
          isInstagramPlatform && looksLikePlatformShortCode(urlTitleFallback)
            ? ""
            : urlTitleFallback;
        const instagramHandle = deriveInstagramHandleFromUrl(
          singleMeta?.webpage_url || job.metadata?.url || ""
        );

        let baseTitle;

        if (isInstagramPlatform) {
          baseTitle = instagramHandle
            ? `${instagramHandle} - Reel`
            : "Instagram - Reel";
        } else if (keepStandaloneTitle && titleForFilename) {
          baseTitle = titleForFilename;
        } else if (artistForName && titleForFilename) {
          baseTitle = `${artistForName} - ${titleForFilename}`;
        } else if (titleCandidate) {
          baseTitle = titleCandidate;
        } else if (safeUrlTitleFallback) {
          baseTitle = safeUrlTitleFallback;
        } else if (isVimeoPlatform) {
          baseTitle = "Vimeo Video";
        } else if (isDailymotionSource) {
          baseTitle = "Dailymotion Video";
        } else if (job.metadata?.source === "local" && job.metadata?.originalName) {
          baseTitle = job.metadata.originalName;
        } else if (job.metadata?.source === "file" && job.metadata?.originalName) {
          baseTitle = job.metadata.originalName;
        } else if (stemFallback && stemFallback.toLowerCase() !== "output") {
          baseTitle = stemFallback;
        } else {
          baseTitle =
            job.metadata?.originalName ||
            singleMeta?.track ||
            job.metadata?.extracted?.title ||
            `job_${jobId}`;
        }

        baseTitle = baseTitle.replace(/\.[^.]*$/, "");
        const safeBase = sanitizeFilename(toNFC(baseTitle)) || "output";

        let targetName = `${safeBase}${desiredExt}`;
        const currentAbs = resolveDownloadPathToAbs(r.outputPath, OUTPUT_DIR);
        if (!currentAbs) {
          throw new Error("Could not resolve current output path");
        }
        let targetAbs = path.join(outputDir, targetName);
        const sameAsCurrent =
          path.resolve(targetAbs) === path.resolve(currentAbs);
        if (fs.existsSync(targetAbs) && !sameAsCurrent) {
          let i = 1;
          const stem = safeBase;
          const ext = desiredExt;
          while (
            fs.existsSync(targetAbs) &&
            path.resolve(targetAbs) !== path.resolve(currentAbs) &&
            i < 1000
          ) {
            targetName = `${stem} (${i})${ext}`;
            targetAbs = path.join(outputDir, targetName);
            i++;
          }
        }

        if (fs.existsSync(currentAbs)) {
          fs.renameSync(currentAbs, targetAbs);
          await queueOwnershipFix(targetAbs);
          job.resultPath = {
            outputPath: toDownloadPathSafe(targetAbs)
          };
          const oldLrc = currentAbs.replace(/\.[^/.]+$/, "") + ".lrc";
          if (fs.existsSync(oldLrc)) {
            const newLrc = targetAbs.replace(/\.[^/.]+$/, "") + ".lrc";
            try {
              fs.renameSync(oldLrc, newLrc);
              await queueOwnershipFix(newLrc);
            } catch {}
          }
        }
      }
    } catch (e) {
      console.warn("Output rename warning:", e.message);
    }

    job.counters.cvDone = 1;
    if (job.metadata?.includeLyrics) {
      updateLyricsStatsLive(1, 1);
    }

    markJobCompleted(job);
    job.progress = 100;
    job.downloadProgress = 100;
    job.convertProgress = 100;
    job.currentPhase = "completed";
    cleanupTempFiles(jobId, inputPath, actualInputPath);
  } catch (error) {
    const jobRef = jobs.get(jobId);
    const isCanceled = error && String(error.message).toUpperCase() === "CANCELED";
    if (jobRef) {
      if (isCanceled) {
        jobRef.status = "canceled";
        jobRef.error = null;
        jobRef.currentPhase = "canceled";
      } else {
        jobRef.status = "error";
        jobRef.error = error.message;
        jobRef.currentPhase = "error";
      }
    }
    if (!isCanceled) {
      // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
      console.error("Job error:", sanitizeLogValue(error?.message || error));
    }
    try {
      killJobProcesses(jobId);
    } catch {}
    if (isCanceled) {
      scheduleTempCleanupAfterJobProcesses(jobId, inputPath);
    } else {
      cleanupTempFiles(jobId, inputPath);
    }
  }
}

// Finds existing output for core application logic.
function findExistingOutput(idPrefix, format, outDir) {
  try {
    const exts =
      {
        mp3: ["mp3"],
        flac: ["flac"],
        wav: ["wav"],
        ogg: ["ogg", "oga"],
        mp4: ["mp4", "m4a"],
        dts: ["dts"]
      }[format] || [format];
    const files = fs.readdirSync(outDir);
    const hit = files.find(
      (f) =>
        f.startsWith(`${idPrefix}.`) &&
        exts.some((e) => f.toLowerCase().endsWith(`.${e}`))
    );
    return hit ? path.join(outDir, hit) : null;
  } catch {
    return null;
  }
}

// Handles make zip from outputs in core application logic.
async function makeZipFromOutputs(
  jobId,
  outputs,
  titleHint = "playlist",
  includeLyrics = false,
  outputDir = OUTPUT_DIR
) {
  const outDir = path.resolve(outputDir || OUTPUT_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const safeBase = sanitizeFilename(
    `${titleHint || "playlist"}_${jobId}`
  ).normalize("NFC");
  const zipName = `${safeBase}.zip`;
  const zipAbs = path.join(outDir, zipName);

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipAbs);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on("close", async () => {
      await queueOwnershipFix(zipAbs);
      resolve(toDownloadPathSafe(zipAbs));
    });
    archive.on("error", (err) => reject(err));

    archive.pipe(output);

    for (const r of outputs) {
      if (!r?.outputPath) continue;
      const abs = resolveDownloadPathToAbs(r.outputPath, OUTPUT_DIR);
      if (abs && fs.existsSync(abs)) {
        const nfcName = path.basename(abs).normalize("NFC");
        archive.file(abs, { name: nfcName });
        if (includeLyrics) {
          const lrcPath = abs.replace(/\.[^/.]+$/, "") + ".lrc";
          if (fs.existsSync(lrcPath)) {
            const lrcName = path.basename(lrcPath).normalize("NFC");
            archive.file(lrcPath, { name: lrcName });
          }
        }
      }
    }
    archive.finalize();
  });
}

// Cleans up temp files for core application logic.
function cleanupTempFiles(jobId, originalInputPath, downloadedPath = null) {
  try {
    const removeGeneratedFile = (candidate, roots) => {
      if (typeof candidate !== "string" || !candidate.trim()) return;
      try {
        const safe = assertPathWithinAny(path.resolve(candidate), roots);
        fs.rmSync(safe, { force: true });
      } catch {}
    };

    removeGeneratedFile(originalInputPath, [UPLOAD_DIR]);

    if (Array.isArray(downloadedPath)) {
      for (const filePath of downloadedPath) {
        removeGeneratedFile(filePath, [TEMP_DIR]);
      }
    } else {
      removeGeneratedFile(downloadedPath, [TEMP_DIR]);
    }

    const safeJobId = String(jobId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
    if (safeJobId) {
      const playlistDir = assertPathWithinAny(path.resolve(TEMP_DIR, safeJobId), [TEMP_DIR]);
      try { fs.rmSync(playlistDir, { recursive: true, force: true }); } catch {}
    }

    try {
      for (const name of fs.readdirSync(TEMP_DIR)) {
        if (!safeJobId || !String(name).includes(safeJobId)) continue;
        const candidate = assertPathWithinAny(path.resolve(TEMP_DIR, path.basename(name)), [TEMP_DIR]);
        try { fs.rmSync(candidate, { recursive: true, force: true }); } catch {}
      }
    } catch {}
  } catch {}
}
