import path from "path";
import fs from "fs";
import { spawn, execFile } from "child_process";
import { registerJobProcess } from "./store.js";
import { getCache, setCache, mergeCacheEntries, PREVIEW_MAX_ENTRIES } from "./cache.js";
import { findOnPATH, isExecutable, toNFC } from "./utils.js";
import { getYouTubeHeaders, getUserAgent, addGeoArgs, getExtraArgs, getLocaleConfig, FLAGS } from "./config.js";
import "dotenv/config";

export const YT_USE_MUSIC = FLAGS.USE_MUSIC;
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_USER_AGENT = getUserAgent();
const DEFAULT_HEADERS = getYouTubeHeaders();
const SKIP_RE = /(private|members\s*only|copyright|blocked|region|geo|not\s+available|unavailable|age[-\s]?restricted|signin|sign\s*in|skipp?ed|removed)/i;
const ERROR_WORD = /\berror\b/i;

function headersToArgs(headersObj) {
  const out = [];
  for (const key of ["Referer", "Origin", "Accept-Language"]) {
    const val = headersObj?.[key];
    if (val) out.push("--add-header", `${key}: ${val}`);
  }
  return out;
}

function emitEvent(progressCallback, opts, payload) {
  if (opts && typeof opts.onEvent === "function") {
    try { opts.onEvent(payload); } catch {}
  }
  if (typeof progressCallback === "function") {
    try { progressCallback({ __event: true, ...payload }); } catch {}
  }
}

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

    if (YT_USE_MUSIC && url.hostname === "www.youtube.com" &&
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

export const isYouTubeUrl = (url) =>
  url.includes("youtube.com/") || url.includes("youtu.be/") ||
  url.includes("youtube.com/watch") || url.includes("youtube.com/playlist");

export const isYouTubePlaylist = (url) =>
  url.includes("list=") || url.includes("/playlist") ||
  url.includes("&list=") || url.match(/youtube\.com.*[&?]list=/);

export const isYouTubeAutomix = (url) =>
  url.includes("&index=") || (url.includes("/watch?v=") && url.includes("&list=RD")) ||
  url.toLowerCase().includes("automix") || url.includes("list=RD");

export function resolveYtDlp() {
  const fromEnv = process.env.YTDLP_BIN;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;

  const commonPaths = [
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
    path.join(process.env.HOME || "", ".local/bin/yt-dlp")
  ];

  for (const path of commonPaths) {
    if (path && isExecutable(path)) return path;
  }

  const fromPATH = findOnPATH(process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  return fromPATH || null;
}

export function idsToMusicUrls(ids) {
  return ids.map(id => YT_USE_MUSIC ?
    `https://music.youtube.com/watch?v=${id}` :
    `https://www.youtube.com/watch?v=${id}`
  );
}

export function idsToWatchUrls(ids) {
  return ids.map(id => `https://www.youtube.com/watch?v=${id}`);
}

function buildBaseArgs(additionalArgs = []) {
  const args = [
   "--ignore-config", "--no-warnings",
   "--socket-timeout", "15",
   "--extractor-args", "youtube:player_client=android,web",
    "--user-agent", DEFAULT_USER_AGENT,
    "--retries", "3", "--retry-sleep", "1",
    "--sleep-requests", "0.1", "-J"
  ];
  if (FLAGS.FORCE_IPV4) args.push("--force-ipv4");

  Object.entries(DEFAULT_HEADERS).forEach(([key, value]) => {
    args.push("--add-header", `${key}: ${value}`);
  });

  const extra = getExtraArgs();
  if (extra.length) args.push(...extra);

  return [...args, ...additionalArgs];
}

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

  if (stripCookies || FLAGS.STRIP_COOKIES) {
    const cookieFlags = ["--cookies", "--cookies-from-browser"];
    cookieFlags.forEach(flag => {
      const index = args.indexOf(flag);
      if (index !== -1) args.splice(index, 2);
    });
  }

  return args;
}

export async function runYtJson(args, label = "ytjson", timeout = DEFAULT_TIMEOUT) {
  const YTDLP_BIN = resolveYtDlp();
  if (!YTDLP_BIN) {
    throw new Error("yt-dlp bulunamadı. Lütfen kurun veya YTDLP_BIN ile yol belirtin.");
  }

  return new Promise((resolve, reject) => {
    const finalArgs = buildBaseArgs(args);
    let stdoutData = "", stderrData = "";

    const process = spawn(YTDLP_BIN, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });

    const timeoutId = setTimeout(() => {
      try { process.kill("SIGKILL"); } catch {}
      reject(new Error(`[${label}] zaman aşımı (${timeout}ms)`));
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
          reject(new Error(`[${label}] JSON parse hatası: ${error.message}\n${stderrData}`));
        }
      } else {
        reject(new Error(`[${label}] çıkış kodu ${code}\n${stderrData.slice(-500)}`));
      }
    });

    process.on("error", (error) => {
      clearTimeout(timeoutId);
      reject(new Error(`[${label}] başlatılamadı: ${error.message}`));
    });
  });
}

function processEntry(entry, index) {
  return {
    index: Number(entry?.playlist_index ?? (index + 1)),
    id: entry?.id || "",
    title: toNFC(entry?.title || entry?.alt_title || ""),
    duration: Number.isFinite(entry?.duration) ? entry.duration : null,
    duration_string: entry?.duration_string || null,
    uploader: toNFC(entry?.uploader || entry?.channel || ""),
    webpage_url: entry?.webpage_url || entry?.url || "",
    thumbnail: (Array.isArray(entry?.thumbnails) && entry.thumbnails.length ?
      entry.thumbnails.at(-1).url : entry?.thumbnail || null)
  };
}

function processEntries(entries, maxEntries = PREVIEW_MAX_ENTRIES) {
  return entries
    .slice(0, maxEntries)
    .map(processEntry)
    .sort((a, b) => a.index - b.index);
}

export async function extractPlaylistAllFlat(url) {
  const data = await runYtJson([
    "--yes-playlist", "--flat-playlist", "--ignore-errors", url
  ], "playlist-all-flat");

  const title = data?.title || data?.playlist_title || "";
  const rawEntries = Array.isArray(data?.entries) ? data.entries : [];
  const count = Number(data?.n_entries) || rawEntries.length || 0;
  const items = processEntries(rawEntries);

  return { title, count, items };
}

export async function getPlaylistMetaLite(url) {
  const isAutomix = isYouTubeAutomix(url);

  if (isAutomix) {
    try {
      const data = await runYtJson([
        "--yes-playlist", "--flat-playlist", "--ignore-errors", url
      ], "automix-meta", 40000);

      const title = data?.title || data?.playlist_title || "YouTube Automix";
      const count = Number(data?.n_entries) || (Array.isArray(data?.entries) ? data.entries.length : 50) || 50;

      setCache(url, { title, count: Math.max(1, count), entries: [] });
      return { title, count: Math.max(1, count), isAutomix: true };
    } catch {
      setCache(url, { title: "YouTube Automix", count: 50, entries: [] });
      return { title: "YouTube Automix", count: 50, isAutomix: true };
    }
  }

  try {
    const data = await runYtJson([
      "--yes-playlist", "--flat-playlist", "--ignore-errors", url
    ], "playlist-meta", 25000);

    const title = data?.title || data?.playlist_title || "";
    const count = Number(data?.n_entries) || Number(data?.playlist_count) ||
                 (Array.isArray(data?.entries) ? data.entries.length : 0);

    return { title, count: Math.max(1, count), isAutomix: false };
  } catch {
    try {
      const data = await runYtJson([
        "--yes-playlist", "--skip-download", "--playlist-items", "1", url
      ], "playlist-meta-fallback", 15000);

      const title = data?.title || data?.playlist_title || "";
      const count = Number(data?.n_entries) || Number(data?.playlist_count) || 1;

      return { title, count: Math.max(1, count), isAutomix: false };
    } catch {
      return { title: "", count: 1, isAutomix: false };
    }
  }
}

export async function extractPlaylistPage(url, start, end) {
  try {
    const data = await runYtJson([
      "--yes-playlist", "--flat-playlist", "--playlist-items", `${start}-${end}`, url
    ], `playlist-page-${start}-${end}`, 20000);

    const entries = Array.isArray(data?.entries) ? data.entries : [];
    const items = entries.map(processEntry);
    const title = data?.title || data?.playlist_title || "";

    return { title, items };
  } catch {
    return { title: "", items: [] };
  }
}

export async function extractAutomixAllFlat(url) {
  const data = await runYtJson([
    "--yes-playlist", "--flat-playlist", "--ignore-errors", url
  ], "automix-all-flat", 25000);

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

export async function extractAutomixPage(url, start, end) {
  try {
    const data = await runYtJson([
      "--yes-playlist", "--flat-playlist", "--ignore-errors",
      "--playlist-items", `${start}-${end}`, url
    ], `automix-page-${start}-${end}`, 45000);

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

export async function fetchYtMetadata(url, isPlaylist = false) {
  const YTDLP_BIN = resolveYtDlp();
  if (!YTDLP_BIN) throw new Error("yt-dlp bulunamadı.");

  const buildArgs = (flat = false) => {
    const args = buildBaseArgs();
    if (!isPlaylist) args.push("--no-playlist");
    if (flat && isPlaylist) args.push("--flat-playlist");
    args.push(url);
    return args;
  };

  const attemptDownload = (args, label) => new Promise((resolve, reject) => {
    let stdoutData = "", stderrData = "";

    const process = spawn(YTDLP_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timeoutId = setTimeout(() => {
      try { process.kill("SIGKILL"); } catch {}
      reject(new Error(`[${label}] zaman aşımı`));
    }, 30000);

    process.stdout.on("data", chunk => stdoutData += chunk.toString());
    process.stderr.on("data", chunk => stderrData += chunk.toString());

    process.on("close", (code) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        try {
          resolve(JSON.parse(stdoutData));
        } catch (error) {
          reject(new Error(`[${label}] JSON parse hatası: ${error.message}`));
        }
      } else {
        reject(new Error(`[${label}] çıkış kodu ${code}`));
      }
    });

    process.on("error", (error) => {
      clearTimeout(timeoutId);
      reject(new Error(`[${label}] başlatılamadı: ${error.message}`));
    });
  });

  const attempts = [
    { label: "nocookies+flat", args: buildArgs(true) },
    { label: "nocookies", args: buildArgs(false) }
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      const data = await attemptDownload(attempt.args, attempt.label);
      return data;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Tüm metadata denemeleri başarısız. Son hata: ${lastError?.message}`);
}

export async function resolvePlaylistSelectedIds(url, indices = []) {
  const data = await extractPlaylistAllFlat(url);
  const items = Array.isArray(data?.items) ? data.items : [];
  const title = data?.title || "";

  const byIndex = new Map(items.map((item, index) => [index + 1, item]));
  const picked = indices.map(idx => byIndex.get(Number(idx))).filter(Boolean);
  const ids = picked.map(entry => entry.id).filter(Boolean);

  return { ids, entries: picked, title };
}

export async function resolveAutomixSelectedIds(url, indices = []) {
  const data = await extractAutomixAllFlat(url);
  const items = Array.isArray(data?.items) ? data.items : [];
  const title = data?.title || "YouTube Automix";

  const byIndex = new Map(items.map((item, index) => [index + 1, item]));
  const picked = indices.map(idx => byIndex.get(Number(idx))).filter(Boolean);
  const ids = picked.map(entry => entry.id).filter(Boolean);

  return { ids, entries: picked, title };
}

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
  if (!YTDLP_BIN) throw new Error("yt-dlp bulunamadı.");
  if ((isAutomix || isPlaylist) && Array.isArray(selectedIds) && selectedIds.length) {
    return downloadSelectedIds(
      YTDLP_BIN,
      selectedIds,
      jobId,
      TEMP_DIR,
      progressCallback,
      opts,
      ctrl
    );
  }

  return downloadStandard(
    YTDLP_BIN, url, jobId,
    isPlaylist, isAutomix, playlistItems,
    TEMP_DIR,
    progressCallback,
    opts,
    ctrl
  );
}

async function downloadSelectedIds(ytDlpBin, selectedIds, jobId, tempDir, progressCallback, opts = {}, ctrl = {}) {
  const seenSkip = new Set();
  const listFile = path.join(tempDir, `${jobId}.urls.txt`);
  const urls = idsToWatchUrls(selectedIds);

  fs.writeFileSync(listFile, urls.join("\n"), "utf8");

  const playlistDir = path.join(tempDir, jobId);
  fs.mkdirSync(playlistDir, { recursive: true });

  const preExisting = getDownloadedFiles(playlistDir, true);
  if (preExisting.length >= selectedIds.length) {
    if (progressCallback) progressCallback(100);
    return preExisting;
  }

  let args;
  let skippedCount = 0;
  let errorsCount = 0;

  const updateSkipStats = () => {
    if (opts.onSkipUpdate) {
      opts.onSkipUpdate({ skippedCount, errorsCount });
    }
  };

  const bumpSkip = (line) => {
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
        jobId: jobId
      });
      updateSkipStats();
      try { process.stderr.write(`\nSKIP_HINT: ${line.trim()}\n`); } catch {}
      return;
      } else if (ERROR_WORD.test(line)) {
      errorsCount++;
      updateSkipStats();
      try { process.stderr.write(`\nSKIP_HINT: ${line.trim()}\n`); } catch {}
    }
  };

  if (opts.video) {
    const h = (opts.maxHeight && Number.isFinite(opts.maxHeight)) ? opts.maxHeight : 1080;
    args = [
      "--ignore-config", "--no-warnings",
      "--socket-timeout", "15",
      "--extractor-args", "youtube:player_client=web_safari,web",
      "--user-agent", DEFAULT_USER_AGENT,
      ...headersToArgs(DEFAULT_HEADERS),
      "--no-playlist", "-N", "2",
      "--ignore-errors", "--no-abort-on-error",
      "--http-chunk-size", "16M", "--concurrent-fragments", "2",
      "--write-thumbnail", "--convert-thumbnails", "jpg",
      "--continue", "--no-overwrites",
      "--autonumber-size", "3",
      "--progress", "--newline",
      "-o", path.join(playlistDir, "%(autonumber)s - %(title)s.%(ext)s"),
      "-a", listFile,
      "-f",
      `b[ext=mp4][height<=${h}]/b[height<=${h}] / (bv*[height<=${h}][ext=mp4]/bv*[height<=${h}] + ba[ext=m4a]/ba) / b`,
      "--merge-output-format", "mp4",
      "--extractor-args", "youtube:player_client=web_safari,web"
    ];
    const geoNetArgs = addGeoArgs([]);
    if (geoNetArgs.length) args.push(...geoNetArgs);
    if (FLAGS.FORCE_IPV4) args.push("--force-ipv4");
  } else {
    args = [
      "--ignore-config", "--no-warnings",
      "--socket-timeout", "15",
      "--extractor-args", "youtube:player_client=android,web",
      "--user-agent", DEFAULT_USER_AGENT,
      ...headersToArgs(DEFAULT_HEADERS),
      "--no-playlist", "-N", "2",
      "--ignore-errors", "--no-abort-on-error",
      "--http-chunk-size", "16M", "--concurrent-fragments", "2",
      "--write-thumbnail", "--convert-thumbnails", "jpg",
      "--continue", "--no-overwrites",
      "--autonumber-size", "3",
      "--progress", "--newline",
      "-o", path.join(playlistDir, "%(autonumber)s - %(title)s.%(ext)s"),
      "-a", listFile,
      "-f", "bestaudio/best"
    ];
    if (FLAGS.FORCE_IPV4) args.push("--force-ipv4");
    const geoNetArgs = addGeoArgs([]);
    if (geoNetArgs.length) args.push(...geoNetArgs);
  }
  if (process.env.YTDLP_ARGS_EXTRA) args.push(...process.env.YTDLP_ARGS_EXTRA.split(/\s+/).filter(Boolean));

  return new Promise((resolve, reject) => {
    let stderrBuf = "";
    const child = spawn(ytDlpBin, args);
    try { registerJobProcess(jobId, child); } catch {}

    const abortIfCanceled = () => {
      if (typeof ctrl?.isCanceled === "function" && ctrl.isCanceled()) {
        try { child.kill('SIGTERM'); } catch {}
        return true;
      }
      return false;
    };

    let downloadedCount = 0;
    const totalCount = selectedIds.length;

    child.stdout.on('data', (data) => {
    if (abortIfCanceled()) return;
    const line = data.toString();
    if (ERROR_WORD.test(line) || SKIP_RE.test(line)) bumpSkip(line);
    if (line.includes('[download] Destination:')) {
      downloadedCount++;
      const progress = (downloadedCount / totalCount) * 100;
      if (progressCallback) progressCallback(progress);
      emitEvent(progressCallback, opts, {
      type: 'file-done',
      downloaded: downloadedCount,
      total: totalCount,
      jobId
    });
    }
  });

  child.stderr.on('data', (data) => {
    if (abortIfCanceled()) return;
    const line = data.toString();
    stderrBuf += line;
    if (ERROR_WORD.test(line) || SKIP_RE.test(line)) bumpSkip(line);
    if (line.includes('[download] Destination:')) {
      downloadedCount++;
      const progress = (downloadedCount / totalCount) * 100;
      if (progressCallback) progressCallback(progress);
    }
  });

    child.stderr.on('data', (data) => {
      if (abortIfCanceled()) return;
      const line = data.toString();
      stderrBuf += line;
      if (ERROR_WORD.test(line) || SKIP_RE.test(line)) bumpSkip(line);
      if (line.includes('[download]') && line.includes('%')) {
        const percentMatch = line.match(/(\d+\.\d+)%/);
        if (percentMatch) {
          const fileProgress = parseFloat(percentMatch[1]);
          const overallProgress = (downloadedCount / totalCount) * 100 + (fileProgress / totalCount);
          if (progressCallback) progressCallback(overallProgress);
        }
      }
    });

    child.on('close', (code, signal) => {
      try { process.stderr.write(`\nSKIP_SUMMARY: skipped=${skippedCount} errors=${errorsCount}\n`); } catch {}
      updateSkipStats();
      emitEvent(progressCallback, opts, {
        type: "summary",
        skippedCount,
        errorsCount,
        lastLogKey: "log.skipSummary",
        lastLogVars: { skipped: skippedCount, errors: errorsCount }
      });
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        return reject(new Error('CANCELED'));
      }
      if (code === null && /terminated|killed|aborted|SIGTERM|SIGKILL/i.test(stderrBuf)) {
        return reject(new Error('CANCELED'));
      }
      const files = getDownloadedFiles(playlistDir, true);
  if (files.length > 0) {
    const finalSkipped = Math.max(0, totalCount - files.length);
     if (finalSkipped !== skippedCount) {
       skippedCount = finalSkipped;
       updateSkipStats();
     }
     if (progressCallback) progressCallback(100);
     return resolve(files);
  }
      const errorTail = String(stderrBuf).split("\n").slice(-20).join("\n");
      return reject(new Error(`yt-dlp hatası (selected-ids): ${code}\n${errorTail}`));
    });

    child.on('error', (error) => {
      reject(new Error(`yt-dlp başlatılamadı: ${error.message}`));
    });
  });
}

async function downloadStandard(
  ytDlpBin, url, jobId,
  isPlaylist, isAutomix, playlistItems,
  tempDir,
  progressCallback = null,
  opts = {},
  ctrl = {}
) {
  const seenSkip = new Set();
  const H = (opts.maxHeight && Number.isFinite(opts.maxHeight)) ? opts.maxHeight : 1080;
  const outputTemplate = path.join(
    tempDir,
    isPlaylist || isAutomix
      ? `${jobId}/%(playlist_index)s - %(title)s.%(ext)s`
      : `${jobId} - %(title)s.%(ext)s`
  );

  if (isPlaylist || isAutomix) {
    const playlistDir = path.join(tempDir, jobId);
    if (fs.existsSync(playlistDir)) {
      const files = getDownloadedFiles(playlistDir, true);
      if (files.length > 0) return files;
      const declaredTotal =
     (Array.isArray(playlistItems) && playlistItems.length)
       ? playlistItems.length
       : (seenTotal || files.length);
   const finalSkipped = Math.max(0, declaredTotal - files.length);
   if (finalSkipped !== skippedCount) {
     skippedCount = finalSkipped;
     updateSkipStats();
   }
    }
  } else {
    const existingSingle = getDownloadedFiles(tempDir, false, jobId);
    if (existingSingle.length > 0) {
      return existingSingle[0];
    }
  }

  let args;
  if (opts.video) {
    args = [
      "--ignore-config", "--no-warnings",
      "--socket-timeout", "15",
      "--extractor-args", "youtube:player_client=web_safari,web",
      "--user-agent", DEFAULT_USER_AGENT,
      "--add-header", `Referer: ${DEFAULT_HEADERS["Referer"]}`,
      "--add-header", `Origin: ${DEFAULT_HEADERS["Origin"]}`,
      "--add-header", `Accept-Language: ${DEFAULT_HEADERS["Accept-Language"]}`,
      "--progress", "--newline",
      "-f",
      `b[ext=mp4][height<=${H}]/b[height<=${H}] / (bv*[height<=${H}][ext=mp4]/bv*[height<=${H}] + ba[ext=m4a]/ba) / b`,
      "--merge-output-format", "mp4",
      "--extractor-args", "youtube:player_client=web_safari,web"
    ];
    const geoNetArgs = addGeoArgs([]);
    if (geoNetArgs.length) args.push(...geoNetArgs);
  } else {
    args = [
      "--progress", "--newline",
      "-f", "bestaudio/best",
      "--ignore-config", "--no-warnings",
      "--socket-timeout", "15",
      "--extractor-args", "youtube:player_client=android,web",
      "--user-agent", DEFAULT_USER_AGENT,
      ...headersToArgs(DEFAULT_HEADERS)
    ];
    if (FLAGS.FORCE_IPV4) args.push("--force-ipv4");
  }

  const geoNetArgs = addGeoArgs([]);
  if (geoNetArgs.length) args.push(...geoNetArgs);

  if (isPlaylist || isAutomix) {
    args.push(
      "--yes-playlist", "--ignore-errors", "--no-abort-on-error",
      "--write-thumbnail", "--convert-thumbnails", "jpg"
    );

    if (Array.isArray(playlistItems) && playlistItems.length > 0) {
      args.push("--playlist-items", playlistItems.join(","));
    } else {
      args.push("--playlist-end", "100");
    }
  } else {
    args.push("--no-playlist");
  }

  args.push(
    "--no-part", "--continue", "--no-overwrites", "--retries", "10",
    "--fragment-retries", "10", "--retry-sleep", "1",
    "-o", outputTemplate
  );

  if (!isPlaylist && !isAutomix) {
    if (opts.video) {
      args.push("--concurrent-fragments", "1", "--limit-rate", "10M");
    } else {
      args.push("--concurrent-fragments", "1", "--limit-rate", "2M");
      if (FLAGS.FORCE_IPV4) args.push("--force-ipv4");
    }
  }

  if (process.env.YTDLP_ARGS_EXTRA) {
    args.push(...process.env.YTDLP_ARGS_EXTRA.split(/\s+/).filter(Boolean));
  }

  if (isAutomix) {
    args.push("--extractor-args", opts.video ? "youtube:player_client=web_safari,web"
                                             : "youtube:player_client=android,web");
  }

  args.push(url);

  const finalArgs = opts.video
    ? withYT403Workarounds(args, { stripCookies: true })
    : args;

  return new Promise((resolve, reject) => {
    const child = spawn(ytDlpBin, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    try { registerJobProcess(jobId, child); } catch {}

    const abortIfCanceled = () => {
      if (typeof ctrl?.isCanceled === "function" && ctrl.isCanceled()) {
        try { child.kill('SIGTERM'); } catch {}
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
    let seenIndex = 0;
    let curFilePct = 0;
    let currentFileIndex = 0;
    let downloadedFiles = 0;

    const updateSkipStats = () => {
      if (opts.onSkipUpdate) {
        opts.onSkipUpdate({ skippedCount, errorsCount });
      }
    };

    const bumpProgress = () => {
      if (!progressCallback) return;
      if (isPlaylist || isAutomix) {
        const total = seenTotal || (Array.isArray(playlistItems) && playlistItems.length) || 100;
        const fileProgress = currentFileIndex > 0 ? ((currentFileIndex - 1) / total) * 100 : 0;
        const currentFileProgress = (curFilePct / 100) * (100 / total);
        const overall = Math.max(0, Math.min(100, fileProgress + currentFileProgress));
        progressCallback(overall);
      } else {
        progressCallback(Math.max(0, Math.min(100, curFilePct)));
      }
    };

    const pctRe = /(\d+(?:\.\d+)?)%/;
    const itemRe = /Downloading item\s+(\d+)\s+of\s+(\d+)/i;
    const destinationRe = /\[download\]\s+Destination:\s*(.+)/i;
    const downloadCompleteRe = /\[download\]\s+(\d+)% of\s+~?\s*(\d+(?:\.\d+)?)(?:\w+)?\s+in\s+/i;

    const bumpSkipStd = (line) => {
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
          jobId: jobId
        });
        updateSkipStats();
        return;
        } else if (ERROR_WORD.test(line)) {
        errorsCount++;
        updateSkipStats();
        try { process.stderr.write(`\nSKIP_HINT: ${line.trim()}\n`); } catch {}
      }
    };

    const handleLine = (line) => {
    if (ERROR_WORD.test(line) || SKIP_RE.test(line)) bumpSkipStd(line);
    if (destinationRe.test(line)) {
      downloadedFiles++;
      currentFileIndex = downloadedFiles;

      if (isPlaylist || isAutomix) {
        const total = seenTotal || downloadedFiles;
        const progress = (downloadedFiles / total) * 100;
        if (progressCallback) progressCallback(progress);
        emitEvent(progressCallback, opts, {
      type: 'file-done',
      downloaded: downloadedFiles,
      total: total,
      jobId
    });
      } else {
        if (progressCallback) progressCallback(100);
      }
    }
    if (itemRe.test(line)) {
      const m2 = line.match(itemRe);
      const idx = parseInt(m2[1], 10);
      const tot = parseInt(m2[2], 10);
      if (Number.isFinite(tot) && tot > 0) seenTotal = tot;
      if (Number.isFinite(idx)) {
        currentFileIndex = idx;
        seenIndex = Math.max(seenIndex, idx - 1);
      }
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
      try { process.stderr.write(`\nSKIP_SUMMARY: skipped=${skippedCount} errors=${errorsCount}\n`); } catch {}
      updateSkipStats();
      emitEvent(progressCallback, opts, {
        type: "summary",
        skippedCount,
        errorsCount,
        lastLogKey: "log.skipSummary",
        lastLogVars: { skipped: skippedCount, errors: errorsCount }
      });
      if (signal === "SIGTERM" || signal === "SIGKILL") {
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
      if (progressCallback) progressCallback(100);
      return resolve(files);
    }
      if (code !== 0) {
        const tail = stderrBuf.split("\n").slice(-20).join("\n");
        return reject(new Error(`yt-dlp hatası: ${code}\n${tail}`));
      }
      return reject(new Error("Playlist klasörü oluştu ama dosya bulunamadı"));
    } else {
      const files = getDownloadedFiles(tempDir, false, jobId);
      if (files.length > 0) {
        if (progressCallback) progressCallback(100);
        return resolve(files[0]);
      }
      if (code !== 0) {
        const tail = stderrBuf.split("\n").slice(-20).join("\n");
        return reject(new Error(`yt-dlp hatası: ${code}\n${tail}`));
      }
      return reject(new Error("İndirme başarılı görünüyor ama dosya bulunamadı"));
    }
    });

    child.on("error", (err) => reject(new Error(`yt-dlp başlatılamadı: ${err.message}`)));
  });
}

function getDownloadedFiles(directory, isPlaylist = false, jobId = null) {
  if (!fs.existsSync(directory)) return [];

  const audioVideoExtensions = /\.(mp4|webm|m4a|mp3|opus|mkv|mka|flac|wav|aac|ogg)$/i;

  let files = fs.readdirSync(directory)
    .filter(file => audioVideoExtensions.test(file))
    .map(file => path.join(directory, file));

  if (isPlaylist) {
    files = files.sort((a, b) => {
      const aNum = parseInt(path.basename(a).split(' - ')[0]) || 0;
      const bNum = parseInt(path.basename(b).split(' - ')[0]) || 0;
      return aNum - bNum;
    });
  } else if (jobId) {
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escapeRe(jobId)}(?:\\.|\\s-\\s)`);
    files = files.filter(file => re.test(path.basename(file)));
  }

  return files;
}

export function parsePlaylistIndexFromPath(filePath) {
  const basename = path.basename(filePath);
  const match = basename.match(/^(\d+)\s*-\s*/);
  return match ? Number(match[1]) : null;
}

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
  const cover  = (Array.isArray(d.thumbnails) && d.thumbnails.length
    ? d.thumbnails.at(-1).url : d.thumbnail || null);

  const out = {
    title: track || d.title || "",
    track: track || d.title || "",
    artist: artist || "",
    uploader: artist || d.uploader || "",
    album: album || "",
    album_artist: artist || "",
    release_year: year || (date ? String(date).slice(0,4) : ""),
    release_date: date || "",
    isrc: d.isrc || "",
    coverUrl: cover || "",
    webpage_url: d.webpage_url || d.original_url || url
  };

  if (!out.title && !out.artist) return null;
  return out;
}
