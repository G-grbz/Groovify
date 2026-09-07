import fs from "fs";
import path from "path";
import { execFileSafe } from "./safeProcess.js";
import { resolveYtDlp, withYT403Workarounds, isMusicEnabled } from "./yt.js";
import { registerJobProcess } from "./store.js";
import crypto from "crypto";
import { getUserAgent, getYouTubeHeaders, addGeoArgs, getExtraArgs, FLAGS } from "./config.js";
import { addCookieArgs, getJsRuntimeArgs } from "./utils.js";
import { isSoundCloudDurationCompatible, isSoundCloudTextDurationMatch } from "./soundcloud.js";
import {
  buildCatalogMusicSearchQueries,
  isCatalogMusicProvider,
  isCatalogTextDurationMatch,
  scoreCatalogMusicCandidateText,
  isMappedMusicDurationCompatible,
  isMappedMusicDurationTight,
  MAPPED_MUSIC_YT_SEARCH_RESULTS,
  MAPPED_MUSIC_YT_SEARCH_RETRIES,
  MAPPED_MUSIC_YT_SEARCH_RETRY_BACKOFF_MS,
  MAPPED_MUSIC_YT_RATE_LIMIT_BACKOFF_MS,
  MAPPED_MUSIC_YT_SEARCH_STAGGER_MS
} from "./mappedMusicMatcher.js";

const BASE_DIR = process.env.DATA_DIR || process.cwd();
const TEMP_DIR = path.resolve(BASE_DIR, "temp");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const YT_SEARCH_RESULTS = Math.max(1, Math.min(10, Number(process.env.YT_SEARCH_RESULTS || 3)));
const YT_SEARCH_TIMEOUT_MS = Math.max(3000, Number(process.env.YT_SEARCH_TIMEOUT_MS || 20000));
const YT_SEARCH_STAGGER_MS = Math.max(0, Number(process.env.YT_SEARCH_STAGGER_MS || 140));
const YT_DOWNLOAD_RETRY_ATTEMPTS = Math.max(
  1,
  Number(process.env.YT_DOWNLOAD_RETRY_ATTEMPTS || 2)
);
const YT_DOWNLOAD_RETRY_BACKOFF_MS = Math.max(
  0,
  Number(process.env.YT_DOWNLOAD_RETRY_BACKOFF_MS || 1200)
);
const YT_DOWNLOAD_STALL_TIMEOUT_MS = Math.max(
  30000,
  Number(process.env.YT_DOWNLOAD_STALL_TIMEOUT_MS || 60000)
);
const YT_DOWNLOAD_HARD_TIMEOUT_MS = Math.max(
  YT_DOWNLOAD_STALL_TIMEOUT_MS * 2,
  Number(process.env.YT_DOWNLOAD_HARD_TIMEOUT_MS || 600000)
);
const YT_DOWNLOAD_WATCHDOG_POLL_MS = Math.max(
  1000,
  Math.min(10000, Number(process.env.YT_DOWNLOAD_WATCHDOG_POLL_MS || 5000))
);
const SOUNDCLOUD_YT_MIN_MATCH_SCORE = Math.max(1, Number(process.env.SOUNDCLOUD_YT_MIN_MATCH_SCORE || 6));
const SOUNDCLOUD_YT_RELAXED_MATCH_SCORE = Math.max(1, Number(process.env.SOUNDCLOUD_YT_RELAXED_MATCH_SCORE || 4));
const SOUNDCLOUD_YT_SEARCH_RESULTS = Math.max(5, Math.min(20, Number(process.env.SOUNDCLOUD_YT_SEARCH_RESULTS || 10)));
const SOUNDCLOUD_YT_TIGHT_DURATION_BASE_SEC = Math.max(3, Number(process.env.SOUNDCLOUD_YT_TIGHT_DURATION_BASE_SEC || 8));
const SOUNDCLOUD_YT_TIGHT_DURATION_RATIO = Math.max(0.01, Math.min(0.20, Number(process.env.SOUNDCLOUD_YT_TIGHT_DURATION_RATIO || 0.05)));
const SOUNDCLOUD_YT_DURATION_BASE_TOLERANCE_SEC = Math.max(5, Number(process.env.SOUNDCLOUD_YT_DURATION_BASE_TOLERANCE_SEC || 30));
const SOUNDCLOUD_YT_DURATION_RATIO_TOLERANCE = Math.max(0.05, Math.min(1, Number(process.env.SOUNDCLOUD_YT_DURATION_RATIO_TOLERANCE || 0.20)));
const SOUNDCLOUD_YT_DURATION_MIN_RATIO = Math.max(0.1, Math.min(1, Number(process.env.SOUNDCLOUD_YT_DURATION_MIN_RATIO || 0.65)));
const SOUNDCLOUD_YT_DURATION_MAX_RATIO = Math.max(1, Number(process.env.SOUNDCLOUD_YT_DURATION_MAX_RATIO || 1.5));
const YT_MATCH_PROBE_TIMEOUT_MS = Math.max(3000, Number(
  process.env.MAPPED_MUSIC_YT_PROBE_TIMEOUT_MS ||
  process.env.SOUNDCLOUD_YT_PROBE_TIMEOUT_MS ||
  20000
));
const _searchCache = new Map();
const _SEARCH_CACHE_MAX = 800;
let _catalogSearchCooldownUntil = 0;


function isYouTubeMusicUrl(value = "") {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "music.youtube.com";
  } catch {
    return false;
  }
}

function toStandardYouTubeUrl(value = "") {
  const parsed = new URL(String(value || "").trim());
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "music.youtube.com") {
    throw new Error("Not a YouTube Music URL");
  }
  parsed.hostname = "www.youtube.com";
  return parsed.toString();
}

// Derives the parent job id from indexed file ids for core application logic.
function deriveJobIdFromFileId(fileId = "") {
  const raw = String(fileId || "").trim();
  if (!raw) return "";
  const cut = raw.lastIndexOf("_");
  return cut > 0 ? raw.slice(0, cut) : raw;
}

function getDownloadActivitySignature(downloadDir, fileId) {
  try {
    const entries = fs.readdirSync(downloadDir, { withFileTypes: true });
    let totalSize = 0;
    let latestMtime = 0;
    let count = 0;

    for (const entry of entries) {
      if (!entry?.isFile?.() || !entry.name.startsWith(`${fileId}.`)) continue;
      const fullPath = path.join(downloadDir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        totalSize += Number(stat.size) || 0;
        latestMtime = Math.max(latestMtime, Number(stat.mtimeMs) || 0);
        count++;
      } catch {}
    }

    return `${count}:${totalSize}:${Math.floor(latestMtime)}`;
  } catch {
    return "0:0:0";
  }
}

function killDownloadProcessTree(child, signal = "SIGKILL") {
  const pid = Number(child?.pid);
  if (!pid) return false;

  if (process.platform === "win32") {
    try {
      execFileSafe(
        "taskkill",
        ["/pid", String(pid), "/T", "/F"],
        { windowsHide: true },
        () => {}
      );
      return true;
    } catch {}
  } else {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {}
  }

  try {
    return !!child.kill?.(signal);
  } catch {
    return false;
  }
}

function startYtDlpDownloadProcess(
  YTDLP_BIN,
  args,
  downloadDir,
  fileId,
  callback
) {
  let watchdogReason = "";
  let lastActivityAt = Date.now();
  let lastSignature = getDownloadActivitySignature(downloadDir, fileId);
  let watchdogInterval = null;
  let hardTimer = null;
  let child = null;

  const touch = () => {
    lastActivityAt = Date.now();
  };

  const clearWatchdog = () => {
    if (watchdogInterval) clearInterval(watchdogInterval);
    if (hardTimer) clearTimeout(hardTimer);
    watchdogInterval = null;
    hardTimer = null;
  };

  child = execFileSafe(
    YTDLP_BIN,
    args,
    {
      maxBuffer: 1024 * 1024 * 1024,
      windowsHide: true,
      // A dedicated process group lets cancellation/watchdog kills include
      // yt-dlp helper processes such as ffmpeg on POSIX systems.
      detached: process.platform !== "win32"
    },
    (err, stdout, stderr) => {
      clearWatchdog();
      callback(err, stdout, stderr, watchdogReason);
    }
  );

  child.stdout?.on?.("data", touch);
  child.stderr?.on?.("data", touch);

  watchdogInterval = setInterval(() => {
    const signature = getDownloadActivitySignature(downloadDir, fileId);
    if (signature !== lastSignature) {
      lastSignature = signature;
      touch();
      return;
    }

    if ((Date.now() - lastActivityAt) < YT_DOWNLOAD_STALL_TIMEOUT_MS) return;

    watchdogReason = `yt-dlp stalled for ${Math.round(YT_DOWNLOAD_STALL_TIMEOUT_MS / 1000)}s`;
    clearWatchdog();
    killDownloadProcessTree(child, "SIGKILL");
  }, YT_DOWNLOAD_WATCHDOG_POLL_MS);
  watchdogInterval.unref?.();

  hardTimer = setTimeout(() => {
    watchdogReason = `yt-dlp exceeded ${Math.round(YT_DOWNLOAD_HARD_TIMEOUT_MS / 1000)}s hard timeout`;
    clearWatchdog();
    killDownloadProcessTree(child, "SIGKILL");
  }, YT_DOWNLOAD_HARD_TIMEOUT_MS);
  hardTimer.unref?.();

  child.once?.("error", clearWatchdog);
  child.once?.("close", clearWatchdog);

  try {
    registerJobProcess(deriveJobIdFromFileId(fileId), child);
  } catch {}

  return child;
}
// Handles cached data get in core application logic.
function _cacheGet(k) { return _searchCache.has(k) ? _searchCache.get(k) : undefined; }
// Handles cached data set in core application logic.
function _cacheSet(k, v) {
  _searchCache.set(k, v);
  if (_searchCache.size > _SEARCH_CACHE_MAX) {
    const first = _searchCache.keys().next().value;
    _searchCache.delete(first);
  }
}

const SEARCH_CHAR_FOLD_MAP = Object.freeze({
  I: "i",
  İ: "i",
  ı: "i",
  Ş: "s",
  ş: "s",
  Ğ: "g",
  ğ: "g",
  Ü: "u",
  ü: "u",
  Ö: "o",
  ö: "o",
  Ç: "c",
  ç: "c",
  ß: "ss",
  Æ: "ae",
  æ: "ae",
  Œ: "oe",
  œ: "oe",
});

// Handles normalize matching text in core application logic.
function _normMatch(s = "") {
  return String(s)
    .replace(/[IİıŞşĞğÜüÖöÇçßÆæŒœ]/g, (ch) => SEARCH_CHAR_FOLD_MAP[ch] || ch)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Handles make map id in core application logic.
export function makeMapId() {
  return crypto.randomBytes(8).toString("hex");
}

// Returns YouTube metadata dlp search args lite used for core application logic.
function getYtDlpSearchArgsLite() {
  const ua = getUserAgent();
  const headers = getYouTubeHeaders();
  const base = [
    "--no-progress",
    "--no-warnings",
    "--skip-download",
    "--flat-playlist",
    "--dump-single-json",
    "--retries", "1",
    "--retry-sleep", "0",
    "--user-agent", ua,
    "--add-header", `Referer: ${headers["Referer"]}`,
    "--add-header", `Accept-Language: ${headers["Accept-Language"]}`,
    "--socket-timeout", "10",
  ];

  if (FLAGS.FORCE_IPV4) base.push("--force-ipv4");

  const geoArgs = addGeoArgs([]);
  if (geoArgs.length) base.push(...geoArgs);

  const extra = getExtraArgs();
  if (extra.length) base.push(...extra);

  return base;
}

// Runs YouTube metadata json lite for core application logic.
async function runYtJsonLite(urls, label = "ytm-search-lite", timeoutMs = YT_SEARCH_TIMEOUT_MS) {
  const YTDLP_BIN = resolveYtDlp();
  if (!YTDLP_BIN) throw new Error("yt-dlp not found");

  const args = withYT403Workarounds(
    [...getYtDlpSearchArgsLite(), ...(Array.isArray(urls) ? urls : [String(urls)])],
    { stripCookies: true }
  );

  return new Promise((resolve, reject) => {
    execFileSafe(
      YTDLP_BIN,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || "").split("\n").slice(-10).join("\n");
          return reject(new Error(`[${label}] yt-dlp error: ${err.code}\n${tail}`));
        }
        try {
          const s = String(stdout || "").trim();
          return resolve(s ? JSON.parse(s) : null);
        } catch (e) {
          const tail = String(stderr || "").split("\n").slice(-10).join("\n");
          return reject(new Error(`[${label}] JSON parse error: ${e.message}\n${tail}`));
        }
      }
    );
  });
}

function uniqueSearchQueries(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const query = String(value || "").replace(/\s+/g, " ").trim();
    if (!query) continue;
    const key = _normMatch(query);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(query);
  }
  return out;
}

export function buildMappedMusicSearchQueries(artist, title, { provider = "", sourceItem = null } = {}) {
  const sourceProvider = String(provider || "").trim().toLowerCase();
  const primaryArtist = String(sourceItem?.match_artist || sourceItem?.matchArtist || artist || "").trim();
  const primaryTitle = String(sourceItem?.match_title || sourceItem?.matchTitle || title || "").trim();
  const rawArtist = String(
    sourceItem?.soundcloud_raw_artist ||
    sourceItem?.artist ||
    sourceItem?.uploader ||
    artist ||
    ""
  ).trim();
  const rawTitle = String(
    sourceItem?.soundcloud_raw_title ||
    sourceItem?.title ||
    sourceItem?.track ||
    title ||
    ""
  ).trim();

  if (isCatalogMusicProvider(sourceProvider)) {
    // Catalog providers expose clean artist/title metadata. Keep the normal
    // artist+title query cheap, and use title-only only when the first search
    // cannot produce a safe candidate.
    return buildCatalogMusicSearchQueries(artist, title);
  }

  if (sourceProvider !== "soundcloud") {
    return uniqueSearchQueries([`${artist || ""} ${title || ""}`]);
  }

  // SoundCloud upload titles often already contain "Artist - Track" while the
  // uploader is merely the account name. Prefer the normalized identity first,
  // then progressively broader fallbacks only when that search is weak/empty.
  return uniqueSearchQueries([
    `${primaryArtist} ${primaryTitle}`,
    primaryTitle,
    `${rawArtist} ${primaryTitle}`,
    rawTitle,
    `${rawArtist} ${rawTitle}`
  ]);
}

function sourceDurationMs(sourceItem = null) {
  const direct = Number(sourceItem?.duration_ms ?? sourceItem?.durationMs ?? 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const seconds = Number(sourceItem?.duration || 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function entryDurationSeconds(entry = null) {
  const seconds = Number(entry?.duration ?? 0);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  const ms = Number(entry?.duration_ms ?? entry?.durationMs ?? 0);
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
}

function isUnsafeSoundCloudYouTubeCandidate(entry = null) {
  const status = String(entry?.live_status || '').toLowerCase();
  return entry?.is_live === true || status === 'is_live' || status === 'is_upcoming';
}

function scoreSearchEntries(entries, artist, title, { provider = '', sourceMs = 0 } = {}) {
  const aNorm = _normMatch(artist || '');
  const tNorm = _normMatch(title || '');
  const ranked = [];

  for (const e of entries) {
    const vid = e?.id;
    if (!vid) continue;

    if (provider === 'soundcloud') {
      if (isUnsafeSoundCloudYouTubeCandidate(e)) continue;
      const duration = entryDurationSeconds(e);
      if (duration > 0 && !isSoundCloudDurationCompatible(sourceMs, duration, {
        baseToleranceSec: SOUNDCLOUD_YT_DURATION_BASE_TOLERANCE_SEC,
        ratioTolerance: SOUNDCLOUD_YT_DURATION_RATIO_TOLERANCE,
        minRatio: SOUNDCLOUD_YT_DURATION_MIN_RATIO,
        maxRatio: SOUNDCLOUD_YT_DURATION_MAX_RATIO
      })) continue;
    } else if (isCatalogMusicProvider(provider)) {
      const status = String(e?.live_status || '').toLowerCase();
      if (e?.is_live === true || status === 'is_live' || status === 'is_upcoming') continue;
      const duration = entryDurationSeconds(e);
      if (duration > 0 && !isMappedMusicDurationCompatible(sourceMs, duration)) continue;
    }

    const et = _normMatch(e?.title || '');
    const ch = _normMatch(e?.uploader || e?.channel || '');
    let score = 0;

    if (isCatalogMusicProvider(provider)) {
      score = scoreCatalogMusicCandidateText(
        artist,
        title,
        e?.title || '',
        e?.uploader || e?.channel || ''
      );
    } else {
      if (tNorm) {
        if (et === tNorm) score += 6;
        else if (et.includes(tNorm) || tNorm.includes(et)) score += 4;
      }

      if (aNorm) {
        if (ch === aNorm) score += 4;
        else if (et.includes(aNorm) || ch.includes(aNorm)) score += 2;
      }

      if (aNorm && tNorm && et.includes(tNorm) && (et.includes(aNorm) || ch.includes(aNorm))) {
        score += 2;
      }

      if (/\btopic\b/.test(ch)) score += 1;
    }

    ranked.push({ entry: e, score, searchRank: ranked.length });
  }

  ranked.sort((a, b) => (b.score - a.score) || (a.searchRank - b.searchRank));
  return ranked;
}

function formatDurationSeconds(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return null;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function youtubeMatchFromEntry(entry = null) {
  const id = String(entry?.id || '').trim();
  if (!id) return null;
  const duration = entryDurationSeconds(entry) || null;
  const thumbnail = entry?.thumbnail ||
    (Array.isArray(entry?.thumbnails) ? entry.thumbnails.at(-1)?.url : null) ||
    null;
  const useMusic = isMusicEnabled();
  return {
    id,
    title: String(entry?.title || '').trim(),
    uploader: String(entry?.uploader || entry?.channel || '').trim(),
    duration,
    duration_string: entry?.duration_string || formatDurationSeconds(duration),
    webpage_url: useMusic
      ? `https://music.youtube.com/watch?v=${id}`
      : `https://www.youtube.com/watch?v=${id}`,
    thumbnail
  };
}

async function probeYouTubeCandidate(entry = null) {
  const id = String(entry?.id || '').trim();
  if (!id) return null;
  const YTDLP_BIN = resolveYtDlp();
  if (!YTDLP_BIN) throw new Error('yt-dlp not found');

  const args = withYT403Workarounds([
    ...getYtDlpCommonArgs(),
    '--skip-download',
    '--no-playlist',
    '--dump-single-json',
    '--socket-timeout', '10',
    `https://www.youtube.com/watch?v=${id}`
  ]);

  return new Promise((resolve, reject) => {
    execFileSafe(
      YTDLP_BIN,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: YT_MATCH_PROBE_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || '').split('\n').slice(-10).join('\n');
          return reject(new Error(`[ytm-duration-probe] yt-dlp error: ${err.code}\n${tail}`));
        }
        try {
          const parsed = String(stdout || '').trim();
          return resolve(parsed ? JSON.parse(parsed) : null);
        } catch (e) {
          return reject(new Error(`[ytm-duration-probe] JSON parse error: ${e.message}`));
        }
      }
    );
  });
}

async function verifySoundCloudCandidate(entry, sourceMs) {
  if (!entry?.id || !sourceMs) return entry;
  const knownDuration = entryDurationSeconds(entry);
  if (knownDuration > 0) {
    return isSoundCloudDurationCompatible(sourceMs, knownDuration, {
      baseToleranceSec: SOUNDCLOUD_YT_DURATION_BASE_TOLERANCE_SEC,
      ratioTolerance: SOUNDCLOUD_YT_DURATION_RATIO_TOLERANCE,
      minRatio: SOUNDCLOUD_YT_DURATION_MIN_RATIO,
      maxRatio: SOUNDCLOUD_YT_DURATION_MAX_RATIO
    }) ? entry : null;
  }

  try {
    const full = await probeYouTubeCandidate(entry);
    const candidate = { ...entry, ...(full || {}), id: entry.id };
    const duration = entryDurationSeconds(candidate);
    if (!duration || !isSoundCloudDurationCompatible(sourceMs, duration, {
        baseToleranceSec: SOUNDCLOUD_YT_DURATION_BASE_TOLERANCE_SEC,
        ratioTolerance: SOUNDCLOUD_YT_DURATION_RATIO_TOLERANCE,
        minRatio: SOUNDCLOUD_YT_DURATION_MIN_RATIO,
        maxRatio: SOUNDCLOUD_YT_DURATION_MAX_RATIO
      })) return null;
    return candidate;
  } catch {
    // Source duration is known. If we cannot verify the YouTube candidate,
    // rejecting it is safer than downloading an arbitrary long mix/video.
    return null;
  }
}

async function verifyCatalogCandidate(entry, sourceMs) {
  if (!entry?.id || !sourceMs) return entry;
  const knownDuration = entryDurationSeconds(entry);
  if (knownDuration > 0) {
    return isMappedMusicDurationCompatible(sourceMs, knownDuration) ? entry : null;
  }

  try {
    const full = await probeYouTubeCandidate(entry);
    const candidate = { ...entry, ...(full || {}), id: entry.id };
    const duration = entryDurationSeconds(candidate);
    if (!duration || !isMappedMusicDurationCompatible(sourceMs, duration)) return null;
    return candidate;
  } catch {
    // Catalog metadata normally has a precise source duration. If YouTube does
    // not expose enough metadata to validate a candidate, skip it rather than
    // downloading an arbitrary mix, live stream, lecture, or compilation.
    return null;
  }
}

async function waitForCatalogSearchCooldown(provider) {
  if (!isCatalogMusicProvider(provider)) return;
  const remaining = _catalogSearchCooldownUntil - Date.now();
  if (remaining > 0) await sleep(remaining);
}

function isYouTubeSearchRateLimitError(error) {
  const message = String(error?.message || error || '');
  return /(?:\b429\b|too many requests|rate.?limit|sign in to confirm you.?re not a bot)/i.test(message);
}

async function runMappedMusicSearchQuery(query, resultLimit, provider) {
  const catalogProvider = isCatalogMusicProvider(provider);
  const attempts = catalogProvider ? (1 + MAPPED_MUSIC_YT_SEARCH_RETRIES) : 1;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    await waitForCatalogSearchCooldown(provider);
    try {
      return await runYtJsonLite([`ytsearch${resultLimit}:${query}`], 'ytm-search-lite', YT_SEARCH_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
      if (catalogProvider && isYouTubeSearchRateLimitError(error)) {
        _catalogSearchCooldownUntil = Math.max(
          _catalogSearchCooldownUntil,
          Date.now() + MAPPED_MUSIC_YT_RATE_LIMIT_BACKOFF_MS
        );
        throw error;
      }
      if (attempt + 1 >= attempts) break;
      const jitter = Math.floor(Math.random() * 150);
      await sleep(MAPPED_MUSIC_YT_SEARCH_RETRY_BACKOFF_MS + jitter);
    }
  }
  throw lastError || new Error('YouTube search failed');
}

// Returns the best YouTube candidate plus its real metadata.
export async function searchYtmBestMatch(artist, title, options = {}) {
  const provider = String(options?.provider || '').trim().toLowerCase();
  const sourceItem = options?.sourceItem || null;
  const queries = buildMappedMusicSearchQueries(artist, title, { provider, sourceItem });
  if (!queries.length) return null;

  const sourceMs = sourceDurationMs(sourceItem);
  const cacheKey = `${provider || 'default'}|${Math.round(sourceMs || 0)}|${queries.map(_normMatch).join('|')}`;
  const cached = _cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const scoreArtist = sourceItem?.match_artist || sourceItem?.matchArtist || artist || '';
  const scoreTitle = sourceItem?.match_title || sourceItem?.matchTitle || title || '';
  const resultLimit = provider === 'soundcloud'
    ? Math.max(YT_SEARCH_RESULTS, SOUNDCLOUD_YT_SEARCH_RESULTS)
    : (isCatalogMusicProvider(provider) ? MAPPED_MUSIC_YT_SEARCH_RESULTS : YT_SEARCH_RESULTS);

  let bestMatch = null;
  let bestScore = -1;
  let firstFallback = null;
  let lastSearchError = null;
  let successfulSearchResponses = 0;

  for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
    const query = queries[queryIndex];
    let data = null;
    try {
      data = await runMappedMusicSearchQuery(query, resultLimit, provider);
    } catch (error) {
      if (provider !== 'soundcloud' && !isCatalogMusicProvider(provider)) throw error;
      if (isCatalogMusicProvider(provider) && isYouTubeSearchRateLimitError(error)) throw error;
      lastSearchError = error;
      // For catalog providers, a failed artist+title search may still recover
      // with the title-only query. SoundCloud likewise keeps its broader fallbacks.
      continue;
    }

    successfulSearchResponses++;
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    if (!entries.length) continue;

    const ranked = scoreSearchEntries(entries, scoreArtist, scoreTitle, { provider, sourceMs });
    for (const candidate of ranked) {
      let verifiedEntry = candidate.entry;
      if (provider === 'soundcloud' && sourceMs > 0) {
        verifiedEntry = await verifySoundCloudCandidate(verifiedEntry, sourceMs);
        if (!verifiedEntry) continue;
      } else if (isCatalogMusicProvider(provider) && sourceMs > 0) {
        verifiedEntry = await verifyCatalogCandidate(verifiedEntry, sourceMs);
        if (!verifiedEntry) continue;
      }

      const match = youtubeMatchFromEntry(verifiedEntry);
      if (!match) continue;
      if (!firstFallback) firstFallback = match;

      const candidateDuration = entryDurationSeconds(verifiedEntry);
      const accepted = provider === 'soundcloud'
        ? isSoundCloudTextDurationMatch(candidate.score, sourceMs, candidateDuration, scoreTitle, {
            strictScore: SOUNDCLOUD_YT_MIN_MATCH_SCORE,
            relaxedScore: SOUNDCLOUD_YT_RELAXED_MATCH_SCORE,
            tightBaseSec: SOUNDCLOUD_YT_TIGHT_DURATION_BASE_SEC,
            tightRatio: SOUNDCLOUD_YT_TIGHT_DURATION_RATIO
          })
        : isCatalogMusicProvider(provider)
          ? isCatalogTextDurationMatch(candidate.score, sourceMs, candidateDuration)
          : candidate.score > 0;
      if (!accepted) continue;

      const durationBonus = provider === 'soundcloud' && isSoundCloudTextDurationMatch(
        SOUNDCLOUD_YT_RELAXED_MATCH_SCORE,
        sourceMs,
        candidateDuration,
        scoreTitle,
        {
          strictScore: Number.MAX_SAFE_INTEGER,
          relaxedScore: SOUNDCLOUD_YT_RELAXED_MATCH_SCORE,
          tightBaseSec: SOUNDCLOUD_YT_TIGHT_DURATION_BASE_SEC,
          tightRatio: SOUNDCLOUD_YT_TIGHT_DURATION_RATIO
        }
      ) ? 2 : (isCatalogMusicProvider(provider) && isMappedMusicDurationTight(sourceMs, candidateDuration) ? 1 : 0);
      const effectiveScore = candidate.score + durationBonus;
      if (effectiveScore > bestScore) {
        bestScore = effectiveScore;
        bestMatch = match;
      }

      // Catalog candidates in the same ytsearch response must be compared, not
      // accepted on the first safe hit. This lets a cleaner top-ranked title
      // beat a noisier but still technically valid result without issuing an
      // additional YouTube search. Because duration can add at most one point,
      // stop once a lower text score can no longer catch the current winner.
      if (isCatalogMusicProvider(provider) && bestMatch && candidate.score + 1 < bestScore) break;
      if (provider === 'soundcloud' && candidate.score >= SOUNDCLOUD_YT_MIN_MATCH_SCORE) break;
      if (provider !== 'soundcloud' && candidate.score >= 6) break;
    }

    if (isCatalogMusicProvider(provider) && bestMatch) break;
    if (provider !== 'soundcloud' && !isCatalogMusicProvider(provider) && bestScore >= 6) break;
    if (provider === 'soundcloud' && bestMatch && bestScore >= SOUNDCLOUD_YT_MIN_MATCH_SCORE + 2) break;
  }

  const fallback = (provider === 'soundcloud' || isCatalogMusicProvider(provider))
    ? bestMatch
    : (bestScore > 0 ? bestMatch : firstFallback);
  if (!fallback && lastSearchError && isCatalogMusicProvider(provider) && successfulSearchResponses === 0) throw lastSearchError;
  if (!fallback && lastSearchError && provider !== 'soundcloud' && !isCatalogMusicProvider(provider)) throw lastSearchError;
  _cacheSet(cacheKey, fallback || null);
  return fallback || null;
}

// Backward-compatible id-only API.
export async function searchYtmBestId(artist, title, options = {}) {
  const match = await searchYtmBestMatch(artist, title, options);
  return match?.id || null;
}

// Handles ids to music URLs in core application logic.
export function idsToMusicUrls(ids, useMusic = isMusicEnabled()) {
  return ids.map((id) =>
    useMusic
      ? `https://music.youtube.com/watch?v=${id}`
      : `https://www.youtube.com/watch?v=${id}`
  );
}

// Returns YouTube metadata dlp common args used for core application logic.
function getYtDlpCommonArgs() {
  const ua = getUserAgent();
  const headers = getYouTubeHeaders();
  const base = [
    "--no-progress",
    "--no-warnings",
    "--retries", "10",
    "--fragment-retries", "10",
    "--retry-sleep", "3",
    "--user-agent", ua,
    "--add-header", `Referer: ${headers["Referer"]}`,
    "--add-header", `Accept-Language: ${headers["Accept-Language"]}`,
  ];

  if (FLAGS.FORCE_IPV4) {
    base.push("--force-ipv4");
  }

  const geoArgs = addGeoArgs([]);
  if (geoArgs.length) base.push(...geoArgs);

  const extra = getExtraArgs();
  if (extra.length) base.push(...extra);

  addCookieArgs(base);
  base.push(...getJsRuntimeArgs());

  return base;
}

// Handles map Spotify metadata to ytm in core application logic.
export async function mapSpotifyToYtm(
  sp,
  onUpdate,
  { concurrency = 3, onLog = null, shouldCancel = null } = {}
) {
  if (!Array.isArray(sp?.items) || sp.items.length === 0) {
    return [];
  }

  let i = 0,
    running = 0;
  const results = new Array(sp.items.length);
  const useMusic = isMusicEnabled();
  const mappingProvider = String(sp?.provider || '').trim().toLowerCase();
  const effectiveConcurrency = isCatalogMusicProvider(mappingProvider)
    ? Math.max(1, Math.min(Number(concurrency) || 1, 3))
    : Math.max(1, Number(concurrency) || 1);
  const effectiveStaggerMs = isCatalogMusicProvider(mappingProvider)
    ? Math.max(YT_SEARCH_STAGGER_MS, MAPPED_MUSIC_YT_SEARCH_STAGGER_MS)
    : YT_SEARCH_STAGGER_MS;
  return new Promise((resolve) => {
    // Handles kick in core application logic.
    const kick = () => {
      if (shouldCancel && shouldCancel()) {
        return resolve(results);
      }
      while (running < effectiveConcurrency && i < sp.items.length) {
        const idx = i++;
        running++;
        (async () => {
          const it = sp.items[idx];
          if (shouldCancel && shouldCancel()) {
            results[idx] = null;
            return;
          }

          if (effectiveStaggerMs > 0) {
            const slot = idx % effectiveConcurrency;
            const jitter = Math.floor(Math.random() * 25);
            await sleep((slot * effectiveStaggerMs) + jitter);
          }

          if (onLog)
            onLog({
              logKey: "log.searchingTrack",
              logVars: { artist: it.artist, title: it.title },
              fallback: `🔍 Searching: ${it.artist} - ${it.title}`,
            });
          let ytMatch = null;
          try {
            const searchArtist = it.match_artist || it.matchArtist || it.artist;
            const searchTitle = it.match_title || it.matchTitle || it.title;
            ytMatch = await searchYtmBestMatch(searchArtist, searchTitle, {
              provider: sp?.provider || it?.source_provider || "",
              sourceItem: it
            });
            if (onLog && ytMatch?.id)
              onLog({
                logKey: "log.foundTrack",
                logVars: { artist: it.artist, title: it.title },
                fallback: `✅ Found: ${it.artist} - ${it.title}`,
              });
            else if (onLog)
              onLog({
                logKey: "log.notFoundTrack",
                logVars: { artist: it.artist, title: it.title },
                fallback: `❌ Not found: ${it.artist} - ${it.title}`,
              });
          } catch (e) {
            if (onLog)
              onLog({
                logKey: "log.searchError",
                logVars: {
                  artist: it.artist,
                  title: it.title,
                  err: e.message,
                },
                fallback: `❌ Search error: ${it.artist} - ${it.title} (${e.message})`,
              });
          }
          const vid = ytMatch?.id || null;
          const item = {
            index: idx + 1,
            id: vid,
            title: it.title,
            uploader: it.artist,
            duration: ytMatch?.duration || null,
            duration_string: ytMatch?.duration_string || null,
            webpage_url: ytMatch?.webpage_url || (vid
              ? useMusic
                ? `https://music.youtube.com/watch?v=${vid}`
                : `https://www.youtube.com/watch?v=${vid}`
              : ""),
            thumbnail: ytMatch?.thumbnail || null,
          };
          results[idx] = item;
          onUpdate(idx, item);
        })()
          .finally(() => {
            running--;
            if (shouldCancel && shouldCancel()) return resolve(results);
            if (i >= sp.items.length && running === 0) resolve(results);
            else kick();
          });
      }
    };
    kick();
  });
}

// Downloads matched Spotify metadata tracks for core application logic.
export async function downloadMatchedSpotifyTracks(
  matchedItems,
  jobId,
  onProgress,
  onLog = null
) {
  const downloadDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(downloadDir, { recursive: true });

  const results = [];
  let completed = 0;
  const total = matchedItems.length;
  const concurrency = 4;
  let currentIndex = 0;
  let running = 0;

  if (onLog)
    onLog({
      logKey: "log.downloading.batchStart",
      logVars: { total, concurrency },
      fallback: `🚀 Starting parallel download of ${total} tracks (max ${concurrency} concurrent)...`,
    });

  return new Promise((resolve, _reject) => {
    // Processes next in core application logic.
    const processNext = async () => {
      while (running < concurrency && currentIndex < total) {
        const index = currentIndex++;
        const item = matchedItems[index];
        running++;

        if (onLog)
          onLog({
            logKey: "log.downloading.start",
            logVars: {
              cur: index + 1,
              total,
              artist: item.uploader,
              title: item.title,
            },
            fallback: `📥 Downloading (${index + 1}/${total}): ${item.uploader} - ${item.title}`,
          });

        try {
          const filePath = await downloadSingleYouTubeVideo(
            item.webpage_url,
            `${jobId}_${index}`,
            downloadDir
          );

          results.push({
            index: item.index,
            title: item.title,
            uploader: item.uploader,
            filePath,
            item,
          });

          completed++;
          if (onProgress) onProgress(completed, total);
          if (onLog)
            onLog({
              logKey: "log.downloading.ok",
              logVars: {
                cur: index + 1,
                total,
                artist: item.uploader,
                title: item.title,
              },
              fallback: `✅ Downloaded (${index + 1}/${total}): ${item.uploader} - ${item.title}`,
            });
        } catch (error) {
          if (onLog)
            onLog({
              logKey: "log.downloading.err",
              logVars: {
                cur: index + 1,
                total,
                artist: item.uploader,
                title: item.title,
                err: error.message,
              },
              fallback: `❌ Download error (${index + 1}/${total}): ${item.uploader} - ${item.title} - ${error.message}`,
            });
          results.push({
            index: item.index,
            title: item.title,
            uploader: item.uploader,
            filePath: null,
            item,
            error: error.message,
          });
          completed++;
          if (onProgress) onProgress(completed, total);
        } finally {
          running--;
          processNext();
        }
      }

      if (completed === total && running === 0) {
        const successful = results.filter((r) => r.filePath).length;
        if (onLog)
          onLog({
            logKey: "log.downloading.summary",
            logVars: { ok: successful, total },
            fallback: `📊 Download completed: ${successful}/${total} tracks successfully downloaded`,
          });
        resolve(results.sort((a, b) => a.index - b.index));
      }
    };

    processNext();
  });
}

// Downloads single you tube video for one attempt in core application logic.
async function downloadSingleYouTubeVideoOnce(url, fileId, downloadDir) {
  const YTDLP_BIN = resolveYtDlp();
  if (!YTDLP_BIN) throw new Error("yt-dlp not found");

  const template = path.join(downloadDir, `${fileId}.%(ext)s`);

  try {
    const pre = fs
      .readdirSync(downloadDir)
      .filter(
        (f) =>
          f.startsWith(`${fileId}.`) &&
          /(\.(mp4|webm|m4a|mp3|opus|flac|wav|aac|ogg))$/i.test(f)
      );
    if (pre.length > 0) return path.join(downloadDir, pre[0]);
  } catch {}

  const base = [
    "-f",
    "bestaudio[abr>=128]/bestaudio/best",
    "--no-playlist",
    "--continue",
    "--no-overwrites",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--socket-timeout",
    "15",
    "--concurrent-fragments",
    "1",
    "--write-thumbnail",
    "-o",
    template,
  ];

  let args = [...getYtDlpCommonArgs(), "--no-abort-on-error", ...base, url];
  const stripCookies = FLAGS.STRIP_COOKIES;
  let finalArgs = withYT403Workarounds(args, { stripCookies });

  return new Promise((resolve, reject) => {
    // Finds downloaded for core application logic.
    const findDownloaded = () => {
      try {
        const files = fs
          .readdirSync(downloadDir)
          .filter(
            (f) =>
              f.startsWith(`${fileId}.`) &&
              /(\.(mp4|webm|m4a|mp3|opus|flac|wav|aac|ogg))$/i.test(f)
          );
        return files.length > 0 ? path.join(downloadDir, files[0]) : null;
      } catch {
        return null;
      }
    };

    const finishAttempt = (
      err,
      _stdout,
      stderr,
      watchdogReason,
      { allowMusicFallback = true } = {}
    ) => {
      if (!err) {
        const p = findDownloaded();
        return p ? resolve(p) : reject(new Error("File downloaded but not found"));
      }

      // With yt-dlp's normal .part behavior, a final media extension indicates
      // that the media file itself finished even if a later optional step failed.
      const have = findDownloaded();
      if (have) return resolve(have);

      if (watchdogReason) {
        return reject(new Error(watchdogReason));
      }

      const stderrStr = String(stderr || "");
      const is403 = /403|Forbidden/i.test(stderrStr);
      const isMusic = isYouTubeMusicUrl(url);

      if (allowMusicFallback && is403 && isMusic) {
        const fallbackUrl = toStandardYouTubeUrl(url);
        const retryArgs = finalArgs
          .map((x) => x)
          .filter((x) => x !== url)
          .concat(fallbackUrl);
        const idxExtr = retryArgs.findIndex(
          (v, i) => v === "--extractor-args"
        );
        if (idxExtr >= 0 && retryArgs[idxExtr + 1]) {
          retryArgs[idxExtr + 1] = "youtube:player_client=android,web";
        }

        startYtDlpDownloadProcess(
          YTDLP_BIN,
          retryArgs,
          downloadDir,
          fileId,
          (err2, so2, se2, fallbackWatchdogReason) => {
            finishAttempt(
              err2,
              so2,
              se2,
              fallbackWatchdogReason,
              { allowMusicFallback: false }
            );
          }
        );
        return;
      }

      const tail = stderrStr.split("\n").slice(-10).join("\n");
      return reject(new Error(`yt-dlp error: ${err.code}\n${tail}`));
    };

    startYtDlpDownloadProcess(
      YTDLP_BIN,
      finalArgs,
      downloadDir,
      fileId,
      (err, stdout, stderr, watchdogReason) => {
        finishAttempt(err, stdout, stderr, watchdogReason);
      }
    );
  });
}

// Downloads single you tube video with outer retry in core application logic.
export async function downloadSingleYouTubeVideo(url, fileId, downloadDir) {
  let lastError = null;

  for (let attempt = 1; attempt <= YT_DOWNLOAD_RETRY_ATTEMPTS; attempt++) {
    try {
      return await downloadSingleYouTubeVideoOnce(url, fileId, downloadDir);
    } catch (error) {
      lastError = error;
      if (attempt >= YT_DOWNLOAD_RETRY_ATTEMPTS) break;

      console.warn(
        `[downloadSingleYouTubeVideo] retry ${attempt}/${YT_DOWNLOAD_RETRY_ATTEMPTS - 1} for ${fileId}: ${
          error?.message || error
        }`
      );

      if (YT_DOWNLOAD_RETRY_BACKOFF_MS > 0) {
        await sleep(YT_DOWNLOAD_RETRY_BACKOFF_MS * attempt);
      }
    }
  }

  throw lastError || new Error("yt-dlp download failed");
}

// Creates download metadata queue for core application logic.
export function createDownloadQueue(
  jobId,
  { concurrency = 4, onProgress, onLog, shouldCancel, onItemDone } = {}
) {
  const downloadDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(downloadDir, { recursive: true });

  let running = 0;
  const q = [];
  const results = [];
  let total = 0,
    done = 0;
  let idleResolve;
  let ended = false;

  // Handles pump in core application logic.
  const pump = async () => {
    while (running < concurrency && q.length) {
      if (shouldCancel && shouldCancel()) {
        q.length = 0;
        if (running === 0 && idleResolve) idleResolve();
        return;
      }
      const task = q.shift();
      running++;
      const { item, idx } = task;
      if (onLog)
        onLog({
          logKey: "log.downloading.start",
          logVars: {
            cur: done + 1,
            total,
            artist: item.uploader,
            title: item.title,
          },
          fallback: `📥 Downloading (${done + 1}/${total}): ${item.uploader} - ${item.title}`,
        });
      try {
        const filePath = await downloadSingleYouTubeVideo(
          item.webpage_url,
          `${jobId}_${idx}`,
          downloadDir
        );

        const dlResult = {
          index: item.index,
          idxZeroBased: idx,
          title: item.title,
          uploader: item.uploader,
          filePath,
          item,
        };

        results.push(dlResult);

        if (onLog)
          onLog({
            logKey: "log.downloading.ok",
            logVars: { artist: item.uploader, title: item.title },
            fallback: `✅ Downloaded: ${item.uploader} - ${item.title}`,
          });

        if (onItemDone && filePath) {
          try {
            onItemDone(dlResult, idx);
          } catch (e) {
            console.warn("[downloadQueue] onItemDone error:", e);
          }
        }
      } catch (e) {
        const dlResult = {
          index: item.index,
          idxZeroBased: idx,
          title: item.title,
          uploader: item.uploader,
          filePath: null,
          item,
          error: e.message,
        };

        results.push(dlResult);

        if (onLog)
          onLog({
            logKey: "log.downloading.err",
            logVars: {
              artist: item.uploader,
              title: item.title,
              err: e.message,
            },
            fallback: `❌ Download error: ${item.uploader} - ${item.title} - ${e.message}`,
          });
        } finally {
          done++;
          if (onProgress) onProgress(done, total);
          running--;
          if (shouldCancel && shouldCancel()) {
            q.length = 0;
            if (running === 0 && idleResolve) idleResolve();
            return;
          }
          if (q.length) pump();
          else if (ended && running === 0 && idleResolve) idleResolve();
        }
      }
    };

  return {
    // Handles enqueue in core application logic.
    enqueue(item, idxZeroBased) {
      total++;
      q.push({ item, idx: idxZeroBased });
      pump();
    },
    // Handles wait for idle in core application logic.
    async waitForIdle() {
      if (running === 0 && q.length === 0) return;
      return new Promise((res) => {
        idleResolve = res;
      });
    },
    // Handles end in core application logic.
    end() {
      ended = true;
      if (q.length === 0 && running === 0 && idleResolve) idleResolve();
    },
    // Returns results used for core application logic.
    getResults() {
      return results.sort((a, b) => a.index - b.index);
    },
  };
}
