import path from "path";
import fs from "fs";
import { spawnSafe } from "./safeProcess.js";
import { createHash } from "crypto";
import { registerJobProcess } from "./store.js";
import { getCache, setCache, mergeCacheEntries, PREVIEW_MAX_ENTRIES } from "./cache.js";
import { findOnPATH, isExecutable, toNFC, addCookieArgs, getJsRuntimeArgs, parseIdFromPath } from "./utils.js";
import { getYouTubeHeaders, getUserAgent, addGeoArgs, getExtraArgs, getLocaleConfig, FLAGS } from "./config.js";
import {
  YTDLP_BIN as BINARY_YTDLP_BIN,
  DENO_BIN,
  FFMPEG_BIN as BINARY_FFMPEG_BIN,
  getBinaryRuntimeEnv
} from "./binaries.js";
import { parseSafeYtDlpExtra } from "./security.js";
import { requestYtMusicJson, createYtMusicRequestGate } from "./ytMusicRequest.js";
import { createYtMusicSharedCache } from "./ytMusicSharedCache.js";
import {
  normalizeYtMusicAlbumEntry,
  normalizeYtMusicAlbumMeta,
  normalizeYtMusicAlbumTitle,
  normalizeYtMusicByline,
  pickYtMusicAlbumArtist,
  isYtMusicAlbumContext
} from "./ytMusicMetadata.js";

// Checks whether music enabled is valid for the yt-dlp YouTube download pipeline.
export function isMusicEnabled() {
  const v = process.env.YT_USE_MUSIC;
  if (v === "0") return false;
  if (v === "1") return true;
  return false;
}

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_USER_AGENT = getUserAgent();
const DEFAULT_HEADERS = getYouTubeHeaders();
const SKIP_RE = /(private|members\s*only|copyright|blocked|region|geo|not\s+available|unavailable|age[-\s]?restricted|signin|sign\s*in|skipp?ed|removed)/i;
const ERROR_WORD = /\berror\b/i;
const DEFAULT_FRAGMENT_CONCURRENCY = 4;
const MEDIA_OUTPUT_EXT_RE = /\.(mp4|webm|m4a|mp3|opus|mkv|mka|flac|wav|aac|ogg)$/i;
const AUTOMIX_ALL_TIMEOUT =
  Number(process.env.AUTOMIX_ALL_TIMEOUT_MS || 25000);

const AUTOMIX_PAGE_TIMEOUT =
  Number(process.env.AUTOMIX_PAGE_TIMEOUT_MS || 45000);

const PLAYLIST_ALL_TIMEOUT =
  Number(process.env.PLAYLIST_ALL_TIMEOUT_MS || 30000);

const PLAYLIST_PAGE_TIMEOUT =
  Number(process.env.PLAYLIST_PAGE_TIMEOUT_MS || 20000);

const PLAYLIST_META_TIMEOUT =
  Number(process.env.PLAYLIST_META_TIMEOUT_MS || 25000);

const PLAYLIST_META_FALLBACK_TIMEOUT =
  Number(process.env.PLAYLIST_META_FALLBACK_TIMEOUT_MS || 15000);

const DM_IMPERSONATION_HINT =
  "Dailymotion requires yt-dlp impersonation dependencies (curl_cffi). Rebuild/install yt-dlp with curl-cffi support.";

const YTM_ORIGIN = "https://music.youtube.com";
const YTM_HOME_BROWSE_ID = "FEmusic_home";
const YTM_HOME_BROWSE_URL = `${YTM_ORIGIN}/browse/${YTM_HOME_BROWSE_ID}`;
const YTM_HOME_RESULT_CACHE_TTL_MS = Math.max(
  15_000,
  Math.min(60 * 60_000, Number(process.env.YTM_HOME_RESULT_CACHE_TTL_MS || 600_000) || 600_000)
);
const ytmSharedCache = createYtMusicSharedCache({
  file: process.env.YTM_SHARED_CACHE_PERSIST === "0" ? null : path.resolve(
    process.env.DATA_DIR || process.cwd(), "cache", "youtube-music-cache.json"
  )
});
process.once("exit", () => ytmSharedCache.close());
const ytmApiGate = createYtMusicRequestGate({
  minIntervalMs: getDiscoverNumber(process.env.YTM_API_MIN_INTERVAL_MS ?? 500, 500, 0, 10000),
  state: ytmSharedCache.map("request-state")
});
const ytmRateLimitWarning = "YouTube geçici istek sınırı uyguladı; mevcut içerikler korunuyor ve yeni sorgular bekletiliyor.";

async function requestSharedYtmJson(fetchPage, { timeoutMs, deadline = Date.now() + timeoutMs, retries = 1 } = {}) {
  return ytmApiGate.run(() => requestYtMusicJson(async (signal) => {
    if (ytmApiGate.retryAfterMs()) throw Object.assign(new Error(ytmRateLimitWarning), { code: "YTM_RATE_LIMITED", status: 429 });
    const response = await fetchPage(signal);
    if (response.status === 429) {
      const error = ytmApiGate.rateLimited(response.headers?.get?.("retry-after"));
      try { await response.body?.cancel?.(); } catch {}
      throw error;
    }
    return response;
  }, { timeoutMs, deadline, retries }), { deadline });
}
const YTM_COOKIE_EXPORT_DIR = path.resolve(
  process.env.DATA_DIR || process.cwd(),
  "temp",
  "ytmusic-home-cookies"
);

// Checks whether benign sabr warning is valid for the yt-dlp YouTube download pipeline.
function isBenignSabrWarning(line) {
  if (!line) return false;
  const s = String(line);
  return (
    /SABR streaming for this client/i.test(s) &&
    /Some web(?:_safari)? client https formats have been skipped as they are missing a url/i.test(s)
  );
}

// Checks whether transient retry line is valid for the yt-dlp YouTube download pipeline.
function isTransientRetryLine(line) {
  if (!line) return false;
  const s = String(line);
  return (
    /\bRetrying\s*\(\d+\/\d+\)/i.test(s) ||
    /\[download\]\s+Got error:/i.test(s)
  );
}

// Checks whether impersonation target error is valid for the yt-dlp YouTube download pipeline.
function isImpersonationUnavailableError(message = "") {
  const s = String(message || "");
  if (!s) return false;
  return (
    /attempting impersonation/i.test(s) &&
    /none of these impersonate targets are available|no impersonate target is available/i.test(s)
  );
}

// Adds dailymotion impersonation hint for the yt-dlp YouTube download pipeline.
function withDailymotionImpersonationHint(error, sourceUrl = "") {
  const msg = String(error?.message || error || "");
  if (!isDailymotionUrl(sourceUrl) || !isImpersonationUnavailableError(msg)) {
    return error instanceof Error ? error : new Error(msg);
  }

  return new Error(`${msg}\n${DM_IMPERSONATION_HINT}`);
}

// Normalizes concurrency for the yt-dlp YouTube download pipeline.
function normalizeConcurrency(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return 4;
  return Math.max(1, Math.min(16, Math.round(num)));
}

function getYtDlpJobSpawnOptions(options = {}) {
  return {
    ...options,
    env: getBinaryRuntimeEnv(options.env),
    detached: process.platform !== "win32"
  };
}

function terminateYtDlpJobProcess(child, signal = "SIGTERM") {
  const pid = Number(child?.pid);
  if (!pid) return;

  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {}
  }

  try { child.kill(signal); } catch {}
}

// Checks whether yt-dlp destination should count as a media item.
function isCountableMediaDestination(dest = "") {
  const target = String(dest || "").trim().split("?")[0];
  if (!target) return false;
  return MEDIA_OUTPUT_EXT_RE.test(target);
}

// Runs with concurrency for the yt-dlp YouTube download pipeline.
async function runWithConcurrency(limit, tasks) {
  const max = Math.max(1, Number(limit) || 1);
  if (!tasks.length) return;

  let index = 0;
  let active = 0;
  let fatalError = null;

  return new Promise((resolve, reject) => {
    // Handles next in the yt-dlp YouTube download pipeline.
    const next = () => {
      if (fatalError) return;
      if (index >= tasks.length && active === 0) {
        return resolve();
      }

      while (active < max && index < tasks.length) {
        const i = index++;
        active++;

        Promise.resolve()
          .then(() => tasks[i]())
          .catch(err => {
            fatalError = err;
            reject(err);
          })
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });
}

// Handles headers to args in the yt-dlp YouTube download pipeline.
function headersToArgs(headersObj) {
  const out = [];
  for (const key of ["Referer", "Origin", "Accept-Language"]) {
    const val = headersObj?.[key];
    if (val) out.push("--add-header", `${key}: ${val}`);
  }
  return out;
}

// Handles emit event in the yt-dlp YouTube download pipeline.
function emitEvent(progressCallback, opts, payload) {
  if (opts && typeof opts.onEvent === "function") {
    try { opts.onEvent(payload); } catch {}
  }
  if (typeof progressCallback === "function") {
    try { progressCallback({ __event: true, ...payload }); } catch {}
  }
}

// Normalizes you tube URL for the yt-dlp YouTube download pipeline.
export function normalizeYouTubeUrl(input) {
  try {
    let url = new URL(input);
    url.hostname = url.hostname.replace(/^m\./, "www.");
    if (url.hostname === "youtu.be") {
      const id = url.pathname.replace(/^\/+/, "");
      const list = url.searchParams.get("list");
      url = new URL("https://www.youtube.com/watch");
      if (id) url.searchParams.set("v", id);
      if (list) url.searchParams.set("list", list);
    }

    if (isMusicEnabled() && url.hostname === "www.youtube.com" &&
        url.pathname === "/watch" && url.searchParams.get("v")) {
      url.hostname = getLocaleConfig().hostnameForWatch(true);
    }

    const DROP_PARAMS = ["feature", "pp", "si", "start_radio", "persist_app", "t"];
    DROP_PARAMS.forEach(param => url.searchParams.delete(param));

    url.hash = "";
    if (typeof url.searchParams.sort === "function") {
      url.searchParams.sort();
    }

    return url.toString();
  } catch {
    return String(input).replace(/([&?])index=\d+/i, "$1").replace(/[?&]$/, "");
  }
}

// Checks whether you tube URL is valid for the yt-dlp YouTube download pipeline.
export const isYouTubeUrl = (url) => {
  const s = String(url || "").trim();
  if (!s) return false;
  try {
    const parsed = new URL(s);
    const host = parsed.hostname.toLowerCase();
    return host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtu.be" ||
      host.endsWith(".youtu.be");
  } catch {
    return false;
  }
};

// Checks whether dailymotion URL is valid for the yt-dlp YouTube download pipeline.
export const isDailymotionUrl = (url) => {
  const s = String(url || "").trim();
  if (!s) return false;
  try {
    const host = new URL(s).hostname.toLowerCase();
    return (
      host === "dailymotion.com" || host.endsWith(".dailymotion.com") ||
      host === "dai.ly" ||
      host.endsWith(".dai.ly")
    );
  } catch {
    return /(?:^|\/\/)(?:www\.)?(?:dailymotion\.com|dai\.ly)\//i.test(s);
  }
};

const DM_NO_IMPERSONATION_EXTRACTOR_ARGS = [
  "generic:impersonate=false",
  "dailymotion:impersonate=false"
];

// Strips impersonation args for the yt-dlp YouTube download pipeline.
function stripImpersonationArgs(args = []) {
  const out = [];
  const input = Array.isArray(args) ? args : [];

  for (let i = 0; i < input.length; i++) {
    const current = input[i];
    if (current === "--impersonate") {
      i += 1;
      continue;
    }

    if (current === "--extractor-args") {
      const value = String(input[i + 1] || "");
      if (/impersonate\s*=/i.test(value)) {
        i += 1;
        continue;
      }
    }

    out.push(current);
  }

  return out;
}

// Applies dailymotion no-impersonation args for the yt-dlp YouTube download pipeline.
function withDailymotionNoImpersonation(args = [], sourceUrl = "") {
  if (!isDailymotionUrl(sourceUrl)) {
    return Array.isArray(args) ? [...args] : [];
  }

  const out = stripImpersonationArgs(args);
  DM_NO_IMPERSONATION_EXTRACTOR_ARGS.forEach((value) => {
    out.push("--extractor-args", value);
  });
  return out;
}

// Builds video format selector for the yt-dlp YouTube download pipeline.
function buildVideoFormatSelector(sourceUrl, maxHeight = 1080) {
  const h = Number.isFinite(Number(maxHeight)) ? Number(maxHeight) : 1080;
  const s = String(sourceUrl || "");
  const isYouTubeLike = isYouTubeUrl(s) || isDailymotionUrl(s);

  if (isYouTubeLike) {
    return (
      `bestvideo[height<=${h}]+bestaudio[abr>=128][vcodec=none]/` +
      `bestvideo[height<=${h}]+bestaudio[vcodec=none]/` +
      `best[vcodec!=none][height<=${h}]/` +
      `best[vcodec!=none]/best`
    );
  }

  return (
    `best[height<=${h}]/` +
    `bestvideo[height<=${h}]+bestaudio/` +
    `bestvideo+bestaudio/` +
    `best`
  );
}

// Checks whether you tube playlist data is valid for the yt-dlp YouTube download pipeline.
export const isYouTubePlaylist = (url) => {
  const s = String(url || "").trim();
  if (!s) return false;
  try {
    const parsed = new URL(s);
    const host = parsed.hostname.toLowerCase();
    const isYoutubeHost =
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtu.be" ||
      host.endsWith(".youtu.be");
    if (!isYoutubeHost) return false;
    if (parsed.searchParams.has("list")) return true;
    if (parsed.pathname === "/playlist" || parsed.pathname.startsWith("/playlist/")) return true;
    return host === "music.youtube.com" && /^\/browse\/MPRE[A-Za-z0-9_-]*$/i.test(parsed.pathname);
  } catch {
    return false;
  }
};

// Checks whether dailymotion playlist data is valid for the yt-dlp YouTube download pipeline.
export const isDailymotionPlaylist = (url) => {
  if (!isDailymotionUrl(url)) return false;
  const s = String(url || "");
  try {
    const u = new URL(s);
    return /\/playlist\//i.test(u.pathname) || u.searchParams.has("playlist");
  } catch {
    return /\/playlist\//i.test(s) || /[?&]playlist=/.test(s);
  }
};

export const isYouTubeAutomix = (url) =>
  String(url || "").includes("&index=") ||
  (String(url || "").includes("/watch?v=") &&
    String(url || "").includes("&list=RD")) ||
  String(url || "").toLowerCase().includes("automix") ||
  String(url || "").includes("list=RD");

// Resolves YouTube metadata dlp for the yt-dlp YouTube download pipeline.
export function resolveYtDlp() {
  const fromEnv = process.env.YTDLP_BIN;
  if (fromEnv && isExecutable(fromEnv)) {
    return fromEnv;
  }

  if (BINARY_YTDLP_BIN && isExecutable(BINARY_YTDLP_BIN)) {
    return BINARY_YTDLP_BIN;
  }

  if (process.platform !== "win32") {
    const commonPaths = [
      "/usr/local/bin/yt-dlp",
      "/usr/bin/yt-dlp",
      path.join(process.env.HOME || "", ".local/bin/yt-dlp")
    ];

    for (const p of commonPaths) {
      if (p && isExecutable(p)) return p;
    }
  }

  const fromPATH = findOnPATH(process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  if (fromPATH && isExecutable(fromPATH)) {
    return fromPATH;
  }

  return null;
}

function resolveYtDlpFfmpegLocation() {
  const fromEnv = String(process.env.FFMPEG_BIN || "").trim();
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;
  if (BINARY_FFMPEG_BIN && isExecutable(BINARY_FFMPEG_BIN)) return BINARY_FFMPEG_BIN;
  return null;
}

function addFfmpegLocationArgs(args = []) {
  const ffmpegLocation = resolveYtDlpFfmpegLocation();
  if (!ffmpegLocation || args.includes("--ffmpeg-location")) return args;
  args.push("--ffmpeg-location", ffmpegLocation);
  return args;
}

// Handles ids to music URLs in the yt-dlp YouTube download pipeline.
export function idsToMusicUrls(ids) {
  return ids.map(id => isMusicEnabled() ?
    `https://music.youtube.com/watch?v=${id}` :
    `https://www.youtube.com/watch?v=${id}`
  );
}

// Handles ids to watch URLs in the yt-dlp YouTube download pipeline.
export function idsToWatchUrls(ids) {
  return ids.map(id =>
    normalizeYouTubeUrl(`https://www.youtube.com/watch?v=${id}`)
  );
}

// Checks whether likely you tube video id is valid for the yt-dlp YouTube download pipeline.
function isLikelyYouTubeVideoId(id) {
  return /^[A-Za-z0-9_-]{11}$/.test(String(id || ""));
}

// Handles ids to download metadata URLs in the yt-dlp YouTube download pipeline.
function idsToDownloadUrls(ids, frozenEntries = [], sourceUrl = "") {
  const byIdWebpage = new Map(
    (Array.isArray(frozenEntries) ? frozenEntries : [])
      .filter((e) => e?.id && e?.webpage_url)
      .map((e) => [String(e.id), String(e.webpage_url)])
  );
  const fromDailymotion = isDailymotionUrl(sourceUrl);

  return (Array.isArray(ids) ? ids : []).map((raw) => {
    const id = String(raw || "").trim();
    if (!id) return id;
    if (/^https?:\/\//i.test(id)) return id;

    if (isLikelyYouTubeVideoId(id)) {
      return normalizeYouTubeUrl(`https://www.youtube.com/watch?v=${id}`);
    }

    const mappedUrl = byIdWebpage.get(id);
    if (mappedUrl && /^https?:\/\//i.test(mappedUrl)) {
      return mappedUrl;
    }

    if (fromDailymotion && /^x[0-9a-z]+$/i.test(id)) {
      return `https://www.dailymotion.com/video/${id}`;
    }

    return normalizeYouTubeUrl(`https://www.youtube.com/watch?v=${id}`);
  });
}

// Determines whether use flat playlist data should run for the yt-dlp YouTube download pipeline.
function shouldUseFlatPlaylist(url) {
  return !isDailymotionUrl(url);
}

// Determines whether attach cookies should run for the yt-dlp YouTube download pipeline.
function shouldAttachCookies(sourceUrl = "", forceCookies = false) {
  if (forceCookies) return true;
  const src = String(sourceUrl || "");
  return isYouTubeUrl(src) || isDailymotionUrl(src);
}

// Builds base args for the yt-dlp YouTube download pipeline.
function buildBaseArgs(additionalArgs = [], { sourceUrl = "" } = {}) {
  const isYouTubeSource = isYouTubeUrl(String(sourceUrl || ""));
  const args = [
    "--ignore-config", "--no-warnings",
    "--socket-timeout", "15",
    "--user-agent", DEFAULT_USER_AGENT,
    "--retries", "3", "--retry-sleep", "1",
    "--sleep-requests", "0.1",
    "-J"
  ];

  if (isYouTubeSource) {
    args.push("--extractor-args", "youtube:player_client=android,web");
  }

  if (FLAGS.FORCE_IPV4) args.push("--force-ipv4");

  if (isYouTubeSource) {
    Object.entries(DEFAULT_HEADERS).forEach(([key, value]) => {
      args.push("--add-header", `${key}: ${value}`);
    });
  }

  const extra = getExtraArgs();
  if (extra.length) args.push(...extra);

  if (shouldAttachCookies(sourceUrl)) {
    addCookieArgs(args, { ui: true });
  }
  args.push(...getJsRuntimeArgs());

  return withDailymotionNoImpersonation(
    [...args, ...additionalArgs],
    sourceUrl
  );
}

// Determines whether strip cookies should run for the yt-dlp YouTube download pipeline.
function shouldStripCookies(explicit = false) {
  const env = process.env.YT_STRIP_COOKIES;

  if (env === "1") {
    return true;
  }

  if (env === "0") {
    return false;
  }

  if (FLAGS.STRIP_COOKIES) {
    return true;
  }
  return !!explicit;
}

// Handles with yt403 workarounds in the yt-dlp YouTube download pipeline.
export function withYT403Workarounds(baseArgs, { stripCookies = false } = {}) {
  let args = [...baseArgs];

  if (FLAGS.APPLY_403_WORKAROUNDS) {
    const tweaks = [
      ["--http-chunk-size", "16M"],
      ["--concurrent-fragments", "2"]
    ];
    tweaks.forEach(([flag, value]) => {
      if (!args.includes(flag)) args.push(flag, value);
    });
    args = addGeoArgs(args);
  }

  const finalStrip = shouldStripCookies(stripCookies);

  if (finalStrip) {
    const cookieFlags = ["--cookies", "--cookies-from-browser"];
    cookieFlags.forEach(flag => {
      const index = args.indexOf(flag);
      if (index !== -1) args.splice(index, 2);
    });
  }

  return args;
}

// Runs YouTube metadata json for the yt-dlp YouTube download pipeline.
export async function runYtJson(args, label = "ytjson", timeout = DEFAULT_TIMEOUT) {
  const YTDLP_BIN = resolveYtDlp();
  if (!YTDLP_BIN) {
    throw new Error("yt-dlp not found. Please install it or set YTDLP_BIN to its path.");
  }

  return new Promise((resolve, reject) => {
    const sourceUrl =
      [...(Array.isArray(args) ? args : [])]
        .reverse()
        .find((x) => typeof x === "string" && /^https?:\/\//i.test(x)) || "";
    const finalArgs = buildBaseArgs(args, { sourceUrl });
    let stdoutData = "", stderrData = "";

    const process = spawnSafe(YTDLP_BIN, finalArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: getBinaryRuntimeEnv()
    });

    const timeoutId = setTimeout(() => {
      try { process.kill("SIGKILL"); } catch {}
      reject(new Error(`[${label}] timeout (${timeout}ms)`));
    }, timeout);

    process.stdout.on("data", chunk => stdoutData += chunk.toString());
    process.stderr.on("data", chunk => stderrData += chunk.toString());

    process.on("close", (code) => {
      clearTimeout(timeoutId);

      if (code === 0) {
        try {
          const result = JSON.parse(stdoutData);
          resolve(result);
        } catch (error) {
          reject(new Error(`[${label}] JSON parse error: ${error.message}\n${stderrData}`));
        }
      } else {
        reject(new Error(`[${label}] exit code ${code}\n${stderrData.slice(-500)}`));
      }
    });

    process.on("error", (error) => {
      clearTimeout(timeoutId);
      reject(new Error(`[${label}] failed to start: ${error.message}`));
    });
  });
}

// Processes entry in the yt-dlp YouTube download pipeline.
function processEntry(entry, index, parentMeta = null) {
  const parent = parentMeta || {};
  const albumContext = isYtMusicAlbumContext(parent) || isYtMusicAlbumContext(entry, parent?.webpage_url || parent?.url || "");
  const albumArtist = albumContext ? pickYtMusicAlbumArtist(entry, parent) : "";
  const normalizedEntry = albumContext
    ? normalizeYtMusicAlbumEntry(entry, {
        parentMeta: parent,
        playlistTitle: parent?.title || parent?.playlist_title || "",
        albumArtist
      })
    : entry;
  const id = entry?.id || "";
  const isDmId = /^x[0-9a-z]+$/i.test(String(id || ""));
  const directUrl = normalizedEntry?.webpage_url || normalizedEntry?.url || entry?.webpage_url || entry?.url || "";
  let resolvedUrl = directUrl;
  if (!resolvedUrl && id) {
    if (isLikelyYouTubeVideoId(id)) {
      resolvedUrl = normalizeYouTubeUrl(`https://www.youtube.com/watch?v=${id}`);
    } else if (isDmId) {
      resolvedUrl = `https://www.dailymotion.com/video/${id}`;
    }
  }

  const titleRaw =
    normalizedEntry?.title ||
    normalizedEntry?.alt_title ||
    normalizedEntry?.track ||
    normalizedEntry?.name ||
    "";

  return {
    index: Number(entry?.playlist_index ?? (index + 1)),
    id,
    title: toNFC(titleRaw || id || ""),
    duration: Number.isFinite(entry?.duration) ? entry.duration : null,
    duration_string: entry?.duration_string || null,
    uploader: toNFC(
      normalizedEntry?.uploader ||
      normalizedEntry?.channel ||
      normalizedEntry?.artist ||
      normalizedEntry?.creator ||
      normalizedEntry?.owner?.screenname ||
      normalizedEntry?.owner?.username ||
      ""
    ),
    artist: toNFC(normalizedEntry?.artist || normalizedEntry?.uploader || ""),
    album: toNFC(normalizedEntry?.album || ""),
    album_artist: toNFC(normalizedEntry?.album_artist || albumArtist || normalizedEntry?.artist || ""),
    release_year: String(
      normalizedEntry?.release_year ||
      (normalizedEntry?.release_date ? String(normalizedEntry.release_date).slice(0, 4) : "") ||
      ""
    ),
    upload_year: String(
      normalizedEntry?.upload_year ||
      (normalizedEntry?.upload_date ? String(normalizedEntry.upload_date).slice(0, 4) : "") ||
      ""
    ),
    track_number: Number.isFinite(Number(normalizedEntry?.track_number)) && Number(normalizedEntry.track_number) > 0
      ? Number(normalizedEntry.track_number)
      : null,
    track_total: Number.isFinite(Number(normalizedEntry?.track_total)) && Number(normalizedEntry.track_total) > 0
      ? Number(normalizedEntry.track_total)
      : null,
    disc_number: Number.isFinite(Number(normalizedEntry?.disc_number)) && Number(normalizedEntry.disc_number) > 0
      ? Number(normalizedEntry.disc_number)
      : null,
    disc_total: Number.isFinite(Number(normalizedEntry?.disc_total)) && Number(normalizedEntry.disc_total) > 0
      ? Number(normalizedEntry.disc_total)
      : null,
    genre: toNFC(
      normalizedEntry?.genre ||
      (Array.isArray(normalizedEntry?.categories) ? normalizedEntry.categories[0] : "") ||
      ""
    ),
    isrc: String(normalizedEntry?.isrc || ""),
    channel_id: String(normalizedEntry?.channel_id || entry?.channel_id || ""),
    view_count: Number.isFinite(Number(normalizedEntry?.view_count)) ? Number(normalizedEntry.view_count) : null,
    webpage_url: resolvedUrl,
    thumbnail: (Array.isArray(entry?.thumbnails) && entry.thumbnails.length ?
      entry.thumbnails.at(-1).url :
      entry?.thumbnail ||
      entry?.thumbnail_720_url ||
      entry?.thumbnail_360_url ||
      entry?.thumbnail_url ||
      null)
  };
}

// Processes entries in the yt-dlp YouTube download pipeline.
function processEntries(entries, maxEntries = PREVIEW_MAX_ENTRIES, parentMeta = null) {
  return entries
    .filter(Boolean)
    .slice(0, maxEntries)
    .map((entry, index) => processEntry(entry, index, parentMeta))
    .sort((a, b) => a.index - b.index);
}

function normalizeSearchLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 12;
  return Math.max(1, Math.min(30, Math.round(n)));
}

function normalizeSearchType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (["track", "song", "songs", "video", "videos"].includes(type)) return "track";
  if (["playlist", "playlists"].includes(type)) return "playlist";
  if (["album", "albums"].includes(type)) return "album";
  if (["artist", "artists"].includes(type)) return "artist";
  return "";
}

function buildYouTubeSearchUrlWithOptions(query, { type = "", sort = "", lang = "", region = "" } = {}) {
  const url = new URL("https://www.youtube.com/results");
  url.searchParams.set("search_query", query);
  const searchType = normalizeSearchType(type);
  const searchSort = String(sort || "").trim().toLowerCase();
  const safeLang = normalizeDiscoverLang(lang || getInnertubeLang());
  const safeRegion = normalizeDiscoverRegion(region || getInnertubeRegion(), safeLang);

  url.searchParams.set("hl", `${safeLang}-${safeRegion}`);
  url.searchParams.set("gl", safeRegion);

  if (searchType === "playlist") {
    url.searchParams.set("sp", "EgIQAw==");
  } else if (searchSort === "date" || searchSort === "upload_date") {
    url.searchParams.set("sp", "CAI=");
  }

  return url.toString();
}

function extractSearchPlaylistId(value = "") {
  const source = String(value || "").trim();
  if (!source) return "";
  try {
    const url = new URL(source, "https://www.youtube.com");
    return url.searchParams.get("list") || "";
  } catch {
    const match = source.match(/[?&]list=([^&#]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }
}

function isLikelyYouTubePlaylistId(id = "") {
  return /^(?:PL|OLAK5uy_|RD|UU|LL|FL|WL|VL|RDMM|RDEM|RDAO)[A-Za-z0-9_-]+$/i.test(String(id || ""));
}

function stripPlaylistParamsFromTrackUrl(value = "") {
  const source = String(value || "").trim();
  if (!source) return "";
  try {
    const url = new URL(source);
    if (/(^|\.)youtube\.com$/i.test(url.hostname) && url.pathname === "/watch" && url.searchParams.get("v")) {
      url.searchParams.delete("list");
      url.searchParams.delete("index");
      url.searchParams.delete("start_radio");
      return url.toString();
    }
  } catch {}
  return source.replace(/([?&])(list|index|start_radio)=[^&#]*/gi, "$1").replace(/[?&]+$/, "");
}

function isYouTubeShortsUrl(value = "") {
  return /(?:^|\/)shorts(?:\/|$)|youtube\.com\/shorts\//i.test(String(value || ""));
}

function normalizeDiscoverPlaylistId(value = "") {
  const id = String(value || "").trim();
  if (!id) return "";
  if (/^VL/i.test(id) && isLikelyYouTubePlaylistId(id.slice(2))) return id.slice(2);
  return isLikelyYouTubePlaylistId(id) ? id : "";
}

function getDiscoverPlaylistId(item = {}) {
  return (
    extractSearchPlaylistId(item.webpage_url || item.url || "") ||
    normalizeDiscoverPlaylistId(item.playlistId) ||
    normalizeDiscoverPlaylistId(item.browseId) ||
    normalizeDiscoverPlaylistId(item.id)
  );
}

function toAbsoluteYouTubeUrl(value = "") {
  const source = String(value || "").trim();
  if (!source) return "";
  if (/^https?:\/\//i.test(source)) return source;
  if (source.startsWith("//")) return `https:${source}`;
  if (source.startsWith("/")) return `https://www.youtube.com${source}`;
  return source;
}

function inferSearchEntryType(entry = {}, item = {}) {
  const rawType = String(entry?._type || entry?.ie_key || entry?.extractor_key || "").toLowerCase();
  const url = String(item?.webpage_url || entry?.webpage_url || entry?.url || "");
  const id = String(item?.id || entry?.id || entry?.playlist_id || "");

  if (
    rawType.includes("album") ||
    /^MPRE[A-Za-z0-9_-]*$/i.test(id) ||
    (() => {
      try {
        const parsed = new URL(url);
        return parsed.hostname.toLowerCase() === "music.youtube.com" &&
          /^\/browse\/MPRE[A-Za-z0-9_-]*$/i.test(parsed.pathname);
      } catch {
        return false;
      }
    })()
  ) {
    return "album";
  }

  if (
    rawType.includes("playlist") ||
    entry?.playlist_id ||
    extractSearchPlaylistId(url) ||
    isLikelyYouTubePlaylistId(id)
  ) {
    return "playlist";
  }

  return "track";
}

function normalizeSearchWebpageUrl(entry = {}, item = {}, type = "track") {
  const direct = String(item?.webpage_url || entry?.webpage_url || entry?.original_url || "").trim();
  const id = String(item?.id || entry?.id || entry?.url || "").trim();
  const rawUrl = String(entry?.url || "").trim();
  const playlistId = String(
    entry?.playlist_id ||
    extractSearchPlaylistId(direct) ||
    extractSearchPlaylistId(rawUrl) ||
    (type === "playlist" && isLikelyYouTubePlaylistId(id) ? id : "") ||
    ""
  ).trim();

  if (type === "album") {
    const browseId =
      String(entry?.browseId || item?.browseId || "").trim() ||
      (String(id).match(/^MPRE[A-Za-z0-9_-]+$/i) ? id : "");

    if (browseId) {
      return `${YTM_ORIGIN}/browse/${encodeURIComponent(browseId)}`;
    }
  }

  if (type === "playlist" && playlistId) {
    return `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
  }

  const absoluteDirect = toAbsoluteYouTubeUrl(direct);
  if (/^https?:\/\//i.test(absoluteDirect)) {
    return normalizeYouTubeUrl(type === "playlist" ? absoluteDirect : stripPlaylistParamsFromTrackUrl(absoluteDirect));
  }

  if (isLikelyYouTubeVideoId(id)) {
    return normalizeYouTubeUrl(`https://www.youtube.com/watch?v=${id}`);
  }

  const absoluteRawUrl = toAbsoluteYouTubeUrl(rawUrl);
  if (/^https?:\/\//i.test(absoluteRawUrl)) {
    return normalizeYouTubeUrl(type === "playlist" ? absoluteRawUrl : stripPlaylistParamsFromTrackUrl(absoluteRawUrl));
  }

  return direct || rawUrl || "";
}

const YTM_SEARCH_TYPE_PARAMS = {
  album: "EgWKAQIYAWoKEAMQBBAJEAoQBQ%3D%3D",
  artist: "EgWKAQIgAWoKEAMQBBAJEAoQBQ%3D%3D"
};

const SEARCH_QUERY_STOP_WORDS = new Set([
  "album",
  "albums",
  "albumler",
  "albumleri",
  "albm",
  "playlist",
  "playlists",
  "liste",
  "listesi",
  "sarki",
  "sarkilar",
  "song",
  "songs",
  "video",
  "videos",
  "official",
  "resmi",
  "audio",
  "dinle",
  "listen",
  "full",
  "tam"
]);

function normalizeSearchMatchText(value = "") {
  return normalizeMusicHomeTitle(value)
    .toLocaleLowerCase("tr")
    .replace(/[ıİ]/g, "i")
    .replace(/[ğ]/g, "g")
    .replace(/[ü]/g, "u")
    .replace(/[ş]/g, "s")
    .replace(/[ö]/g, "o")
    .replace(/[ç]/g, "c")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getSearchQueryTokens(query = "") {
  return normalizeSearchMatchText(query)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !SEARCH_QUERY_STOP_WORDS.has(token));
}

function getSearchItemMatchText(item = {}) {
  return normalizeSearchMatchText([
    item.title,
    item.uploader,
    item.channel,
    item.artist,
    item.album,
    item.album_artist,
    item.description,
    item.searchableText
  ].filter(Boolean).join(" "));
}

function isLikelyNonMusicYtmItem(item = {}) {
  const url = String(item.webpage_url || item.url || "");
  if (isYouTubeShortsUrl(url)) return true;

  const text = getSearchItemMatchText(item);
  return /\b(bolum|episode|episodes|podcast|podcasts)\b/.test(text) || /\bshorts?\b/.test(text);
}

function filterSearchItemsForQuery(items = [], query = "", searchType = "") {
  const list = Array.isArray(items) ? items : [];
  if (!["album", "artist"].includes(searchType)) return list;

  const tokens = getSearchQueryTokens(query);
  if (!tokens.length) return list;

  return list.filter((item) => {
    const haystack = getSearchItemMatchText(item);
    return tokens.every((token) => haystack.includes(token));
  });
}

function isYtmSearchItemType(item = {}, targetType = "") {
  const type = String(item?.type || "").toLowerCase();
  if (!targetType) return true;
  if (targetType === "album") return type === "album";
  if (targetType === "artist") return type === "artist";
  if (targetType === "playlist") return type === "playlist";
  if (targetType === "track") return type === "track" && !isLikelyNonMusicYtmItem(item);
  return true;
}

function extractYtmSearchItemsFromTree(data, { targetType = "", limit = 30 } = {}) {
  const out = [];
  const visited = new WeakSet();

  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 18 || out.length >= limit || visited.has(node)) return;
    visited.add(node);

    if (getDirectYtmItemRenderer(node)) {
      const item = normalizeYtmRendererItem(node, out.length);
      if (item && isYtmSearchItemType(item, targetType)) {
        out.push({
          ...item,
          index: out.length + 1,
          source: "youtube_music_search"
        });
      }
      return;
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          walk(child, depth + 1);
          if (out.length >= limit) return;
        }
      } else if (value && typeof value === "object") {
        walk(value, depth + 1);
      }
    }
  };

  walk(data);
  return uniqueMusicHomeItems(out, limit);
}

async function searchYouTubeMusicContent(query, { limit = 12, type = "", lang = "", region = "", timeoutMs: timeoutOverride = null, useCookies = true } = {}) {
  const q = String(query || "").trim();
  if (!q || ytmApiGate.retryAfterMs()) return [];

  const searchType = normalizeSearchType(type);
  const safeLang = normalizeDiscoverLang(lang || getInnertubeLang());
  const safeRegion = normalizeDiscoverRegion(region || getInnertubeRegion(), safeLang);
  const timeoutMs = Number.isFinite(Number(timeoutOverride)) && Number(timeoutOverride) > 0
    ? Number(timeoutOverride)
    : Number(process.env.YTM_SEARCH_TIMEOUT_MS || 12000);

  let cookies = [];
  try {
    const cookieFile = useCookies ? await resolveMusicHomeCookieFile() : "";
    cookies = parseNetscapeCookieFile(cookieFile, "music.youtube.com");
  } catch {}

  const cookieHeader = buildCookieHeader(cookies);
  const bootstrap = cookieHeader ? await fetchYtmBootstrapConfig(cookieHeader, Math.min(timeoutMs, 6000)) : {};
  const clientVersion = String(process.env.YTM_CLIENT_VERSION || bootstrap.clientVersion || getDefaultYtmClientVersion()).trim();

  const headers = {
    "Accept": "application/json",
    "Accept-Language": getDiscoverHl(safeLang),
    "Content-Type": "application/json",
    "Origin": YTM_ORIGIN,
    "Referer": `${YTM_ORIGIN}/search?q=${encodeURIComponent(q)}`,
    "User-Agent": DEFAULT_USER_AGENT,
    "X-Goog-AuthUser": cookieHeader ? String(process.env.YTM_AUTH_USER || bootstrap.authUser || "0") : "0",
    "X-Origin": YTM_ORIGIN,
    "X-Youtube-Client-Name": "67",
    "X-Youtube-Client-Version": clientVersion
  };
  if (bootstrap.visitorData) headers["X-Goog-Visitor-Id"] = bootstrap.visitorData;
  if (cookieHeader) headers.Cookie = cookieHeader;
  const auth = buildSapisidAuthHeader(cookies);
  if (auth) headers.Authorization = auth;

  try {
    const context = {
      client: {
        clientName: "WEB_REMIX",
        clientVersion,
        visitorData: bootstrap.visitorData || undefined,
        hl: getDiscoverHl(safeLang),
        gl: safeRegion
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    };

    const body = {
      context,
      query: q
    };

    if (YTM_SEARCH_TYPE_PARAMS[searchType]) {
      body.params = YTM_SEARCH_TYPE_PARAMS[searchType];
    }

    // Parsed cookie-file values are domain-scoped, sanitized, and sent only to the fixed YTM_ORIGIN.
    const data = await requestSharedYtmJson((signal) => fetch(`${YTM_ORIGIN}/youtubei/v1/search?prettyPrint=false`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify(body)
    }), { timeoutMs, retries: 0 });

    return extractYtmSearchItemsFromTree(data, {
      targetType: searchType,
      limit
    });
  } catch {
    return [];
  }
}

async function searchYouTubeMusicArtistAlbums(query, { limit = 12, lang = "", region = "" } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];

  const timeoutMs = Number(process.env.YTM_SEARCH_TIMEOUT_MS || 12000);
  const artists = await searchYouTubeMusicContent(q, {
    limit: 8,
    type: "artist",
    lang,
    region
  });
  const matchedArtists = filterSearchItemsForQuery(artists, q, "artist")
    .filter((artist) => artist?.browseId || artist?.id)
    .slice(0, 2);

  const albums = [];
  for (const artist of matchedArtists) {
    if (albums.length >= limit) break;
    try {
      const browseId = artist.browseId || artist.id;
      const artistAlbums = await fetchPublicYouTubeMusicBrowseDiscover({
        browseId,
        limit: Math.max(limit, 24),
        targetType: "album",
        preset: "",
        lang,
        region,
        timeoutMs: Math.min(timeoutMs, 10000)
      });
      albums.push(...artistAlbums.map((album) => ({
        ...album,
        type: "album",
        uploader: /^\d{4}$/.test(String(album.uploader || "").trim())
          ? (artist.title || album.uploader || "")
          : (album.uploader || artist.title || ""),
        searchableText: [album.searchableText, artist.title, artist.uploader].filter(Boolean).join(" ")
      })));
    } catch (error) {
      discoverDebug("artist-albums:error", {
        artist: summarizeDiscoverItem(artist),
        error: error?.message || String(error)
      });
    }
  }

  return uniqueMusicHomeItems(filterSearchItemsForQuery(albums, q, "album"), limit);
}

// Searches YouTube content for the ytlive browser UI.
export async function searchYouTubeContent(query, { limit = 12, type = "", sort = "", lang = "", region = "", musicOnly = false } = {}) {
  const q = String(query || "").trim();
  if (!q) {
    return { query: q, items: [] };
  }

  const safeLimit = normalizeSearchLimit(limit);
  const searchType = normalizeSearchType(type);
  const safeLang = normalizeDiscoverLang(lang || getInnertubeLang());
  const safeRegion = normalizeDiscoverRegion(region || getInnertubeRegion(), safeLang);
  const timeout = Number(process.env.YOUTUBE_SEARCH_TIMEOUT_MS || 30000);
  let data = null;

  if (["track", "album", "artist"].includes(searchType)) {
    const musicItems = await searchYouTubeMusicContent(q, {
      limit: safeLimit,
      type: searchType,
      lang: safeLang,
      region: safeRegion
    });
    const filteredMusicItems = filterSearchItemsForQuery(musicItems, q, searchType);
    const directMusicItems = filteredMusicItems.length ? filteredMusicItems : musicItems;

    if (directMusicItems.length) {
      return { query: q, type: searchType, items: directMusicItems };
    }
  }

  if (searchType === "album") {
    const artistAlbums = await searchYouTubeMusicArtistAlbums(q, {
      limit: safeLimit,
      lang: safeLang,
      region: safeRegion
    });
    if (artistAlbums.length) {
      return { query: q, type: searchType, items: artistAlbums };
    }
  }

  if (musicOnly) {
    return { query: q, type: searchType || "all", items: [] };
  }

  const searchSort = String(sort || "").trim().toLowerCase();
  const preferSearchUrl = searchType === "playlist" || searchSort === "date" || searchSort === "upload_date";

  if (preferSearchUrl) {
    try {
      data = await runYtJson(
        ["--flat-playlist", "--playlist-end", String(safeLimit), buildYouTubeSearchUrlWithOptions(q, { type: searchType, sort: searchSort, lang: safeLang, region: safeRegion })],
        searchType === "playlist" ? "youtube-search-playlist" : "youtube-search-date",
        timeout
      );
    } catch (error) {
      console.warn("YouTube filtered search URL failed, falling back to ytsearch:", error?.message || error);
    }
  }

  if (!data) {
    data = await runYtJson(
      ["--flat-playlist", `ytsearch${safeLimit}:${q}`],
      "youtube-search",
      timeout
    );
  }

  const entries = Array.isArray(data?.entries) ? data.entries : (data ? [data] : []);
  const items = entries
    .filter(Boolean)
    .map((entry, index) => {
      const base = processEntry(entry, index);
      const type = inferSearchEntryType(entry, base);
      const webpageUrl = normalizeSearchWebpageUrl(entry, base, type);
      return {
        ...base,
        index: index + 1,
        type,
        source: "youtube",
        webpage_url: webpageUrl,
        url: webpageUrl
      };
    })
    .filter((item) => item.title || item.id || item.webpage_url)
    .filter((item) => {
      if (!searchType) return true;
      if (searchType === "track") return item.type === "track";
      if (searchType === "playlist") return item.type === "playlist";
      if (searchType === "album") return item.type === "album";
      return true;
    });

  return {
    query: q,
    type: searchType || "all",
    items: filterSearchItemsForQuery(items, q, searchType)
  };
}

const DISCOVER_MOOD_PRESETS = new Set([
  "energizing",
  "workout",
  "feel-good",
  "relax",
  "sad",
  "romance",
  "commute",
  "party",
  "focus",
  "sleep"
]);

const DISCOVER_PRESETS = new Set([
  "popular",
  "new",
  "playlist",
  "local",
  ...DISCOVER_MOOD_PRESETS
]);

function normalizeDiscoverPreset(value = "") {
  const preset = String(value || "").trim().toLowerCase();
  return DISCOVER_PRESETS.has(preset) ? preset : "energizing";
}

function isMoodDiscoverPreset(value = "") {
  return DISCOVER_MOOD_PRESETS.has(String(value || "").trim().toLowerCase());
}

function normalizeDiscoverPage(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.min(10, Math.round(n)));
}

function normalizeDiscoverLang(value = "") {
  const lang = String(value || "").trim().toLowerCase().slice(0, 2);
  return ["tr", "en", "de", "fr", "es"].includes(lang) ? lang : "en";
}

function normalizeDiscoverRegion(value = "", lang = "en") {
  const raw = String(value || "").trim().toUpperCase();
  const defaults = {
    tr: "TR",
    de: "DE",
    fr: "FR",
    es: "ES",
    en: "US"
  };
  const safeLang = normalizeDiscoverLang(lang);
  const fallback = defaults[safeLang] || "US";
  if (!/^[A-Z]{2}$/.test(raw)) return fallback;
  if (safeLang !== "en" && raw === "US") return fallback;
  return raw;
}

function getDiscoverHl(lang) {
  return normalizeDiscoverLang(lang);
}

function getDiscoverTargetType(preset = "") {
  return normalizeDiscoverPreset(preset) === "playlist" ? "playlist" : "track";
}

function isDiscoverItemType(item = {}, targetType = "track") {
  const url = String(item.webpage_url || item.url || "");
  const itemType = String(item.type || "").toLowerCase();
  const browseId = String(item.browseId || item.id || "");
  const playlistLike =
    itemType === "playlist" ||
    (itemType !== "track" && (getDiscoverPlaylistId(item) || /(?:\/playlist|[?&]list=)/i.test(url)));

  if (targetType === "album") {
    return itemType === "album" || /^MPRE/i.test(browseId) || /\/browse\/MPRE/i.test(url);
  }

  if (targetType === "playlist") {
    return playlistLike;
  }

  if (isLikelyNonMusicYtmItem(item)) return false;

  const videoId = String(item.id || "").match(/^[A-Za-z0-9_-]{11}$/) || /(?:\/watch\?|youtu\.be\/)/i.test(url);
  return !!videoId && !playlistLike;
}

function normalizeDiscoverEntries(entries = [], { targetType = "track" } = {}) {
  return (Array.isArray(entries) ? entries : [])
    .filter(Boolean)
    .map((entry, index) => {
      const base = processEntry(entry, index);
      const type = inferSearchEntryType(entry, base);
      const webpageUrl = normalizeSearchWebpageUrl(entry, base, type);
      return {
        ...base,
        index: index + 1,
        type,
        source: "youtube_discover",
        webpage_url: webpageUrl,
        url: webpageUrl
      };
    })
    .filter((item) => item.title || item.id || item.webpage_url)
    .filter((item) => isDiscoverItemType(item, targetType));
}

function uniqueDiscoverItems(items = [], limit = 60) {
  return uniqueMusicHomeItems(items, limit);
}

const DISCOVER_RESULT_CACHE = ytmSharedCache.map("discover-results");
const DISCOVER_BROWSE_CACHE = ytmSharedCache.map("discover-browse");
const DISCOVER_BROWSE_SHELF_CACHE = ytmSharedCache.map("discover-shelves");
const DISCOVER_PLAYLIST_TRACK_CACHE = ytmSharedCache.map("discover-playlists");

function isDiscoverDebugEnabled() {
  return String(process.env.YOUTUBE_DISCOVER_DEBUG || "0").trim() !== "0";
}

function getDiscoverCacheTtlMs() {
  const n = Number(process.env.YOUTUBE_DISCOVER_CACHE_TTL_MS || 900000);
  return Number.isFinite(n) && n >= 0 ? n : 900000;
}

function getDiscoverNumber(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function getCachedDiscoverValue(cache, key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCachedDiscoverValue(cache, key, value) {
  const ttl = getDiscoverCacheTtlMs();
  if (!ttl) return value;
  if (cache.size > 120) {
    const now = Date.now();
    for (const [entryKey, entry] of cache) {
      if (entry.expiresAt < now || cache.size > 100) cache.delete(entryKey);
    }
  }
  cache.set(key, {
    expiresAt: Date.now() + ttl,
    value
  });
  return value;
}

function trimDiscoverText(value = "", max = 80) {
  const text = normalizeMusicHomeTitle(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function summarizeDiscoverItem(item = {}) {
  return {
    title: trimDiscoverText(item.title || item.id || ""),
    type: item.type || "",
    id: trimDiscoverText(item.id || "", 32),
    browseId: trimDiscoverText(item.browseId || "", 48),
    playlistId: trimDiscoverText(getDiscoverPlaylistId(item), 48),
    params: item.params ? trimDiscoverText(item.params, 24) : ""
  };
}

function summarizeDiscoverShelf(shelf = {}) {
  return {
    title: trimDiscoverText(shelf.title || ""),
    browseId: trimDiscoverText(shelf.browseId || "", 48),
    params: shelf.params ? trimDiscoverText(shelf.params, 24) : "",
    items: Array.isArray(shelf.items) ? shelf.items.length : 0,
    sample: (Array.isArray(shelf.items) ? shelf.items : []).slice(0, 3).map(summarizeDiscoverItem)
  };
}

function discoverDebug(stage, data = {}) {
  if (!isDiscoverDebugEnabled()) return;
  try {
    console.info(`[youtube-discover] ${stage}`, JSON.stringify(data));
  } catch {
    console.info(`[youtube-discover] ${stage}`, data);
  }
}

function matchesAnyDiscoverPattern(value = "", patterns = []) {
  const source = normalizeMusicHomeTitle(value).toLowerCase();
  return patterns.some((pattern) => pattern.test(source));
}

function getDiscoverShelfPatterns(preset = "", lang = "en") {
  const safePreset = normalizeDiscoverPreset(preset);
  if (safePreset === "new") {
    return [/new/i, /release/i, /latest/i, /yeni/i, /çıkan/i, /nouveau/i, /nouveaut/i, /neu/i, /nueva/i, /nuevo/i];
  }
  if (safePreset === "playlist") {
    return [/playlist/i, /mix/i, /mood/i, /genre/i, /liste/i, /çalma/i, /ruh hali/i, /tarz/i];
  }
  if (safePreset === "local") {
    if (normalizeDiscoverLang(lang) === "tr") return [/türk/i, /turk/i, /pop/i, /yerel/i];
    return [/pop/i, /local/i, /genre/i];
  }
  return [];
}

function shelfMatchesDiscoverPreset(shelf = {}, preset = "", lang = "en") {
  const safePreset = normalizeDiscoverPreset(preset);
  if (safePreset === "popular") return true;
  if (safePreset === "local" && normalizeDiscoverLang(lang) !== "tr") {
    const shelfText = `${shelf?.title || ""} ${shelf?.browseId || ""}`;
    if (isLikelyTurkishDiscoverText(shelfText)) return false;
  }

  const patterns = getDiscoverShelfPatterns(safePreset, lang);
  if (!patterns.length) return true;

  return (
    matchesAnyDiscoverPattern(shelf.title, patterns) ||
    matchesAnyDiscoverPattern(shelf.browseId, patterns)
  );
}

function flattenDiscoverShelves(shelves = [], { targetType = "track", limit = 60, preset = "", lang = "en" } = {}) {
  const items = [];
  let skippedShelves = 0;
  for (const shelf of Array.isArray(shelves) ? shelves : []) {
    if (preset && !shelfMatchesDiscoverPreset(shelf, preset, lang)) {
      skippedShelves += 1;
      continue;
    }
    for (const item of Array.isArray(shelf?.items) ? shelf.items : []) {
      if (!isDiscoverItemType(item, targetType)) continue;
      items.push({
        ...item,
        source: "youtube_music_discover"
      });
      if (items.length >= limit) break;
    }
    if (items.length >= limit) break;
  }
  const unique = uniqueDiscoverItems(items, limit);
  discoverDebug("flatten", {
    preset,
    targetType,
    shelves: Array.isArray(shelves) ? shelves.length : 0,
    skippedShelves,
    rawItems: items.length,
    uniqueItems: unique.length,
    sample: unique.slice(0, 5).map(summarizeDiscoverItem)
  });
  return unique;
}

function filterDiscoverShelves(shelves = [], { targetType = "track", limitPerShelf = 12, maxShelves = 6, preset = "", lang = "en" } = {}) {
  const out = [];
  let skippedShelves = 0;

  for (const shelf of Array.isArray(shelves) ? shelves : []) {
    if (preset && !shelfMatchesDiscoverPreset(shelf, preset, lang)) {
      skippedShelves += 1;
      continue;
    }

    const items = uniqueDiscoverItems(
      (Array.isArray(shelf?.items) ? shelf.items : [])
        .filter((item) => isDiscoverItemType(item, targetType))
        .map((item) => ({
          ...item,
          source: "youtube_music_discover"
        })),
      limitPerShelf
    );

    if (!items.length) continue;
    out.push({
      ...shelf,
      source: "youtube_music_home_fill",
      items
    });

    if (out.length >= maxShelves) break;
  }

  const uniqueShelves = mergeMusicHomeShelves([out], { maxShelves, limitPerShelf });
  discoverDebug("shelves:filter", {
    preset,
    targetType,
    shelves: Array.isArray(shelves) ? shelves.length : 0,
    skippedShelves,
    returnedShelves: uniqueShelves.length,
    sample: uniqueShelves.slice(0, 5).map(summarizeDiscoverShelf)
  });
  return uniqueShelves;
}

function extractYtmDiscoverItemsFromTree(data, { targetType = "track", limit = 60 } = {}) {
  const out = [];
  const visited = new WeakSet();

  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 16 || out.length >= limit || visited.has(node)) return;
    visited.add(node);

    if (getDirectYtmItemRenderer(node)) {
      const item = normalizeYtmRendererItem(node, out.length);
      if (item && isDiscoverItemType(item, targetType)) {
        out.push({
          ...item,
          source: "youtube_music_discover"
        });
      }
      return;
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          walk(child, depth + 1);
          if (out.length >= limit) return;
        }
      } else if (value && typeof value === "object") {
        walk(value, depth + 1);
      }
    }
  };

  walk(data);
  return uniqueDiscoverItems(out, limit);
}

async function fetchYouTubeMusicBrowseDiscover({ browseId, params = "", limit, targetType, preset = "", lang, region, timeoutMs, useCookies = true, returnShelves = false, maxShelves = 6, continuationPages = null }) {
  const safeLang = normalizeDiscoverLang(lang);
  const safeRegion = normalizeDiscoverRegion(region, safeLang);
  const shelfLimit = normalizeMusicHomeNumber(maxShelves, 6, 1, 50);
  let cookies = [];
  if (useCookies) {
    try { cookies = parseNetscapeCookieFile(await resolveMusicHomeCookieFile(), "music.youtube.com"); } catch {}
  }
  const cookieHeader = buildCookieHeader(cookies);
  const cacheKey = JSON.stringify({
    browseId,
    params,
    limit,
    targetType,
    preset,
    lang: safeLang,
    region: safeRegion,
    useCookies: !!useCookies,
    sessionKey: createHash("sha256").update(cookieHeader).digest("hex"),
    authUser: cookieHeader ? String(process.env.YTM_AUTH_USER || "0") : "0",
    returnShelves: !!returnShelves,
    maxShelves: shelfLimit
  });
  const cache = returnShelves ? DISCOVER_BROWSE_SHELF_CACHE : DISCOVER_BROWSE_CACHE;
  const cached = getCachedDiscoverValue(cache, cacheKey);
  if (cached) {
    discoverDebug("browse:cache-hit", {
      browseId,
      params: params ? trimDiscoverText(params, 24) : "",
      preset,
      targetType,
      itemCount: returnShelves ? undefined : cached.length,
      shelfCount: returnShelves ? cached.length : undefined,
      useCookies: !!useCookies
    });
    return cached;
  }

  if (ytmApiGate.retryAfterMs()) throw Object.assign(new Error(ytmRateLimitWarning), { code: "YTM_RATE_LIMITED" });
  const bootstrap = cookieHeader ? await fetchYtmBootstrapConfig(cookieHeader, Math.min(timeoutMs, 6000)) : {};
  const clientVersion = String(process.env.YTM_CLIENT_VERSION || bootstrap.clientVersion || getDefaultYtmClientVersion()).trim();

  const headers = {
    "Accept": "application/json",
    "Accept-Language": getDiscoverHl(safeLang),
    "Content-Type": "application/json",
    "Origin": YTM_ORIGIN,
    "Referer": `${YTM_ORIGIN}/`,
    "User-Agent": DEFAULT_USER_AGENT,
    "X-Goog-AuthUser": "0",
    "X-Origin": YTM_ORIGIN,
    "X-Youtube-Client-Name": "67",
    "X-Youtube-Client-Version": clientVersion
  };
  if (bootstrap.visitorData) headers["X-Goog-Visitor-Id"] = bootstrap.visitorData;
  if (cookieHeader) headers.Cookie = cookieHeader;
  const auth = buildSapisidAuthHeader(cookies);
  if (auth) headers.Authorization = auth;

  const deadline = Date.now() + timeoutMs;
  const context = {
    client: {
      clientName: "WEB_REMIX",
      clientVersion,
      visitorData: bootstrap.visitorData || undefined,
      hl: getDiscoverHl(safeLang),
      gl: safeRegion
    },
    user: { lockedSafetyMode: false },
    request: { useSsl: true }
  };

  const postBrowse = async (payload) => {
      // Parsed cookie-file values are domain-scoped, sanitized, and sent only to the fixed YTM_ORIGIN.
      return requestSharedYtmJson((signal) => fetch(`${YTM_ORIGIN}/youtubei/v1/browse?prettyPrint=false`, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({ context, ...payload })
      }), { timeoutMs, deadline, retries: 0 });
  };

  {
    const firstPayload = browseId === "FEmusic_charts"
      ? { browseId, formData: { selectedValues: [safeRegion] } }
      : { browseId };
    if (params) firstPayload.params = params;

    discoverDebug("browse:start", {
      browseId,
      params: params ? trimDiscoverText(params, 24) : "",
      preset,
      targetType,
      lang: safeLang,
      region: safeRegion,
      limit,
      returnShelves: !!returnShelves,
      maxShelves: shelfLimit,
      hasCookie: !!cookieHeader,
      hasAuth: !!auth,
      useCookies: !!useCookies,
      clientVersion
    });

    const firstPage = await postBrowse(firstPayload);
    let shelves = buildMusicHomeShelvesFromInnertube(firstPage, { maxShelves: returnShelves ? shelfLimit : 12, limitPerShelf: limit });
    discoverDebug("browse:first-page", {
      browseId,
      preset,
      shelfCount: shelves.length,
      shelves: shelves.slice(0, 8).map(summarizeDiscoverShelf),
      continuationCount: Array.from(collectYtmContinuationTokens(firstPage)).length
    });
    let filteredShelves = returnShelves
      ? filterDiscoverShelves(shelves, { targetType, limitPerShelf: limit, maxShelves: shelfLimit, preset, lang: safeLang })
      : [];
    let items = returnShelves ? [] : flattenDiscoverShelves(shelves, { targetType, limit, preset, lang: safeLang });
    if (!returnShelves && !items.length) {
      items = extractYtmDiscoverItemsFromTree(firstPage, { targetType, limit });
      discoverDebug("browse:direct-items", {
        browseId,
        preset,
        targetType,
        itemCount: items.length,
        sample: items.slice(0, 8).map(summarizeDiscoverItem)
      });
    }
    const seenTokens = new Set();
    const tokenQueue = Array.from(collectYtmContinuationTokens(firstPage));
    let continuationPages = 0;
    const maxContinuationPages = continuationPages == null
      ? getDiscoverNumber(process.env.YOUTUBE_DISCOVER_CONTINUATION_PAGES ?? 2, 2, 0, 6)
      : getDiscoverNumber(continuationPages, 0, 0, 6);

    while ((returnShelves ? filteredShelves.length < shelfLimit : items.length < limit) && tokenQueue.length && continuationPages < maxContinuationPages) {
      const token = tokenQueue.shift();
      if (!token || seenTokens.has(token)) continue;
      seenTokens.add(token);
      continuationPages += 1;

      const nextPage = await postBrowse({ continuation: token });
      const nextShelves = buildMusicHomeShelvesFromInnertube(nextPage, { maxShelves: returnShelves ? shelfLimit : 12, limitPerShelf: limit });
      discoverDebug("browse:continuation", {
        browseId,
        preset,
        page: continuationPages,
        token: trimDiscoverText(token, 18),
        shelfCount: nextShelves.length,
        shelves: nextShelves.slice(0, 6).map(summarizeDiscoverShelf)
      });
      shelves = mergeMusicHomeShelves(
        [
          shelves,
          nextShelves
        ],
        { maxShelves: returnShelves ? shelfLimit : 12, limitPerShelf: limit }
      );
      if (returnShelves) {
        filteredShelves = filterDiscoverShelves(shelves, { targetType, limitPerShelf: limit, maxShelves: shelfLimit, preset, lang: safeLang });
      }
      if (!returnShelves) {
        items = flattenDiscoverShelves(shelves, { targetType, limit, preset, lang: safeLang });
      }
      if (!returnShelves && !items.length) {
        items = extractYtmDiscoverItemsFromTree(nextPage, { targetType, limit });
        discoverDebug("browse:continuation-direct-items", {
          browseId,
          preset,
          targetType,
          page: continuationPages,
          itemCount: items.length,
          sample: items.slice(0, 6).map(summarizeDiscoverItem)
        });
      }

      for (const nextToken of collectYtmContinuationTokens(nextPage)) {
        if (!seenTokens.has(nextToken)) tokenQueue.push(nextToken);
      }
    }

    if (returnShelves) {
      discoverDebug("browse:shelves-done", {
        browseId,
        preset,
        targetType,
        shelfCount: filteredShelves.length,
        continuationPages,
        sample: filteredShelves.slice(0, 6).map(summarizeDiscoverShelf)
      });
      return setCachedDiscoverValue(cache, cacheKey, filteredShelves);
    }

    discoverDebug("browse:done", {
      browseId,
      preset,
      targetType,
      itemCount: items.length,
      continuationPages,
      sample: items.slice(0, 6).map(summarizeDiscoverItem)
    });
    return setCachedDiscoverValue(cache, cacheKey, items);
  }
}

async function fetchPublicYouTubeMusicBrowseDiscover(options = {}) {
  const preferCookies = shouldPreferDiscoverCookies(options);
  let triedCookies = false;

  if (preferCookies) {
    triedCookies = true;
    try {
      const items = await fetchYouTubeMusicBrowseDiscover({ ...options, useCookies: true });
      if (items.length) return items;
      discoverDebug("browse:cookie-empty", {
        browseId: options.browseId,
        params: options.params ? trimDiscoverText(options.params, 24) : "",
        targetType: options.targetType
      });
    } catch (error) {
      discoverDebug("browse:cookie-error", {
        browseId: options.browseId,
        params: options.params ? trimDiscoverText(options.params, 24) : "",
        targetType: options.targetType,
        error: error?.message || String(error)
      });
    }
  }

  try {
    const items = await fetchYouTubeMusicBrowseDiscover({ ...options, useCookies: false });
    if (items.length || triedCookies || String(process.env.YOUTUBE_DISCOVER_COOKIE_FALLBACK || "1") === "0") return items;
    discoverDebug("browse:public-empty", {
      browseId: options.browseId,
      params: options.params ? trimDiscoverText(options.params, 24) : "",
      targetType: options.targetType
    });
  } catch (error) {
    discoverDebug("browse:public-error", {
      browseId: options.browseId,
      params: options.params ? trimDiscoverText(options.params, 24) : "",
      targetType: options.targetType,
      error: error?.message || String(error)
    });
  }

  if (triedCookies) return [];
  return fetchYouTubeMusicBrowseDiscover({ ...options, useCookies: true });
}

async function fetchPublicYouTubeMusicBrowseShelves(options = {}) {
  const preferCookies = shouldPreferDiscoverCookies(options);
  let triedCookies = false;

  if (preferCookies) {
    triedCookies = true;
    try {
      const shelves = await fetchYouTubeMusicBrowseDiscover({ ...options, returnShelves: true, useCookies: true });
      if (shelves.length) return shelves;
      discoverDebug("browse-shelves:cookie-empty", {
        browseId: options.browseId,
        params: options.params ? trimDiscoverText(options.params, 24) : "",
        targetType: options.targetType
      });
    } catch (error) {
      discoverDebug("browse-shelves:cookie-error", {
        browseId: options.browseId,
        params: options.params ? trimDiscoverText(options.params, 24) : "",
        targetType: options.targetType,
        error: error?.message || String(error)
      });
    }
  }

  try {
    const shelves = await fetchYouTubeMusicBrowseDiscover({ ...options, returnShelves: true, useCookies: false });
    if (shelves.length || triedCookies || String(process.env.YOUTUBE_DISCOVER_COOKIE_FALLBACK || "1") === "0") return shelves;
    discoverDebug("browse-shelves:public-empty", {
      browseId: options.browseId,
      params: options.params ? trimDiscoverText(options.params, 24) : "",
      targetType: options.targetType
    });
  } catch (error) {
    discoverDebug("browse-shelves:public-error", {
      browseId: options.browseId,
      params: options.params ? trimDiscoverText(options.params, 24) : "",
      targetType: options.targetType,
      error: error?.message || String(error)
    });
  }

  if (triedCookies) return [];
  return fetchYouTubeMusicBrowseDiscover({ ...options, returnShelves: true, useCookies: true });
}

async function fetchYtdlpDiscoverPlaylist(url, { limit, targetType = "track", timeoutMs, label }) {
  const data = await runYtJson(
    ["--extractor-args", "youtubetab:skip=authcheck", "--flat-playlist", "--playlist-end", String(limit), url],
    label,
    timeoutMs
  );
  const entries = Array.isArray(data?.entries) ? data.entries : (data ? [data] : []);
  return normalizeDiscoverEntries(entries, { targetType });
}

async function expandDiscoverPlaylistsToTracks(playlists = [], { limit, timeoutMs, lang, region, useCookies = false } = {}) {
  const items = [];
  discoverDebug("playlist-expand:start", {
    playlistCount: Array.isArray(playlists) ? playlists.length : 0,
    limit,
    playlists: (Array.isArray(playlists) ? playlists : []).slice(0, 6).map(summarizeDiscoverItem)
  });
  for (const playlist of Array.isArray(playlists) ? playlists : []) {
    if (items.length >= limit) break;

    const playlistId = getDiscoverPlaylistId(playlist);
    if (!playlistId) {
      discoverDebug("playlist-expand:skip-no-id", summarizeDiscoverItem(playlist));
      continue;
    }

    const cacheKey = `${playlistId}:${limit}:${normalizeDiscoverLang(lang)}:${normalizeDiscoverRegion(region, lang)}`;
    const cached = getCachedDiscoverValue(DISCOVER_PLAYLIST_TRACK_CACHE, cacheKey);
    if (cached) {
      items.push(...cached.slice(0, Math.max(1, limit - items.length)));
      discoverDebug("playlist-expand:cache-hit", {
        playlist: summarizeDiscoverItem(playlist),
        trackCount: cached.length
      });
      continue;
    }

    let tracks = [];
    const browseId = playlist.browseId || `VL${playlistId}`;
    if (browseId) {
      try {
        tracks = await fetchPublicYouTubeMusicBrowseDiscover({
          browseId,
          limit: Math.max(1, limit - items.length),
          targetType: "track",
          preset: "",
          lang,
          region,
          timeoutMs,
          useCookies
        });
        discoverDebug("playlist-expand:api-tracks", {
          playlist: summarizeDiscoverItem(playlist),
          trackCount: tracks.length,
          sample: tracks.slice(0, 4).map(summarizeDiscoverItem)
        });
      } catch (error) {
        discoverDebug("playlist-expand:api-error", {
          playlist: summarizeDiscoverItem(playlist),
          error: error?.message || String(error)
        });
      }
    }

    try {
      if (!tracks.length) {
        tracks = await fetchYtdlpDiscoverPlaylist(
          `https://music.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`,
          {
            limit: Math.max(1, limit - items.length),
            timeoutMs: Math.min(timeoutMs, getDiscoverNumber(process.env.YOUTUBE_DISCOVER_PLAYLIST_TIMEOUT_MS || 10000, 10000, 1000, 30000)),
            label: "youtube-discover-playlist-tracks"
          }
        );
        discoverDebug("playlist-expand:ytdlp-tracks", {
          playlist: summarizeDiscoverItem(playlist),
          trackCount: tracks.length,
          sample: tracks.slice(0, 4).map(summarizeDiscoverItem)
        });
      }

      setCachedDiscoverValue(DISCOVER_PLAYLIST_TRACK_CACHE, cacheKey, tracks);
      items.push(...tracks);
    } catch (error) {
      discoverDebug("playlist-expand:error", {
        playlist: summarizeDiscoverItem(playlist),
        error: error?.message || String(error)
      });
    }
  }

  const unique = uniqueDiscoverItems(items, limit);
  discoverDebug("playlist-expand:done", {
    rawItems: items.length,
    uniqueItems: unique.length,
    sample: unique.slice(0, 6).map(summarizeDiscoverItem)
  });
  return unique;
}

function getLocalSignalPatterns(lang = "en") {
  const safeLang = normalizeDiscoverLang(lang);
  const signals = {
    tr: [/türk/i, /turk/i, /turkish/i, /türkiye/i, /turkiye/i, /yerel/i],
    de: [/deutsch/i, /german/i, /deutschland/i, /germany/i],
    fr: [/fran[çc]ais/i, /fran[çc]aise/i, /french/i, /france/i],
    es: [/latino/i, /latin/i, /espa[ñn]ol/i, /spanish/i, /espa[ñn]a/i, /mexic/i],
    en: [/english/i, /american/i, /british/i, /\bus\b/i, /\buk\b/i, /global/i, /international/i]
  };
  return signals[safeLang] || signals.en;
}

function matchesAnyPattern(value = "", patterns = []) {
  const source = String(value || "");
  return patterns.some((pattern) => pattern.test(source));
}

function getLocalCategoryScore(item = {}, lang = "en") {
  const safeLang = normalizeDiscoverLang(lang);
  const title = normalizeMusicHomeTitle(item.title || "").toLowerCase();
  const localSignals = getLocalSignalPatterns(safeLang);
  const foreignSignals = ["tr", "de", "fr", "es", "en"]
    .filter((candidate) => candidate !== safeLang)
    .flatMap((candidate) => getLocalSignalPatterns(candidate));
  let score = 0;
  if (/pop/i.test(title)) score += 4;
  if (matchesAnyPattern(title, localSignals)) score += 8;
  if (matchesAnyPattern(title, foreignSignals)) score -= 8;
  if (/k[-\s]?pop/i.test(title)) score -= 5;
  if (/hits?|top|chart|trend/i.test(title)) score += 1;
  if (safeLang === "tr" && /parti|havam|enerji|dans|neşeli|neseli|eğlence|eglence/i.test(title)) score += 2;
  return score;
}

function getMoodCategoryPatterns(preset = "") {
  const patterns = {
    energizing: [
      /power/,
      /energi/,
      /\benergy\b/,
      /energiz/,
      /energetic/,
      /upbeat/,
      /hareket/,
      /canli/,
      /motivasyon/,
      /motivation/,
      /dinamik/
    ],
    workout: [
      /workout/,
      /training/,
      /fitness/,
      /\bgym\b/,
      /exercise/,
      /antrenman/,
      /\bspor\b/,
      /egzersiz/,
      /entrenamiento/,
      /gimnasio/,
      /entrainement/,
      /sport/
    ],
    "feel-good": [
      /sentirse bien/,
      /feel good/,
      /happy/,
      /mood booster/,
      /good mood/,
      /keyif/,
      /iyi his/,
      /neseli/,
      /mutlu/,
      /gute laune/,
      /bonne humeur/,
      /buen rollo/,
      /alegre/,
      /joyeux/
    ],
    relax: [
      /relax/,
      /chill/,
      /calm/,
      /rahat/,
      /sakin/,
      /dinlen/,
      /entspann/,
      /detente/,
      /relaj/,
      /tranquil/
    ],
    sad: [
      /\bsad\b/,
      /sadness/,
      /huzun/,
      /duygusal/,
      /melankol/,
      /triste/,
      /traurig/,
      /chagrin/,
      /heartbreak/
    ],
    romance: [
      /romant/,
      /romance/,
      /\blove\b/,
      /\bask\b/,
      /amour/,
      /amor/,
      /liebe/
    ],
    commute: [
      /desplazamientos diarios/,
      /pour la route/,
      /commute/,
      /driving/,
      /drive/,
      /road trip/,
      /travel/,
      /yol/,
      /araba/,
      /surus/,
      /ise gid/,
      /pendel/,
      /arbeitsweg/,
      /fahrt/,
      /trajet/,
      /route/,
      /conduc/,
      /trayecto/,
      /viaje/
    ],
    party: [
      /party/,
      /parti/,
      /dance/,
      /dans/,
      /eglence/,
      /fiesta/,
      /feier/,
      /fete/,
      /soiree/
    ],
    focus: [
      /focus/,
      /fokus/,
      /odak/,
      /concentr/,
      /study/,
      /work/,
      /calisma/,
      /konzentr/,
      /travail/,
      /estudiar/,
      /trabajar/,
      /productiv/
    ],
    sleep: [
      /sleep/,
      /uyku/,
      /dorm/,
      /schlaf/,
      /sommeil/,
      /sueno/,
      /night/
    ]
  };
  return patterns[preset] || [];
}

function getLocalizedMoodCategoryTitles(preset = "", lang = "en") {
  const safeLang = normalizeDiscoverLang(lang);
  const titles = {
    en: {
      energizing: ["energizing", "energy"],
      workout: ["workout"],
      "feel-good": ["feel good"],
      relax: ["relax"],
      sad: ["sad"],
      romance: ["romance", "romantic"],
      commute: ["commute"],
      party: ["party"],
      focus: ["focus"],
      sleep: ["sleep"]
    },
    tr: {
      energizing: ["enerjik", "enerji"],
      workout: ["antrenman", "spor"],
      "feel-good": ["keyifli", "iyi hisset", "neseli"],
      relax: ["rahatlama", "rahatla", "sakin"],
      sad: ["huzunlu", "duygusal"],
      romance: ["romantik", "ask"],
      commute: ["ise gidip gelme", "yol"],
      party: ["parti"],
      focus: ["odaklanma", "odaklan"],
      sleep: ["uyku"]
    },
    fr: {
      energizing: ["energie"],
      workout: ["sport"],
      "feel-good": ["bonne humeur"],
      relax: ["detente"],
      sad: ["triste"],
      romance: ["romance"],
      commute: ["pour la route"],
      party: ["fete"],
      focus: ["concentration"],
      sleep: ["sommeil"]
    },
    de: {
      energizing: ["power"],
      workout: ["workout"],
      "feel-good": ["gute laune"],
      relax: ["entspannung"],
      sad: ["traurig"],
      romance: ["romantik"],
      commute: ["arbeitsweg"],
      party: ["party"],
      focus: ["konzentration"],
      sleep: ["einschlafen"]
    },
    es: {
      energizing: ["energia"],
      workout: ["entrenamiento"],
      "feel-good": ["sentirse bien"],
      relax: ["relax"],
      sad: ["triste"],
      romance: ["amor"],
      commute: ["desplazamientos diarios"],
      party: ["fiesta"],
      focus: ["concentracion"],
      sleep: ["dormir"]
    }
  };
  return titles[safeLang]?.[preset] || titles.en[preset] || [];
}

function getMoodCategoryScore(item = {}, preset = "", lang = "en") {
  const patterns = getMoodCategoryPatterns(preset);
  const exactTitles = getLocalizedMoodCategoryTitles(preset, lang);
  if (!patterns.length && !exactTitles.length) return 0;

  const title = normalizeSearchMatchText(item.title || "");
  const exactMatch = exactTitles.some((candidate) => title === candidate);
  const phraseMatch = exactTitles.some((candidate) => candidate && title.includes(candidate));
  const matchCount = patterns.filter((pattern) => pattern.test(title)).length;
  if (!matchCount && !phraseMatch) return 0;

  let score = matchCount * 10;
  if (exactMatch) score += 100;
  else if (phraseMatch) score += 60;
  if (new RegExp(`\\b${preset.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`).test(title)) score += 4;
  if (/playlist|mix|radio|songs|sarkilar|chansons|canciones|songs/.test(title)) score += 1;
  return score;
}

function getDiscoverCategoryScore(item = {}, preset = "", lang = "en") {
  const safePreset = normalizeDiscoverPreset(preset);
  if (isMoodDiscoverPreset(safePreset)) return getMoodCategoryScore(item, safePreset, lang);
  return getLocalCategoryScore(item, lang);
}

function getDiscoverCategoryLimit(preset, limit) {
  const safeLimit = Math.max(1, Number(limit) || 18);
  if (isMoodDiscoverPreset(preset)) return Math.max(80, Math.min(120, safeLimit * 4));
  if (preset === "local") return Math.max(60, Math.min(80, safeLimit * 3));
  return Math.max(24, Math.min(60, safeLimit * 2));
}

function selectDiscoverCategories(categoryCandidates = [], { preset, lang, maxLocal = 3, maxDefault = 6 } = {}) {
  const safePreset = normalizeDiscoverPreset(preset);
  if (isMoodDiscoverPreset(safePreset)) {
    return categoryCandidates
      .map((item) => ({ item, score: getMoodCategoryScore(item, safePreset, lang) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map(({ item }) => item);
  }

  if (safePreset !== "local") return categoryCandidates.slice(0, maxDefault);

  const scored = categoryCandidates
    .map((item) => ({ item, score: getLocalCategoryScore(item, lang) }))
    .filter(({ score }) => score > 0);

  if (scored.length) return scored.slice(0, maxLocal).map(({ item }) => item);
  return categoryCandidates.slice(0, maxLocal);
}

async function getDiscoverCategoryPlaylists({ preset, limit, lang, region, timeoutMs }) {
  const categoryLimit = getDiscoverCategoryLimit(preset, limit);
  const categories = await fetchPublicYouTubeMusicBrowseDiscover({
    browseId: "FEmusic_moods_and_genres",
    limit: categoryLimit,
    targetType: "playlist",
    preset: "",
    lang,
    region,
    timeoutMs
  });

  const categoryCandidates = categories
    .filter((item) => item.browseId === "FEmusic_moods_and_genres_category" && item.params)
    .sort((a, b) => {
      if (preset === "local" || isMoodDiscoverPreset(preset)) {
        return getDiscoverCategoryScore(b, preset, lang) - getDiscoverCategoryScore(a, preset, lang);
      }
      return 0;
    });

  const selectedCategories = selectDiscoverCategories(categoryCandidates, {
    preset,
    lang,
    maxLocal: 3,
    maxDefault: 6
  });

  discoverDebug("categories:playlists:selected", {
    preset,
    rawCategoryItems: categories.length,
    candidateCount: categoryCandidates.length,
    selectedCount: selectedCategories.length,
    candidates: categoryCandidates.slice(0, 10).map((item) => ({
      ...summarizeDiscoverItem(item),
      score: getDiscoverCategoryScore(item, preset, lang)
    })),
    selected: selectedCategories.map((item) => ({
      ...summarizeDiscoverItem(item),
      score: getDiscoverCategoryScore(item, preset, lang)
    }))
  });

  let playlists = [];
  for (const category of selectedCategories) {
    if (playlists.length >= limit) break;
    try {
      const categoryPlaylists = await fetchPublicYouTubeMusicBrowseDiscover({
        browseId: category.browseId,
        params: category.params,
        limit,
        targetType: "playlist",
        preset: "",
        lang,
        region,
        timeoutMs
      });
      playlists = uniqueDiscoverItems([...playlists, ...categoryPlaylists], limit);
      discoverDebug("categories:playlists:category", {
        category: summarizeDiscoverItem(category),
        returned: categoryPlaylists.length,
        total: playlists.length,
        sample: categoryPlaylists.slice(0, 5).map(summarizeDiscoverItem)
      });
    } catch (error) {
      discoverDebug("categories:playlists:error", {
        category: summarizeDiscoverItem(category),
        error: error?.message || String(error)
      });
    }
  }

  discoverDebug("categories:playlists:done", {
    preset,
    playlistCount: playlists.length,
    sample: playlists.slice(0, 8).map(summarizeDiscoverItem)
  });
  return playlists;
}

async function getDiscoverCategoryTracks({ preset, limit, lang, region, timeoutMs }) {
  const categoryLimit = getDiscoverCategoryLimit(preset, limit);
  const categories = await fetchPublicYouTubeMusicBrowseDiscover({
    browseId: "FEmusic_moods_and_genres",
    limit: categoryLimit,
    targetType: "playlist",
    preset: "",
    lang,
    region,
    timeoutMs
  });

  const categoryCandidates = categories
    .filter((item) => item.browseId === "FEmusic_moods_and_genres_category" && item.params)
    .sort((a, b) => {
      if (preset === "local" || isMoodDiscoverPreset(preset)) {
        return getDiscoverCategoryScore(b, preset, lang) - getDiscoverCategoryScore(a, preset, lang);
      }
      return 0;
    });

  const selectedCategories = selectDiscoverCategories(categoryCandidates, {
    preset,
    lang,
    maxLocal: 3,
    maxDefault: 6
  });

  discoverDebug("categories:tracks:selected", {
    preset,
    rawCategoryItems: categories.length,
    candidateCount: categoryCandidates.length,
    selectedCount: selectedCategories.length,
    candidates: categoryCandidates.slice(0, 10).map((item) => ({
      ...summarizeDiscoverItem(item),
      score: getDiscoverCategoryScore(item, preset, lang)
    })),
    selected: selectedCategories.map((item) => ({
      ...summarizeDiscoverItem(item),
      score: getDiscoverCategoryScore(item, preset, lang)
    }))
  });

  let tracks = [];
  for (const category of selectedCategories) {
    if (tracks.length >= limit) break;
    try {
      const categoryTracks = await fetchPublicYouTubeMusicBrowseDiscover({
        browseId: category.browseId,
        params: category.params,
        limit,
        targetType: "track",
        preset: "",
        lang,
        region,
        timeoutMs
      });
      tracks = uniqueDiscoverItems([...tracks, ...categoryTracks], limit);
      discoverDebug("categories:tracks:category", {
        category: summarizeDiscoverItem(category),
        returned: categoryTracks.length,
        total: tracks.length,
        sample: categoryTracks.slice(0, 5).map(summarizeDiscoverItem)
      });
    } catch (error) {
      discoverDebug("categories:tracks:error", {
        category: summarizeDiscoverItem(category),
        error: error?.message || String(error)
      });
    }
  }

  discoverDebug("categories:tracks:done", {
    preset,
    trackCount: tracks.length,
    sample: tracks.slice(0, 8).map(summarizeDiscoverItem)
  });
  return tracks;
}

function getDiscoverMoodFallbackQuery(preset = "", lang = "en") {
  const safeLang = normalizeDiscoverLang(lang);
  const queries = {
    tr: {
      energizing: "enerjik müzik",
      workout: "antrenman müzikleri",
      "feel-good": "keyifli şarkılar",
      relax: "rahatlama müziği",
      sad: "hüzünlü şarkılar",
      romance: "romantik şarkılar",
      commute: "işe giderken müzik",
      party: "parti müzikleri",
      focus: "odaklanma müziği",
      sleep: "uyku müziği"
    },
    en: {
      energizing: "energetic music",
      workout: "workout music",
      "feel-good": "feel good music",
      relax: "relaxing music",
      sad: "sad music",
      romance: "romantic music",
      commute: "commute music",
      party: "party music",
      focus: "focus music",
      sleep: "sleep music"
    },
    de: {
      energizing: "power musik",
      workout: "workout musik",
      "feel-good": "gute laune musik",
      relax: "entspannung musik",
      sad: "traurig musik",
      romance: "romantik musik",
      commute: "arbeitsweg musik",
      party: "partymusik",
      focus: "konzentration musik",
      sleep: "einschlafen musik"
    },
    fr: {
      energizing: "energie musique",
      workout: "sport musique",
      "feel-good": "musique bonne humeur",
      relax: "musique detente",
      sad: "chansons tristes",
      romance: "romance musique",
      commute: "pour la route musique",
      party: "musique fete",
      focus: "musique concentration",
      sleep: "musique sommeil"
    },
    es: {
      energizing: "musica energica",
      workout: "musica entrenamiento",
      "feel-good": "musica sentirse bien",
      relax: "musica relax",
      sad: "canciones tristes",
      romance: "musica amor",
      commute: "musica desplazamientos diarios",
      party: "musica de fiesta",
      focus: "musica concentracion",
      sleep: "musica dormir"
    }
  };
  return queries[safeLang]?.[preset] || queries.en[preset] || "music";
}

function getDiscoverMoodFallbackQueries(preset = "", lang = "en") {
  const safeLang = normalizeDiscoverLang(lang);
  const variants = {
    tr: {
      energizing: ["enerjik", "enerjik şarkılar", "hareketli şarkılar", "motivasyon müzikleri", "türkçe hareketli şarkılar"],
      workout: ["antrenman", "spor müzikleri", "fitness şarkıları", "gym müzikleri", "koşu müzikleri"],
      "feel-good": ["keyifli", "keyifli şarkılar", "iyi hissettiren müzikler", "neşeli şarkılar", "mutlu şarkılar"],
      relax: ["rahatlama", "rahatlama müziği", "sakin müzik", "chill müzik", "dinlendirici şarkılar"],
      sad: ["hüzünlü", "hüzünlü şarkılar", "duygusal müzik", "melankolik şarkılar", "ağlatan şarkılar"],
      romance: ["romantik", "romantik şarkılar", "aşk şarkıları", "romantik müzik", "sevda şarkıları"],
      commute: ["işe giderken", "işe giderken müzik", "yol müzikleri", "araba müzikleri", "uzun yol şarkıları"],
      party: ["parti", "parti müzikleri", "dans şarkıları", "eğlence müzikleri", "hareketli pop"],
      focus: ["odaklanma", "odaklanma müziği", "çalışma müziği", "konsantrasyon müziği", "ders çalışma müziği"],
      sleep: ["uyku", "uyku müziği", "rahat uyku müzikleri", "sakin uyku müziği", "uyku şarkıları"]
    },
    en: {
      energizing: ["energetic music", "upbeat songs", "motivation music", "energy songs"],
      workout: ["workout music", "gym music", "fitness songs", "running music"],
      "feel-good": ["feel good music", "happy songs", "mood booster music", "good mood songs"],
      relax: ["relaxing music", "chill music", "calm songs", "relax songs"],
      sad: ["sad music", "sad songs", "melancholy music", "emotional songs"],
      romance: ["romantic music", "love songs", "romance songs", "romantic songs"],
      commute: ["commute music", "driving music", "road trip songs", "travel songs"],
      party: ["party music", "dance songs", "party playlist", "club songs"],
      focus: ["focus music", "study music", "concentration music", "work music"],
      sleep: ["sleep music", "sleep songs", "calm sleep music", "night music"]
    },
    de: {
      energizing: ["power musik", "energie musik", "motivationsmusik", "dynamische musik"],
      workout: ["workout musik", "fitness musik", "training musik", "laufmusik"],
      "feel-good": ["gute laune musik", "frohe songs", "feel good musik", "glückliche songs"],
      relax: ["entspannung musik", "ruhige musik", "chill musik", "relax musik"],
      sad: ["traurig musik", "melancholische musik", "traurige songs", "emotionale songs"],
      romance: ["romantik musik", "liebeslieder", "romantische songs", "liebe musik"],
      commute: ["arbeitsweg musik", "musik zum pendeln", "fahrmusik", "roadtrip songs"],
      party: ["partymusik", "tanzmusik", "party songs", "club musik"],
      focus: ["konzentration musik", "fokus musik", "musik zum arbeiten", "lern musik"],
      sleep: ["einschlafen musik", "schlafmusik", "ruhige schlafmusik", "nacht musik"]
    },
    fr: {
      energizing: ["energie musique", "musique energique", "musique dynamique", "musique motivation"],
      workout: ["sport musique", "musique sport", "chansons fitness", "musique entrainement"],
      "feel-good": ["musique bonne humeur", "chansons joyeuses", "musique feel good", "bonne humeur chansons"],
      relax: ["musique detente", "musique relaxante", "musique calme", "chansons relax"],
      sad: ["chansons tristes", "musique melancolique", "musique triste", "chansons emotionnelles"],
      romance: ["romance musique", "musique romantique", "chansons amour", "chansons romantiques"],
      commute: ["pour la route musique", "musique route", "musique voiture", "chansons voyage"],
      party: ["musique fete", "chansons danse", "musique soiree", "musique party"],
      focus: ["musique concentration", "musique travail", "musique focus", "musique etudier"],
      sleep: ["musique sommeil", "musique pour dormir", "musique calme sommeil", "musique nuit"]
    },
    es: {
      energizing: ["musica energica", "canciones motivadoras", "musica con energia", "musica dinamica"],
      workout: ["musica entrenamiento", "musica gimnasio", "canciones fitness", "musica correr"],
      "feel-good": ["musica sentirse bien", "musica buen rollo", "canciones alegres", "musica feliz"],
      relax: ["musica relax", "musica relajante", "musica tranquila", "canciones relax"],
      sad: ["canciones tristes", "musica melancolica", "musica triste", "canciones emocionales"],
      romance: ["musica amor", "canciones de amor", "musica romantica", "canciones romanticas"],
      commute: ["musica desplazamientos diarios", "musica para conducir", "canciones de viaje", "musica carretera"],
      party: ["musica de fiesta", "canciones para bailar", "musica party", "musica discoteca"],
      focus: ["musica concentracion", "musica para estudiar", "musica para trabajar", "musica focus"],
      sleep: ["musica dormir", "musica para dormir", "musica tranquila para dormir", "musica noche"]
    }
  };
  return Array.from(new Set([
    getDiscoverMoodFallbackQuery(preset, safeLang),
    ...(variants[safeLang]?.[preset] || variants.en[preset] || [])
  ].map((query) => String(query || "").trim()).filter(Boolean)));
}

const discoverMoodSearchCache = ytmSharedCache.map("mood-queries");
const discoverMoodSearchInFlight = new Map();
const discoverMoodPools = ytmSharedCache.map("mood-pools");
const discoverMoodPoolInFlight = new Map();

async function searchDiscoverMoodFallback({ preset, limit, lang, region, timeoutMs = 6000 }) {
  const key = JSON.stringify({ preset, lang, region });
  // Different browsers/page sizes share the pool fill, not just identical URLs.
  const active = discoverMoodPoolInFlight.get(key);
  if (active) {
    await active;
    const pool = getCachedDiscoverValue(discoverMoodPools, key);
    if (pool?.items.length >= limit) return { items: pool.items.slice(0, limit) };
  }
  const request = fillDiscoverMoodPool({ preset, limit, lang, region, timeoutMs });
  discoverMoodPoolInFlight.set(key, request);
  try { return await request; }
  finally { if (discoverMoodPoolInFlight.get(key) === request) discoverMoodPoolInFlight.delete(key); }
}

async function fillDiscoverMoodPool({ preset, limit, lang, region, timeoutMs }) {
  const queries = getDiscoverMoodFallbackQueries(preset, lang);
  const deadline = Date.now() + Math.min(timeoutMs, 6000);
  const poolKey = JSON.stringify({ preset, lang, region });
  let pool = getCachedDiscoverValue(discoverMoodPools, poolKey);
  if (!pool) {
    pool = { items: [], completedQueries: [] };
    setCachedDiscoverValue(discoverMoodPools, poolKey, pool);
  }
  const searchQuery = async (query) => {
    // Fixed batch size means pagination reuses earlier query results.
    const key = JSON.stringify({ query, lang, region });
    let tracks = getCachedDiscoverValue(discoverMoodSearchCache, key);
    if (!tracks) {
      let request = discoverMoodSearchInFlight.get(key);
      if (!request) {
        request = searchYouTubeMusicContent(query, {
          limit: 30, type: "track", lang, region, useCookies: false,
          timeoutMs: Math.min(2500, Math.max(1, deadline - Date.now()))
        }).then((result) => {
          if (result.length) setCachedDiscoverValue(discoverMoodSearchCache, key, result);
          return result;
        }).finally(() => discoverMoodSearchInFlight.delete(key));
        discoverMoodSearchInFlight.set(key, request);
      }
      tracks = await request;
    }
    return tracks;
  };
  const pending = queries.filter((query) => !pool.completedQueries.includes(query));
  // Keep only two upstream searches active per mood. The accumulated ordering
  // remains stable across pages even if an earlier query fails and recovers.
  for (let index = 0; index < pending.length; index += 2) {
    if (pool.items.length >= limit || Date.now() >= deadline) break;
    const batch = pending.slice(index, index + 2);
    const results = await Promise.all(batch.map(searchQuery));
    results.forEach((tracks, offset) => {
      if (tracks.length && !pool.completedQueries.includes(batch[offset])) pool.completedQueries.push(batch[offset]);
      pool.items = uniqueMusicHomeItems([...pool.items, ...tracks], 120);
    });
  }
  // Persist mutations without extending the original pool's freshness window.
  const entry = discoverMoodPools.get(poolKey);
  if (entry) discoverMoodPools.set(poolKey, entry);
  return { query: queries.join(" | "), items: pool.items.slice(0, limit) };
}

function getDiscoverMoodDisplayTitle(preset = "", lang = "en") {
  const safeLang = normalizeDiscoverLang(lang);
  const titles = {
    tr: {
      energizing: "Enerjik",
      workout: "Antrenman",
      "feel-good": "Keyifli",
      relax: "Rahatlama",
      sad: "Hüzünlü",
      romance: "Romantik",
      commute: "İşe gidip gelme",
      party: "Parti",
      focus: "Odaklanma",
      sleep: "Uyku"
    },
    en: {
      energizing: "Energetic",
      workout: "Workout",
      "feel-good": "Feel good",
      relax: "Relax",
      sad: "Sad",
      romance: "Romantic",
      commute: "Commute",
      party: "Party",
      focus: "Focus",
      sleep: "Sleep"
    },
    de: {
      energizing: "Power",
      workout: "Workout",
      "feel-good": "Gute Laune",
      relax: "Entspannung",
      sad: "Traurig",
      romance: "Romantisch",
      commute: "Arbeitsweg",
      party: "Party",
      focus: "Konzentration",
      sleep: "Einschlafen"
    },
    fr: {
      energizing: "Énergie",
      workout: "Sport",
      "feel-good": "Bonne humeur",
      relax: "Détente",
      sad: "Triste",
      romance: "Romance",
      commute: "Pour la route",
      party: "Fête",
      focus: "Concentration",
      sleep: "Sommeil"
    },
    es: {
      energizing: "Energía",
      workout: "Entrenamiento",
      "feel-good": "Sentirse bien",
      relax: "Relax",
      sad: "Triste",
      romance: "Amor",
      commute: "Desplazamientos diarios",
      party: "Fiesta",
      focus: "Concentración",
      sleep: "Dormir"
    }
  };
  return titles[safeLang]?.[preset] || titles.en[preset] || "YouTube Music";
}

async function getDiscoverItemsForPreset({ preset, limit, lang, region, timeoutMs }) {
  const safePreset = normalizeDiscoverPreset(preset);
  const safeLang = normalizeDiscoverLang(lang);
  const safeRegion = normalizeDiscoverRegion(region, safeLang);
  discoverDebug("preset:start", { preset: safePreset, limit, lang: safeLang, region: safeRegion });

  if (isMoodDiscoverPreset(safePreset)) {
    const result = await searchDiscoverMoodFallback({
      preset: safePreset, limit, lang: safeLang, region: safeRegion, timeoutMs
    });
    return result.items;
  }

  if (safePreset === "popular") {
    const chartPlaylists = await fetchPublicYouTubeMusicBrowseDiscover({
      browseId: "FEmusic_charts",
      limit: Math.max(12, Math.min(40, limit)),
      targetType: "playlist",
      preset: "",
      lang,
      region,
      timeoutMs
    }).then((items) => items.filter((item) => getDiscoverPlaylistId(item)));
    discoverDebug("preset:popular:chart-playlists", {
      count: chartPlaylists.length,
      sample: chartPlaylists.slice(0, 8).map(summarizeDiscoverItem)
    });
    const chartTracks = await expandDiscoverPlaylistsToTracks(chartPlaylists, { limit, timeoutMs, lang, region });
    if (chartTracks.length) {
      discoverDebug("preset:popular:return-expanded-tracks", {
        count: chartTracks.length,
        sample: chartTracks.slice(0, 6).map(summarizeDiscoverItem)
      });
      return chartTracks;
    }

    const directTracks = await fetchPublicYouTubeMusicBrowseDiscover({
      browseId: "FEmusic_charts",
      limit,
      targetType: "track",
      preset: "",
      lang,
      region,
      timeoutMs
    });
    discoverDebug("preset:popular:return-direct-tracks", {
      count: directTracks.length,
      sample: directTracks.slice(0, 6).map(summarizeDiscoverItem)
    });
    return directTracks;
  }

  if (safePreset === "new") {
    try {
      const newVideos = await fetchPublicYouTubeMusicBrowseDiscover({
        browseId: "FEmusic_new_releases_videos",
        limit,
        targetType: "track",
        preset: "",
        lang,
        region,
        timeoutMs
      });
      discoverDebug("preset:new:direct-videos", {
        count: newVideos.length,
        sample: newVideos.slice(0, 8).map(summarizeDiscoverItem)
      });
      if (newVideos.length) return newVideos;
    } catch (error) {
      discoverDebug("preset:new:direct-videos-error", { error: error?.message || String(error) });
    }

    const exploreTracks = await fetchPublicYouTubeMusicBrowseDiscover({
      browseId: "FEmusic_explore",
      limit,
      targetType: "track",
      preset: "new",
      lang,
      region,
      timeoutMs
    });
    discoverDebug("preset:new:return-explore", {
      count: exploreTracks.length,
      sample: exploreTracks.slice(0, 8).map(summarizeDiscoverItem)
    });
    return exploreTracks;
  }

  if (safePreset === "playlist") {
    const playlists = await getDiscoverCategoryPlaylists({ preset: "playlist", limit, lang, region, timeoutMs });
    discoverDebug("preset:playlist:return", {
      count: playlists.length,
      sample: playlists.slice(0, 8).map(summarizeDiscoverItem)
    });
    return playlists;
  }

  const localDirectTracks = await getDiscoverCategoryTracks({ preset: "local", limit, lang, region, timeoutMs });
  if (localDirectTracks.length) {
    discoverDebug("preset:local:return-direct-category-tracks", {
      count: localDirectTracks.length,
      sample: localDirectTracks.slice(0, 8).map(summarizeDiscoverItem)
    });
    return localDirectTracks;
  }

  const localPlaylists = await getDiscoverCategoryPlaylists({ preset: "local", limit: Math.max(12, Math.min(40, limit)), lang, region, timeoutMs });
  const localTracks = await expandDiscoverPlaylistsToTracks(localPlaylists, { limit, timeoutMs, lang, region });
  if (localTracks.length) {
    discoverDebug("preset:local:return-expanded-tracks", {
      count: localTracks.length,
      sample: localTracks.slice(0, 8).map(summarizeDiscoverItem)
    });
    return localTracks;
  }

  const fallbackChartPlaylists = await fetchPublicYouTubeMusicBrowseDiscover({
    browseId: "FEmusic_charts",
    limit: Math.max(12, Math.min(40, limit)),
    targetType: "playlist",
    preset: "",
    lang,
    region,
    timeoutMs
  }).then((items) => items.filter((item) => getDiscoverPlaylistId(item)));
  const fallbackTracks = await expandDiscoverPlaylistsToTracks(fallbackChartPlaylists, { limit, timeoutMs, lang, region });
  discoverDebug("preset:local:return-fallback-chart", {
    playlistCount: fallbackChartPlaylists.length,
    count: fallbackTracks.length,
    sample: fallbackTracks.slice(0, 8).map(summarizeDiscoverItem)
  });
  return fallbackTracks;
}

function isLikelyTurkishDiscoverText(value = "") {
  const text = normalizeMusicHomeTitle(value).toLowerCase();
  return (
    /[çğıöşü]/i.test(text) ||
    /\b(türk|turk|turkish|türkçe|turkce|kürtçe|kurtce|arabesk|yeni\s+klip|kırgınım|kirginim|değiştiremezsin|degistiremezsin|sebebi\s+yar|durum\s+çok\s+acil|durum\s+cok\s+acil)\b/i.test(text)
  );
}

function filterDiscoverItemsForLocale(items = [], { preset, lang } = {}) {
  if (normalizeDiscoverPreset(preset) !== "new" || normalizeDiscoverLang(lang) !== "en") {
    return items;
  }

  const filtered = (Array.isArray(items) ? items : []).filter((item) => {
    const text = `${item?.title || ""} ${item?.uploader || ""}`;
    return !isLikelyTurkishDiscoverText(text);
  });

  discoverDebug("locale-filter:new", {
    lang,
    before: Array.isArray(items) ? items.length : 0,
    after: filtered.length,
    removed: (Array.isArray(items) ? items : [])
      .filter((item) => isLikelyTurkishDiscoverText(`${item?.title || ""} ${item?.uploader || ""}`))
      .slice(0, 6)
      .map(summarizeDiscoverItem)
  });

  return filtered;
}

// Reads queryless regional discovery feeds for the ytlive preset buttons.
const discoverRequestsInFlight = new Map();

export async function discoverYouTubeContent(options = {}) {
  const lang = normalizeDiscoverLang(options.lang);
  const normalized = {
    preset: normalizeDiscoverPreset(options.preset), limit: normalizeSearchLimit(options.limit ?? 18),
    page: normalizeDiscoverPage(options.page), lang, region: normalizeDiscoverRegion(options.region, lang)
  };
  const key = JSON.stringify(normalized);
  if (discoverRequestsInFlight.has(key)) return discoverRequestsInFlight.get(key);
  const request = loadDiscoverYouTubeContent(normalized);
  discoverRequestsInFlight.set(key, request);
  try { return await request; } finally { discoverRequestsInFlight.delete(key); }
}

async function loadDiscoverYouTubeContent({ preset = "popular", limit = 18, page = 1, lang = "en", region = "" } = {}) {
  const safePreset = normalizeDiscoverPreset(preset);
  const safeLimit = normalizeSearchLimit(limit);
  const safePage = normalizeDiscoverPage(page);
  const safeLang = normalizeDiscoverLang(lang);
  const safeRegion = normalizeDiscoverRegion(region, safeLang);
  const targetType = getDiscoverTargetType(safePreset);
  const offset = (safePage - 1) * safeLimit;
  const fetchLimit = Math.min(120, offset + safeLimit + 1);
  const timeout = getDiscoverNumber(
    process.env.YOUTUBE_DISCOVER_TIMEOUT_MS || process.env.YOUTUBE_SEARCH_TIMEOUT_MS || 12000,
    12000,
    1000,
    30000
  );
  const apiTimeout = Math.min(
    timeout,
    getDiscoverNumber(process.env.YOUTUBE_DISCOVER_API_TIMEOUT_MS || 9000, 9000, 1000, 30000)
  );
  let items = [];
  const resultCacheKey = JSON.stringify({
    preset: safePreset,
    limit: safeLimit,
    page: safePage,
    lang: safeLang,
    region: safeRegion
  });
  const cachedResult = getCachedDiscoverValue(DISCOVER_RESULT_CACHE, resultCacheKey);
  if (cachedResult) {
    discoverDebug("request:cache-hit", {
      preset: safePreset,
      page: safePage,
      itemCount: cachedResult.items?.length || 0,
      hasMore: !!cachedResult.hasMore
    });
    return cachedResult;
  }

  discoverDebug("request:start", {
    preset: safePreset,
    limit: safeLimit,
    page: safePage,
    lang: safeLang,
    region: safeRegion,
    targetType,
    fetchLimit,
    timeout
  });
  try {
    items = await getDiscoverItemsForPreset({
      preset: safePreset,
      limit: fetchLimit,
      lang: safeLang,
      region: safeRegion,
      timeoutMs: apiTimeout
    });
    items = filterDiscoverItemsForLocale(items, { preset: safePreset, lang: safeLang });
  } catch (error) {
    console.warn(`YouTube Music discover ${safePreset} failed:`, error?.message || error);
  }

  const pageItems = items.slice(offset, offset + safeLimit).map((item, index) => ({
    ...item,
    index: offset + index + 1
  }));

  discoverDebug("request:done", {
    preset: safePreset,
    totalItems: items.length,
    offset,
    pageItems: pageItems.length,
    hasMore: items.length > offset + safeLimit,
    sample: pageItems.slice(0, 8).map(summarizeDiscoverItem)
  });

  const result = {
    query: "",
    filterOnly: true,
    preset: safePreset,
    type: targetType,
    lang: safeLang,
    region: safeRegion,
    page: safePage,
    hasMore: items.length > offset + safeLimit,
    items: pageItems,
    ...(ytmApiGate.retryAfterMs() ? { retryAfterMs: ytmApiGate.retryAfterMs(), warning: ytmRateLimitWarning } : {})
  };
  // Transient upstream failures must remain retryable.
  return pageItems.length === safeLimit && !result.retryAfterMs ? setCachedDiscoverValue(DISCOVER_RESULT_CACHE, resultCacheKey, result) : result;
}

function hasUsableCookieSource() {
  const cookieFile = String(process.env.YTDLP_COOKIES || "").trim();
  if (cookieFile) {
    try {
      if (fs.existsSync(cookieFile) && fs.statSync(cookieFile).size > 0) {
        return true;
      }
    } catch {}
  }

  return !!String(process.env.YTDLP_COOKIES_FROM_BROWSER || "").trim();
}

function shouldPreferDiscoverCookies({ lang = "" } = {}) {
  if (!hasUsableCookieSource()) return false;

  const configured = String(process.env.YOUTUBE_DISCOVER_COOKIE_FIRST || "").trim();
  if (configured) return configured !== "0";

  const requestedLang = normalizeDiscoverLang(lang || getInnertubeLang());
  const defaultLang = normalizeDiscoverLang(getInnertubeLang());
  return requestedLang === defaultLang;
}

function normalizeMusicHomeNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeMusicHomeTitle(value = "") {
  return toNFC(String(value || "").replace(/\s+/g, " ").trim());
}

function normalizeMusicHomeTitleKey(value = "") {
  return normalizeMusicHomeTitle(value)
    .toLocaleLowerCase("tr")
    .replace(/[ıİ]/g, "i")
    .replace(/[ğ]/g, "g")
    .replace(/[ü]/g, "u")
    .replace(/[ş]/g, "s")
    .replace(/[ö]/g, "o")
    .replace(/[ç]/g, "c")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getMusicHomeShelfTitle(node = {}) {
  return normalizeMusicHomeTitle(
    node?.title ||
    node?.playlist_title ||
    node?.name ||
    node?.label ||
    node?.tab_title ||
    node?.section_title ||
    ""
  );
}

function isMusicHomePlayableItem(item = {}) {
  const url = String(item.webpage_url || item.url || "");
  const id = String(item.id || "");
  const type = String(item.type || "").toLowerCase();
  if (!url) return false;
  if (isLikelyYouTubeVideoId(id)) return true;
  if (type === "album" && /\/browse\/MPRE/i.test(url)) return true;
  if (type === "playlist" && (extractSearchPlaylistId(url) || /\/playlist\?/i.test(url))) return true;
  if (extractSearchPlaylistId(url)) return true;
  return /(?:\/watch\?|youtu\.be\/|\/playlist\?|\/browse\/MPRE)/i.test(url);
}

function normalizeMusicHomeItem(entry = {}, index = 0) {
  const base = processEntry(entry, index);
  const type = inferSearchEntryType(entry, base);
  const webpageUrl = normalizeSearchWebpageUrl(entry, base, type);
  const item = {
    ...base,
    index: index + 1,
    type,
    source: "youtube_music_home",
    webpage_url: webpageUrl,
    url: webpageUrl
  };

  if (!item.title && !item.id && !item.webpage_url) return null;
  if (!isMusicHomePlayableItem(item)) return null;
  return item;
}

function getMusicHomeItemKey(item = {}) {
  const playlistId = extractSearchPlaylistId(item.webpage_url || item.url || "");
  const paramKey = item.params ? `${item.id || item.browseId || ""}:${item.params}` : "";
  return String(
    paramKey ||
    item.id ||
    playlistId ||
    item.webpage_url ||
    item.url ||
    `${item.title || ""}:${item.uploader || ""}`
  ).trim().toLowerCase();
}

function uniqueMusicHomeItems(items = [], limit = 12) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = getMusicHomeItemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }

  return out;
}

function isMusicHomeDisplayItem(item = {}) {
  return ["track", "playlist", "album"].includes(String(item.type || "").toLowerCase()) &&
    !!(item.webpage_url || item.url);
}

function countMusicHomeShelfTracks(shelf = {}) {
  return (Array.isArray(shelf?.items) ? shelf.items : [])
    .filter((item) => String(item?.type || "").toLowerCase() === "track")
    .length;
}

function orderMusicHomeShelvesForDisplay(shelves = [], maxShelves = 6) {
  const list = Array.isArray(shelves) ? shelves : [];
  const trackShelves = list.filter((shelf) => countMusicHomeShelfTracks(shelf) > 0);
  if (!trackShelves.length) return list.slice(0, maxShelves);

  const preferredTrackCount = Math.min(
    trackShelves.length,
    Math.max(1, Math.ceil(maxShelves / 2))
  );
  const picked = [];
  const seen = new Set();

  const addShelf = (shelf) => {
    const key = `${normalizeMusicHomeTitleKey(shelf?.title) || ""}:${getMusicHomeItemKey(shelf?.items?.[0] || {})}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    picked.push(shelf);
  };

  trackShelves.slice(0, preferredTrackCount).forEach(addShelf);
  list.forEach(addShelf);
  return picked.slice(0, maxShelves);
}

function buildMusicHomeShelves(data, { maxShelves = 6, limitPerShelf = 12 } = {}) {
  const shelves = [];
  const seenShelves = new Set();
  const visited = new WeakSet();

  const addShelf = (title, items) => {
    const shelfItems = uniqueMusicHomeItems(items, limitPerShelf);
    if (!shelfItems.length) return;

    const safeTitle = normalizeMusicHomeTitle(title) || "YouTube Music";
    const firstKey = getMusicHomeItemKey(shelfItems[0]);
    const shelfKey = `${safeTitle.toLowerCase()}:${firstKey}`;
    if (seenShelves.has(shelfKey)) return;

    seenShelves.add(shelfKey);
    shelves.push({
      title: safeTitle,
      items: shelfItems
    });
  };

  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 7 || shelves.length >= maxShelves) return;
    if (visited.has(node)) return;
    visited.add(node);

    const entries = Array.isArray(node.entries) ? node.entries.filter(Boolean) : [];
    if (entries.length) {
      const directItems = entries
        .map((entry, index) => normalizeMusicHomeItem(entry, index))
        .filter(Boolean);

      if (directItems.length) {
        const title = getMusicHomeShelfTitle(node) || (depth === 0 ? "YouTube Music" : "");
        if (title || directItems.length > 1) {
          addShelf(title || "YouTube Music", directItems);
        }
      }

      for (const entry of entries) {
        walk(entry, depth + 1);
        if (shelves.length >= maxShelves) return;
      }
    }

    const nestedKeys = ["contents", "items", "sections", "tabs", "shelves", "children"];
    for (const key of nestedKeys) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          walk(child, depth + 1);
          if (shelves.length >= maxShelves) return;
        }
      } else if (value && typeof value === "object") {
        walk(value, depth + 1);
      }
    }
  };

  walk(data);
  return shelves.slice(0, maxShelves);
}

function hasCookieFile(filePath = "") {
  const p = String(filePath || "").trim();
  if (!p) return false;
  try {
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

let ytmExportedCookieCache = {
  path: "",
  expiresAt: 0
};

let ytmBootstrapCache = {
  cookieKey: "",
  config: {},
  expiresAt: 0
};

// Complete results are cached briefly; partial results also keep their private
// continuation checkpoint so the next request can resume instead of stopping.
const ytmHomeResultCache = ytmSharedCache.map("home");
const ytmHomeResultInFlight = new Map();
const ytmPublicHomeCache = ytmSharedCache.map("public-home");
const ytmPublicHomeInFlight = new Map();

function getYtmHomeResultCacheKey({ lang, region, sessionKey }) {
  return JSON.stringify({
    sessionKey,
    authUser: String(process.env.YTM_AUTH_USER || "").trim(),
    lang: normalizeDiscoverLang(lang),
    region: normalizeDiscoverRegion(region, lang)
  });
}

function cloneYtmHomeResult(result = {}) {
  return {
    ...result,
    authAttempts: Array.isArray(result.authAttempts) ? [...result.authAttempts] : result.authAttempts,
    shelves: (Array.isArray(result.shelves) ? result.shelves : []).map((shelf) => ({
      ...shelf,
      items: Array.isArray(shelf?.items) ? [...shelf.items] : []
    }))
  };
}

function getCachedYtmHomeResult(key) {
  const entry = ytmHomeResultCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now() || !Array.isArray(entry.result?.shelves)) {
    ytmHomeResultCache.delete(key);
    return null;
  }
  return entry;
}

function cacheYtmHomeResult(key, result = {}, resumeState = null) {
  if (result?.source !== "innertube" || result?.personalized === false || !result?.shelves?.length) return;
  for (const [entryKey, entry] of ytmHomeResultCache) {
    if (entry.expiresAt <= Date.now() || ytmHomeResultCache.size >= 32) ytmHomeResultCache.delete(entryKey);
  }
  ytmHomeResultCache.set(key, {
    expiresAt: Date.now() + 24 * 60 * 60_000,
    freshUntil: Date.now() + YTM_HOME_RESULT_CACHE_TTL_MS,
    updatedAt: Date.now(),
    retryAt: Date.now() + (result.warning ? getDiscoverNumber(process.env.YTM_PARTIAL_RETRY_DELAY_MS ?? 5000, 5000, 0, 60000) : 0),
    result: cloneYtmHomeResult(result),
    resumeState
  });
}

function invalidateYtmSessionCaches({ removeExport = false } = {}) {
  const cachedPath = ytmExportedCookieCache.path;
  ytmExportedCookieCache = { path: "", expiresAt: 0 };
  ytmBootstrapCache = { cookieKey: "", config: {}, expiresAt: 0 };
  ytmHomeResultCache.clear();

  if (removeExport && cachedPath) {
    try {
      const safeRoot = path.resolve(YTM_COOKIE_EXPORT_DIR);
      const safePath = path.resolve(cachedPath);
      if (safePath.startsWith(`${safeRoot}${path.sep}`)) fs.unlinkSync(safePath);
    } catch {}
  }
}

function pruneMusicHomeCookieExports() {
  try {
    const entries = fs
      .readdirSync(YTM_COOKIE_EXPORT_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^ytm-cookies-.*\.txt$/i.test(entry.name))
      .map((entry) => {
        const abs = path.join(YTM_COOKIE_EXPORT_DIR, entry.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(abs).mtimeMs || 0; } catch {}
        return { abs, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const now = Date.now();
    entries.forEach((entry, index) => {
      if (index < 4 && now - entry.mtimeMs < 10 * 60 * 1000) return;
      try { fs.unlinkSync(entry.abs); } catch {}
    });
  } catch {}
}

function exportBrowserCookiesForMusicHome(timeoutMs = 5000) {
  const cookieBrowser = String(process.env.YTDLP_COOKIES_FROM_BROWSER || "").trim();
  if (!cookieBrowser) return Promise.resolve("");

  const YTDLP_BIN = resolveYtDlp();
  if (!YTDLP_BIN) {
    return Promise.reject(new Error("yt-dlp not found. Please install it or set YTDLP_BIN to its path."));
  }

  fs.mkdirSync(YTM_COOKIE_EXPORT_DIR, { recursive: true });
  pruneMusicHomeCookieExports();
  const cookiePath = path.join(YTM_COOKIE_EXPORT_DIR, `ytm-cookies-${Date.now()}-${process.pid}.txt`);
  fs.writeFileSync(cookiePath, "# Netscape HTTP Cookie File\n");

  const args = [
    "--ignore-config",
    "--no-warnings",
    "--cookies-from-browser", cookieBrowser,
    "--cookies", cookiePath,
    "--skip-download",
    "--simulate",
    "--retries", "0",
    "--socket-timeout", "1",
    YTM_HOME_BROWSE_URL
  ];

  return new Promise((resolve, reject) => {
    let stderrData = "";
    const child = spawnSafe(YTDLP_BIN, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: getBinaryRuntimeEnv()
    });
    const timeoutId = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderrData += chunk.toString();
    });

    child.on("close", () => {
      clearTimeout(timeoutId);
      if (hasCookieFile(cookiePath) && fs.statSync(cookiePath).size > "# Netscape HTTP Cookie File\n".length) {
        resolve(cookiePath);
        return;
      }
      reject(new Error(`YouTube Music browser cookies could not be exported.\n${stderrData.slice(-500)}`));
    });

    child.on("error", (error) => {
      clearTimeout(timeoutId);
      reject(new Error(`YouTube Music browser cookie export failed: ${error.message}`));
    });
  });
}

const ytmCookieExportsInFlight = new Map();

async function resolveMusicHomeCookieFile({ forceRefresh = false } = {}) {
  const cookieFile = String(process.env.YTDLP_COOKIES || "").trim();
  if (hasCookieFile(cookieFile)) return cookieFile;
  if (String(process.env.YTDLP_COOKIES_FROM_BROWSER || "").trim()) {
    if (!forceRefresh && ytmExportedCookieCache.browser === String(process.env.YTDLP_COOKIES_FROM_BROWSER).trim() && ytmExportedCookieCache.expiresAt > Date.now() && hasCookieFile(ytmExportedCookieCache.path)) {
      return ytmExportedCookieCache.path;
    }

    const browser = String(process.env.YTDLP_COOKIES_FROM_BROWSER).trim();
    if (ytmCookieExportsInFlight.has(browser)) return ytmCookieExportsInFlight.get(browser);
    const request = exportBrowserCookiesForMusicHome();
    ytmCookieExportsInFlight.set(browser, request);
    try {
      const exported = await request;
      ytmExportedCookieCache = {
        path: exported,
        browser,
        expiresAt: Date.now() + getDiscoverNumber(process.env.YTM_COOKIE_EXPORT_CACHE_TTL_MS || 1800000, 1800000, 0, 3600000)
      };
      return exported;
    } finally {
      ytmCookieExportsInFlight.delete(browser);
    }
  }
  return "";
}

function parseNetscapeCookieFile(cookieFile, targetHost = "music.youtube.com") {
  if (!hasCookieFile(cookieFile)) return [];

  const nowSec = Math.floor(Date.now() / 1000);
  const lines = fs.readFileSync(cookieFile, "utf8").split(/\r?\n/);
  const cookies = [];

  for (let line of lines) {
    if (!line) continue;
    if (line.startsWith("#HttpOnly_")) {
      line = line.slice("#HttpOnly_".length);
    } else if (line.startsWith("#")) {
      continue;
    }

    const parts = line.split("\t");
    if (parts.length < 7) continue;

    const [domainRaw, , cookiePath, secure, expiryRaw, name, ...valueParts] = parts;
    const value = valueParts.join("\t");
    const domain = String(domainRaw || "").replace(/^\./, "").toLowerCase();
    const expires = Number(expiryRaw || 0);
    const host = targetHost.toLowerCase();
    const domainMatches = host === domain || host.endsWith(`.${domain}`);

    const safeName = String(name || "").trim();
    const safeValue = String(value || "")
      .replace(/\r/g, "")
      .replace(/\n/g, "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, 8192);
    if (!domainMatches || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/.test(safeName)) continue;
    if (expires && Number.isFinite(expires) && expires < nowSec) continue;

    cookies.push({
      domain,
      path: cookiePath || "/",
      secure: /^true$/i.test(String(secure || "")),
      expires,
      name: safeName,
      value: safeValue
    });
  }

  return cookies;
}

function buildCookieHeader(cookies = []) {
  return cookies
    .filter((cookie) => cookie?.name && cookie.value != null)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function getCookieValue(cookies = [], names = []) {
  const wanted = names.map((name) => String(name).toLowerCase());
  const found = cookies.find((cookie) => wanted.includes(String(cookie.name || "").toLowerCase()));
  return found?.value || "";
}

function hasYtmBrowserAuthCookie(cookies = []) {
  const hasSid = !!getCookieValue(cookies, ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"]);
  const hasLoginInfo = !!getCookieValue(cookies, ["LOGIN_INFO"]);
  return hasSid && hasLoginInfo;
}

function buildSidAuthorizationPart(scheme, sid, origin = YTM_ORIGIN) {
  if (!sid) return "";
  const timestamp = Math.floor(Date.now() / 1000);
  const hash = createHash("sha1")
    .update(`${timestamp} ${sid} ${origin}`)
    .digest("hex");
  return `${scheme} ${timestamp}_${hash}`;
}

function buildSapisidAuthHeader(cookies = []) {
  // Match yt-dlp's current YouTube SID auth behavior. SAPISID falls back to
  // __Secure-3PAPISID, and modern browser sessions can also provide 1P/3P hashes.
  const sapisid = getCookieValue(cookies, ["SAPISID"]) ||
    getCookieValue(cookies, ["__Secure-3PAPISID"]);
  const onePartySapisid = getCookieValue(cookies, ["__Secure-1PAPISID"]);
  const threePartySapisid = getCookieValue(cookies, ["__Secure-3PAPISID"]);

  return [
    buildSidAuthorizationPart("SAPISIDHASH", sapisid),
    buildSidAuthorizationPart("SAPISID1PHASH", onePartySapisid),
    buildSidAuthorizationPart("SAPISID3PHASH", threePartySapisid)
  ].filter(Boolean).join(" ");
}

function getInnertubeLang() {
  return String(process.env.YT_LANG || "en-US").trim() || "en-US";
}

function getInnertubeRegion() {
  return String(process.env.YT_DEFAULT_REGION || "US").trim().toUpperCase() || "US";
}

function getInnertubeLocale(lang = "", region = "") {
  const safeLang = normalizeDiscoverLang(lang || getInnertubeLang());
  const safeRegion = normalizeDiscoverRegion(region || getInnertubeRegion(), safeLang);
  return {
    lang: safeLang,
    region: safeRegion,
    hl: `${safeLang}-${safeRegion}`,
    acceptLanguage: `${safeLang}-${safeRegion},${safeLang};q=0.9,en;q=0.8`
  };
}

function getDefaultYtmClientVersion() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `1.${stamp}.01.00`;
}

function extractYtmBootstrapConfig(html = "") {
  const source = String(html || "");
  const pick = (patterns) => {
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match?.[1]) {
        try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
      }
    }
    return "";
  };

  return {
    clientVersion: pick([
      /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/,
      /"clientVersion"\s*:\s*"([^"]+)"/
    ]),
    visitorData: pick([
      /"VISITOR_DATA"\s*:\s*"([^"]+)"/,
      /"visitorData"\s*:\s*"([^"]+)"/
    ]),
    apiKey: pick([
      /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/,
      /"innertubeApiKey"\s*:\s*"([^"]+)"/
    ]),
    authUser: pick([
      /"SESSION_INDEX"\s*:\s*"?(\d+)"?/,
      /"sessionIndex"\s*:\s*"?(\d+)"?/
    ]),
    delegatedSessionId: pick([
      /"DELEGATED_SESSION_ID"\s*:\s*"([^"]+)"/,
      /"delegatedSessionId"\s*:\s*"([^"]+)"/
    ]),
    loggedIn: /"LOGGED_IN"\s*:\s*true/i.test(source)
      ? true
      : (/"LOGGED_IN"\s*:\s*false/i.test(source) ? false : null)
  };
}

const ytmBootstrapInFlight = new Map();

async function fetchYtmBootstrapConfig(cookieHeader, timeoutMs = 6000) {
  const key = createHash("sha256").update(cookieHeader).digest("hex");
  if (ytmBootstrapInFlight.has(key)) return ytmBootstrapInFlight.get(key);
  const request = loadYtmBootstrapConfig(cookieHeader, timeoutMs);
  ytmBootstrapInFlight.set(key, request);
  try { return await request; } finally { ytmBootstrapInFlight.delete(key); }
}

async function loadYtmBootstrapConfig(cookieHeader, timeoutMs = 6000) {
  if (!cookieHeader) return {};

  const cookieKey = createHash("sha1").update(cookieHeader).digest("hex");
  if (
    ytmBootstrapCache.cookieKey === cookieKey &&
    ytmBootstrapCache.expiresAt > Date.now() &&
    ytmBootstrapCache.config &&
    typeof ytmBootstrapCache.config === "object"
  ) {
    return ytmBootstrapCache.config;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Parsed cookie-file values are domain-scoped, sanitized, and sent only to the fixed YTM_ORIGIN.
    const response = await fetch(`${YTM_ORIGIN}/`, {
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": DEFAULT_HEADERS["Accept-Language"],
        "Cookie": cookieHeader,
        "User-Agent": DEFAULT_USER_AGENT
      },
      signal: controller.signal
    });
    const html = await response.text();
    const config = response.ok ? extractYtmBootstrapConfig(html) : {};
    if (response.ok) {
      ytmBootstrapCache = {
        cookieKey,
        config,
        expiresAt: Date.now() + getDiscoverNumber(
          process.env.YTM_BOOTSTRAP_CACHE_TTL_MS || 600000,
          600000,
          0,
          3600000
        )
      };
    }
    return config;
  } catch {
    return {};
  } finally {
    clearTimeout(timeoutId);
  }
}

function textFromRuns(value) {
  if (!value) return "";
  if (typeof value === "string") return normalizeMusicHomeTitle(value);
  if (value.simpleText) return normalizeMusicHomeTitle(value.simpleText);
  if (Array.isArray(value.runs)) {
    return normalizeMusicHomeTitle(value.runs.map((run) => run?.text || "").join(""));
  }
  if (value.text) return textFromRuns(value.text);
  if (value.accessibility?.accessibilityData?.label) {
    return normalizeMusicHomeTitle(value.accessibility.accessibilityData.label);
  }
  if (value.accessibilityData?.label) return normalizeMusicHomeTitle(value.accessibilityData.label);
  return "";
}

function collectYtmSearchableText(value, { maxDepth = 8, maxParts = 120 } = {}) {
  const parts = [];
  const visited = new WeakSet();

  const add = (text) => {
    const safeText = normalizeMusicHomeTitle(text);
    if (safeText && !parts.includes(safeText)) parts.push(safeText);
  };

  const walk = (node, depth = 0) => {
    if (parts.length >= maxParts || depth > maxDepth || node == null) return;
    if (typeof node === "string") {
      add(node);
      return;
    }
    if (typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);

    add(textFromRuns(node));

    for (const [key, child] of Object.entries(node)) {
      if (parts.length >= maxParts) return;
      if (/(thumbnail|icon|tracking|logging|token|params|url|commandMetadata|webCommandMetadata)/i.test(key)) {
        continue;
      }
      walk(child, depth + 1);
    }
  };

  walk(value);
  return parts.join(" ");
}

function normalizeYtmThumbnailUrl(url = "") {
  const source = String(url || "").trim();
  if (!source) return null;
  if (source.startsWith("//")) return `https:${source}`;
  if (source.startsWith("/")) return `${YTM_ORIGIN}${source}`;
  return source;
}

function findYtmThumbnail(value) {
  if (!value || typeof value !== "object") return null;

  const candidates = [
    value.thumbnail,
    value.thumbnails,
    value.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail,
    value.thumbnailRenderer?.croppedSquareThumbnailRenderer?.thumbnail,
    value.thumbnail?.musicThumbnailRenderer?.thumbnail,
    value.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail,
    value.musicThumbnailRenderer?.thumbnail,
    value.croppedSquareThumbnailRenderer?.thumbnail
  ];

  for (const candidate of candidates) {
    const thumbs = Array.isArray(candidate) ? candidate : candidate?.thumbnails;
    if (Array.isArray(thumbs) && thumbs.length) {
      return normalizeYtmThumbnailUrl(thumbs.at(-1)?.url);
    }
  }

  const visited = new WeakSet();
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 5 || visited.has(node)) return null;
    visited.add(node);

    const thumbs = Array.isArray(node.thumbnails) ? node.thumbnails : null;
    if (thumbs?.length) return normalizeYtmThumbnailUrl(thumbs.at(-1)?.url);

    for (const [key, child] of Object.entries(node)) {
      if (!/(thumbnail|image|avatar|cover)/i.test(key)) continue;
      if (Array.isArray(child)) {
        for (const item of child) {
          const found = walk(item, depth + 1);
          if (found) return found;
        }
      } else {
        const found = walk(child, depth + 1);
        if (found) return found;
      }
    }

    return null;
  };

  return walk(value);
}

function findYtmMenuEndpoint(value) {
  const items = value?.menu?.menuRenderer?.items;
  if (!Array.isArray(items)) return null;

  for (const item of items) {
    const endpoint =
      item?.menuNavigationItemRenderer?.navigationEndpoint ||
      item?.menuServiceItemRenderer?.serviceEndpoint;
    if (endpoint?.watchEndpoint || endpoint?.watchPlaylistEndpoint || endpoint?.browseEndpoint) {
      return endpoint;
    }
  }

  return null;
}

function isYtmPlayableEndpoint(value = {}) {
  return !!(
    value?.watchEndpoint?.videoId ||
    value?.watchPlaylistEndpoint?.playlistId
  );
}

function findYtmPlayableEndpoint(value, maxDepth = 6) {
  const visited = new WeakSet();

  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > maxDepth || visited.has(node)) return null;
    visited.add(node);

    if (isYtmPlayableEndpoint(node)) return node;

    const directCandidates = [
      node.playNavigationEndpoint,
      node.clickCommand,
      node.onTap,
      node.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint,
      node.thumbnailOverlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint,
      node.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.navigationEndpoint,
      findYtmMenuEndpoint(node)
    ].filter(Boolean);

    for (const candidate of directCandidates) {
      const found = walk(candidate, depth + 1);
      if (found) return found;
    }

    for (const [key, child] of Object.entries(node)) {
      if (/(accessibility|badge|icon|logging|thumbnail|tracking)/i.test(key)) {
        continue;
      }

      if (Array.isArray(child)) {
        for (const item of child) {
          const found = walk(item, depth + 1);
          if (found) return found;
        }
      } else if (child && typeof child === "object") {
        const found = walk(child, depth + 1);
        if (found) return found;
      }
    }

    return null;
  };

  return walk(value);
}

function findYtmEndpoint(value) {
  if (!value || typeof value !== "object") return null;
  if (isYtmPlayableEndpoint(value)) return value;

  const playable = findYtmPlayableEndpoint(value);
  if (playable) return playable;

  if (value.browseEndpoint) return value;

  return (
    value.playNavigationEndpoint ||
    value.clickCommand ||
    value.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint ||
    value.thumbnailOverlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint ||
    value.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.navigationEndpoint ||
    findYtmMenuEndpoint(value) ||
    value.navigationEndpoint ||
    null
  );
}

function getYtmPrimaryBrowseEndpoint(renderer = {}) {
  if (!renderer || typeof renderer !== "object") return null;

  const titleRunEndpoints = Array.isArray(renderer?.title?.runs)
    ? renderer.title.runs.map((run) => run?.navigationEndpoint?.browseEndpoint)
    : [];
  const scopedBrowse = findYtmBrowseEndpoint({
    navigationEndpoint: renderer.navigationEndpoint,
    title: renderer.title,
    onTap: renderer.onTap,
    clickCommand: renderer.clickCommand,
    buttonText: renderer.buttonText
  });

  const candidates = [
    renderer?.navigationEndpoint?.browseEndpoint,
    renderer?.title?.navigationEndpoint?.browseEndpoint,
    ...titleRunEndpoints,
    renderer?.onTap?.browseEndpoint,
    renderer?.clickCommand?.browseEndpoint,
    scopedBrowse,
    renderer?.browseId ? { browseId: renderer.browseId, params: renderer.params || "" } : null
  ];

  return candidates.find((candidate) => candidate?.browseId || candidate?.params) || null;
}

function getYtmBrowseEndpointType(browse = {}, renderer = {}) {
  const browseId = String(browse?.browseId || "").trim();
  if (/^MPRE/i.test(browseId)) return "album";

  const rendererText = normalizeMusicHomeTitle([
    textFromRuns(renderer?.subtitle),
    textFromRuns(renderer?.secondSubtitle),
    textFromRuns(renderer?.straplineText),
    textFromRuns(renderer?.byline),
    textFromRuns(renderer?.description)
  ].filter(Boolean).join(" "));

  if (/(artist|sanatçı|sanatci|künstler|artiste|artista)/i.test(rendererText)) {
    return "artist";
  }
  if (/^VL/i.test(browseId) || isLikelyYouTubePlaylistId(browseId)) {
    return "playlist";
  }
  return "";
}

function shouldPreferYtmPrimaryBrowseEndpoint(browse = {}, renderer = {}) {
  const type = getYtmBrowseEndpointType(browse, renderer);
  return type === "album" || type === "artist";
}

function ytmEndpointToItem(endpoint = {}, renderer = {}) {
  const watch = endpoint.watchEndpoint;
  const watchPlaylist = endpoint.watchPlaylistEndpoint;
  const browse = endpoint.browseEndpoint;
  const rendererVideoId =
    renderer?.playlistItemData?.videoId ||
    renderer?.videoId ||
    renderer?.onTap?.watchEndpoint?.videoId ||
    "";

  if (watch?.videoId || rendererVideoId) {
    const url = new URL(`${YTM_ORIGIN}/watch`);
    const videoId = watch?.videoId || rendererVideoId;
    url.searchParams.set("v", videoId);
    return {
      id: videoId,
      type: "track",
      playlistId: "",
      webpage_url: url.toString()
    };
  }

  const playlistId =
    watchPlaylist?.playlistId ||
    renderer?.playlistId ||
    (browse?.browseId && /^VL/i.test(browse.browseId) ? browse.browseId.slice(2) : "");
  if (playlistId) {
    return {
      id: playlistId,
      type: "playlist",
      browseId: browse?.browseId || "",
      playlistId,
      params: browse?.params || "",
      webpage_url: `${YTM_ORIGIN}/playlist?list=${encodeURIComponent(playlistId)}`
    };
  }

  const browseId =
    browse?.browseId ||
    renderer?.browseId ||
    (browse?.params ? "FEmusic_moods_and_genres_category" : "");
  if (browseId) {
    const flexText = (Array.isArray(renderer?.flexColumns) ? renderer.flexColumns : [])
      .map((column) => textFromRuns(column?.musicResponsiveListItemFlexColumnRenderer?.text))
      .filter(Boolean)
      .join(" ");
    const rendererText = normalizeMusicHomeTitle([
      textFromRuns(renderer?.subtitle),
      textFromRuns(renderer?.secondSubtitle),
      textFromRuns(renderer?.byline),
      flexText
    ].filter(Boolean).join(" "));
    const isArtist = /(artist|sanatçı|sanatci|künstler|artiste|artista)/i.test(rendererText);
    return {
      id: browseId,
      type: isArtist ? "artist" : (/^MPRE/i.test(browseId) ? "album" : "playlist"),
      browseId,
      params: browse?.params || renderer?.params || "",
      webpage_url: `${YTM_ORIGIN}/browse/${encodeURIComponent(browseId)}`
    };
  }

  return null;
}

function getYtmRendererTitle(renderer = {}) {
  const flex = renderer.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text;
  return textFromRuns(renderer.title || renderer.buttonText || renderer.text || flex || renderer.name);
}

function getYtmRendererSubtitle(renderer = {}) {
  const flex = (Array.isArray(renderer.flexColumns) ? renderer.flexColumns.slice(1) : [])
    .map((column) => textFromRuns(column?.musicResponsiveListItemFlexColumnRenderer?.text))
    .filter(Boolean)
    .join(" - ");

  return (
    textFromRuns(renderer.subtitle) ||
    textFromRuns(renderer.secondSubtitle) ||
    textFromRuns(renderer.straplineText) ||
    textFromRuns(renderer.byline) ||
    flex ||
    ""
  );
}

function getYtmRendererDuration(renderer = {}) {
  const fixed = (Array.isArray(renderer.fixedColumns) ? renderer.fixedColumns : [])
    .map((column) => textFromRuns(column?.musicResponsiveListItemFixedColumnRenderer?.text))
    .find(Boolean);
  return fixed || textFromRuns(renderer.duration) || "";
}

function getDirectYtmItemRenderer(value = {}) {
  return (
    value.musicTwoRowItemRenderer ||
    value.musicResponsiveListItemRenderer ||
    value.musicMultiRowListItemRenderer ||
    value.musicNavigationButtonRenderer ||
    value.musicCardShelfRenderer ||
    null
  );
}

function findYtmItemRenderer(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;

  const direct = getDirectYtmItemRenderer(value);
  if (direct) return direct;

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findYtmItemRenderer(item, depth + 1);
        if (found) return found;
      }
    } else if (child && typeof child === "object") {
      const found = findYtmItemRenderer(child, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function normalizeYtmRendererItem(value = {}, index = 0) {
  const renderer = findYtmItemRenderer(value) || value;
  if (!renderer || typeof renderer !== "object") return null;

  const primaryBrowse = getYtmPrimaryBrowseEndpoint(renderer);
  const endpoint = primaryBrowse && shouldPreferYtmPrimaryBrowseEndpoint(primaryBrowse, renderer)
    ? { browseEndpoint: primaryBrowse }
    : findYtmEndpoint(renderer);
  const item = ytmEndpointToItem(endpoint || {}, renderer);
  if (!item?.webpage_url) return null;

  const title = getYtmRendererTitle(renderer);
  if (!title && !item.id) return null;
  const searchableText = collectYtmSearchableText(renderer);

  return {
    index: index + 1,
    id: item.id,
    type: item.type,
    browseId: item.browseId || null,
    playlistId: item.playlistId || null,
    params: item.params || null,
    title: title || item.id,
    duration: null,
    duration_string: getYtmRendererDuration(renderer) || null,
    uploader: normalizeYtMusicByline(getYtmRendererSubtitle(renderer)),
    searchableText,
    webpage_url: item.webpage_url,
    url: item.webpage_url,
    thumbnail: findYtmThumbnail(renderer),
    source: "youtube_music_home"
  };
}

function getYtmShelfTitle(renderer = {}) {
  return (
    textFromRuns(renderer.header?.musicCarouselShelfBasicHeaderRenderer?.title) ||
    textFromRuns(renderer.header?.musicShelfBasicHeaderRenderer?.title) ||
    textFromRuns(renderer.header?.runs) ||
    textFromRuns(renderer.title) ||
    "YouTube Music"
  );
}

function findYtmBrowseEndpoint(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  if (value.browseEndpoint) return value.browseEndpoint;
  if (value.navigationEndpoint?.browseEndpoint) return value.navigationEndpoint.browseEndpoint;

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findYtmBrowseEndpoint(item, depth + 1);
        if (found) return found;
      }
    } else if (child && typeof child === "object") {
      const found = findYtmBrowseEndpoint(child, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function getYtmShelfBrowseMeta(renderer = {}) {
  const browse = findYtmBrowseEndpoint({
    header: renderer.header,
    title: renderer.title,
    navigationEndpoint: renderer.navigationEndpoint,
    moreContentButton: renderer.moreContentButton
  });
  return {
    browseId: browse?.browseId || "",
    params: browse?.params || ""
  };
}

function buildMusicHomeShelvesFromInnertube(data, { maxShelves = 6, limitPerShelf = 12 } = {}) {
  const shelves = [];
  const seenShelves = new Set();

  const addShelf = (title, rawItems, meta = {}) => {
    const items = uniqueMusicHomeItems(
      (Array.isArray(rawItems) ? rawItems : [])
        .map((item, index) => normalizeYtmRendererItem(item, index))
        .filter(Boolean)
        .filter(isMusicHomeDisplayItem),
      limitPerShelf
    );
    if (!items.length) return;

    const safeTitle = normalizeMusicHomeTitle(title) || "YouTube Music";
    const key = `${safeTitle.toLowerCase()}:${getMusicHomeItemKey(items[0])}`;
    if (seenShelves.has(key)) return;
    seenShelves.add(key);
    shelves.push({ title: safeTitle, ...meta, items });
  };

  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 12 || shelves.length >= maxShelves) return;

    const carousel = node.musicCarouselShelfRenderer;
    if (carousel?.contents) {
      addShelf(getYtmShelfTitle(carousel), carousel.contents, getYtmShelfBrowseMeta(carousel));
    }

    const shelf = node.musicShelfRenderer;
    if (shelf?.contents) {
      addShelf(getYtmShelfTitle(shelf), shelf.contents, getYtmShelfBrowseMeta(shelf));
    }

    const grid = node.gridRenderer;
    if (grid?.items) {
      addShelf(getYtmShelfTitle(grid), grid.items, getYtmShelfBrowseMeta(grid));
    }

    const cardShelf = node.musicCardShelfRenderer;
    if (cardShelf) {
      addShelf(getYtmShelfTitle(cardShelf), [
        cardShelf,
        ...(Array.isArray(cardShelf.contents) ? cardShelf.contents : [])
      ], getYtmShelfBrowseMeta(cardShelf));
    }

    const immersive = node.musicImmersiveCarouselShelfRenderer;
    if (immersive?.contents) {
      addShelf(getYtmShelfTitle(immersive), immersive.contents, getYtmShelfBrowseMeta(immersive));
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          walk(child, depth + 1);
          if (shelves.length >= maxShelves) return;
        }
      } else if (value && typeof value === "object") {
        walk(value, depth + 1);
      }
    }
  };

  const homeSections = getYtmHomeSectionItems(data);
  if (homeSections.length) {
    for (const section of homeSections) {
      walk(section);
      if (shelves.length >= maxShelves) break;
    }
  } else {
    walk(data);
  }
  return shelves.slice(0, maxShelves);
}

function mergeMusicHomeShelves(shelfGroups = [], { maxShelves = 6, limitPerShelf = 12 } = {}) {
  const shelves = [];
  const seenShelves = new Set();

  for (const group of shelfGroups) {
    for (const shelf of Array.isArray(group) ? group : []) {
      const items = uniqueMusicHomeItems(shelf?.items, limitPerShelf);
      if (!items.length) continue;

      const title = normalizeMusicHomeTitle(shelf?.title) || "YouTube Music";
      const titleKey = normalizeMusicHomeTitleKey(title) || title.toLowerCase();
      const browseKey = [shelf?.browseId, shelf?.params].filter(Boolean).join(":");
      const key = browseKey
        ? `browse:${browseKey}`
        : `${titleKey}:${getMusicHomeItemKey(items[0])}`;
      if (seenShelves.has(key)) continue;

      seenShelves.add(key);
      shelves.push({ ...shelf, title, items });
      if (shelves.length >= maxShelves) return shelves;
    }
  }

  return shelves;
}

function selectMusicHomeShelves(shelves = [], { maxShelves = 6, limitPerShelf = 12 } = {}) {
  const shelfLimit = normalizeMusicHomeNumber(maxShelves, 6, 1, 50);
  return mergeMusicHomeShelves([shelves], {
    maxShelves: shelfLimit,
    limitPerShelf
  }).map((shelf) => ({ ...shelf, pinned: false }));
}

function getYtmHomeSectionListRenderer(data = {}) {
  const tabs = data?.contents?.singleColumnBrowseResultsRenderer?.tabs;
  if (!Array.isArray(tabs)) return null;

  for (const tab of tabs) {
    const sectionList = tab?.tabRenderer?.content?.sectionListRenderer;
    if (sectionList && typeof sectionList === "object") return sectionList;
  }
  return null;
}

function getYtmHomeSectionItems(data = {}) {
  const initial = getYtmHomeSectionListRenderer(data)?.contents;
  if (Array.isArray(initial)) return initial;

  const continuation = data?.continuationContents?.sectionListContinuation?.contents;
  if (Array.isArray(continuation)) return continuation;

  const actions = Array.isArray(data?.onResponseReceivedActions)
    ? data.onResponseReceivedActions
    : [];
  for (const action of actions) {
    const items = action?.appendContinuationItemsAction?.continuationItems;
    if (Array.isArray(items)) return items;
  }
  return [];
}

function getYtmLegacyHomeContinuationToken(data = {}) {
  const continuationSets = [
    getYtmHomeSectionListRenderer(data)?.continuations,
    data?.continuationContents?.sectionListContinuation?.continuations
  ];

  for (const continuations of continuationSets) {
    if (!Array.isArray(continuations)) continue;
    for (const continuation of continuations) {
      const token =
        continuation?.nextContinuationData?.continuation ||
        continuation?.reloadContinuationData?.continuation ||
        continuation?.timedContinuationData?.continuation ||
        "";
      if (token) return String(token);
    }
  }
  return "";
}

function getYtmInlineHomeContinuationToken(data = {}) {
  const items = getYtmHomeSectionItems(data);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const renderer = items[index]?.continuationItemRenderer;
    const token =
      renderer?.continuationEndpoint?.continuationCommand?.token ||
      renderer?.continuationEndpoint?.nextContinuationData?.continuation ||
      "";
    if (token) return String(token);
  }
  return "";
}

function getYtmLoggedInState(data = {}) {
  const services = data?.responseContext?.serviceTrackingParams;
  if (!Array.isArray(services)) return null;

  for (const service of services) {
    const params = Array.isArray(service?.params) ? service.params : [];
    const loggedIn = params.find((item) => String(item?.key || "").toLowerCase() === "logged_in");
    if (!loggedIn) continue;
    const value = String(loggedIn.value ?? "").trim().toLowerCase();
    if (["1", "true"].includes(value)) return true;
    if (["0", "false"].includes(value)) return false;
  }
  return null;
}

function resolveYtmAuthUserCandidates(bootstrap = {}) {
  const candidates = [];
  const add = (value) => {
    const safe = String(value ?? "").trim();
    const parsed = Number(safe);
    if (
      /^\d+$/.test(safe) &&
      Number.isInteger(parsed) &&
      parsed >= 0 &&
      parsed <= 20 &&
      !candidates.includes(safe)
    ) {
      candidates.push(safe);
    }
  };

  // A configured account remains the first choice, but don't get stuck on it:
  // browser account slots can change after a profile/account is removed.
  add(process.env.YTM_AUTH_USER);
  add(bootstrap?.authUser);
  for (let index = 0; index <= 5; index += 1) add(index);
  return candidates.length ? candidates : ["0"];
}

function collectYtmContinuationTokens(value, tokens = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 12) return tokens;

  const addToken = (token) => {
    const safe = String(token || "").trim();
    if (safe) tokens.add(safe);
  };

  addToken(value.continuationCommand?.token);
  addToken(value.nextContinuationData?.continuation);
  addToken(value.reloadContinuationData?.continuation);
  addToken(value.timedContinuationData?.continuation);
  addToken(value.continuationEndpoint?.continuationCommand?.token);
  addToken(value.continuationEndpoint?.nextContinuationData?.continuation);
  addToken(value.continuationEndpoint?.reloadContinuationData?.continuation);
  addToken(value.continuationEndpoint?.timedContinuationData?.continuation);
  addToken(value.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token);
  addToken(value.continuationItemRenderer?.continuationEndpoint?.nextContinuationData?.continuation);
  addToken(value.continuationItemRenderer?.continuationEndpoint?.reloadContinuationData?.continuation);
  addToken(value.continuationItemRenderer?.continuationEndpoint?.timedContinuationData?.continuation);

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) collectYtmContinuationTokens(item, tokens, depth + 1);
    } else if (child && typeof child === "object") {
      collectYtmContinuationTokens(child, tokens, depth + 1);
    }
  }

  return tokens;
}

async function fetchYouTubeMusicHomeInnertube({ maxShelves, limitPerShelf, timeoutMs = 15000, lang = "", region = "", forceFreshCookies = false, onProgress = null, resumeState = null, onCheckpoint = null }) {
  const cookieFile = await resolveMusicHomeCookieFile({ forceRefresh: forceFreshCookies });
  const cookies = parseNetscapeCookieFile(cookieFile, "music.youtube.com");
  const cookieHeader = buildCookieHeader(cookies);
  if (!cookieHeader) {
    return { personalized: false, cookieAvailable: false, shelves: [] };
  }
  if (!hasYtmBrowserAuthCookie(cookies)) {
    const hasLoginInfo = !!getCookieValue(cookies, ["LOGIN_INFO"]);
    const hasSid = !!getCookieValue(cookies, ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"]);
    const missing = [
      hasLoginInfo ? "" : "LOGIN_INFO",
      hasSid ? "" : "SAPISID/__Secure-*PAPISID"
    ].filter(Boolean).join(" + ");
    const error = new Error(`YouTube Music browser cookies are not a complete signed-in session${missing ? ` (missing ${missing})` : ""}.`);
    error.code = "YTM_AUTH_COOKIE_MISSING";
    throw error;
  }

  const locale = getInnertubeLocale(lang, region);
  const bootstrap = await fetchYtmBootstrapConfig(cookieHeader, Math.min(timeoutMs, 2500));
  const clientVersion = String(process.env.YTM_CLIENT_VERSION || bootstrap.clientVersion || getDefaultYtmClientVersion()).trim();
  const authUserCandidates = resolveYtmAuthUserCandidates(bootstrap);
  const headers = {
    "Accept": "application/json",
    "Accept-Language": locale.acceptLanguage,
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
    "Origin": YTM_ORIGIN,
    "Pragma": "no-cache",
    "Referer": `${YTM_ORIGIN}/`,
    "User-Agent": DEFAULT_USER_AGENT,
    "X-Goog-Visitor-Id": bootstrap.visitorData || "",
    "X-Origin": YTM_ORIGIN,
    "X-Youtube-Bootstrap-Logged-In": "true",
    "X-Youtube-Client-Name": "67",
    "X-Youtube-Client-Version": clientVersion,
    "Cookie": cookieHeader
  };
  const auth = buildSapisidAuthHeader(cookies);
  if (auth) headers.Authorization = auth;
  if (bootstrap.delegatedSessionId) headers["X-Goog-PageId"] = bootstrap.delegatedSessionId;

  const deadline = Date.now() + getDiscoverNumber(process.env.YTM_HOME_TOTAL_TIMEOUT_MS || 30000, 30000, 1000, 120000);
  const sessionKey = createHash("sha256").update(cookieHeader).digest("hex");
  const resume = resumeState?.sessionKey === sessionKey ? resumeState : null;

  const context = {
    client: {
      clientName: "WEB_REMIX",
      clientVersion,
      visitorData: bootstrap.visitorData || undefined,
      hl: locale.lang,
      gl: locale.region
    },
    user: {
      lockedSafetyMode: false,
      ...(bootstrap.delegatedSessionId ? { onBehalfOfUser: bootstrap.delegatedSessionId } : {})
    },
    request: { useSsl: true }
  };

  const postBrowse = async (payload, { legacyContinuation = "", authUser = "0" } = {}) => {
    const endpoint = new URL(`${YTM_ORIGIN}/youtubei/v1/browse`);
    endpoint.searchParams.set("alt", "json");
    endpoint.searchParams.set("prettyPrint", "false");
    if (!bootstrap.apiKey) {
      throw new Error("YouTube Music bootstrap did not expose an Innertube API key");
    }
    endpoint.searchParams.set("key", bootstrap.apiKey);
    if (legacyContinuation) {
      endpoint.searchParams.set("ctoken", legacyContinuation);
      endpoint.searchParams.set("continuation", legacyContinuation);
    }

    // Parsed cookie-file values are domain-scoped, sanitized, and sent only to the fixed YTM_ORIGIN.
    return requestSharedYtmJson((signal) => fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "X-Goog-AuthUser": authUser },
      signal,
      body: JSON.stringify({ context, ...payload })
    }), { timeoutMs, deadline });

  };

  {
    let firstPage = null;
    let loggedIn = resume?.loggedIn ?? null;
    let authUser = resume?.authUser || authUserCandidates[0] || "0";
    const authAttempts = resume ? [...resume.authAttempts] : [];

    for (const candidate of resume ? [] : authUserCandidates) {
      const candidatePage = await postBrowse(
        { browseId: YTM_HOME_BROWSE_ID },
        { authUser: candidate }
      );
      const candidateLoggedIn = getYtmLoggedInState(candidatePage);
      authAttempts.push(candidate);

      if (candidateLoggedIn === true || (candidateLoggedIn == null && bootstrap.loggedIn === true)) {
        firstPage = candidatePage;
        loggedIn = candidateLoggedIn;
        authUser = candidate;
        break;
      }

      if (!firstPage) {
        firstPage = candidatePage;
        loggedIn = candidateLoggedIn;
        authUser = candidate;
      }
    }

    if (loggedIn === false || (loggedIn == null && bootstrap.loggedIn === false)) {
      const error = new Error(
        `YouTube Music browser session is not authenticated for account index ${authAttempts.join(", ")}`
      );
      error.code = "YTM_AUTH_REJECTED";
      error.authAttempts = authAttempts;
      throw error;
    }

    // Keep the whole already-returned page; asking for fewer visible shelves
    // must not discard data needed by another browser with a larger layout.
    let parsedShelves = resume?.shelves || buildMusicHomeShelvesFromInnertube(firstPage, { maxShelves: 100, limitPerShelf });
    const seenTokens = new Set(resume?.seenTokens || []);
    const getContinuation = (page) => {
      const legacyToken = getYtmLegacyHomeContinuationToken(page);
      return { token: legacyToken || getYtmInlineHomeContinuationToken(page), legacy: !!legacyToken };
    };
    let continuation = resume?.continuation || getContinuation(firstPage);
    let continuationPages = resume?.continuationPages || 0;
    let loadedPages = 0;
    const checkpoint = () => onCheckpoint?.({
      sessionKey, authUser, authAttempts, loggedIn, shelves: parsedShelves,
      seenTokens: [...seenTokens], continuation, continuationPages
    });
    let continuationWarning = "";
    const emitProgress = (phase) => {
      if (typeof onProgress !== "function" || !parsedShelves.length) return;
      try {
        onProgress({
          personalized: loggedIn !== false,
          cookieAvailable: true,
          source: "innertube",
          authUser,
          authAttempts,
          loggedIn,
          continuationPages,
          fetchedShelves: parsedShelves.length,
          title: "YouTube Music",
          shelves: parsedShelves,
          phase
        });
      } catch {}
    };
    checkpoint();
    emitProgress(resume ? "resuming" : "first-page");
    const maxContinuationPages = normalizeMusicHomeNumber(
      process.env.YTM_HOME_CONTINUATION_PAGES ?? 12,
      12,
      0,
      40
    );

    while (parsedShelves.length < maxShelves && loadedPages < maxContinuationPages) {
      const { token, legacy } = continuation;
      if (!token || seenTokens.has(token)) break;

      // Home uses sectionListContinuation pagination. Newer response shapes can instead expose
      // a continuationItemRenderer; support both without crawling unrelated shelf/menu tokens.
      let nextPage;
      try {
        nextPage = legacy
          ? await postBrowse(
              { browseId: YTM_HOME_BROWSE_ID },
              { legacyContinuation: token, authUser }
            )
          : await postBrowse({ continuation: token }, { authUser });
      } catch (error) {
        // The first page has already proved that this browser session is signed in.
        // Do not discard those personal shelves because a later pagination request
        // times out or is rejected; return the usable partial Home instead.
        continuationWarning = error?.message || "YouTube Music home continuation could not be loaded.";
        // A rejected/expired continuation must be rebuilt from Home next time.
        if (error?.status >= 400 && error?.status < 500 && error.status !== 429) onCheckpoint?.(null);
        console.warn("YouTube Music home continuation failed; keeping loaded personal shelves:", continuationWarning);
        break;
      }
      const hasSectionResponse = Array.isArray(nextPage?.continuationContents?.sectionListContinuation?.contents) ||
        (Array.isArray(nextPage?.onResponseReceivedActions) && nextPage.onResponseReceivedActions.some(
          (action) => Array.isArray(action?.appendContinuationItemsAction?.continuationItems)
        ));
      if (!hasSectionResponse) {
        // A transient/malformed 200 response must not turn a partial feed into
        // a permanently complete cache entry. Keep the unconsumed checkpoint.
        continuationWarning = "YouTube Music continuation returned an incomplete response.";
        break;
      }
      if (getYtmLoggedInState(nextPage) === false) {
        onCheckpoint?.(null);
        continuationWarning = "YouTube Music continuation session was rejected.";
        break;
      }
      seenTokens.add(token);
      continuationPages += 1;
      loadedPages += 1;
      const nextShelves = buildMusicHomeShelvesFromInnertube(nextPage, { maxShelves: 100, limitPerShelf });
      parsedShelves = mergeMusicHomeShelves(
        [parsedShelves, nextShelves],
        { maxShelves: 100, limitPerShelf }
      );
      continuation = getContinuation(nextPage);
      checkpoint();
      emitProgress("continuation");
    }

    const hasMore = !!continuation.token && !seenTokens.has(continuation.token);
    return {
      personalized: loggedIn !== false && parsedShelves.length > 0,
      cookieAvailable: true,
      source: "innertube",
      authUser,
      authAttempts,
      loggedIn,
      continuationPages,
      fetchedShelves: parsedShelves.length,
      partial: !!continuationWarning || hasMore,
      hasMore,
      warning: continuationWarning,
      title: "YouTube Music",
      shelves: parsedShelves
    };
  }
}

async function getFallbackYouTubeMusicHomeShelves({ maxShelves, fetchShelves, limitPerShelf, timeoutMs, lang = "", region = "", cookieAvailable = false } = {}) {
  const targetShelves = normalizeMusicHomeNumber(maxShelves, 6, 1, 50);
  const browseShelves = normalizeMusicHomeNumber(fetchShelves || targetShelves, targetShelves, targetShelves, 100);
  const perShelf = normalizeMusicHomeNumber(limitPerShelf, 12, 4, 24);
  const safeLang = normalizeDiscoverLang(lang);
  const safeRegion = normalizeDiscoverRegion(region, safeLang);
  const shelfGroups = [];
  const browseTimeout = Math.min(timeoutMs || 4000, 4000);

  try {
    const publicShelves = await fetchPublicYouTubeMusicBrowseShelves({
      browseId: YTM_HOME_BROWSE_ID,
      limit: perShelf,
      targetType: "track",
      preset: "",
      lang: safeLang,
      region: safeRegion,
      timeoutMs: browseTimeout,
      maxShelves: browseShelves,
      continuationPages: 0
    });
    if (publicShelves.length) shelfGroups.push(publicShelves);
  } catch (error) {
    discoverDebug("home-fallback:public-home-error", {
      error: error?.message || String(error)
    });
  }

  let mergedShelves = mergeMusicHomeShelves(shelfGroups, {
    maxShelves: browseShelves,
    limitPerShelf: perShelf
  });

  // If anonymous Home is sparse, fill it with a small set of independent,
  // concurrent YT Music searches. This restores useful fallback shelves without
  // the previous long sequential mood crawl.
  if (mergedShelves.length < Math.min(targetShelves, 8)) {
    const presetOrder = [
      "energizing",
      "workout",
      "feel-good",
      "relax",
      "party",
      "focus",
      "romance",
      "commute",
      "sad",
      "sleep"
    ];
    const needed = Math.max(0, Math.min(10, targetShelves - mergedShelves.length));
    const searchTimeout = Math.min(Math.max(1500, browseTimeout), 3500);
    const presetResults = await Promise.allSettled(
      presetOrder.slice(0, needed).map(async (preset) => {
        const query = getDiscoverMoodFallbackQuery(preset, safeLang);
        const items = await searchYouTubeMusicContent(query, {
          limit: perShelf,
          type: "track",
          lang: safeLang,
          region: safeRegion,
          timeoutMs: searchTimeout
        });
        return {
          preset,
          items: uniqueMusicHomeItems(items, perShelf)
        };
      })
    );

    for (const result of presetResults) {
      if (result.status !== "fulfilled" || !result.value.items.length) continue;
      shelfGroups.push([{
        title: getDiscoverMoodDisplayTitle(result.value.preset, safeLang),
        source: "youtube_music_home_fallback",
        items: result.value.items
      }]);
    }

    mergedShelves = mergeMusicHomeShelves(shelfGroups, {
      maxShelves: browseShelves,
      limitPerShelf: perShelf
    });
  }

  return {
    personalized: false,
    fallback: true,
    source: "fallback",
    cookieAvailable,
    title: "YouTube Music",
    shelves: selectMusicHomeShelves(mergedShelves, {
      maxShelves: targetShelves,
      limitPerShelf: perShelf
    })
  };
}

// Reads a fresh signed-in YouTube Music home feed for the ytlive UI.
async function loadYouTubeMusicHomeShelves({ shelves = 6, limit = 12, lang = "", region = "", onProgress = null, resumeState = null, onCheckpoint = null, retainFetched = false } = {}) {
  const startedAt = Date.now();
  const withTiming = (result = {}) => ({
    ...result,
    elapsedMs: Math.max(0, Date.now() - startedAt)
  });
  const cookieAvailable = hasUsableCookieSource();
  if (ytmApiGate.retryAfterMs()) return withTiming({
    source: "innertube", cookieAvailable, personalized: cookieAvailable, shelves: [],
    partial: true, hasMore: true, warning: ytmRateLimitWarning
  });
  const maxShelves = normalizeMusicHomeNumber(shelves, 6, 1, 50);
  const defaultFetchShelves = maxShelves;
  const fetchShelves = normalizeMusicHomeNumber(
    process.env.YTM_HOME_FETCH_SHELVES || defaultFetchShelves,
    defaultFetchShelves,
    maxShelves,
    100
  );
  const limitPerShelf = normalizeMusicHomeNumber(limit, 12, 4, 24);
  if (!cookieAvailable) {
    const fallback = await getFallbackYouTubeMusicHomeShelves({
      maxShelves,
      fetchShelves,
      limitPerShelf,
      timeoutMs: Number(process.env.YTM_HOME_FALLBACK_TIMEOUT_MS || 12000),
      lang,
      region,
      cookieAvailable: false
    });
    return withTiming(fallback);
  }

  const timeout = Number(process.env.YTM_HOME_TIMEOUT_MS || 10000);
  const innertubeTimeout = Math.min(timeout, Number(process.env.YTM_HOME_INNERTUBE_TIMEOUT_MS || 7000));
  let innertubeWarning = "";
  let innertubeErrorCode = "";

  const streamProgress = typeof onProgress === "function"
    ? (progress = {}) => {
        const selectedShelves = retainFetched ? progress.shelves : selectMusicHomeShelves(progress.shelves, { maxShelves, limitPerShelf });
        if (!selectedShelves.length) return;
        onProgress({
          ...progress,
          shelves: selectedShelves,
          fetchedShelves: selectedShelves.length,
          elapsedMs: Math.max(0, Date.now() - startedAt)
        });
      }
    : null;

  const tryInnertube = async ({ forceFreshCookies = false } = {}) => {
    const result = await fetchYouTubeMusicHomeInnertube({
      maxShelves: fetchShelves,
      limitPerShelf,
      timeoutMs: innertubeTimeout,
      lang,
      region,
      forceFreshCookies,
      resumeState: forceFreshCookies ? null : resumeState,
      onCheckpoint,
      onProgress: streamProgress
    });
    const selectedShelves = retainFetched ? result.shelves : selectMusicHomeShelves(result.shelves, { maxShelves, limitPerShelf });
    return {
      ...result,
      shelves: selectedShelves
    };
  };

  try {
    const result = await tryInnertube();
    if (result.shelves.length) return withTiming(result);

    innertubeWarning = "YouTube Music Innertube home returned no playable shelves.";
    console.warn("YouTube Music home API returned no shelves, using fallback shelves.");
  } catch (error) {
    innertubeWarning = error?.message || String(error);
    innertubeErrorCode = String(error?.code || "");

    const canRefreshBrowserCookies =
      ["YTM_AUTH_COOKIE_MISSING", "YTM_AUTH_REJECTED"].includes(innertubeErrorCode) &&
      !!String(process.env.YTDLP_COOKIES_FROM_BROWSER || "").trim() &&
      !String(process.env.YTDLP_COOKIES || "").trim();

    if (canRefreshBrowserCookies) {
      try {
        invalidateYtmSessionCaches({ removeExport: true });
        const retryResult = await tryInnertube({ forceFreshCookies: true });
        if (retryResult.shelves.length) return withTiming(retryResult);
        innertubeWarning = "YouTube Music refreshed browser session returned no playable shelves.";
        innertubeErrorCode = "";
      } catch (retryError) {
        innertubeWarning = retryError?.message || String(retryError);
        innertubeErrorCode = String(retryError?.code || innertubeErrorCode);
      }
    }

    console.warn("YouTube Music home API failed, using fallback shelves:", innertubeWarning);
  }

  const authFailure = ["YTM_AUTH_COOKIE_MISSING", "YTM_AUTH_REJECTED"].includes(innertubeErrorCode);
  if (ytmApiGate.retryAfterMs()) return withTiming({
    source: "innertube", cookieAvailable, personalized: cookieAvailable, shelves: [],
    partial: true, hasMore: true, warning: ytmRateLimitWarning
  });
  if (!authFailure && String(process.env.YTM_HOME_YTDLP_FALLBACK || "0").trim() === "1") {
    try {
      const data = await runYtJson(
        ["--flat-playlist", YTM_HOME_BROWSE_URL],
        "youtube-music-home",
        Math.min(timeout, Number(process.env.YTM_HOME_YTDLP_TIMEOUT_MS || 8000))
      );
      const parsedShelves = buildMusicHomeShelves(data, { maxShelves: fetchShelves, limitPerShelf });
      const selectedShelves = selectMusicHomeShelves(parsedShelves, { maxShelves, limitPerShelf });
      if (selectedShelves.length) {
        return withTiming({
          personalized: cookieAvailable && parsedShelves.length > 0,
          cookieAvailable,
          source: "yt-dlp",
          authUser: String(process.env.YTM_AUTH_USER || "").trim() || null,
          warning: innertubeWarning
            ? `YouTube Music Innertube home unavailable: ${innertubeWarning}`
            : "YouTube Music Innertube home was unavailable; using yt-dlp home output.",
          title: normalizeMusicHomeTitle(data?.title || "YouTube Music"),
          shelves: selectedShelves
        });
      }
      console.warn("YouTube Music home yt-dlp returned no shelves, using fallback shelves.");
    } catch (error) {
      console.warn("YouTube Music home yt-dlp failed, using fallback shelves:", error?.message || error);
    }
  }

  const fallback = await getFallbackYouTubeMusicHomeShelves({
    maxShelves,
    fetchShelves,
    limitPerShelf,
    timeoutMs: Number(process.env.YTM_HOME_FALLBACK_TIMEOUT_MS || 12000),
    lang,
    region,
    cookieAvailable,
  });
  return withTiming({
    ...fallback,
    authUser: String(process.env.YTM_AUTH_USER || "").trim() || null,
    warning: innertubeWarning || fallback.warning || "YouTube Music personalized home was unavailable."
  });
}

// Reads the signed-in YouTube Music home feed for the ytlive UI.
export async function getYouTubeMusicHomeShelves({ shelves = 6, limit = 12, lang = "", region = "", onProgress = null, forceRefresh = false } = {}) {
  const startedAt = Date.now();
  const maxShelves = normalizeMusicHomeNumber(shelves, 6, 1, 50);
  const limitPerShelf = normalizeMusicHomeNumber(limit, 12, 4, 24);
  if (!hasUsableCookieSource()) {
    const key = JSON.stringify({ shelves: maxShelves, limit: limitPerShelf, lang: normalizeDiscoverLang(lang), region: normalizeDiscoverRegion(region, lang) });
    const cachedPublic = getCachedDiscoverValue(ytmPublicHomeCache, key);
    if (cachedPublic) return { ...cloneYtmHomeResult(cachedPublic), cached: true, cacheScope: "server" };
    let request = ytmPublicHomeInFlight.get(key);
    if (!request) {
      request = loadYouTubeMusicHomeShelves({ shelves, limit, lang, region }).then((result) => {
        if (result.shelves.length && !ytmApiGate.retryAfterMs()) setCachedDiscoverValue(ytmPublicHomeCache, key, result);
        return result;
      }).finally(() => ytmPublicHomeInFlight.delete(key));
      ytmPublicHomeInFlight.set(key, request);
    }
    return { ...cloneYtmHomeResult(await request), cacheScope: "server", retryAfterMs: ytmApiGate.retryAfterMs() };
  }

  // Changing the cookie file/profile/account must never reuse another session's
  // recommendations or continuation tokens. Only the hash stays in cache keys.
  let cookieHeader = "";
  try {
    cookieHeader = buildCookieHeader(parseNetscapeCookieFile(await resolveMusicHomeCookieFile(), "music.youtube.com"));
  } catch {}
  if (!cookieHeader) {
    // Never read a personal cache entry under an unknown/failed session identity.
    return loadYouTubeMusicHomeShelves({ shelves, limit, lang, region, onProgress });
  }
  const homeCacheKey = getYtmHomeResultCacheKey({
    lang, region,
    sessionKey: createHash("sha256").update(cookieHeader).digest("hex")
  });
  const cached = getCachedYtmHomeResult(homeCacheKey);
  const project = (result) => {
    const projected = cloneYtmHomeResult(result);
    projected.shelves = projected.shelves.slice(0, maxShelves).map((shelf) => ({ ...shelf, items: shelf.items.slice(0, limitPerShelf) }));
    const enough = projected.shelves.length >= maxShelves;
    return { ...projected, fetchedShelves: projected.shelves.length,
      hasMore: !!result.hasMore && !enough, partial: !!result.partial && !enough, cacheScope: "server",
      retryAfterMs: Math.max(ytmApiGate.retryAfterMs(), Number(ytmHomeResultCache.get(homeCacheKey)?.retryAt || 0) - Date.now(), 0)
    };
  };
  const subscriber = onProgress ? (progress) => onProgress(project(progress)) : null;
  const send = (listener, progress) => {
    try { return listener?.(cloneYtmHomeResult(progress)); } catch { return false; }
  };

  // Join manual refreshes too; all subscribers get live progress, not just done.
  let active = ytmHomeResultInFlight.get(homeCacheKey);
  const fresh = cached?.freshUntil > Date.now();
  const enough = cached && (cached.result.shelves.length >= maxShelves || (!cached.result.hasMore && !cached.result.partial));
  const refreshAllowed = forceRefresh && (!cached || Date.now() - cached.updatedAt >= 30000);
  if (!active && cached && (ytmApiGate.retryAfterMs() || cached.retryAt > Date.now())) {
    return { ...project(cached.result), cached: true, stale: !fresh,
      warning: ytmApiGate.retryAfterMs() ? ytmRateLimitWarning : cached.result.warning };
  }
  if (!active && cached && enough && fresh && !refreshAllowed) {
    return { ...project(cached.result), cached: true, elapsedMs: Date.now() - startedAt };
  }
  if (!active) {
    let resumeState = refreshAllowed || !fresh ? null : cached?.resumeState;
    let best = cached?.result || null;
    active = { listeners: new Set(), progress: null, promise: null };
    if (subscriber) active.listeners.add(subscriber);
    const emit = (progress) => {
      active.progress = progress;
      for (const listener of active.listeners) {
        if (send(listener, progress) === false) active.listeners.delete(listener);
      }
    };
    const preserveLoaded = (result) => {
      if (best && result.source === "innertube" && result.authUser === best.authUser &&
          result.shelves.length < best.shelves.length) {
        return { ...result, shelves: best.shelves, fetchedShelves: best.shelves.length };
      }
      return result;
    };
    if (best) emit({ ...best, cached: true, stale: !fresh, phase: "resuming", elapsedMs: 0 });
    ytmHomeResultInFlight.set(homeCacheKey, active);
    active.promise = loadYouTubeMusicHomeShelves({
      shelves, limit: 24, lang, region, resumeState, retainFetched: true,
      onCheckpoint: (state) => { resumeState = state; },
      onProgress: (progress) => {
        best = preserveLoaded(progress);
        emit(best);
      }
    }).then((result) => {
      // A complete fresh feed may legitimately change; only incomplete refreshes
      // retain the larger already-displayed result.
      let finalResult = result.partial ? preserveLoaded(result) : result;
      if (best?.shelves.length && (result.source !== "innertube" || !result.shelves.length)) {
        finalResult = { ...best, partial: true, hasMore: true, cached: true, warning: result.warning || "YouTube Music refresh failed." };
      }
      if (finalResult.cached && cached) {
        // An unsuccessful refresh is not fresh data. Preserve its original age.
        ytmHomeResultCache.set(homeCacheKey, { ...cached, retryAt: Date.now() + 30000 });
        return finalResult;
      }
      cacheYtmHomeResult(homeCacheKey, finalResult, finalResult.hasMore ? resumeState : null);
      return finalResult;
    }).finally(() => {
      if (ytmHomeResultInFlight.get(homeCacheKey) === active) ytmHomeResultInFlight.delete(homeCacheKey);
    });
  } else if (subscriber) {
    active.listeners.add(subscriber);
    if (active.progress) send(subscriber, active.progress);
  }
  try {
    return project(await active.promise);
  } finally {
    active.listeners.delete(subscriber);
  }
}

// Extracts playlist data all flat for the yt-dlp YouTube download pipeline.
export async function extractPlaylistAllFlat(url) {
  const useFlat = shouldUseFlatPlaylist(url);
  const args = useFlat
    ? ["--yes-playlist", "--flat-playlist", "--ignore-errors", url]
    : ["--yes-playlist", "--ignore-errors", "--skip-download", url];
  const data = await runYtJson(
    args,
    "playlist-all-flat",
    PLAYLIST_ALL_TIMEOUT
  );

  const parentMeta = {
    ...(data || {}),
    webpage_url: data?.webpage_url || url,
    url: data?.url || url
  };
  const title = normalizeYtMusicAlbumTitle(data?.title || data?.playlist_title || "", {
    meta: parentMeta,
    sourceUrl: url
  });
  const rawEntries = Array.isArray(data?.entries) ? data.entries : [];
  const count = Number(data?.n_entries) || rawEntries.length || 0;
  const items = processEntries(rawEntries, PREVIEW_MAX_ENTRIES, parentMeta);

  return { title, count, items };
}

// Returns playlist data meta lite used for the yt-dlp YouTube download pipeline.
export async function getPlaylistMetaLite(url) {
  const isAutomix = isYouTubeAutomix(url);

  if (isAutomix) {
    try {
      const data = await runYtJson(
        ["--yes-playlist", "--flat-playlist", "--ignore-errors", url],
        "automix-meta",
        40000
      );

      const title = data?.title || data?.playlist_title || "YouTube Automix";
      const count = Number(data?.n_entries) ||
                    (Array.isArray(data?.entries) ? data.entries.length : 50) ||
                    50;

      setCache(url, { title, count: Math.max(1, count), entries: [] });
      return { title, count: Math.max(1, count), isAutomix: true };
    } catch {
      setCache(url, { title: "YouTube Automix", count: 50, entries: [] });
      return { title: "YouTube Automix", count: 50, isAutomix: true };
    }
  }

  const useFlat = shouldUseFlatPlaylist(url);
  const metaArgs = useFlat
    ? ["--yes-playlist", "--flat-playlist", "--ignore-errors", url]
    : ["--yes-playlist", "--ignore-errors", "--skip-download", "--playlist-items", "1", url];

  try {
    const data = await runYtJson(
      metaArgs,
      "playlist-meta",
      PLAYLIST_META_TIMEOUT
    );

    const title = normalizeYtMusicAlbumTitle(data?.title || data?.playlist_title || "", {
      meta: data,
      sourceUrl: url
    });
    const count = Number(data?.n_entries) || Number(data?.playlist_count) ||
                 (Array.isArray(data?.entries) ? data.entries.length : 0);

    return { title, count: Math.max(1, count), isAutomix: false };
  } catch {
    try {
      const data = await runYtJson(
        ["--yes-playlist", "--skip-download", "--playlist-items", "1", url],
        "playlist-meta-fallback",
        PLAYLIST_META_FALLBACK_TIMEOUT
      );

      const title = normalizeYtMusicAlbumTitle(data?.title || data?.playlist_title || "", {
        meta: data,
        sourceUrl: url
      });
      const count = Number(data?.n_entries) || Number(data?.playlist_count) || 1;

      return { title, count: Math.max(1, count), isAutomix: false };
    } catch {
      return { title: "", count: 1, isAutomix: false };
    }
  }
}

// Extracts playlist data page for the yt-dlp YouTube download pipeline.
export async function extractPlaylistPage(url, start, end) {
  try {
    const useFlat = shouldUseFlatPlaylist(url);
    const args = useFlat
      ? [
          "--yes-playlist", "--flat-playlist",
          "--playlist-items", `${start}-${end}`,
          url
        ]
      : [
          "--yes-playlist", "--ignore-errors", "--skip-download",
          "--playlist-items", `${start}-${end}`,
          url
        ];
    const data = await runYtJson(
      args,
      `playlist-page-${start}-${end}`,
      PLAYLIST_PAGE_TIMEOUT
    );

    const entries = Array.isArray(data?.entries) ? data.entries : [];
    const parentMeta = {
      ...(data || {}),
      webpage_url: data?.webpage_url || url,
      url: data?.url || url
    };
    const items = entries.map((entry, index) => processEntry(entry, index, parentMeta));
    const title = normalizeYtMusicAlbumTitle(data?.title || data?.playlist_title || "", {
      meta: parentMeta,
      sourceUrl: url
    });

    return { title, items };
  } catch {
    return { title: "", items: [] };
  }
}

// Extracts automix all flat for the yt-dlp YouTube download pipeline.
export async function extractAutomixAllFlat(url) {
  const data = await runYtJson([
    "--yes-playlist", "--flat-playlist", "--ignore-errors", url
  ], "automix-all-flat", AUTOMIX_ALL_TIMEOUT);

  const title = data?.title || data?.playlist_title || "YouTube Automix";
  const rawEntries = Array.isArray(data?.entries) ? data.entries : [];
  const count = Number(data?.n_entries) || rawEntries.length || 50;

  const items = rawEntries
    .slice(0, PREVIEW_MAX_ENTRIES)
    .map((entry, index) => ({
      ...processEntry(entry, index),
      uploader: entry?.uploader || entry?.channel || "YouTube Mix",
      webpage_url: entry?.webpage_url || entry?.url || url
    }))
    .sort((a, b) => a.index - b.index);

  return { title, count: Math.max(1, count), items };
}

// Extracts automix page for the yt-dlp YouTube download pipeline.
export async function extractAutomixPage(url, start, end) {
  try {
    const data = await runYtJson(
      [
        "--yes-playlist", "--flat-playlist", "--ignore-errors",
        "--playlist-items", `${start}-${end}`, url
      ],
      `automix-page-${start}-${end}`,
      AUTOMIX_PAGE_TIMEOUT
    );

    const entries = Array.isArray(data?.entries) ? data.entries : [];
    const items = entries.map((entry, index) => ({
      ...processEntry(entry, index),
      uploader: entry?.uploader || entry?.channel || "YouTube Mix",
      webpage_url: entry?.webpage_url || entry?.url || url
    }));

    const title = data?.title || data?.playlist_title || "YouTube Automix";
    const count = Number(data?.n_entries) || entries.length || 50;
    const cache = getCache(url) || { title, count: 0, entries: [] };
    if (!cache.title) cache.title = title;
    mergeCacheEntries(url, items);

    return { title, items, count };
  } catch {
    return null;
  }
}

// Handles ensure automix upto in the yt-dlp YouTube download pipeline.
export async function ensureAutomixUpto(url, upto, batchSize = 50) {
  const cache = getCache(url);
  if (!cache) return;

  const have = cache.entries.length;
  if (have >= upto) return;

  let start = have + 1;
  while (start <= upto && cache.entries.length < PREVIEW_MAX_ENTRIES) {
    const end = Math.min(start + batchSize - 1, upto);
    const page = await extractAutomixPage(url, start, end);

    if (page && Array.isArray(page.items) && page.items.length) {
      mergeCacheEntries(url, page.items);
      start = end + 1;
    } else {
      break;
    }
  }
}

// Loads YouTube metadata metadata for the yt-dlp YouTube download pipeline.
export async function fetchYtMetadata(url, isPlaylist = false) {
  const YTDLP_BIN = resolveYtDlp();
  if (!YTDLP_BIN) throw new Error("yt-dlp not found.");

  // Builds args for the yt-dlp YouTube download pipeline.
  const buildArgs = (flat = false, { stripCookies = false } = {}) => {
    let args = buildBaseArgs([], { sourceUrl: url });
    if (!args.includes("--no-check-formats")) {
      args.push("--no-check-formats");
    }

    if (!isPlaylist) args.push("--no-playlist");
    if (flat && isPlaylist) args.push("--flat-playlist");
    args = withYT403Workarounds(args, { stripCookies });

    args.push(url);
    return args;
  };

  const attemptDownload = (args, label) =>
    new Promise((resolve, reject) => {
      let stdoutData = "", stderrData = "";

      console.warn("[yt-meta-debug]", label, "args:", args.join(" "));

      const child = spawnSafe(YTDLP_BIN, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: getBinaryRuntimeEnv()
      });
      const timeoutId = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error(`[${label}] timeout`));
      }, 30000);

      child.stdout.on("data", chunk => stdoutData += chunk.toString());
      child.stderr.on("data", chunk => stderrData += chunk.toString());

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        if (code === 0) {
          try {
            resolve(JSON.parse(stdoutData));
          } catch (error) {
            reject(new Error(`[${label}] JSON parse error: ${error.message}\n${stderrData}`));
          }
        } else {
          const tail = stderrData.split("\n").slice(-20).join("\n");
          reject(new Error(`[${label}] exit code ${code}\n${tail}`));
        }
      });

      child.on("error", (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`[${label}] failed to start: ${error.message}`));
      });
    });

  const attempts = [
    { label: "meta+cookies+flat", args: buildArgs(true,  { stripCookies: false }) },
    { label: "meta+cookies",      args: buildArgs(false, { stripCookies: false }) },
    { label: "meta+nocookies",    args: buildArgs(false, { stripCookies: true  }) }
  ];

  let lastError;
for (const attempt of attempts) {
  try {
    const data = await attemptDownload(attempt.args, attempt.label);
    return data;
  } catch (error) {
    lastError = error;
    const msg = String(error.message || "");
    if (isDailymotionUrl(url) && isImpersonationUnavailableError(msg)) {
      console.warn("[yt-meta] dailymotion metadata skipped (impersonation dependency unavailable)");
      return null;
    }
    if (/Sign in to confirm your age/i.test(msg) ||
        /may be inappropriate for some users/i.test(msg) ||
        /age[-\s]?restricted/i.test(msg)) {
      console.warn("[yt-meta] age-restricted, metadata alınamadı, null dönüyorum");
      return null;
    }
  }
}

throw withDailymotionImpersonationHint(
  new Error(`All metadata attempts failed. Last error: ${lastError?.message}`),
  url
);
}

// Resolves playlist data selected ids for the yt-dlp YouTube download pipeline.
export async function resolvePlaylistSelectedIds(url, indices = []) {
  const data = await extractPlaylistAllFlat(url);
  const items = Array.isArray(data?.items) ? data.items : [];
  const title = data?.title || "";

  const byIndex = new Map(items.map((item, index) => [index + 1, item]));
  const picked = indices.map(idx => byIndex.get(Number(idx))).filter(Boolean);
  const ids = picked.map(entry => entry.id).filter(Boolean);

  return { ids, entries: picked, title };
}

// Resolves automix selected ids for the yt-dlp YouTube download pipeline.
export async function resolveAutomixSelectedIds(url, indices = []) {
  const data = await extractAutomixAllFlat(url);
  const items = Array.isArray(data?.items) ? data.items : [];
  const title = data?.title || "YouTube Automix";

  const byIndex = new Map(items.map((item, index) => [index + 1, item]));
  const picked = indices.map(idx => byIndex.get(Number(idx))).filter(Boolean);
  const ids = picked.map(entry => entry.id).filter(Boolean);

  return { ids, entries: picked, title };
}

// Downloads you tube video for the yt-dlp YouTube download pipeline.
export async function downloadYouTubeVideo(
  url,
  jobId,
  isPlaylist = false,
  playlistItems = null,
  isAutomix = false,
  selectedIds = null,
  TEMP_DIR = path.resolve(process.cwd(), "temp"),
  progressCallback = null,
  opts = {},
  ctrl = {}
) {
  try {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  } catch {}

  const YTDLP_BIN = resolveYtDlp();
  if (!YTDLP_BIN) throw new Error("yt-dlp not found.");
  if (isYouTubeUrl(String(url || ""))) {
    url = normalizeYouTubeUrl(url);
  }

  const hasSelectedIds =
    (isAutomix || isPlaylist) &&
    Array.isArray(selectedIds) &&
    selectedIds.length > 0;

  try {
    if (hasSelectedIds) {
      const conc = normalizeConcurrency(opts.youtubeConcurrency);
      return await downloadSelectedIdsParallel(
        YTDLP_BIN,
        selectedIds,
        jobId,
        TEMP_DIR,
        progressCallback,
        { ...opts, youtubeConcurrency: conc },
        ctrl
      );
    }

    return await downloadStandard(
      YTDLP_BIN,
      url,
      jobId,
      isPlaylist,
      isAutomix,
      playlistItems,
      TEMP_DIR,
      progressCallback,
      opts,
      ctrl
    );
  } catch (error) {
    throw withDailymotionImpersonationHint(error, opts?.sourceUrl || url);
  }
}

// Downloads selected ids for the yt-dlp YouTube download pipeline.
async function downloadSelectedIds(
  ytDlpBin,
  selectedIds,
  jobId,
  tempDir,
  progressCallback,
  opts = {},
  ctrl = {}
) {
  const idToIndex = new Map((opts?.frozenEntries || []).filter(e => e?.id && Number.isFinite(e.index)).map(e => [e.id, e.index]));
  const seenSkip = new Set();
  const listFile = path.join(tempDir, `${jobId}.urls.txt`);
  const urls = idsToDownloadUrls(selectedIds, opts?.frozenEntries, opts?.sourceUrl || "");
  const sourceUrl = opts?.sourceUrl || urls?.[0] || "";
  const sourceHeaders = isYouTubeUrl(String(sourceUrl || "")) ? DEFAULT_HEADERS : null;
  const fragmentConc = normalizeConcurrency(
    process.env.YTDLP_FRAGMENT_CONCURRENCY || DEFAULT_FRAGMENT_CONCURRENCY
  );

  fs.writeFileSync(listFile, urls.join("\n"), "utf8");

  const playlistDir = path.join(tempDir, jobId);
  fs.mkdirSync(playlistDir, { recursive: true });

  const preExisting = getDownloadedFiles(playlistDir, true);
  if (preExisting.length >= selectedIds.length) {
    if (progressCallback) progressCallback(100);
    return preExisting;
  }

  const totalCount = selectedIds.length;
  let skippedCount = 0;
  let errorsCount = 0;

  // Updates skip stats for the yt-dlp YouTube download pipeline.
  const updateSkipStats = () => {
    if (opts.onSkipUpdate) {
      opts.onSkipUpdate({ skippedCount, errorsCount });
    }
  };

  // Handles bump skip in the yt-dlp YouTube download pipeline.
  const bumpSkip = (line) => {
    if (isBenignSabrWarning(line)) return;
    if (isTransientRetryLine(line)) return;
    if (/^\s*SKIP_(SUMMARY|HINT):/i.test(line)) return;
    const key = line.replace(/\s+/g, " ").trim();
    if (seenSkip.has(key)) return;
    seenSkip.add(key);

    if (SKIP_RE.test(line)) {
      skippedCount++;
      emitEvent(progressCallback, opts, {
        type: "skip-hint",
        skippedCount,
        errorsCount,
        lastLogKey: "log.skippedItem",
        raw: line,
        jobId
      });
      updateSkipStats();
      try { process.stderr.write(`\nSKIP_HINT: ${line.trim()}\n`); } catch {}
    } else if (ERROR_WORD.test(line)) {
      errorsCount++;
      updateSkipStats();
      try { process.stderr.write(`\nSKIP_HINT: ${line.trim()}\n`); } catch {}
    }
  };

let args;

if (opts.video) {
    const h = (opts.maxHeight && Number.isFinite(opts.maxHeight)) ? opts.maxHeight : 1080;
    const videoHeaders = headersToArgs(opts?.requestHeaders || sourceHeaders);
    args = [
      "--ignore-config", "--no-warnings",
      "--socket-timeout", "15",
      "--user-agent", DEFAULT_USER_AGENT,
      ...videoHeaders,
      "--force-ipv4",
      "--no-playlist",
      "--ignore-errors", "--no-abort-on-error",
      "--no-part",
      "--progress", "--newline",
      "-N", String(fragmentConc),
      "-f", buildVideoFormatSelector(opts?.sourceUrl || urls?.[0] || "", h),
      "-o", path.join(playlistDir, "%(id)s.%(ext)s"),
      "-a", listFile
    ];
  } else {
    args = [
      "--ignore-config", "--no-warnings",
      "--socket-timeout", "15",
      "--user-agent", DEFAULT_USER_AGENT,
      ...headersToArgs(sourceHeaders),
      "--no-playlist",
      "-N", String(fragmentConc),
      "--ignore-errors", "--no-abort-on-error",
      "--write-thumbnail", "--convert-thumbnails", "jpg",
      "--continue", "--no-overwrites",
      "--progress", "--newline",
      "-o", path.join(playlistDir, "%(id)s.%(ext)s"),
      "-a", listFile,
      "-f", "bestaudio[abr>=128]/bestaudio/best"
    ];

    if (FLAGS.FORCE_IPV4) args.push("--force-ipv4");
    const geoNetArgs = addGeoArgs([]);
    if (geoNetArgs.length) args.push(...geoNetArgs);

    const extraEnv = process.env.YTDLP_EXTRA || process.env.YTDLP_ARGS_EXTRA;
    if (extraEnv) {
      args.push(...parseSafeYtDlpExtra(extraEnv));
    }
  }
  const cookieSourceUrl = opts?.sourceUrl || urls?.[0] || "";
  if (shouldAttachCookies(cookieSourceUrl, !!opts?.forceCookies)) {
    addCookieArgs(args, { ui: !!opts?.forceCookies });
  }
  addFfmpegLocationArgs(args);
  args.push(...getJsRuntimeArgs());
  args = withDailymotionNoImpersonation(args, cookieSourceUrl);

  return new Promise((resolve, reject) => {
    let stderrBuf = "";
    let downloadedCount = 0;
    let activeDestinationIsMedia = false;

    const child = spawnSafe(ytDlpBin, args, getYtDlpJobSpawnOptions());
    try { registerJobProcess(jobId, child); } catch {}

    // Handles abort if canceled in the yt-dlp YouTube download pipeline.
    const abortIfCanceled = () => {
      if (typeof ctrl?.isCanceled === "function" && ctrl.isCanceled()) {
        terminateYtDlpJobProcess(child, "SIGTERM");
        return true;
      }
      return false;
    };

    // Handles handle line in the yt-dlp YouTube download pipeline.
    const handleLine = (line) => {
      if (!line) return;
      if (ERROR_WORD.test(line) || SKIP_RE.test(line)) bumpSkip(line);
      if (line.includes("[download] Destination:")) {
        const m = line.match(/Destination:\s*(.+)$/i);
        const dest = m ? m[1].trim() : "";
        activeDestinationIsMedia = isCountableMediaDestination(dest);

        if (activeDestinationIsMedia) {
          downloadedCount++;
          const logicalDone = opts.video
            ? Math.min(totalCount, Math.ceil(downloadedCount / 2))
            : Math.min(totalCount, downloadedCount);

          const progress = (logicalDone / totalCount) * 100;
          if (typeof opts.onFileDone === "function") {
            let absPath = dest;
            if (!path.isAbsolute(absPath)) {
              absPath = path.join(playlistDir, dest);
            }

            const fileId = parseIdFromPath(absPath);
            const playlistIndex = (fileId && idToIndex.has(fileId)) ? idToIndex.get(fileId) : parsePlaylistIndexFromPath(absPath);
            try {
              opts.onFileDone({
                filePath: absPath,
                playlistIndex,
                id: fileId || null
              });
            } catch {}
          }

          if (progressCallback) progressCallback(progress);
          emitEvent(progressCallback, opts, {
            type: "file-done",
            downloaded: logicalDone,
            total: totalCount,
            jobId
          });
        }
        return;
      }
      const pctMatch = line.match(/(\d+(?:\.\d+)?)%/);
      if (pctMatch && progressCallback && activeDestinationIsMedia) {
        const filePct = parseFloat(pctMatch[1]);
        const overall = (downloadedCount / totalCount) * 100 + (filePct / totalCount);
        progressCallback(Math.min(100, overall));
      }
    };

    child.stdout.on("data", (data) => {
      if (abortIfCanceled()) return;
      const s = data.toString();
      s.split(/\r?\n/).forEach(handleLine);
    });

    child.stderr.on("data", (data) => {
      if (abortIfCanceled()) return;
      const s = data.toString();
      stderrBuf += s;
      s.split(/\r?\n/).forEach(handleLine);
    });

    child.on("close", (code, signal) => {
      const emitSummary = () => {
        try {
          process.stderr.write(`\nSKIP_SUMMARY: skipped=${skippedCount} errors=${errorsCount}\n`);
        } catch {}
        updateSkipStats();
        emitEvent(progressCallback, opts, {
          type: "summary",
          skippedCount,
          errorsCount,
          lastLogKey: "log.skipSummary",
          lastLogVars: { skipped: skippedCount, errors: errorsCount }
        });
      };

      if (signal === "SIGTERM" || signal === "SIGKILL") {
        return reject(new Error("CANCELED"));
      }
      if (code === null && /terminated|killed|aborted|SIGTERM|SIGKILL/i.test(stderrBuf)) {
        return reject(new Error("CANCELED"));
      }

      const files = getDownloadedFiles(playlistDir, true);
      if (files.length > 0) {
        const finalSkipped = Math.max(0, totalCount - files.length);
        if (finalSkipped !== skippedCount) {
          skippedCount = finalSkipped;
          updateSkipStats();
        }
        emitSummary();
        if (progressCallback) progressCallback(100);
        return resolve(files);
      }

      emitSummary();
      const errorTail = String(stderrBuf).split("\n").slice(-20).join("\n");
      return reject(new Error(`yt-dlp error (selected-ids): ${code}\n${errorTail}`));
    });

    child.on("error", (error) => {
      reject(new Error(`yt-dlp failed to start: ${error.message}`));
    });
  });
}

// Downloads selected ids parallel for the yt-dlp YouTube download pipeline.
async function downloadSelectedIdsParallel(
  ytDlpBin,
  selectedIds,
  jobId,
  tempDir,
  progressCallback,
  opts = {},
  ctrl = {}
) {
  const idToIndex = new Map((opts?.frozenEntries || []).filter(e => e?.id && Number.isFinite(e.index)).map(e => [e.id, e.index]));
  const urls = idsToDownloadUrls(selectedIds, opts?.frozenEntries, opts?.sourceUrl || "");
  const playlistDir = path.join(tempDir, jobId);
  fs.mkdirSync(playlistDir, { recursive: true });

  const preExisting = getDownloadedFiles(playlistDir, true);
  if (preExisting.length >= selectedIds.length) {
    if (progressCallback) progressCallback(100);
    return preExisting;
  }

  const fragmentConc = normalizeConcurrency(
    process.env.YTDLP_FRAGMENT_CONCURRENCY || DEFAULT_FRAGMENT_CONCURRENCY
  );

  const totalCount = selectedIds.length;
  let completedCount = preExisting.length;
  let skippedCount = 0;
  let errorsCount = 0;
  const seenSkip = new Set();

  // Updates skip stats for the yt-dlp YouTube download pipeline.
  const updateSkipStats = () => {
    if (typeof opts.onSkipUpdate === "function") {
      opts.onSkipUpdate({ skippedCount, errorsCount });
    }
  };

  // Handles bump skip in the yt-dlp YouTube download pipeline.
  const bumpSkip = (line) => {
    if (isBenignSabrWarning(line)) return;
    if (isTransientRetryLine(line)) return;
    if (/^\s*SKIP_(SUMMARY|HINT):/i.test(line)) return;
    const key = line.replace(/\s+/g, " ").trim();
    if (seenSkip.has(key)) return;
    seenSkip.add(key);

    if (SKIP_RE.test(line)) {
      skippedCount++;
      emitEvent(progressCallback, opts, {
        type: "skip-hint",
        skippedCount,
        errorsCount,
        lastLogKey: "log.skippedItem",
        raw: line,
        jobId
      });
      updateSkipStats();
      try { process.stderr.write(`\nSKIP_HINT: ${line.trim()}\n`); } catch {}
    } else if (ERROR_WORD.test(line)) {
      errorsCount++;
      updateSkipStats();
      try { process.stderr.write(`\nSKIP_HINT: ${line.trim()}\n`); } catch {}
    }
  };

  // Handles overall progress in the yt-dlp YouTube download pipeline.
  const overallProgress = () => {
    if (!progressCallback) return;
    const pct = Math.min(100, (completedCount / totalCount) * 100);
    progressCallback(pct);
  };

  const makeTask = (url, index) => async () => {
    if (typeof ctrl?.isCanceled === "function" && ctrl.isCanceled()) {
      throw new Error("CANCELED");
    }

    const outputTemplate = path.join(playlistDir, `%(id)s.%(ext)s`);

    let args;

    if (opts.video) {
      const h = (opts.maxHeight && Number.isFinite(opts.maxHeight))
        ? opts.maxHeight
        : 1080;

      args = [
        "--force-ipv4",
        "--no-playlist",
        "--ignore-errors", "--no-abort-on-error",
        "--no-part",
        "--progress", "--newline",
        "-N", String(fragmentConc),
        "-f", buildVideoFormatSelector(url, h),
        "-o", outputTemplate,
        url
      ];
    } else {
      args = [
        "--ignore-config", "--no-warnings",
        "--socket-timeout", "15",
        "--user-agent", DEFAULT_USER_AGENT,
        ...headersToArgs(isYouTubeUrl(String(url || "")) ? DEFAULT_HEADERS : null),
        "--no-playlist",
        "--ignore-errors", "--no-abort-on-error",
        "--write-thumbnail", "--convert-thumbnails", "jpg",
        "--continue", "--no-overwrites",
        "--autonumber-size", "3",
        "--progress", "--newline",
        "-N", String(fragmentConc),
        "-f", "bestaudio[abr>=128]/bestaudio/best",
        "-o", outputTemplate,
        url
      ];

      if (FLAGS.FORCE_IPV4) args.push("--force-ipv4");
      const geoNetArgs = addGeoArgs([]);
      if (geoNetArgs.length) args.push(...geoNetArgs);

      const extraEnv = process.env.YTDLP_EXTRA || process.env.YTDLP_ARGS_EXTRA;
      if (extraEnv) {
        args.push(...parseSafeYtDlpExtra(extraEnv));
      }
    }

    if (shouldAttachCookies(url, !!opts?.forceCookies)) {
      addCookieArgs(args, { ui: !!opts?.forceCookies });
    }
    addFfmpegLocationArgs(args);
    args.push(...getJsRuntimeArgs());
    args = withDailymotionNoImpersonation(args, url);

    return new Promise((resolve, reject) => {
      let stderrBuf = "";
      let mediaDestAbs = null;
      let emittedDone = false;

      const child = spawnSafe(ytDlpBin, args, getYtDlpJobSpawnOptions());
      try { registerJobProcess(jobId, child); } catch {}

      // Handles abort if canceled in the yt-dlp YouTube download pipeline.
      const abortIfCanceled = () => {
        if (typeof ctrl?.isCanceled === "function" && ctrl.isCanceled()) {
          terminateYtDlpJobProcess(child, "SIGTERM");
          return true;
        }
        return false;
      };

      // Handles fallback abs path by id in the yt-dlp YouTube download pipeline.
      const fallbackAbsPathById = () => {
        const fallbackId = selectedIds[index];
        if (!fallbackId) return null;
        try {
          const all = getDownloadedFiles(playlistDir, true)
            .filter((p) => parseIdFromPath(p) === fallbackId);
          return all[0] || null;
        } catch {
          return null;
        }
      };

      // Handles emit file done once in the yt-dlp YouTube download pipeline.
      const emitFileDoneOnce = () => {
        if (emittedDone) return;
        const donePath =
          (mediaDestAbs && fs.existsSync(mediaDestAbs) && mediaDestAbs) ||
          fallbackAbsPathById();
        if (!donePath) return;
        emittedDone = true;

        completedCount++;
        overallProgress();

        emitEvent(progressCallback, opts, {
          type: "file-done",
          downloaded: completedCount,
          total: totalCount,
          jobId
        });

        if (typeof opts.onFileDone === "function") {
          const fileId = parseIdFromPath(donePath);
          const playlistIndex = (fileId && idToIndex.has(fileId))
            ? idToIndex.get(fileId)
            : parsePlaylistIndexFromPath(donePath);
          try {
            opts.onFileDone({
              filePath: donePath,
              playlistIndex,
              id: fileId || null
            });
          } catch {}
        }
      };

      // Handles handle line in the yt-dlp YouTube download pipeline.
      const handleLine = (line) => {
        if (!line) return;

        if (ERROR_WORD.test(line) || SKIP_RE.test(line)) {
          bumpSkip(line);
        }

        if (line.includes("[download] Destination:")) {
          const m = line.match(/Destination:\s*(.+)$/i);
          const dest = m ? m[1].trim() : "";
          if (isCountableMediaDestination(dest)) {
            mediaDestAbs = path.isAbsolute(dest) ? dest : path.join(playlistDir, dest);
          }
        }
      };

      child.stdout.on("data", (d) => {
        if (abortIfCanceled()) return;
        d.toString().split(/\r?\n/).forEach(handleLine);
      });

      child.stderr.on("data", (d) => {
        if (abortIfCanceled()) return;
        const s = d.toString();
        stderrBuf += s;
        s.split(/\r?\n/).forEach(handleLine);
      });

      child.on("close", (code, signal) => {
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          return reject(new Error("CANCELED"));
        }

        if (code === 0) {
          emitFileDoneOnce();
          return resolve();
        }

        const tail = String(stderrBuf).split("\n").slice(-20).join("\n");

        if (SKIP_RE.test(tail) || ERROR_WORD.test(tail)) {
          emitFileDoneOnce();
          return resolve();
        }

        return reject(new Error(`yt-dlp error (parallel id ${index + 1}): ${code}\n${tail}`));
      });

      child.on("error", (err) => {
        reject(new Error(`yt-dlp failed to start: ${err.message}`));
      });
    });
  };

  const conc = normalizeConcurrency(opts.youtubeConcurrency);
  const tasks = urls.map((url, idx) => makeTask(url, idx));

  await runWithConcurrency(conc, tasks);

  const files = getDownloadedFiles(playlistDir, true);
  const finalSkipped = Math.max(0, totalCount - files.length);
  if (finalSkipped !== skippedCount) {
    skippedCount = finalSkipped;
    updateSkipStats();
  }

  try {
    process.stderr.write(`\nSKIP_SUMMARY: skipped=${skippedCount} errors=${errorsCount}\n`);
  } catch {}
  updateSkipStats();
  emitEvent(progressCallback, opts, {
    type: "summary",
    skippedCount,
    errorsCount,
    lastLogKey: "log.skipSummary",
    lastLogVars: { skipped: skippedCount, errors: errorsCount }
  });

  if (files.length > 0) {
    if (progressCallback) progressCallback(100);
    return files;
  }

  throw new Error("Download appears successful but output files were not found");
}

// Downloads standard for the yt-dlp YouTube download pipeline.
async function downloadStandard(
  ytDlpBin,
  url,
  jobId,
  isPlaylist,
  isAutomix,
  playlistItems,
  tempDir,
  progressCallback = null,
  opts = {},
  ctrl = {}
) {
  const H = (opts.maxHeight && Number.isFinite(opts.maxHeight)) ? opts.maxHeight : 1080;
  const fragmentConc = normalizeConcurrency(
    process.env.YTDLP_FRAGMENT_CONCURRENCY || DEFAULT_FRAGMENT_CONCURRENCY
  );

  const outputTemplate = path.join(
    tempDir,
    isPlaylist || isAutomix
      ? `${jobId}/%(playlist_index)s.%(ext)s`
      : (
          opts.preferTitleTemplate === false
            ? `${jobId}.%(ext)s`
            : `${jobId} - %(title).180B.%(ext)s`
        )
  );

  if (isPlaylist || isAutomix) {
    const playlistDir = path.join(tempDir, jobId);
    if (fs.existsSync(playlistDir)) {
      const files = getDownloadedFiles(playlistDir, true);
      if (files.length > 0) return files;
    }
  } else {
    const existingSingle = getDownloadedFiles(tempDir, false, jobId);
    if (existingSingle.length > 0) {
      return existingSingle[0];
    }
  }

  let args;

  if (opts.video) {
    const h = H || 1080;
    const videoHeaders = headersToArgs(
      opts?.requestHeaders || (isYouTubeUrl(String(url || "")) ? DEFAULT_HEADERS : null)
    );
    args = [
      "--ignore-config", "--no-warnings",
      "--socket-timeout", "15",
      "--user-agent", DEFAULT_USER_AGENT,
      ...videoHeaders,
      "--force-ipv4",
      "--progress", "--newline",
      "-f",
      buildVideoFormatSelector(url, h)
    ];

    if (isPlaylist || isAutomix) {
      args.push(
        "--yes-playlist",
        "--ignore-errors",
        "--no-abort-on-error",
        "--no-part",
        "-N", String(fragmentConc),
        "-o", outputTemplate
      );

      if (Array.isArray(playlistItems) && playlistItems.length > 0) {
        args.push("--playlist-items", playlistItems.join(","));
      } else {
        args.push("--playlist-end", "100");
      }
    } else {
      args.push(
        "--no-playlist",
        "--no-part",
        "-o", outputTemplate
      );
    }

    const extraEnv = process.env.YTDLP_EXTRA || process.env.YTDLP_ARGS_EXTRA;
    if (extraEnv) {
      args.push(...parseSafeYtDlpExtra(extraEnv));
    }
    if (shouldAttachCookies(opts?.sourceUrl || url, !!opts?.forceCookies)) {
      addCookieArgs(args, { ui: !!opts?.forceCookies });
    }
    addFfmpegLocationArgs(args);
    args.push(...getJsRuntimeArgs());

    args.push(url);
      } else {
    args = [
      "--ignore-config", "--no-warnings",
      "--socket-timeout", "15",
      "--user-agent", DEFAULT_USER_AGENT,
      ...headersToArgs(
        opts?.requestHeaders || (isYouTubeUrl(String(url || "")) ? DEFAULT_HEADERS : null)
      ),
      "--progress", "--newline",
      "-f", "bestaudio[abr>=128]/bestaudio/best"
    ];

        if (FLAGS.FORCE_IPV4) args.push("--force-ipv4");
        const geoNetArgs = addGeoArgs([]);
        if (geoNetArgs.length) args.push(...geoNetArgs);

        if (isPlaylist || isAutomix) {
      args.push(
        "--yes-playlist",
        "--ignore-errors",
        "--no-abort-on-error",
        "--write-thumbnail",
        "--convert-thumbnails", "jpg",
        "-N", String(fragmentConc),
      );

      if (Array.isArray(playlistItems) && playlistItems.length > 0) {
        args.push("--playlist-items", playlistItems.join(","));
      } else {
        args.push("--playlist-end", "100");
      }
    } else {
      args.push("--no-playlist");

      const audioLimit = process.env.YTDLP_AUDIO_LIMIT_RATE;
      if (audioLimit) {
        args.push("--limit-rate", audioLimit);
      }
    }

    args.push(
      "--no-part", "--continue", "--no-overwrites",
      "--retries", "10",
      "--fragment-retries", "10",
      "--retry-sleep", "1",
      "-o", outputTemplate
    );

    const extraEnv = process.env.YTDLP_EXTRA || process.env.YTDLP_ARGS_EXTRA;
    if (extraEnv) {
      args.push(...parseSafeYtDlpExtra(extraEnv));
    }
    if (shouldAttachCookies(opts?.sourceUrl || url, !!opts?.forceCookies)) {
      addCookieArgs(args, { ui: !!opts?.forceCookies });
    }
    addFfmpegLocationArgs(args);
    args.push(...getJsRuntimeArgs());
    args.push(url);
  }

  const finalArgs = withDailymotionNoImpersonation(args, opts?.sourceUrl || url);
  return new Promise((resolve, reject) => {
    const child = spawnSafe(ytDlpBin, finalArgs, {
      ...getYtDlpJobSpawnOptions(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    try { registerJobProcess(jobId, child); } catch {}

    // Handles abort if canceled in the yt-dlp YouTube download pipeline.
    const abortIfCanceled = () => {
      if (typeof ctrl?.isCanceled === "function" && ctrl.isCanceled()) {
        terminateYtDlpJobProcess(child, "SIGTERM");
        return true;
      }
      return false;
    };

    if (abortIfCanceled()) {
      return reject(new Error("CANCELED"));
    }
    const cancelTick = setInterval(() => { abortIfCanceled(); }, 250);

    let stderrBuf = "";
    let skippedCount = 0;
    let errorsCount = 0;
    let seenTotal = null;
    let downloadedFiles = 0;
    let curFilePct = 0;
    let activeDestinationIsMedia = false;

    // Updates skip stats for the yt-dlp YouTube download pipeline.
    const updateSkipStats = () => {
      if (opts.onSkipUpdate) {
        opts.onSkipUpdate({ skippedCount, errorsCount });
      }
    };

    // Handles bump skip std in the yt-dlp YouTube download pipeline.
    const bumpSkipStd = (line) => {
      if (isBenignSabrWarning(line)) return;
      if (isTransientRetryLine(line)) return;
      if (/^\s*SKIP_(SUMMARY|HINT):/i.test(line)) return;
      const key = line.replace(/\s+/g, " ").trim();
      if (seenSkip.has(key)) return;
      seenSkip.add(key);

      if (SKIP_RE.test(line)) {
        skippedCount++;
        emitEvent(progressCallback, opts, {
          type: "skip-hint",
          skippedCount,
          errorsCount,
          lastLogKey: "log.skippedItem",
          raw: line,
          jobId
        });
        updateSkipStats();
        try { process.stderr.write(`\nSKIP_HINT: ${line.trim()}\n`); } catch {}
      } else if (ERROR_WORD.test(line)) {
        errorsCount++;
        updateSkipStats();
        try { process.stderr.write(`\nSKIP_HINT: ${line.trim()}\n`); } catch {}
      }
    };

    const seenSkip = new Set();
    const pctRe = /(\d+(?:\.\d+)?)%/;
    const itemRe = /Downloading item\s+(\d+)\s+of\s+(\d+)/i;
    const destinationRe = /\[download\]\s+Destination:/i;

    // Handles bump progress in the yt-dlp YouTube download pipeline.
    const bumpProgress = () => {
      if (!progressCallback) return;

      if (isPlaylist || isAutomix) {
        const total = seenTotal || downloadedFiles || 1;
        const fileProgress = (downloadedFiles / total) * 100;
        const currentFileProgress = (curFilePct / 100) * (100 / total);
        const overall = Math.max(0, Math.min(100, fileProgress + currentFileProgress));
        progressCallback(overall);
      } else {
        progressCallback(Math.max(0, Math.min(100, curFilePct)));
      }
    };

    // Handles handle line in the yt-dlp YouTube download pipeline.
    const handleLine = (line) => {
      if (!line) return;

      if (ERROR_WORD.test(line) || SKIP_RE.test(line)) {
        bumpSkipStd(line);
      }

      if (destinationRe.test(line)) {
        const m = line.match(/Destination:\s*(.+)$/i);
        const dest = (m?.[1] || "").trim();
        activeDestinationIsMedia = isCountableMediaDestination(dest);

        if (activeDestinationIsMedia && (isPlaylist || isAutomix)) {
          downloadedFiles++;

          const total = seenTotal || downloadedFiles;
          if (progressCallback) {
            const progress = (downloadedFiles / total) * 100;
            progressCallback(progress);
          }

          emitEvent(progressCallback, opts, {
            type: "file-done",
            downloaded: downloadedFiles,
            total: seenTotal || downloadedFiles,
            jobId
          });

          if (typeof opts.onFileDone === "function" && dest) {
            let absPath = dest;
            if (!path.isAbsolute(absPath)) {
              const playlistDir = path.join(tempDir, jobId);
              absPath = path.join(playlistDir, dest);
            }

            const playlistIndex = parsePlaylistIndexFromPath(absPath);
            try {
              opts.onFileDone({
                filePath: absPath,
                playlistIndex
              });
            } catch {}
          }
        }
        return;
      }

      const pctMatch = line.match(pctRe);
      if (pctMatch && activeDestinationIsMedia) {
        curFilePct = parseFloat(pctMatch[1]) || 0;
        bumpProgress();
      }

      const mItem = line.match(itemRe);
      if (mItem) {
        const idx = parseInt(mItem[1], 10);
        const tot = parseInt(mItem[2], 10);
        if (Number.isFinite(tot) && tot > 0) seenTotal = tot;
      }
    };
    child.stdout.on("data", (d) => {
      if (abortIfCanceled()) return;
      const s = d.toString();
      s.split(/\r?\n/).forEach(handleLine);
    });

    child.stderr.on("data", (d) => {
      if (abortIfCanceled()) return;
      const s = d.toString();
      stderrBuf += s;
      s.split(/\r?\n/).forEach(handleLine);
    });

    child.on("close", (code, signal) => {
      clearInterval(cancelTick);
      const emitSummary = () => {
        try { process.stderr.write(`\nSKIP_SUMMARY: skipped=${skippedCount} errors=${errorsCount}\n`); } catch {}
        updateSkipStats();
        emitEvent(progressCallback, opts, {
          type: "summary",
          skippedCount,
          errorsCount,
          lastLogKey: "log.skipSummary",
          lastLogVars: { skipped: skippedCount, errors: errorsCount }
        });
      };

      if (signal === "SIGTERM" || signal === "SIGKILL") {
        return reject(new Error("CANCELED"));
      }
      if (code === null && /terminated|killed|aborted|SIGTERM|SIGKILL/i.test(stderrBuf)) {
        return reject(new Error("CANCELED"));
      }

      if (isPlaylist || isAutomix) {
        const playlistDir = path.join(tempDir, jobId);
        const files = getDownloadedFiles(playlistDir, true);
        if (files.length > 0) {
          const declaredTotal =
            (Array.isArray(playlistItems) && playlistItems.length)
              ? playlistItems.length
              : (seenTotal || files.length);
          const finalSkipped = Math.max(0, declaredTotal - files.length);
          if (finalSkipped !== skippedCount) {
            skippedCount = finalSkipped;
            updateSkipStats();
          }
          emitSummary();
          if (progressCallback) progressCallback(100);
          return resolve(files);
        }

        emitSummary();
        if (code !== 0) {
          const tail = stderrBuf.split("\n").slice(-20).join("\n");
          return reject(new Error(`yt-dlp error: ${code}\n${tail}`));
        }
        return reject(new Error("Download appears successful but output file was not found"));
      } else {
        emitSummary();
        const files = getDownloadedFiles(tempDir, false, jobId);
        if (files.length > 0) {
          if (progressCallback) progressCallback(100);
          return resolve(files[0]);
        }
        if (code !== 0) {
          const tail = stderrBuf.split("\n").slice(-20).join("\n");
          return reject(new Error(`yt-dlp error: ${code}\n${tail}`));
        }
        return reject(new Error("Download appears successful but output file was not found"));
      }
    });

    child.on("error", (err) => {
      clearInterval(cancelTick);
      reject(new Error(`yt-dlp failed to start: ${err.message}`));
    });
  });
}

// Returns downloaded files used for the yt-dlp YouTube download pipeline.
function getDownloadedFiles(directory, isPlaylist = false, jobId = null) {
  if (!fs.existsSync(directory)) return [];

  let files = fs.readdirSync(directory)
    .filter(file => MEDIA_OUTPUT_EXT_RE.test(file))
    .map(file => path.join(directory, file));

  if (isPlaylist) {
    files = files.sort((a, b) => {
      const aNum = parsePlaylistIndexFromPath(a) || 0;
      const bNum = parsePlaylistIndexFromPath(b) || 0;
      return aNum - bNum;
    });
  } else if (jobId) {
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escapeRe(jobId)}(?:\\.|\\s-\\s)`);
    files = files.filter(file => re.test(path.basename(file)));
  }
  return files;
}

// Parses playlist data index from path for the yt-dlp YouTube download pipeline.
export function parsePlaylistIndexFromPath(filePath) {
  const basename = path.basename(filePath);
  const noExt = basename.replace(/\.[A-Za-z0-9]+$/i, "");
  if (!noExt) return null;

  // Accept true index-based names:
  // "12.ext" or legacy "12 - title.ext"
  if (/^\d+$/.test(noExt)) return Number(noExt);
  const legacy = noExt.match(/^(\d+)\s*-\s+.+$/);
  return legacy ? Number(legacy[1]) : null;
}

// Builds entries map for the yt-dlp YouTube download pipeline.
export function buildEntriesMap(ytMetadata) {
  const map = new Map();
  const entries = Array.isArray(ytMetadata?.entries) ? ytMetadata.entries : [];

  entries.forEach(entry => {
    const index = Number(entry?.playlist_index ?? entry?.playlist?.index);
    if (Number.isFinite(index)) {
      map.set(index, entry);
    }
  });
  return map;
}

// Handles media probe data youtube music meta in the yt-dlp YouTube download pipeline.
export async function probeYoutubeMusicMeta(input) {
  const url = typeof input === "string" && !/^https?:\/\//i.test(input)
    ? `https://www.youtube.com/watch?v=${input}`
    : input;
  const data = await runYtJson([
    "--no-playlist",
    url
  ], "yt-music-probe", 20000);

  const d = Array.isArray(data?.entries) ? data.entries[0] : data;
  if (!d) return null;

  const artist = toNFC(d.artist || d.artist_uploader || d.uploader || d.channel || "");
  const track  = toNFC(d.track  || d.title || "");
  const album  = toNFC(d.album  || "");
  const year   = (d.release_year && String(d.release_year)) || "";
  const date   = d.release_date || d.upload_date || "";
  const genre  = d.genre || (Array.isArray(d.categories) ? d.categories[0] : "") || "";
  const copyright = d.copyright || d.license || d.license_name || "";
  const cover  = (Array.isArray(d.thumbnails) && d.thumbnails.length
    ? d.thumbnails.at(-1).url : d.thumbnail || null);

  const out = normalizeYtMusicAlbumMeta({
    title: track || d.title || "",
    track: track || d.title || "",
    artist: artist || "",
    uploader: artist || d.uploader || "",
    album: album || "",
    album_artist: artist || "",
    release_year: year || (date ? String(date).slice(0,4) : ""),
    release_date: date || "",
    upload_year: d.upload_date ? String(d.upload_date).slice(0, 4) : "",
    upload_date: d.upload_date || "",
    track_number: Number(d.track_number) || null,
    disc_number: Number(d.disc_number) || null,
    track_total: Number(d.track_total) || null,
    disc_total: Number(d.disc_total) || null,
    genre: genre || "",
    copyright: copyright || "",
    isrc: d.isrc || "",
    coverUrl: cover || "",
    webpage_url: d.webpage_url || d.original_url || url
  }, { sourceUrl: url, parentMeta: d });

  if (!out.title && !out.artist) return null;
  return out;
}
