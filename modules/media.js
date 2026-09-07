import { spawnSafe } from "./safeProcess.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { sanitizeFilename, findOnPATH, isExecutable } from "./utils.js";
import { attachLyricsToMedia } from "./lyrics.js";
import { jobs } from "./store.js";
import { rewriteId3v11Tag, writeRichId3v2Tag } from "./id3.js";
import { toDownloadPath, resolveDownloadPathToAbs } from "./outputPaths.js";
import { ensureOwnership } from "./fsOwnership.js";
import "dotenv/config";
import { FFMPEG_BIN as BINARY_FFMPEG_BIN } from "./binaries.js";
import { getFfmpegCaps } from "./ffmpegCaps.js";
import { assertPathWithinAny, fetchSafeRemote, sanitizeLogValue } from "./security.js";
import {
  describeRingtone,
  isRingtoneEnabled,
  resolveRingtoneSegment
} from "./ringtone.js";

const FFMPEG_STALL_TIMEOUT_MS = Math.max(
  30000,
  Number(process.env.FFMPEG_STALL_TIMEOUT_MS || 90000)
);
const FFMPEG_WATCHDOG_POLL_MS = Math.max(
  1000,
  Math.min(10000, Number(process.env.FFMPEG_WATCHDOG_POLL_MS || 5000))
);

// Returns optimal encoder params used for the FFmpeg media conversion pipeline.
function getOptimalEncoderParams(codec, hardware, quality = 'medium') {
    const params = {
        'h264': {
            'software': { preset: 'medium', tune: 'film', crf: '23' },
            'nvenc': { preset: 'p7', tune: 'hq', cq: '23' },
            'qsv': { preset: 'medium', quality: '23' },
            'vaapi': { quality: '23' }
        },
        'h265': {
            'software': { preset: 'medium', crf: '28' },
            'nvenc': { preset: 'p7', cq: '28' },
            'qsv': { preset: 'medium', quality: '28' },
            'vaapi': { quality: '28' }
        },
        'av1': {
            'software': { cpuUsed: '4', rowMt: '1', crf: '30' },
            'nvenc': { preset: 'p7', cq: '30' },
            'qsv': { preset: 'medium', quality: '30' },
            'vaapi': { quality: '30' }
        },
        'vp9': {
            'software': { cpuUsed: '2', rowMt: '1', crf: '31' },
            'vaapi': { quality: '31' }
        }
    };
    return params[codec]?.[hardware] || params['h264'][hardware] || params['h264']['software'];
}

// Normalizes nvenc preset and tune for the FFmpeg media conversion pipeline.
function normalizeNvencPresetAndTune(rawPreset) {
  const v = String(rawPreset || "").trim().toLowerCase();

  if (/^p[1-7]$/.test(v)) return { preset: v, tune: null };

  if (["hq", "ll", "ull", "lossless"].includes(v)) {
    return { preset: "p4", tune: v };
  }

  const legacyMap = {
    slow: "p7",
    medium: "p5",
    fast: "p3",
    hp: "p3",
    hq: "p5",
    bd: "p5",
    ll: "p4",
    llhq: "p5",
    llhp: "p3",
    lossless: "p4",
    losslesshp: "p3"
  };

  if (legacyMap[v]) return { preset: legacyMap[v], tune: null };
  return { preset: "p4", tune: null };
}

// Normalizes nvenc profile for encoder for the FFmpeg media conversion pipeline.
function normalizeNvencProfileForEncoder(enc, rawProfile) {
  const e = String(enc || "").toLowerCase();
  const p = String(rawProfile || "").trim().toLowerCase();

  if (e === "h264" || e === "h264_10bit" || e === "libx264" || e === "x264") {
    if (["baseline", "main", "high"].includes(p)) return p;
    return "high";
  }

  if (e === "hevc" || e === "hevc_10bit") {
    if (e === "hevc_10bit") return "main10";
    return (p === "main10") ? "main10" : "main";
  }

  if (e === "av1" || e === "av1_10bit") {
    return "main";
  }

  return p || "high";
}

// Returns the FFmpeg caps key required for a specific NVENC-backed codec.
function getRequiredNvencCapKey(encoder) {
  const value = String(encoder || "").toLowerCase();

  switch (value) {
    case "h264":
    case "x264":
    case "libx264":
      return "h264_nvenc";
    case "h264_10bit":
      return "h264_nvenc_10bit";
    case "hevc":
      return "hevc_nvenc";
    case "hevc_10bit":
      return "hevc_nvenc_10bit";
    case "av1":
      return "av1_nvenc";
    case "av1_10bit":
      return "av1_nvenc_10bit";
    default:
      return null;
  }
}

// Checks whether FFmpeg failed while initializing a hardware encoder/device.
function isRecoverableHardwareEncoderError(detail) {
  const text = String(detail || "").toLowerCase();
  if (!text) return false;

  return [
    "could not open encoder before eof",
    "nothing was written into output file",
    "conversion failed",
    "openencodesessionex failed",
    "no capable devices found",
    "cannot load libcuda",
    "device not found",
    "device setup failed",
    "failed to initialise encoder",
    "failed to initialize encoder",
    "error initializing output stream",
    "operation not permitted"
  ].some((needle) => text.includes(needle));
}

// Handles force8bit codec if tonemapping in the FFmpeg media conversion pipeline.
function force8bitCodecIfTonemapping(selectedCodec, codecConfig) {
  if (!selectedCodec || selectedCodec.bitDepth !== 10) return selectedCodec;

  switch (selectedCodec.encoder) {
    case "h264_10bit":
      return codecConfig["h264"];
    case "hevc_10bit":
      return codecConfig["h265"];
    case "av1_10bit":
      return codecConfig["av1"];
    case "vp9_10bit":
      return codecConfig["vp9"];
    default:
      return selectedCodec;
  }
}

const PRESET_ORDER = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow"
];

// Normalizes sw preset for the FFmpeg media conversion pipeline.
function normalizeSwPreset(p) {
  const v = String(p || "").trim().toLowerCase();
  return PRESET_ORDER.includes(v) ? v : "veryfast";
}

// Handles preset rank in the FFmpeg media conversion pipeline.
function presetRank(p) {
  const v = normalizeSwPreset(p);
  const idx = PRESET_ORDER.indexOf(v);
  return idx >= 0 ? idx : 2;
}

// Handles preset to aom cpu used in the FFmpeg media conversion pipeline.
function presetToAomCpuUsed(p) {
  const r = presetRank(p);
  return Math.max(0, Math.min(8, 8 - r));
}

// Handles preset to svt preset in the FFmpeg media conversion pipeline.
function presetToSvtPreset(p) {
  const map = {
    ultrafast: 12,
    superfast: 11,
    veryfast:  10,
    faster:    9,
    fast:      8,
    medium:    7,
    slow:      6,
    slower:    5,
    veryslow:  4
  };
  return map[normalizeSwPreset(p)] ?? 10;
}

// Handles preset to vp9 cpu used in the FFmpeg media conversion pipeline.
function presetToVp9CpuUsed(p) {
  return presetToAomCpuUsed(p);
}

// Handles preset to vp9 deadline in the FFmpeg media conversion pipeline.
function presetToVp9Deadline(p) {
  const r = presetRank(p);
  if (r <= 2) return "realtime";
  if (r <= 5) return "good";
  return "best";
}

// Resolves FFmpeg arguments bin for the FFmpeg media conversion pipeline.
function resolveFfmpegBin() {
  const isWin = process.platform === "win32";
  const exe = isWin ? "ffmpeg.exe" : "ffmpeg";
  const fromEnvFile = process.env.FFMPEG_BIN || process.env.FFMPEG_PATH;
  if (fromEnvFile && isExecutable(fromEnvFile)) {
    return fromEnvFile;
  }

  if (process.env.FFMPEG_DIR) {
    const candidate = path.join(process.env.FFMPEG_DIR, exe);
    if (isExecutable(candidate)) return candidate;
  }

  if (BINARY_FFMPEG_BIN && isExecutable(BINARY_FFMPEG_BIN)) {
    return BINARY_FFMPEG_BIN;
  }

  const fromPATH = findOnPATH(exe);
  if (fromPATH && isExecutable(fromPATH)) {
    return fromPATH;
  }

  const guesses = isWin
    ? [
        "C:\\tools\\ffmpeg\\bin\\ffmpeg.exe",
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
        "C:\\tools\\yt-dlp\\ffmpeg.exe",
        "C:\\Windows\\ffmpeg.exe"
      ]
    : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/bin/ffmpeg"];

  if (process.resourcesPath) {
    const packed = path.join(process.resourcesPath, "bin", exe);
    guesses.unshift(packed);
  }

  for (const g of guesses) {
    if (isExecutable(g)) return g;
  }

  return exe;
}

// Handles emit log in the FFmpeg media conversion pipeline.
function emitLog(onLog, payload) {
  if (payload?.fallback) console.log(payload.fallback);
  if (onLog) onLog(payload);
}

// Normalizes loudnorm mode identifiers used by the FFmpeg media conversion pipeline.
function normalizeLoudnormMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "two_pass") return "two_pass";
  if (mode === "dynamic") return "dynamic";
  return "ebu_r128";
}

// Resolves loudnorm mode configuration used by the FFmpeg media conversion pipeline.
function getLoudnormModeConfig(value) {
  const mode = normalizeLoudnormMode(value);

  if (mode === "two_pass") {
    return {
      mode,
      targetI: -23,
      targetTp: -2,
      targetLra: 7,
      linear: true,
      twoPass: true
    };
  }

  if (mode === "dynamic") {
    return {
      mode,
      targetI: -16,
      targetTp: -1.5,
      targetLra: 11,
      linear: false,
      twoPass: false
    };
  }

  return {
    mode: "ebu_r128",
    targetI: -23,
    targetTp: -2,
    targetLra: 7,
    linear: true,
    twoPass: false
  };
}

// Builds loudnorm filter expression used by the FFmpeg media conversion pipeline.
function buildLoudnormFilter(config, stats = null, printFormat = null) {
  const cfg = config || getLoudnormModeConfig("ebu_r128");
  const parts = [
    `loudnorm=I=${cfg.targetI}`,
    `TP=${cfg.targetTp}`,
    `LRA=${cfg.targetLra}`
  ];

  if (cfg.linear === true) parts.push("linear=true");
  else if (cfg.linear === false) parts.push("linear=false");

  if (stats) {
    parts.push(`measured_I=${stats.input_i}`);
    parts.push(`measured_TP=${stats.input_tp}`);
    parts.push(`measured_LRA=${stats.input_lra}`);
    parts.push(`measured_thresh=${stats.input_thresh}`);
    parts.push(`offset=${stats.target_offset}`);
  }

  if (printFormat) parts.push(`print_format=${printFormat}`);
  return parts.join(":");
}

// Parses loudnorm analysis JSON emitted by FFmpeg in the media conversion pipeline.
function parseLoudnormAnalysisStats(stderr = "") {
  const text = String(stderr || "");
  const matches = text.match(/\{\s*"input_i"[\s\S]*?\}/g);
  if (!matches || !matches.length) return null;

  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i]);
      const keys = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"];
      const normalized = {};

      let ok = true;
      for (const key of keys) {
        const num = Number(parsed?.[key]);
        if (!Number.isFinite(num)) {
          ok = false;
          break;
        }
        normalized[key] = String(num);
      }

      if (ok) return normalized;
    } catch {}
  }

  return null;
}

// Resolves template for the FFmpeg media conversion pipeline.
export function resolveTemplate(meta, template) {
  const pick = (a, b) =>
    (meta[a] || "").toString().trim() || (meta[b] || "").toString().trim();
  return template
    .replace(/%\(([^)]+)\)s/g, (_, keyExpr) => {
      if (keyExpr.includes("|")) {
        const [a, b] = keyExpr.split("|").map((s) => s.trim());
        return pick(a, b) || "";
      }
      const v = (meta[keyExpr] || "").toString().trim();
      return v || "";
    })
    .replace(/\s+-\s+/g, " - ")
    .replace(/^\s*-\s+/, "")
    .replace(/\s+-\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Handles maybe clean title in the FFmpeg media conversion pipeline.
export function maybeCleanTitle(t) {
  if (!t) return t;
  if (process.env.TITLE_CLEAN_PIPE === "1") {
    const parts = t.split("|").map((s) => s.trim());
    if (parts.length > 1) return parts.at(-1);
  }
  return t;
}

// Handles refine output basename in the FFmpeg media conversion pipeline.
function refineOutputBasename(name) {
  let s = String(name || "").trim();
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
    if (head && tail) s = `${head} - ${tail}`;
    else if (head) s = head;
  }

  s = s.replace(/\s*(?:[-–—•]\s*)+$/, "").trim();
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

// Handles clean title for audio tags in the FFmpeg media conversion pipeline.
function cleanTitleForTags(t) {
  if (!t) return t;
  let s = String(t).trim();

  s = s.replace(/\s*_\s*/g, " ");
  s = s.replace(/[\s_]+$/, "");
  s = s.replace(/[\s\-–—•]+$/, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

// Downloads thumbnail for the FFmpeg media conversion pipeline.
export async function downloadThumbnail(thumbnailUrl, destBasePathNoExt) {
  if (!thumbnailUrl) return null;
  try {
    const baseDir = path.resolve(process.env.DATA_DIR || process.cwd());
    const allowedRoots = [path.join(baseDir, 'outputs'), path.join(baseDir, 'temp'), path.join(baseDir, 'uploads')];
    const safeBase = assertPathWithinAny(path.resolve(String(destBasePathNoExt || '')), allowedRoots);
    const res = await fetchSafeRemote(thumbnailUrl, {}, { maxRedirects: 3 });
    if (!res.ok) return null;
    const maxCoverBytes = 25 * 1024 * 1024;
    const declaredLength = Number(res.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxCoverBytes) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxCoverBytes) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    let ext = ".jpg";
    if (ct.includes("image/webp")) ext = ".webp";
    else if (ct.includes("image/png")) ext = ".png";
    else if (ct.includes("jpeg")) ext = ".jpg";
    const destPath = assertPathWithinAny(`${safeBase}${ext}`, allowedRoots);
    // Remote image data is size-limited and the destination is confined to approved Gharmonize roots.
    fs.writeFileSync(destPath, Buffer.from(buf), { mode: 0o600 });
    return destPath;
  } catch {
    return null;
  }
}

// Resolves cover path from meta for the FFmpeg media conversion pipeline.
async function resolveCoverPathFromMeta(metadata, jobId, outputDir, tempDir) {
  const url =
    metadata?.coverUrl ||
    metadata?.thumbnailUrl ||
    metadata?.imageUrl ||
    null;

  if (!url) return null;

  const dir = (tempDir && path.isAbsolute(tempDir)) ? tempDir : (outputDir || process.cwd());
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  const base = path.join(dir, `.cover_${jobId}_${Date.now()}`);
  const p = await downloadThumbnail(url, base);
  if (p && fs.existsSync(p)) return p;
  return null;
}

// Handles environment variables truth in the FFmpeg media conversion pipeline.
function envTruth(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["0", "false", "no", "off", "disable", "disabled"].includes(s)) return false;
  return true;
}

// Determines whether prefer Spotify metadata cover should run for the FFmpeg media conversion pipeline.
function shouldPreferSpotifyCover() {
  const explicit = envTruth(process.env.PREFER_SPOTIFY_TAGS);
  if (explicit === null) return true;
  return explicit;
}

// Handles looks like Spotify metadata cover URL in the FFmpeg media conversion pipeline.
function looksLikeSpotifyCoverUrl(url) {
  const u = String(url || "").trim();
  if (!u) return false;
  return /(^|\/\/)i\.scdn\.co\//i.test(u) || /scdn\.co/i.test(u);
}

// Handles ensure jpeg cover in the FFmpeg media conversion pipeline.
export async function ensureJpegCover(
  coverPath,
  jobId,
  tempDir,
  ffmpegFromCaller = null
) {
  try {
    if (!coverPath || !fs.existsSync(coverPath)) return null;

    const ext = path.extname(coverPath).toLowerCase();
    if ([".jpg", ".jpeg"].includes(ext)) return coverPath;

    const ffmpegBin = ffmpegFromCaller || resolveFfmpegBin();

    let outDir = path.dirname(coverPath);
    if (!outDir || outDir === "." || !path.isAbsolute(outDir)) {
      outDir = tempDir || process.cwd();
    }

    const baseName = path.basename(coverPath, ext);
    const outJpg = path.join(outDir, `${baseName}.norm.jpg`);

    await new Promise((resolve, reject) => {
      const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", coverPath, outJpg];
      const p = spawnSafe(ffmpegBin, args);
      let err = "";
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (code) =>
        code === 0 && fs.existsSync(outJpg)
          ? resolve()
          : reject(new Error(`Cover conversion failed (code ${code}): ${err}`))
      );
      p.on("error", (e) =>
        reject(new Error(`Failed to start ffmpeg: ${e.message}`))
      );
    });

    return outJpg;
  } catch (e) {
    // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
    console.warn("⚠️ Cover conversion warning:", sanitizeLogValue(e?.message || e));
    return null;
  }
}

// Returns comment text used for the FFmpeg media conversion pipeline.
const getCommentText = () => {
  if (process.env.MEDIA_COMMENT) return process.env.MEDIA_COMMENT;
  if (process.env.COMMENT_TEXT) return process.env.COMMENT_TEXT;
  return "Gharmonize";
};

const shouldWriteId3v1 = () => process.env.WRITE_ID3V1 !== "0";
const shouldWriteMp3Xing = () => process.env.MP3_WRITE_XING === "1";

const VIDEO_HWACCEL = (process.env.VIDEO_HWACCEL || "off").toLowerCase();
const NVENC_PRESET  = process.env.NVENC_PRESET  || "fast";
const NVENC_Q       = process.env.NVENC_Q       || "23";
const QSV_PRESET    = process.env.QSV_PRESET    || "veryfast";
const QSV_Q         = process.env.QSV_Q         || "23";
const VAAPI_DEVICE  = process.env.VAAPI_DEVICE  || "/dev/dri/renderD128";
const VAAPI_QUALITY = process.env.VAAPI_QUALITY || "23";

// Handles comment key for in the FFmpeg media conversion pipeline.
function commentKeyFor(fmt) {
  const f = String(fmt || "").toLowerCase();
  if (f === "flac" || f === "ogg") return "DESCRIPTION";
  if (f === "mp4" || f === "m4a") return "\u00A9cmt";
  if (f === "mp3") return "comment";
  if (f === "eac3" || f === "ac3") return "comment";
  if (f === "aac") return "comment";
  if (f === "dts") return "comment";
  return "comment";
}

// Handles append comment metadata in the FFmpeg media conversion pipeline.
function appendCommentMetadata(args, format, commentText) {
  if (!commentText) return;
  const key = commentKeyFor(format);
  args.push("-metadata", `${key}=${commentText}`);
}

// Selects composer text for the FFmpeg media conversion pipeline.
function pickComposerText(meta = {}) {
  return (
    meta.composer ||
    meta.album_artist ||
    meta.artist ||
    meta.uploader ||
    ""
  );
}

// Builds common meta pairs for the FFmpeg media conversion pipeline.
function buildCommonMetaPairs(resolvedMeta, format) {
  const baseNumbers = {
    track_number: resolvedMeta.track_number ?? null,
    track_total:  resolvedMeta.track_total  ?? null,
    disc_number:  resolvedMeta.disc_number  ?? null,
    disc_total:   resolvedMeta.disc_total   ?? null
  };

  const tn   = Number(baseNumbers.track_number) || null;
  const ttot = Number(baseNumbers.track_total)  || null;
  const dn   = Number(baseNumbers.disc_number)  || null;
  const dtot = Number(baseNumbers.disc_total)   || null;
  const trackTag = tn ? (ttot ? `${tn}/${ttot}` : String(tn)) : "";
  const discTag  = dn ? (dtot ? `${dn}/${dtot}` : String(dn)) : "";
  const dateTag =
    resolvedMeta.release_date &&
    /^\d{4}(-\d{2}(-\d{2})?)?$/.test(resolvedMeta.release_date)
      ? resolvedMeta.release_date
      : resolvedMeta.release_year || resolvedMeta.upload_date || "";

  const metaPairs = {
    title:  resolvedMeta.track || resolvedMeta.title || "",
    artist: resolvedMeta.artist || "",
    album:  resolvedMeta.album || resolvedMeta.playlist_title || "",
    date:   dateTag || "",
    track:  trackTag || "",
    disc:   discTag || "",
    genre:  resolvedMeta.genre || "",
    composer: pickComposerText(resolvedMeta)
  };

  if (resolvedMeta.album_artist) {
    metaPairs.album_artist = resolvedMeta.album_artist;
    metaPairs.ALBUMARTIST  = resolvedMeta.album_artist;
  }

  const labelLike = resolvedMeta.label || resolvedMeta.publisher;
  if (labelLike) {
    metaPairs.publisher = labelLike;
    metaPairs.PUBLISHER = labelLike;
  }

  if (resolvedMeta.copyright) {
    metaPairs.copyright = resolvedMeta.copyright;
    metaPairs.COPYRIGHT = resolvedMeta.copyright;
  }

  if (resolvedMeta.webpage_url) {
    metaPairs.URL = resolvedMeta.webpage_url;
  }

  if (resolvedMeta.playlist_index) {
    metaPairs.playlist_index = String(resolvedMeta.playlist_index);
    metaPairs.PLAYLIST_INDEX = String(resolvedMeta.playlist_index);
  }

  if (resolvedMeta.playlist_total) {
    metaPairs.playlist_total = String(resolvedMeta.playlist_total);
    metaPairs.PLAYLIST_TOTAL = String(resolvedMeta.playlist_total);
  }

  return metaPairs;
}

// Determines whether skip retag should run for the FFmpeg media conversion pipeline.
function shouldSkipRetag(format) {
  const f = String(format || "").toLowerCase();
  return (f === "wav" || f === "aac" || f === "ac3" || f === "eac3" || f === "dts");
}

// Handles retag media file in the FFmpeg media conversion pipeline.
export async function retagMediaFile(
  absOutputPath,
  format,
  metadata = {},
  coverPath = null,
  opts = {}
) {
  const tempFilesToCleanup = [];
  let tmpOut = null;
  // Handles safe unlink in the FFmpeg media conversion pipeline.
  const safeUnlink = (p) => {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  };
  try {
    if (!absOutputPath || !fs.existsSync(absOutputPath)) return null;
    const f = String(format || path.extname(absOutputPath).slice(1) || "").toLowerCase();

    if (shouldSkipRetag(f)) {
      // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
      console.log(`ℹ️ retag skipped for format=${sanitizeLogValue(f)} (container metadata limits) → ${sanitizeLogValue(path.basename(absOutputPath))}`);
      return null;
    }

    const ffmpegBin = opts?.ffmpegBin || resolveFfmpegBin();
    const tempDir = opts?.tempDir || path.dirname(absOutputPath);
    const jobId = opts?.jobId || "retag";
    const preferSpotifyCover = shouldPreferSpotifyCover();
    const resolvedMeta = {
      ...metadata,
      title: cleanTitleForTags(maybeCleanTitle(metadata?.title)),
      track: cleanTitleForTags(metadata?.track),
    };

    let canEmbedCover = false;
    let coverToUse = null;
    const coverOkFormats = new Set(["mp3", "flac", "m4a", "mp4", "ogg"]);
    if (coverOkFormats.has(f)) {
      const metaCoverUrl = String(resolvedMeta?.coverUrl || "").trim();
      const useSpotifyCover = preferSpotifyCover && looksLikeSpotifyCoverUrl(metaCoverUrl);

      let pickedCoverPath = coverPath;
      if (useSpotifyCover) {
        try {
          const dl = await resolveCoverPathFromMeta(
            { coverUrl: metaCoverUrl },
            jobId,
            path.dirname(absOutputPath),
            tempDir
          );
          if (dl && fs.existsSync(dl)) {
            pickedCoverPath = dl;
            tempFilesToCleanup.push(dl);
          }
        } catch {}
      }

      if (pickedCoverPath) {
        try {
          coverToUse = await ensureJpegCover(pickedCoverPath, jobId, tempDir, ffmpegBin);
        } catch {}
        if (coverToUse && fs.existsSync(coverToUse)) {
          canEmbedCover = true;
          if (coverToUse !== pickedCoverPath) tempFilesToCleanup.push(coverToUse);
        }
      }
    }
    const preserveExistingCover = !canEmbedCover && coverOkFormats.has(f);

    const metaPairs = buildCommonMetaPairs(resolvedMeta, f);
    const ext = path.extname(absOutputPath) || `.${f}`;
    const base = absOutputPath.slice(0, -ext.length);
    tmpOut = `${base}.retag.${crypto.randomBytes(4).toString("hex")}${ext}`;

    await new Promise((resolve, reject) => {
      const args = ["-hide_banner", "-nostdin", "-y", "-i", absOutputPath];
      if (canEmbedCover) args.push("-i", coverToUse);
      args.push("-map_metadata", "0");

    for (const [k, v] of Object.entries(metaPairs)) {
      if (v != null && String(v).length) args.push("-metadata", `${k}=${v}`);
    }

      const commentText = getCommentText();
      appendCommentMetadata(args, f, commentText);
      if (resolvedMeta.isrc) args.push("-metadata", `ISRC=${resolvedMeta.isrc}`);
      if (resolvedMeta.webpage_url) args.push("-metadata", `URL=${resolvedMeta.webpage_url}`);
      args.push("-map", "0:a");
      if (preserveExistingCover) {
        args.push("-map", "0:v?");
        args.push("-c:v", "copy");
        args.push("-disposition:v:0", "attached_pic");
      }

      if (canEmbedCover) {
        args.push(
          "-map", "1:v?",
          "-disposition:v", "attached_pic",
          "-metadata:s:v", "title=Album cover"
        );
        if (f === "mp3") args.push("-c:v", "mjpeg");
        else if (f === "flac") args.push("-c:v", "mjpeg");
        else if (f === "m4a" || f === "mp4") args.push("-c:v", "mjpeg");
        else if (f === "ogg") args.push("-c:v", "mjpeg");
      }
      args.push("-c:a", "copy");
      if (f === "mp3") {
        args.push("-id3v2_version", "3");
        if (shouldWriteId3v1()) args.push("-write_id3v1", "1");
      }

      args.push(tmpOut);

      // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
      console.log("🏷️ FFmpeg retag args:", sanitizeLogValue(args.join(" ")));
      const p = spawnSafe(ffmpegBin, args);
      try { opts?.onProcess?.(p); } catch {}
      let err = "";
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (code) => {
        if (code === 0 && fs.existsSync(tmpOut)) return resolve();
        const tail = String(err || "").split("\n").slice(-12).join("\n");
        return reject(new Error(`retag ffmpeg error (code ${code}): ${tail}`));
      });
      p.on("error", (e) => reject(new Error(`retag spawn error: ${e.message}`)));
    });

    try { fs.renameSync(tmpOut, absOutputPath); }
    catch {
      fs.copyFileSync(tmpOut, absOutputPath);
      try { fs.unlinkSync(tmpOut); } catch {}
    }

    if (f === "mp3") {
      writeRichId3v2Tag(absOutputPath, {
        ...resolvedMeta,
        comment: getCommentText()
      });
      if (shouldWriteId3v1()) {
        rewriteId3v11Tag(absOutputPath, {
          ...resolvedMeta,
          comment: getCommentText()
        });
      }
    }

    // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
    console.log(`✅ retag ok: ${sanitizeLogValue(path.basename(absOutputPath))}`);
    return absOutputPath;
  } catch (e) {
    // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
    console.warn("⚠️ retag warning:", sanitizeLogValue(e?.message || e));
    return null;
  } finally {
    safeUnlink(tmpOut);
    for (const p of tempFilesToCleanup) {
      safeUnlink(p);
    }
  }
}

// Handles force10bit codec for hdr output in the FFmpeg media conversion pipeline.
function force10bitCodecForHdrOutput(selectedCodec, codecConfig) {
  if (!selectedCodec) return selectedCodec;
  if (selectedCodec.bitDepth === 10) return selectedCodec;

  switch (selectedCodec.encoder) {
    case "h264":
    case "x264":
    case "libx264":
      return codecConfig["h264_10bit"] || selectedCodec;
    case "hevc":
    case "h265":
      return codecConfig["h265_10bit"] || selectedCodec;
    case "av1":
      return codecConfig["av1_10bit"] || selectedCodec;
    case "vp9":
      return codecConfig["vp9_10bit"] || selectedCodec;
    default:
      return selectedCodec;
  }
}

// Converts media for the FFmpeg media conversion pipeline.
export async function convertMedia(
  inputPath,
  format,
  bitrate,
  jobId,
  progressCallback,
  metadata = {},
  coverPath = null,
  isVideo = false,
  outputDir,
  tempDir,
  opts = {}
) {
  const tempFilesToCleanup = [];
  const outputRootDir = opts?.outputRootDir
    ? path.resolve(opts.outputRootDir)
    : path.resolve(process.env.DATA_DIR || process.cwd(), "outputs");
  outputDir = assertPathWithinAny(
    path.resolve(String(outputDir || outputRootDir)),
    [outputRootDir]
  );
  const toResultDownloadPath = (absPath) =>
    toDownloadPath(absPath, outputRootDir) ||
    `/download/${encodeURIComponent(path.basename(absPath || ""))}`;
  const resolveResultDownloadPath = (downloadPath) =>
    resolveDownloadPathToAbs(downloadPath, outputRootDir);
  const ensureResultOwnership = async (mediaResult) => {
    const actualOutputPath = resolveResultDownloadPath(mediaResult?.outputPath);
    const actualLyricsPath = resolveResultDownloadPath(mediaResult?.lyricsPath);

    if (actualOutputPath) {
      await ensureOwnership(actualOutputPath);
    }
    if (actualLyricsPath) {
      await ensureOwnership(actualLyricsPath);
    }
  };
  // Handles safe unlink in the FFmpeg media conversion pipeline.
  const safeUnlink = (p) => {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  };
  const ffmpegFromOpts = opts?.ffmpegBin || null;
  const isCanceled =
  typeof opts.isCanceled === "function" ? () => !!opts.isCanceled() : () => false;

  const stereoConvert = opts?.stereoConvert || "auto";
  const preferSpotifyCover = shouldPreferSpotifyCover();
  const ringtone = isRingtoneEnabled(opts?.ringtone)
    ? { ...opts.ringtone }
    : null;
  const atempoAdjustRaw =
    (opts?.videoSettings?.audioAtempoAdjust != null)
      ? String(opts.videoSettings.audioAtempoAdjust)
      : (opts?.atempoAdjust != null)
      ? String(opts.atempoAdjust)
      : "none";
  let atempoAdjust = atempoAdjustRaw || "none";
  const bitDepth = opts?.bitDepth || null;
  const videoSettings = opts.videoSettings || {};
  const selectedStreams = opts.selectedStreams || null;
  const hdrMode = videoSettings?.hdrMode || 'auto';
  const hdrToneMapping = videoSettings?.hdrToneMapping || 'hable';
  const hdrPeakBrightness = Number(videoSettings?.hdrPeakBrightness || '1000');
  const HDR_TO_SDR_FILTERS = {
    hable:    `zscale=t=linear,format=gbrpf32le,tonemap=hable:peak=${hdrPeakBrightness}:desat=0,zscale=primaries=bt709:matrix=bt709:transfer=bt709,format=yuv420p`,
    mobius:   `zscale=t=linear,format=gbrpf32le,tonemap=mobius:peak=${hdrPeakBrightness}:desat=0,zscale=primaries=bt709:matrix=bt709:transfer=bt709,format=yuv420p`,
    reinhard: `zscale=t=linear,format=gbrpf32le,tonemap=reinhard:peak=${hdrPeakBrightness}:desat=0,zscale=primaries=bt709:matrix=bt709:transfer=bt709,format=yuv420p`
  };

  const SDR_TO_HDR_FILTER =
    `setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,` +
    `zscale=t=linear:npl=100,` +
    `format=gbrpf32le,` +
    `zscale=primaries=bt2020:transfer=smpte2084:matrix=bt2020nc:range=tv,` +
    `format=p010le`;

  let volumeGainRaw = null;
  if (opts?.volumeGain != null) {
    volumeGainRaw = opts.volumeGain;
  } else if (videoSettings?.volumeGain != null) {
    volumeGainRaw = videoSettings.volumeGain;
  } else if (metadata?.volumeGain != null) {
    volumeGainRaw = metadata.volumeGain;
  }

  let loudnormRaw = null;
  if (opts?.loudnorm != null) {
    loudnormRaw = opts.loudnorm;
  } else if (videoSettings?.loudnorm != null) {
    loudnormRaw = videoSettings.loudnorm;
  } else if (metadata?.loudnorm != null) {
    loudnormRaw = metadata.loudnorm;
  }

  let loudnormModeRaw = null;
  if (opts?.loudnormMode != null) {
    loudnormModeRaw = opts.loudnormMode;
  } else if (videoSettings?.loudnormMode != null) {
    loudnormModeRaw = videoSettings.loudnormMode;
  } else if (metadata?.loudnormMode != null) {
    loudnormModeRaw = metadata.loudnormMode;
  }

  // Handles clamp int in the FFmpeg media conversion pipeline.
  const clampInt = (v, min, max) => {
   const n = Math.round(Number(v));
   if (!Number.isFinite(n)) return null;
   return Math.min(max, Math.max(min, n));
 };

  // Handles clamp non neg int in the FFmpeg media conversion pipeline.
  const clampNonNegInt = (v, fallback = 0) => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0) return fallback;
    return n;
  };

  // Normalizes hex color for the FFmpeg media conversion pipeline.
  const normalizeHexColor = (c) => {
    const s = String(c || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
    if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s}`;
    return '#000000';
  };

  // Handles ensure vf append in the FFmpeg media conversion pipeline.
  const ensureVfAppend = (args, frag) => {
    if (!frag) return;
    const i = args.lastIndexOf("-vf");
    if (i !== -1 && typeof args[i + 1] === "string") {
      args[i + 1] = `${args[i + 1]},${frag}`;
    } else {
      args.push("-vf", frag);
    }
  };

  // Builds orientation filter for the FFmpeg media conversion pipeline.
  const buildOrientationFilter = (mode) => {
    const m = String(mode || 'auto').toLowerCase();
    if (m === '90cw') return "transpose=1";
    if (m === '90ccw') return "transpose=2";
    if (m === '180') return "transpose=2,transpose=2";
    if (m === 'hflip') return "hflip";
    if (m === 'vflip') return "vflip";
    return null;
  };

  // Builds crop edges filter for the FFmpeg media conversion pipeline.
  const buildCropEdgesFilter = (settings) => {
    if (!settings?.cropEnabled) return null;
    const L = clampNonNegInt(settings.cropLeft, 0);
    const R = clampNonNegInt(settings.cropRight, 0);
    const T = clampNonNegInt(settings.cropTop, 0);
    const B = clampNonNegInt(settings.cropBottom, 0);
    if ((L + R + T + B) <= 0) return null;
    return `crop=in_w-${L + R}:in_h-${T + B}:${L}:${T}`;
  };

  // Builds border filter for the FFmpeg media conversion pipeline.
  const buildBorderFilter = (settings, targetWidth, targetHeight) => {
    if (!settings?.borderEnabled) return null;
    const bs = clampNonNegInt(settings.borderSize, 0);
    if (!bs) return null;
    const col = normalizeHexColor(settings.borderColor);

    const tw = Number.isFinite(Number(targetWidth)) ? Number(targetWidth) : null;
    const th = Number.isFinite(Number(targetHeight)) ? Number(targetHeight) : null;

    if (tw && th) {
      return `pad=w=${tw}+${bs * 2}:h=${th}+${bs * 2}:x=${bs}:y=${bs}:color=${col}`;
    }

    return `pad=iw+${bs * 2}:ih+${bs * 2}:${bs}:${bs}:color=${col}`;
  };

  const proresProfile =
    clampInt(videoSettings?.proresProfile, 0, 5) ??
    clampInt(videoSettings?.swSettings?.proresProfile, 0, 5) ??
    2;

  const swCrf = clampInt(videoSettings?.swSettings?.quality, 16, 30);

  // Handles to even in the FFmpeg media conversion pipeline.
  const toEven = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return null;
  const xi = Math.round(x);
  return (xi % 2 === 0) ? xi : (xi - 1);
};

// Computes target height for the FFmpeg media conversion pipeline.
function computeTargetHeight({ heightMode, targetHeight, srcH, fallbackH, allowUpscale }) {
  const mode = String(heightMode || 'auto').toLowerCase();

  if (mode === 'source') {
    return { targetH: 0, reason: 'source->no-height' };
  }

  if (mode === 'custom') {
    const h0 = toEven(targetHeight);
    if (!h0) return { targetH: fallbackH, reason: 'custom-invalid->fallback' };

    if (!allowUpscale && srcH > 0 && h0 > srcH) {
      return { targetH: srcH, reason: 'custom-upscale-blocked->src' };
    }

    return { targetH: h0, reason: 'custom' };
  }

  return { targetH: 0, reason: 'auto->no-height' };
}

// Computes width for scaling for the FFmpeg media conversion pipeline.
function computeWidthForScaling({ scaleMode, targetWidth, srcW }) {
  const mode = String(scaleMode || "auto").toLowerCase();
  if (mode !== "custom" && mode !== "auto") return { widthW: null, reason: `mode=${mode}` };

  const w0 = toEven(targetWidth);
  if (!w0) return { widthW: null, reason: "no/invalid-width" };

  const MIN_W = 320;
  const MAX_W = (srcW && srcW > 0) ? srcW : 8192;
  if (w0 < MIN_W) return { widthW: null, reason: `too-small(<${MIN_W})` };
  if (w0 > MAX_W) return { widthW: null, reason: `too-large(>${MAX_W})` };

  return { widthW: w0, reason: "ok" };
}

  const volumeGain =
    volumeGainRaw != null ? Number(volumeGainRaw) : null;
  const loudnormEnabled =
    loudnormRaw === true ||
    loudnormRaw === "true" ||
    loudnormRaw === "1" ||
    loudnormRaw === 1;
  const loudnormMode = normalizeLoudnormMode(loudnormModeRaw);
  const loudnormConfig = getLoudnormModeConfig(loudnormMode);
  const hasExplicitAudioSelection = Array.isArray(selectedStreams?.audio);
  const selectedAudioStreams = Array.isArray(selectedStreams?.audio)
    ? selectedStreams.audio
    : [];
  const selectedSubtitleStreams = Array.isArray(selectedStreams?.subtitles)
    ? selectedStreams.subtitles
    : [];
    try {
    console.log("🎚 convertMedia selectedStreams:", {
      inputPath,
      format,
      isVideo,
      selectedAudioStreams,
      selectedSubtitleStreams,
      hasVideo: selectedStreams?.hasVideo
    });
  } catch {}

  const hasVideoFlag =
    typeof selectedStreams?.hasVideo === "boolean"
      ? selectedStreams.hasVideo
      : isVideo;

  const audioLanguageMap = selectedStreams?.audioLanguages || null;
  const subtitleLanguageMap = selectedStreams?.subtitleLanguages || null;

  let videoHwaccel = videoSettings.hwaccel || VIDEO_HWACCEL;

  const disableQsvInDocker = process.env.DISABLE_QSV_IN_DOCKER === "1";
  const disableVaapiInDocker = process.env.DISABLE_VAAPI_IN_DOCKER === "1";

  if (disableQsvInDocker && videoHwaccel === "qsv") {
    console.log("⚠️ Docker: QSV is disabled in Docker, falling back to NVENC");
    videoHwaccel = "nvenc";
  }

  if (disableVaapiInDocker && videoHwaccel === "vaapi") {
    console.log("⚠️ Docker: VAAPI is disabled in Docker, falling back to NVENC");
    videoHwaccel = "nvenc";
  }

  const audioCodec = videoSettings.audioTranscodeEnabled ?
                         videoSettings.audioCodec : 'aac';
  const audioBitrate = videoSettings.audioTranscodeEnabled ?
                          videoSettings.audioBitrate : '192k';
   const audioChannels = videoSettings.audioTranscodeEnabled ?
                           videoSettings.audioChannels : 'original';
  const audioSampleRate = videoSettings.audioTranscodeEnabled ?
                             videoSettings.audioSampleRate : '48000';

  if (String(audioCodec || "").toLowerCase() === "copy") {
    atempoAdjust = "none";
  }

  console.log(`🎬 Video Setting:`, { isVideo, format, videoSettings, videoHwaccel });
  console.log(`🎵 Audio Setting: Codec=${audioCodec}, Bitrate=${audioBitrate}, Transcode=${videoSettings.audioTranscodeEnabled}`);

  // Parses fps for the FFmpeg media conversion pipeline.
  const parseFps = (v) => {
     if (v == null) return null;
     const s = String(v).trim().toLowerCase();
     if (!s || s === "source" || s === "auto") return null;

     const n = Number(s);
     if (!Number.isFinite(n) || n <= 0) return null;
     return Math.max(15, Math.min(120, n));
 };

 const targetFps = parseFps(videoSettings.fps);

 console.log(`🎬 Video Settings:`, {
   isVideo,
   format,
   videoSettings,
   videoHwaccel,
   transcodeEnabled: videoSettings.transcodeEnabled,
   targetFps
 });

  // Parses sr for the FFmpeg media conversion pipeline.
  const parseSR = (v) => {
    const n = Number(String(v || "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? Math.round(n) : NaN;
  };

  const isEac3Ac3 = format === "eac3" || format === "ac3" || format === "aac" || format === "dts";
  const srOpt1 = parseSR(opts?.sampleRate);
  const srOpt2 = parseSR(opts?.sampleRateHz);
  const srEnv = parseSR(process.env.TARGET_SAMPLE_RATE);

  let SAMPLE_RATE;
  if (isEac3Ac3) {
    SAMPLE_RATE = Number.isFinite(srOpt1)
      ? srOpt1
      : Number.isFinite(srOpt2)
      ? srOpt2
      : Number.isFinite(srEnv)
      ? srEnv
      : 48000;
  } else {
    SAMPLE_RATE = Number.isFinite(srOpt1)
      ? srOpt1
      : Number.isFinite(srOpt2)
      ? srOpt2
      : Number.isFinite(srEnv)
      ? srEnv
      : 48000;
  }

  if (!Number.isFinite(SAMPLE_RATE) || SAMPLE_RATE <= 0) {
    SAMPLE_RATE = 48000;
  }

  const SAFE_SR = Math.min(192000, Math.max(8000, SAMPLE_RATE));

  const pickNearest = (target, allowed) =>
    allowed.reduce(
      (best, cur) =>
        Math.abs(cur - target) < Math.abs(best - target) ? cur : best,
      allowed[0]
    );

  // Normalizes sr for the FFmpeg media conversion pipeline.
  function normalizeSR(fmt, sr) {
    const f = String(fmt || "").toLowerCase();
    if (f === "mp3") {
      const allowed = [
        8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000
      ];
      const picked = pickNearest(sr, allowed);
      return { sr: picked, note: "mp3-legal" };
    }
    if (f === "mp4" || f === "m4r") {
      const picked = pickNearest(sr, [22050, 32000, 44100, 48000]);
      return { sr: picked, note: "aac-clamped" };
    }
    return { sr: sr, note: "as-is" };
  }

  let baseSR = SAFE_SR;
  if (
    isVideo &&
    format === "mp4" &&
    !Number.isFinite(srOpt1) &&
    !Number.isFinite(srOpt2) &&
    !Number.isFinite(srEnv)
  ) {
    baseSR = 48000;
  }

  const { sr: SR_NORM, note: SR_NOTE } = normalizeSR(format, baseSR);

  // Builds unique out for the FFmpeg media conversion pipeline.
  const buildUniqueOut = (baseName, fmt) => {
    const safeBaseName = sanitizeFilename(String(baseName || "")) || `output_${jobId}`;
    const safeFormat = String(fmt || "").trim().toLowerCase();
    if (!/^[a-z0-9]{1,10}$/.test(safeFormat)) {
      throw new Error("Invalid output format");
    }

    const makePath = (name) => {
      const candidate = path.resolve(outputDir, name);
      const rel = path.relative(outputDir, candidate);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error("Output path escapes output directory");
      }
      return candidate;
    };

    let fileName = `${safeBaseName}.${safeFormat}`;
    let outPath = makePath(fileName);
    let n = 1;
    // outPath is constructed from a sanitized basename/format and verified to remain under outputDir.
    while (fs.existsSync(outPath)) {
      fileName = `${safeBaseName} (${n++}).${safeFormat}`;
      outPath = makePath(fileName);
    }
    return { fileName, outPath };
  };

  let FINAL_SAMPLE_RATE = SR_NORM;
  if (videoSettings.audioTranscodeEnabled && audioSampleRate !== 'original') {
    const selectedSR = parseInt(audioSampleRate);
    if (Number.isFinite(selectedSR) && selectedSR > 0) {
      FINAL_SAMPLE_RATE = Math.min(192000, Math.max(8000, selectedSR));
      console.log(`🎵 Selected sample rate: ${audioSampleRate} -> ${FINAL_SAMPLE_RATE} Hz`);
    }
  } else if (audioSampleRate === 'original') {
    FINAL_SAMPLE_RATE = null;
    console.log(`🎵 Original sample rate will be preserved`);
  }

  const srSrc = Number.isFinite(srOpt1)
    ? "opt.sampleRate"
    : Number.isFinite(srOpt2)
    ? "opt.sampleRateHz"
    : Number.isFinite(srEnv)
    ? "env"
    : "default";

  // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
  const conversionLog = `🎵 Conversion → in: ${sanitizeLogValue(path.basename(
      inputPath
    ))} | fmt=${sanitizeLogValue(format)} | lyrics=${
      opts.includeLyrics !== false ? "yes" : "no"
    } | embedLyrics=${opts.embedLyrics === true ? "yes" : "no"} | video=${isVideo ? "yes" : "no"} | sr=${SAMPLE_RATE}Hz (src=${srSrc}→${SR_NORM} ${SR_NOTE}) | stereo=${stereoConvert} | atempo=${atempoAdjust} | loudnorm=${loudnormEnabled ? loudnormConfig.mode : "off"}${ringtone ? ` | ringtone=${describeRingtone(ringtone)}` : ""}`;
  console.log(conversionLog);

  const template = isVideo
    ? process.env.FILENAME_TEMPLATE_VIDEO || "%(title)s"
    : process.env.FILENAME_TEMPLATE || "%(artist|album_artist)s - %(track|title)s";

  const resolvedMeta = {
    ...metadata,
    title: cleanTitleForTags(maybeCleanTitle(metadata?.title)),
    track: cleanTitleForTags(metadata?.track),
  };
  const SRC_H = 0;
  const EFFECTIVE_H = 0;
  const VIDEO_PRESET = process.env.VIDEO_PRESET || "veryfast";

  let basename = resolveTemplate(resolvedMeta, template) || `output_${jobId}`;
  basename = refineOutputBasename(basename);
  basename = sanitizeFilename(basename);
  basename = basename.replace(/[\s_]+$/, '').replace(/\s{2,}/g, ' ').trim();
  if (ringtone) {
    basename = sanitizeFilename(`${basename} - ringtone`)
      .replace(/[\s_]+$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch {}

  let outputFileName = null;
  let outputPath = null;
  let canEmbedCover = false;
  let coverToUse = null;
  let downloadedCoverPath = null;

  const origCoverPath = coverPath;
  const metaCoverUrl = String(metadata?.coverUrl || "").trim();
  const metaLooksSpotify = looksLikeSpotifyCoverUrl(metaCoverUrl);
  let forcedSpotifyCover = false;

  if (!ringtone && !isVideo && coverPath && preferSpotifyCover && metaLooksSpotify) {
    forcedSpotifyCover = true;
    coverPath = null;
  }

  if (!ringtone && !coverPath && !isVideo) {
    try {
      downloadedCoverPath = await resolveCoverPathFromMeta(metadata, jobId, outputDir, tempDir);
      if (downloadedCoverPath) {
        coverPath = downloadedCoverPath;
        tempFilesToCleanup.push(downloadedCoverPath);
      }
    } catch {}
  }

  if (!ringtone && !isVideo && forcedSpotifyCover && !coverPath && origCoverPath) {
    coverPath = origCoverPath;
  }

  if (!ringtone && !isVideo && coverPath && ["mp3", "flac"].includes(format)) {
    try {
      coverToUse = await ensureJpegCover(coverPath, jobId, tempDir, ffmpegFromOpts);
    } catch (e) {
      // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
      console.warn("⚠️ Cover conversion warning:", sanitizeLogValue(e?.message || e));
    }
    if (coverToUse && fs.existsSync(coverToUse)) {
      canEmbedCover = true;
      if (coverToUse !== coverPath) tempFilesToCleanup.push(coverToUse);
    }
  }

  const ffmpegBin = ffmpegFromOpts || resolveFfmpegBin();
  console.log(`🧭 Using FFmpeg: ${ffmpegBin}`);
  let effectiveHwMode = "off";
  let result;

  try {
    result = await new Promise((resolve, reject) => {
    (async () => {

  const previewClip = ringtone ? null : (selectedStreams?.previewClip || null);
  // Handles timecode to seconds in the FFmpeg media conversion pipeline.
  const timecodeToSeconds = (tc) => {
    if (!tc) return NaN;
    const m = String(tc).trim().match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
    if (!m) return NaN;
    const h = Number(m[1]), mi = Number(m[2]), s = Number(m[3]);
    const frac = m[4] ? Number(`0.${m[4]}`) : 0;
    return (h * 3600) + (mi * 60) + s + (Number.isFinite(frac) ? frac : 0);
  };
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  const args = ["-hide_banner", "-nostdin", "-y"];
  const ringtoneSegment = ringtone
    ? await resolveRingtoneSegment(inputPath, ringtone, {
        ffmpegBin,
        onProcess: opts.onProcess,
        isCanceled,
        selectedStreams
      })
    : null;

  const orientationMode = String(videoSettings?.orientation || 'auto').toLowerCase();
    if (isVideo && orientationMode !== 'auto') {
      args.push("-noautorotate");
  }

  let clipDuration = null;
  if (ringtoneSegment) {
    clipDuration = clamp(Number(ringtoneSegment.durationSec || 0), 1, 600);
    if (Number(ringtoneSegment.startSec || 0) > 0) {
      args.push("-ss", String(ringtoneSegment.startSec));
    }
    console.log("🔔 Ringtone segment selected:", ringtoneSegment);
  } else if (isVideo && previewClip?.enabled) {
    const startSec = timecodeToSeconds(previewClip.start);
    const endSec   = timecodeToSeconds(previewClip.end);
    if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec) {
      clipDuration = clamp(endSec - startSec, 1, 600);
      args.push("-ss", previewClip.start);
    } else {
      console.warn("⚠️ previewClip ignored (invalid range):", previewClip);
    }
  }

  args.push("-i", inputPath);

  if (clipDuration != null) {
    args.push("-t", String(clipDuration));
  }

  const analysisInputArgs = args.slice();

    if (isCanceled()) return reject(new Error("CANCELED"));

    if (!isVideo && !canEmbedCover) {
      if (selectedAudioStreams.length > 0) {
        args.push("-map", `0:${selectedAudioStreams[0]}`);
      } else if (!hasExplicitAudioSelection) {
        args.push("-map", "0:a:0");
      }
      args.push("-vn");
    }
    if (canEmbedCover) args.push("-i", coverToUse);

    const tn = Number(resolvedMeta.track_number) || null;
    const ttot = Number(resolvedMeta.track_total) || null;
    const dn = Number(resolvedMeta.disc_number) || null;
    const dtot = Number(resolvedMeta.disc_total) || null;
    const trackTag = tn ? (ttot ? `${tn}/${ttot}` : String(tn)) : "";
    const discTag = dn ? (dtot ? `${dn}/${dtot}` : String(dn)) : "";
    const dateTag =
      resolvedMeta.release_date &&
      /^\d{4}(-\d{2}(-\d{2})?)?$/.test(resolvedMeta.release_date)
        ? resolvedMeta.release_date
        : resolvedMeta.release_year || resolvedMeta.upload_date || "";

    const metaPairs = {
      title: resolvedMeta.track || resolvedMeta.title || "",
      artist: resolvedMeta.artist || "",
      album: resolvedMeta.album || resolvedMeta.playlist_title || "",
      date: dateTag || "",
      track: trackTag || "",
      disc: discTag || "",
      genre: resolvedMeta.genre || ""
    };

    if (resolvedMeta.album_artist) metaPairs.album_artist = resolvedMeta.album_artist;

    const labelLike = resolvedMeta.label || resolvedMeta.publisher;
    if (labelLike) metaPairs.publisher = labelLike;

    if (resolvedMeta.copyright) metaPairs.copyright = resolvedMeta.copyright;
    if (resolvedMeta.playlist_index) metaPairs.playlist_index = String(resolvedMeta.playlist_index);
    if (resolvedMeta.playlist_total) metaPairs.playlist_total = String(resolvedMeta.playlist_total);

    args.push("-map_metadata", "-1");

    for (const [k, v] of Object.entries(metaPairs)) {
      if (v) args.push("-metadata", `${k}=${v}`);
    }

    const commentText = getCommentText();
    if (format !== "mp3") appendCommentMetadata(args, format, commentText);

    if (resolvedMeta.isrc) args.push("-metadata", `ISRC=${resolvedMeta.isrc}`);

    if (!isVideo && (format === "flac" || format === "ogg")) {
      if (resolvedMeta.album_artist)
        args.push("-metadata", `ALBUMARTIST=${resolvedMeta.album_artist}`);
      const composer = pickComposerText(resolvedMeta);
      if (composer) {
        args.push("-metadata", `composer=${composer}`);
        args.push("-metadata", `COMPOSER=${composer}`);
      }
      if (labelLike) {
        args.push("-metadata", `LABEL=${labelLike}`);
        args.push("-metadata", `PUBLISHER=${labelLike}`);
      }
      if (resolvedMeta.webpage_url)
        args.push("-metadata", `URL=${resolvedMeta.webpage_url}`);
      if (resolvedMeta.genre) args.push("-metadata", `GENRE=${resolvedMeta.genre}`);
      if (resolvedMeta.copyright)
        args.push("-metadata", `COPYRIGHT=${resolvedMeta.copyright}`);
    }

    if (!isVideo && format === "mp3") {
      if (resolvedMeta.album_artist)
        args.push("-metadata", `ALBUMARTIST=${resolvedMeta.album_artist}`);
      const composer = pickComposerText(resolvedMeta);
      if (composer) args.push("-metadata", `composer=${composer}`);
      if (resolvedMeta.genre) args.push("-metadata", `genre=${resolvedMeta.genre}`);
      if (resolvedMeta.copyright)
        args.push("-metadata", `copyright=${resolvedMeta.copyright}`);
      if (resolvedMeta.webpage_url)
        args.push("-metadata", `URL=${resolvedMeta.webpage_url}`);

      const cmt = getCommentText();
      appendCommentMetadata(args, format, cmt);
    }

    if (canEmbedCover) {
      if (selectedAudioStreams.length > 0) {
        args.push("-map", `0:${selectedAudioStreams[0]}`);
      } else if (!hasExplicitAudioSelection) {
        args.push("-map", "0:a");
      }

      args.push(
        "-map",
        "1:v?",
        "-disposition:v",
        "attached_pic",
        "-metadata:s:v",
        "title=Album cover"
      );
      if (format === "mp3") args.push("-c:v", "mjpeg", "-id3v2_version", "3");
      else if (format === "flac") args.push("-c:v", "mjpeg");
    }

    if (!isVideo && format === "mp3") {
      args.push("-id3v2_version", "3");
      if (shouldWriteId3v1()) args.push("-write_id3v1", "1");
    }

    if (isVideo) {
      if (hasVideoFlag) {
    args.push("-map", "0:v:0?");
  } else {
    args.push("-vn");
  }

  if (selectedAudioStreams.length > 0) {
    selectedAudioStreams.forEach((aIdx) => {
      if (Number.isInteger(aIdx) && aIdx >= 0) {
        args.push("-map", `0:${aIdx}`);
      }
    });
  } else if (!hasExplicitAudioSelection) {
    args.push("-map", "0:a:0?");
  } else {
    args.push("-an");
  }

  if (selectedSubtitleStreams.length > 0) {
      selectedSubtitleStreams.forEach((sIdx, i) => {
        if (Number.isInteger(sIdx) && sIdx >= 0) {
          args.push("-map", `0:${sIdx}`);
        }
        if (i === 0) {
          args.push("-disposition:s:0", "default");
        }
      });

      if (format === "mp4") {
        console.log("🎬 Subtitles will be written as mov_text in MP4 output");
        args.push("-c:s", "mov_text");
      } else {
        args.push("-c:s", "copy");
      }
    }

  if (selectedStreams) {
    if (Array.isArray(selectedAudioStreams) && audioLanguageMap) {
      let outAudioIndex = 0;
      if (selectedAudioStreams.length > 0) {
        for (const srcIdx of selectedAudioStreams) {
          const lang = audioLanguageMap[srcIdx];
          if (lang && lang !== "und") {
            const normLang = String(lang).trim().toLowerCase().slice(0, 3);
            if (normLang) {
              args.push(`-metadata:s:a:${outAudioIndex}`, `language=${normLang}`);
              }
            }
            outAudioIndex++;
          }
        } else {
      }
    }

    const includeSubtitleMeta =
      Array.isArray(selectedSubtitleStreams) &&
      subtitleLanguageMap;

    if (includeSubtitleMeta) {
      let outSubIndex = 0;
      if (selectedSubtitleStreams.length > 0) {
        for (const srcIdx of selectedSubtitleStreams) {
          const lang = subtitleLanguageMap[srcIdx];
          if (lang && lang !== "und") {
            const normLang = String(lang).trim().toLowerCase().slice(0, 3);
            if (normLang) {
              args.push(`-metadata:s:s:${outSubIndex}`, `language=${normLang}`);
            }
          }
          outSubIndex++;
        }
      }
    }
  }

  if (format === "mp4" || format === "mkv" || format === "mov" || format === "webm") {
    console.log(`🎬 Video transcode: ${videoSettings.transcodeEnabled ? 'ON' : 'OFF'}`);
    const br = (bitrate || "").toString().trim();
    const isVidMb = /^[0-9]+(\.[0-9]+)?m$/i.test(br);
    const isVidKb = /^[0-9]+k$/i.test(br);

    let srcInfo = null;
    try {
      const { probeVideoStreamInfo } = await import("./ffmpegCaps.js");
      srcInfo = await probeVideoStreamInfo(ffmpegBin, inputPath, 15000);
    } catch (e) {
      // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
      console.warn("⚠️ probeVideoStreamInfo failed:", sanitizeLogValue(e?.message || e));
      srcInfo = null;
    }

    const SRC_W = Number(srcInfo?.width) || Number(resolvedMeta.__srcWidth) || 0;
    const SRC_H = Number(srcInfo?.height) || Number(resolvedMeta.__srcHeight) || 0;
    const ct = String(
    srcInfo?.color_transfer ||
    srcInfo?.color_trc ||
    srcInfo?.transfer_characteristics ||
    ""
  ).toLowerCase();
  const prim = String(srcInfo?.color_primaries || "").toLowerCase();
  const csp  = String(srcInfo?.color_space || srcInfo?.colorspace || "").toLowerCase();

  const srcIsHdr = !!srcInfo && (
    ct.includes("2084") ||
    ct.includes("b67")  ||
    prim.includes("2020") ||
    csp.includes("2020") ||
    !!srcInfo?.mastering_display ||
    !!srcInfo?.content_light_level
  );

  const forceTonemap = hdrMode === "tonemap_to_sdr";
  const forceKeepHdr = hdrMode === "keep_hdr";
  const forceNoneHdr = hdrMode === "none";
  const forceSdrToHdr = hdrMode === "sdr_to_hdr";

  // Handles target is sdr fn in the FFmpeg media conversion pipeline.
  const targetIsSdrFn = () => {
    if (forceTonemap) return true;
    if (forceKeepHdr) return false;
    if (forceSdrToHdr) return false;
    if (forceNoneHdr)  return true;
    if (!srcIsHdr) return true;

  const wants10bit = String(videoSettings.videoCodec || "auto")
    .toLowerCase()
    .includes("10bit");
  return !wants10bit;
  };

  const targetIsSdr = targetIsSdrFn();
  const shouldTonemap  = !forceNoneHdr && targetIsSdr && (srcIsHdr || forceTonemap);
  const shouldKeepHdr  = !forceNoneHdr && !forceSdrToHdr && !targetIsSdr && (srcIsHdr || forceKeepHdr);
  const shouldSdrToHdr = !forceNoneHdr && forceSdrToHdr;

  if (forceTonemap && !srcIsHdr) {
    console.log("⚠️ hdrMode=tonemap_to_sdr selected but HDR not detected → forcing tonemap filters.");
  }

  if (forceSdrToHdr && srcIsHdr) {
    console.log("ℹ️ hdrMode=sdr_to_hdr selected but source looks HDR already → will still re-tag/convert to PQ/BT2020.");
  }

    resolvedMeta.__srcWidth = SRC_W;
    resolvedMeta.__srcHeight = SRC_H;

    let autoHeight = 0;
    if (!autoHeight && br) {
        const m = br.match(/(\d{3,4})p/i);
        if (m) autoHeight = parseInt(m[1], 10) || 0;
    }
    if (!autoHeight) autoHeight = 1080;

    const allowUpscale = videoSettings.allowUpscale === true;
    const { targetH: targetHeight, reason: heightReason } = computeTargetHeight({
        heightMode: videoSettings.heightMode,
        targetHeight: videoSettings.targetHeight,
        srcH: SRC_H,
        fallbackH: autoHeight,
        allowUpscale
    });

    const keepOriginal = String(videoSettings.heightMode || "auto").toLowerCase() === "source";
    const { widthW, reason: widthReason } = keepOriginal
      ? { widthW: null, reason: "keep-original" }
      : computeWidthForScaling({
          scaleMode: videoSettings.scaleMode,
          targetWidth: videoSettings.targetWidth,
          srcW: SRC_W
        });

    console.log("📐 scale decision:", {
      scaleMode: videoSettings.scaleMode,
      targetWidth: videoSettings.targetWidth,
      widthW,
      widthReason,
      targetHeight,
      heightReason,
      srcW: SRC_W,
      srcH: SRC_H
    });

    const codecPref = String(videoSettings.videoCodec || "auto").toLowerCase();

    let hwMode = String(videoHwaccel || "off").toLowerCase();

    const resizeMode = String(videoSettings?.resizeMode || "scale").toLowerCase();
    const cropEdgesFilter = buildCropEdgesFilter(videoSettings);
    const orientFilter = buildOrientationFilter(videoSettings?.orientation);

    const evenizeFilter = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

    const colorRange = String(videoSettings.colorRange || "auto").toLowerCase();
    const colorPrim  = String(videoSettings.colorPrimaries || "auto").toLowerCase();

    let colorMetaPushed = false;

    // Handles map color range in the FFmpeg media conversion pipeline.
    function mapColorRange(v) {
      if (v === "tv" || v === "limited") return "tv";
      if (v === "pc" || v === "full") return "pc";
      return null;
    }

    // Normalizes prim for the FFmpeg media conversion pipeline.
    function normalizePrim(p) {
      return String(p || "").trim().toLowerCase();
    }

    // Handles decide sdr color meta in the FFmpeg media conversion pipeline.
    function decideSdrColorMeta(prim) {
      if (prim === "bt2020") {
        return { primaries: "bt2020", trc: "bt2020-10", colorspace: "bt2020nc" };
      }
      if (prim === "bt709") {
        return { primaries: "bt709", trc: "bt709", colorspace: "bt709" };
      }
      return { primaries: prim, trc: null, colorspace: null };
    }

    // Handles push color metadata in the FFmpeg media conversion pipeline.
    const pushColorMetadata = () => {
      if (colorMetaPushed) return;
      colorMetaPushed = true;

      const cr = mapColorRange(colorRange);
      if (cr) args.push("-color_range", cr);

      const prim = normalizePrim(colorPrim);
      if (!prim || prim === "auto") return;

      const m = decideSdrColorMeta(prim);
      if (m.primaries)  args.push("-color_primaries", m.primaries);
      if (m.trc)        args.push("-color_trc", m.trc);
      if (m.colorspace) args.push("-colorspace", m.colorspace);
      if (srcIsHdr && targetIsSdrFn()) {
        args.push("-color_primaries", "bt709");
        args.push("-color_trc", "bt709");
        args.push("-colorspace", "bt709");
        } else if (srcIsHdr && hdrMode === 'keep_hdr') {
          if (srcInfo?.color_primaries) args.push("-color_primaries", srcInfo.color_primaries);
          if (srcInfo?.color_transfer) args.push("-color_trc", srcInfo.color_transfer);
          if (srcInfo?.color_space) args.push("-colorspace", srcInfo.color_space);
          if (srcInfo?.mastering_display) {
            args.push("-mastering_display", srcInfo.mastering_display);
          }
          if (srcInfo?.content_light_level) {
            args.push("-content_light_level", srcInfo.content_light_level);
        }
      }
    };

    // Builds set params for the FFmpeg media conversion pipeline.
    function buildSetParams() {
      const prim = normalizePrim(colorPrim);
      if (!prim || prim === "auto") return null;

      const m = decideSdrColorMeta(prim);
      const parts = [];
      const cr = mapColorRange(colorRange);
      if (cr) parts.push(`range=${cr}`);

      if (m.primaries)  parts.push(`color_primaries=${m.primaries}`);
      if (m.trc)        parts.push(`color_trc=${m.trc}`);
      if (m.colorspace) parts.push(`colorspace=${m.colorspace}`);

      return parts.length ? `setparams=${parts.join(":")}` : null;
    }

    // Builds resize filter for the FFmpeg media conversion pipeline.
    function buildResizeFilter({ widthW, targetHeight, resizeMode, borderColor }) {
      const w = Number.isFinite(Number(widthW)) ? Number(widthW) : null;
      const h = Number.isFinite(Number(targetHeight)) ? Number(targetHeight) : 0;
      const col = normalizeHexColor(borderColor);

      if ((resizeMode === "crop" || resizeMode === "pad") && w && h > 0) {
        if (resizeMode === "crop") {
          return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
        }
        return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${col}`;
      }

      const needScale = (widthW != null) || (targetHeight > 0);
      if (!needScale) return null;
      const wExpr = (widthW != null) ? widthW : -2;
      const hExpr = (targetHeight > 0) ? targetHeight : -2;
      return `scale=${wExpr}:${hExpr}`;
    }

  // Builds base vf for the FFmpeg media conversion pipeline.
  function buildBaseVf(selectedCodecLocal) {
      const chain = [];

      const sp = buildSetParams();
      if (sp) chain.push(sp);

      if (shouldSdrToHdr) {
        chain.push(SDR_TO_HDR_FILTER);
      }

      if (shouldTonemap) {
        const tm = String(hdrToneMapping || "hable").toLowerCase();
        const filter = HDR_TO_SDR_FILTERS[tm] || HDR_TO_SDR_FILTERS.hable;
        chain.push(filter);
      } else if (shouldKeepHdr) {
        const bitDepth = selectedCodecLocal?.bitDepth || 8;
        if (bitDepth === 10) {
          chain.push("format=p010le");
        }
      }

      if (orientFilter) chain.push(orientFilter);
      if (cropEdgesFilter) chain.push(cropEdgesFilter);

      const colForPad = normalizeHexColor(videoSettings?.borderColor);
      const resizeFrag = buildResizeFilter({
        widthW,
        targetHeight,
        resizeMode,
        borderColor: colForPad
      });
      if (resizeFrag) chain.push(resizeFrag);

      const borderFilterNew = buildBorderFilter(
        videoSettings,
        widthW || null,
        (targetHeight > 0) ? targetHeight : null
      );
      if (borderFilterNew) chain.push(borderFilterNew);

      if (targetFps) chain.push(`fps=${targetFps}`);
      chain.push(evenizeFilter);

      return chain.length ? chain.join(",") : null;
    }

      const codecConfig = {
        'auto': {
            name: 'H.264',
            bitDepth: 8,
            encoder: 'h264',
            format: 'mp4'
        },
        'h264': {
            name: 'H.264 8-bit',
            bitDepth: 8,
            encoder: 'h264',
            format: 'mp4'
        },
        'h264_10bit': {
            name: 'H.264 10-bit',
            bitDepth: 10,
            encoder: 'h264_10bit',
            format: 'mp4'
        },
        'h265': {
            name: 'H.265/HEVC 8-bit',
            bitDepth: 8,
            encoder: 'hevc',
            format: 'mp4'
        },
        'h265_10bit': {
            name: 'H.265/HEVC 10-bit',
            bitDepth: 10,
            encoder: 'hevc_10bit',
            format: 'mp4'
        },
        'av1': {
            name: 'AV1 8-bit',
            bitDepth: 8,
            encoder: 'av1',
            format: 'mp4'
        },
        'av1_10bit': {
            name: 'AV1 10-bit',
            bitDepth: 10,
            encoder: 'av1_10bit',
            format: 'mp4'
        },
        'vp9': {
            name: 'VP9 8-bit',
            bitDepth: 8,
            encoder: 'vp9',
            format: 'webm'
        },
        'vp9_10bit': {
            name: 'VP9 10-bit',
            bitDepth: 10,
            encoder: 'vp9_10bit',
            format: 'webm'
        },
        'x264': {
            name: 'x264 (CPU)',
            bitDepth: 8,
            encoder: 'libx264',
            format: 'mp4'
        },
        'prores': {
            name: 'Apple ProRes 422',
            bitDepth: 10,
            encoder: 'prores',
            format: 'mov'
        },
        'copy': {
            name: 'Orijinal Codec',
            bitDepth: null,
            encoder: 'copy',
            format: null
        }
    };

    let selectedCodec = codecConfig[codecPref] || codecConfig["auto"];
    console.log(`🎬 Selected codec: ${selectedCodec.name} (${selectedCodec.encoder})`);
    const userExplicitContainer = !!format && format !== "auto";

    if (shouldSdrToHdr) {
      const before = selectedCodec;
      if (selectedCodec.encoder === "copy") {
        selectedCodec = codecConfig["h265_10bit"] || codecConfig["h264_10bit"] || selectedCodec;
      } else {
        selectedCodec = force10bitCodecForHdrOutput(selectedCodec, codecConfig);
      }
      if (before !== selectedCodec) {
        // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
        console.log(`🔁 SDR→HDR: forcing 10-bit codec: ${sanitizeLogValue(before.name)} -> ${sanitizeLogValue(selectedCodec.name)}`);
      }
    }

    if (!userExplicitContainer && selectedCodec.format && selectedCodec.format !== format) {
      const oldFmt = format;
      format = selectedCodec.format;
      // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
      console.log(`📦 Container changed: ${sanitizeLogValue(oldFmt)} -> ${sanitizeLogValue(format)}`);
    }

    if (shouldTonemap && selectedCodec.bitDepth === 10) {
      console.log("⚠️ HDR→SDR tonemap active: forcing 8-bit output codec to avoid 10-bit pix_fmt mismatches.");
      selectedCodec = force8bitCodecIfTonemapping(selectedCodec, codecConfig);
    }

    if (!outputPath || !outputFileName) {
      const built = buildUniqueOut(basename, format);
      outputFileName = built.fileName;
      outputPath = built.outPath;
    } else {
      if (!outputPath.endsWith(`.${format}`)) {
        const built = buildUniqueOut(basename, format);
        outputFileName = built.fileName;
        outputPath = built.outPath;
      }
    }

    let caps = null;
    try {
      caps = await getFfmpegCaps(ffmpegBin);
    } catch (e) {
      console.warn("⚠️ getFfmpegCaps failed:", e?.message || e);
      caps = null;
    }

    const capOk = (k) => !!(caps && caps[k] && caps[k].ok);
    const summarizeRuntimeProbeDetail = (detail) => {
      const lines = String(detail || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (!lines.length) return "";

      const preferredPatterns = [
        /Driver does not support the required nvenc API version/i,
        /minimum required Nvidia driver/i,
        /required nvenc API/i,
        /NVENC API/i,
        /nvEncOpenEncodeSessionEx/i,
        /libnvidia-encode/i,
        /Cannot load libcuda/i,
        /cuInit/i,
        /CUDA_ERROR/i,
        /Device creation failed/i,
        /No capable devices/i,
        /Permission denied/i,
        /Operation not permitted/i,
        /Could not open encoder/i,
        /Error while opening encoder/i
      ];

      for (const pattern of preferredPatterns) {
        const match = lines.find((line) => pattern.test(line));
        if (match) return match;
      }

      return lines[lines.length - 1];
    };
    const wantsAv1 = selectedCodec.encoder === "av1" || selectedCodec.encoder === "av1_10bit";
    const wants10  = selectedCodec.encoder.endsWith("_10bit");

    if (hwMode === "nvenc" && wantsAv1) {
      const needKey = wants10 ? "av1_nvenc_10bit" : "av1_nvenc";
      if (!capOk(needKey)) {
        if (capOk("libsvtav1")) {
          console.log(`⚠️ ${needKey} unsupported → fallback: software libsvtav1 (keep AV1).`);
          hwMode = "off";
        } else {
          console.log(`⚠️ ${needKey} unsupported and no libsvtav1 → fallback: HEVC NVENC.`);
          selectedCodec = wants10 ? codecConfig["h265_10bit"] : codecConfig["h265"];
        }
      }
    }

    if (hwMode === "nvenc" && selectedCodec.encoder === "h264_10bit" && !capOk("h264_nvenc_10bit")) {
      console.log("⚠️ h264_nvenc 10-bit unsupported → fallback: h264 8-bit.");
      selectedCodec = codecConfig["h264"];
    }

    if (hwMode === "nvenc" && selectedCodec.encoder === "hevc_10bit" && !capOk("hevc_nvenc_10bit")) {
      console.log("⚠️ hevc_nvenc 10-bit unsupported → fallback: hevc 8-bit.");
      selectedCodec = codecConfig["h265"];
    }

    const requiredNvencCapKey =
      hwMode === "nvenc" ? getRequiredNvencCapKey(selectedCodec.encoder) : null;
    if (requiredNvencCapKey && !capOk(requiredNvencCapKey)) {
      const capDetail = summarizeRuntimeProbeDetail(caps?.[requiredNvencCapKey]?.detail);

      console.log(
        `⚠️ ${requiredNvencCapKey} runtime probe failed${
          capDetail ? `: ${capDetail}` : ""
        } → fallback: software encoder.`
      );
      hwMode = "off";
    }

    const useNvenc = hwMode === "nvenc";
    const useQsv   = hwMode === "qsv";
    const useVaapi = hwMode === "vaapi";
    effectiveHwMode = useNvenc ? "nvenc" : useQsv ? "qsv" : useVaapi ? "vaapi" : "off";
    const baseVf = buildBaseVf(selectedCodec);

    // Handles qsv pix fmt for in the FFmpeg media conversion pipeline.
    const qsvPixFmtFor = (enc, bitDepth) => {
      if (bitDepth === 10 || String(enc || "").includes("10bit") || String(enc || "").endsWith("_10bit")) return "p010le";
      return "nv12";
    };

    // Normalizes qsv profile for the FFmpeg media conversion pipeline.
    const normalizeQsvProfile = (enc, rawProfile) => {
      const p = String(rawProfile || "").trim().toLowerCase();
      if (enc === "hevc" || enc === "hevc_10bit") {
        if (enc === "hevc_10bit") return "main10";
        return (p === "main10") ? "main10" : "main";
      }
      if (["baseline", "main", "high"].includes(p)) return p;
      return "high";
    };

    let explicitBv = null;
    if (isVidMb || isVidKb) {
        explicitBv = isVidMb ? br.replace(/m$/i, "M") : br;
    }

    let pixFmtAlreadySet = false;
    // Handles push pix fmt in the FFmpeg media conversion pipeline.
    const pushPixFmt = (fmt) => {
      if (!fmt) return;
      if (pixFmtAlreadySet) return;
      args.push("-pix_fmt", fmt);
      pixFmtAlreadySet = true;
    };

    let vf = (!useVaapi && baseVf) ? baseVf : null;

    if (vf && useQsv && selectedCodec.encoder !== "copy") {
      const qsvPixFmt = (selectedCodec.bitDepth === 10) ? "p010le" : "nv12";
      vf = `${vf},format=${qsvPixFmt}`;
    }

    if (vf) args.push("-vf", vf);

    if (shouldTonemap) {
      args.push("-color_primaries", "bt709");
      args.push("-color_trc", "bt709");
      args.push("-colorspace", "bt709");
      const cr = mapColorRange(colorRange);
      if (cr) args.push("-color_range", cr);
      } else if (shouldSdrToHdr) {
      args.push("-color_primaries", "bt2020");
      args.push("-color_trc", "smpte2084");
      args.push("-colorspace", "bt2020nc");
      const cr = mapColorRange(colorRange);
      if (cr) args.push("-color_range", cr);

    } else if (shouldKeepHdr) {
      if (srcInfo?.color_primaries) args.push("-color_primaries", srcInfo.color_primaries);
      if (srcInfo?.color_transfer)  args.push("-color_trc", srcInfo.color_transfer);
      if (srcInfo?.color_space)     args.push("-colorspace", srcInfo.color_space);
      const cr = mapColorRange(colorRange);
      if (cr) args.push("-color_range", cr);
      if (srcInfo?.mastering_display)    args.push("-mastering_display", srcInfo.mastering_display);
      if (srcInfo?.content_light_level)  args.push("-content_light_level", srcInfo.content_light_level);
    }

    if (useNvenc) {
    const nvencPreset = videoSettings.nvencSettings?.preset || NVENC_PRESET;
    const nvencQuality = videoSettings.nvencSettings?.quality || NVENC_Q;
    const nvencTune = videoSettings.nvencSettings?.tune || null;
    const nvencProfileRaw = videoSettings.nvencSettings?.profile || 'high';
    const nvencLevel = videoSettings.nvencSettings?.level || null;
    const validNvencTunes = ['hq', 'll', 'ull', 'lossless'];
    const nvencProfile = normalizeNvencProfileForEncoder(selectedCodec.encoder, nvencProfileRaw);

    let finalNvencTune = null;
    if (nvencTune) {
      if (validNvencTunes.includes(nvencTune)) {
        finalNvencTune = nvencTune;
      } else {
        const tuneMap = {
          'film': 'hq',
          'animation': 'hq',
          'grain': 'hq',
          'fastdecode': 'll',
          'zerolatency': 'll',
          'psnr': 'hq',
          'ssim': 'hq'
        };
        finalNvencTune = tuneMap[nvencTune] || 'hq';
        console.log(`🔄 NVENC tune conversion: ${nvencTune} -> ${finalNvencTune}`);
      }
    }

  switch (selectedCodec.encoder) {
    case "h264":
          args.push("-c:v", "h264_nvenc");
          pushPixFmt("yuv420p");
          args.push("-profile:v", nvencProfile);
          if (nvencLevel && nvencLevel !== 'auto') args.push("-level:v", nvencLevel);
          break;

    case 'x264':
    case 'libx264':
      args.push("-c:v", "h264_nvenc");
      pushPixFmt("yuv420p");
      args.push("-profile:v", nvencProfile);
      if (nvencLevel && nvencLevel !== 'auto') {
        args.push("-level:v", nvencLevel);
      }
      break;

    case "h264_10bit":
      args.push("-c:v", "h264_nvenc"); pushPixFmt("p010le");
      if (nvencProfile && nvencProfile !== 'high') {
        args.push("-profile:v", nvencProfile);
      }
      if (nvencLevel && nvencLevel !== 'auto') {
        args.push("-level:v", nvencLevel);
      }
      break;

    case "hevc":
      args.push("-c:v", "hevc_nvenc");
      if (nvencProfile) args.push("-profile:v", nvencProfile);
      if (nvencLevel && nvencLevel !== 'auto') {
        args.push("-level:v", nvencLevel);
      }
      break;

    case "hevc_10bit":
      args.push("-c:v", "hevc_nvenc"); pushPixFmt("p010le");
      if (nvencProfile) args.push("-profile:v", nvencProfile);
      if (nvencLevel && nvencLevel !== 'auto') {
        args.push("-level:v", nvencLevel);
      }
      break;

    case "av1":
      args.push("-c:v", "av1_nvenc");
      if (nvencProfile && nvencProfile !== 'main') {
        args.push("-profile:v", nvencProfile);
      }
      if (nvencLevel && nvencLevel !== 'auto') {
        args.push("-level:v", nvencLevel);
      }
      break;

    case "av1_10bit":
      args.push("-c:v", "av1_nvenc"); pushPixFmt("p010le");
      if (nvencProfile && nvencProfile !== 'main') {
        args.push("-profile:v", nvencProfile);
      }
      if (nvencLevel && nvencLevel !== 'auto') {
        args.push("-level:v", nvencLevel);
      }
      break;

    default:
      args.push("-c:v", "h264_nvenc");
      pushPixFmt("yuv420p");
      args.push("-profile:v", nvencProfile);
      if (nvencLevel && nvencLevel !== 'auto') {
        args.push("-level:v", nvencLevel);
      }
      break;
  }

    const rawNvencPreset = videoSettings.nvencSettings?.preset || NVENC_PRESET;
    const rawNvencQuality = videoSettings.nvencSettings?.quality || NVENC_Q;
    const { preset: nvPreset, tune: legacyTune } = normalizeNvencPresetAndTune(rawNvencPreset);
    const effectiveTune = finalNvencTune || legacyTune;

    args.push("-preset", nvPreset);
    if (effectiveTune) {
      if (validNvencTunes.includes(effectiveTune)) {
        args.push("-tune", effectiveTune);
      } else {
        console.log(`⚠️ Skipping invalid NVENC tune: ${effectiveTune}`);
      }
    }

    args.push("-rc:v", "vbr");
      if (selectedCodec.encoder === "h264") {
        const prim = normalizePrim(colorPrim);
        if (prim === "bt2020" && !shouldTonemap) {
          const full = (mapColorRange(colorRange) === "pc") ? 1 : 0;
          args.push(
            "-bsf:v",
            `h264_metadata=colour_primaries=9:transfer_characteristics=14:matrix_coefficients=9:video_full_range_flag=${full}`
          );
        }
      }

      if (explicitBv) {
        args.push("-b:v", explicitBv, "-maxrate", explicitBv, "-bufsize", `${explicitBv}*2`);
      } else {
        args.push("-cq:v", nvencQuality);
      }
    }
      else if (useQsv) {
      const qsvPreset = videoSettings.qsvSettings?.preset || QSV_PRESET;
      const qsvQuality = videoSettings.qsvSettings?.quality || QSV_Q;
      const qsvTune = videoSettings.qsvSettings?.tune || null;
      const qsvProfileRaw = videoSettings.qsvSettings?.profile || 'high';
      const qsvLevel = videoSettings.qsvSettings?.level || null;
      const qsvEnc = selectedCodec.encoder;
      const qsvProfile = normalizeQsvProfile(qsvEnc, qsvProfileRaw);
      const qsvPixFmt = qsvPixFmtFor(qsvEnc, selectedCodec.bitDepth || 8);
      const qsvPresetNorm = normalizeSwPreset(qsvPreset);
      let canUseQsvPresetFlag = false;

      switch(selectedCodec.encoder) {
        case 'h264':
          args.push("-c:v", "h264_qsv");
          args.push("-pix_fmt", qsvPixFmt);
          args.push("-profile:v", qsvProfile);
          canUseQsvPresetFlag = true;
          if (qsvLevel && qsvLevel !== 'auto') {
            args.push("-level:v", qsvLevel);
          }
          break;
        case 'h264_10bit':
          args.push("-c:v", "h264_qsv", "-pix_fmt", qsvPixFmt);
          args.push("-profile:v", qsvProfile);
          canUseQsvPresetFlag = true;
          if (qsvLevel && qsvLevel !== 'auto') {
            args.push("-level:v", qsvLevel);
          }
          break;
        case 'hevc':
          args.push("-c:v", "hevc_qsv");
          args.push("-pix_fmt", qsvPixFmt);
          args.push("-profile:v", qsvProfile);
          canUseQsvPresetFlag = true;
          if (qsvLevel && qsvLevel !== 'auto') {
            args.push("-level:v", qsvLevel);
          }
          break;
        case 'hevc_10bit':
          args.push("-c:v", "hevc_qsv", "-pix_fmt", qsvPixFmt);
          args.push("-profile:v", qsvProfile);
          canUseQsvPresetFlag = true;
          if (qsvLevel && qsvLevel !== 'auto') {
            args.push("-level:v", qsvLevel);
          }
          break;
        case "av1":
          if (capOk("libsvtav1")) {
            const svtP = presetToSvtPreset(qsvPresetNorm);
            args.push("-c:v", "libsvtav1", "-preset", String(svtP));
          } else {
            const cpuUsed = presetToAomCpuUsed(qsvPresetNorm);
            args.push("-c:v", "libaom-av1", "-cpu-used", String(cpuUsed), "-row-mt", "1");
          }
          break;
        case "av1_10bit":
          if (capOk("libsvtav1")) {
            const svtP = presetToSvtPreset(qsvPresetNorm);
            args.push("-c:v", "libsvtav1", "-preset", String(svtP), "-pix_fmt", "yuv420p10le");
          } else {
            const cpuUsed = presetToAomCpuUsed(qsvPresetNorm);
            args.push("-c:v", "libaom-av1", "-cpu-used", String(cpuUsed), "-row-mt", "1", "-pix_fmt", "yuv420p10le");
          }
          break;
        default:
          args.push("-c:v", "h264_qsv");
          args.push("-pix_fmt", qsvPixFmt);
          args.push("-profile:v", qsvProfile);
          canUseQsvPresetFlag = true;
          if (qsvLevel && qsvLevel !== 'auto') {
            args.push("-level:v", qsvLevel);
          }
      }

      if (canUseQsvPresetFlag) {
        args.push("-preset", qsvPresetNorm);
      }

      if (qsvTune) {
        console.log(`⚠️ QSV: ignoring tune=${qsvTune} (not supported reliably)`);
      }

      if (explicitBv) {
        args.push("-b:v", explicitBv);
      } else {
        args.push("-global_quality", qsvQuality, "-rc_mode", "vbr");
      }
    }
    else if (useVaapi) {
      const vaapiDevice = videoSettings.vaapiSettings?.device || VAAPI_DEVICE;
      const vaapiQuality = videoSettings.vaapiSettings?.quality || VAAPI_QUALITY;
      const vaapiTune = videoSettings.vaapiSettings?.tune || null;
      const vaapiProfile = videoSettings.vaapiSettings?.profile || 'high';
      const vaapiLevel = videoSettings.vaapiSettings?.level || null;
      const pre = [];
      const sp = buildSetParams();
      if (sp) pre.push(sp);
      if (shouldTonemap) {
        const tm = String(hdrToneMapping || "hable").toLowerCase();
        const filter = HDR_TO_SDR_FILTERS[tm] || HDR_TO_SDR_FILTERS.hable;
        pre.push(filter);
      } else if (shouldKeepHdr) {
        if ((selectedCodec.bitDepth || 8) === 10) {
          pre.push("format=p010le");
        }
      }
      if (orientFilter) pre.push(orientFilter);
      if (cropEdgesFilter) pre.push(cropEdgesFilter);

      const col = normalizeHexColor(videoSettings?.borderColor);
      const wantBorder = !!videoSettings?.borderEnabled;
      const keepOriginal = String(videoSettings.heightMode || "auto").toLowerCase() === "source";
      const needScale = !keepOriginal && ((widthW != null) || (targetHeight > 0));
      const needCpuResize =
        (resizeMode === "crop" || resizeMode === "pad") ||
        (resizeMode === "scale" && wantBorder);

      if (needCpuResize) {
        const cpuResize = buildResizeFilter({
          widthW,
          targetHeight,
          resizeMode: (resizeMode === "scale") ? "scale" : resizeMode,
          borderColor: col
        });
        if (cpuResize) pre.push(cpuResize);

        const borderFrag = buildBorderFilter(
          videoSettings,
          widthW || null,
          (targetHeight > 0) ? targetHeight : null
        );
        if (borderFrag) pre.push(borderFrag);

        pre.push(evenizeFilter);
        const uploadFmt = (shouldKeepHdr && (selectedCodec.bitDepth === 10)) ? "p010le" : "nv12";
        pre.push(`format=${uploadFmt}`, "hwupload");

        let vaapiFilter = pre.join(",");
        if (targetFps) vaapiFilter += `,fps=${targetFps}`;
        args.push("-vaapi_device", vaapiDevice, "-vf", vaapiFilter);
      } else {
        pre.push(evenizeFilter);
        const uploadFmt = (shouldKeepHdr && (selectedCodec.bitDepth === 10)) ? "p010le" : "nv12";
        pre.push(`format=${uploadFmt}`, "hwupload");
        let vaapiFilter = pre.join(",");

        if (needScale) {
          const wExpr = (widthW != null) ? widthW : -2;
          const hExpr = (targetHeight > 0) ? targetHeight : -2;
          vaapiFilter += `,scale_vaapi=w=${wExpr}:h=${hExpr}`;
        }
        if (targetFps) vaapiFilter += `,fps=${targetFps}`;
        args.push("-vaapi_device", vaapiDevice, "-vf", vaapiFilter);
      }

      switch(selectedCodec.encoder) {
        case 'h264':
          args.push("-c:v", "h264_vaapi");
          args.push("-profile:v", vaapiProfile);
          if (vaapiLevel && vaapiLevel !== 'auto') {
            args.push("-level:v", vaapiLevel);
          }
          break;
        case 'h264_10bit':
          args.push("-c:v", "h264_vaapi", "-pix_fmt", "p010le");
          args.push("-profile:v", vaapiProfile);
          if (vaapiLevel && vaapiLevel !== 'auto') {
            args.push("-level:v", vaapiLevel);
          }
          break;
        case 'hevc':
          args.push("-c:v", "hevc_vaapi");
          args.push("-profile:v", vaapiProfile);
          if (vaapiLevel && vaapiLevel !== 'auto') {
            args.push("-level:v", vaapiLevel);
          }
          break;
        case 'hevc_10bit':
          args.push("-c:v", "hevc_vaapi", "-pix_fmt", "p010le");
          args.push("-profile:v", vaapiProfile);
          if (vaapiLevel && vaapiLevel !== 'auto') {
            args.push("-level:v", vaapiLevel);
          }
          break;
        case 'av1':
          args.push("-c:v", "av1_vaapi");
          args.push("-profile:v", vaapiProfile);
          if (vaapiLevel && vaapiLevel !== 'auto') {
            args.push("-level:v", vaapiLevel);
          }
          break;
        case 'av1_10bit':
          args.push("-c:v", "av1_vaapi", "-pix_fmt", "p010le");
          args.push("-profile:v", vaapiProfile);
          if (vaapiLevel && vaapiLevel !== 'auto') {
            args.push("-level:v", vaapiLevel);
          }
          break;
        default:
          args.push("-c:v", "h264_vaapi");
          args.push("-profile:v", vaapiProfile);
          if (vaapiLevel && vaapiLevel !== 'auto') {
            args.push("-level:v", vaapiLevel);
          }
      }

      if (vaapiTune) args.push("-tune", vaapiTune);

      if (explicitBv) {
        args.push("-b:v", explicitBv, "-maxrate", explicitBv, "-bufsize", `${explicitBv}*2`);
      } else {
        args.push("-global_quality", vaapiQuality);
      }
    }
    else {
      const swQuality = videoSettings.swSettings?.quality || '23';
      const swPreset  = normalizeSwPreset(videoSettings.swSettings?.preset || VIDEO_PRESET || "veryfast");
      const swTune = String(videoSettings.swSettings?.tune ?? '').trim();
      const swProfile = videoSettings.swSettings?.profile || 'high';
      const swLevel = videoSettings.swSettings?.level || null;

      let swProfileEff = swProfile;
      if (selectedCodec.encoder === "h264_10bit") swProfileEff = "high10";
      if (selectedCodec.encoder === "hevc") swProfileEff = "main";
      if (selectedCodec.encoder === "hevc_10bit") swProfileEff = "main10";

      const VP9_LEVELS = new Set([
        "1","1.1","2","2.1","3","3.1","4","4.1",
        "5","5.1","5.2","6","6.1","6.2"
      ]);

      switch (selectedCodec.encoder) {
        case 'h264':
        case 'x264':
          args.push("-c:v", "libx264", "-preset", swPreset);
          if (swProfileEff) args.push("-profile:v", swProfileEff);
          if (swLevel && swLevel !== 'auto') args.push("-level:v", swLevel);
          break;
        case 'h264_10bit':
          args.push("-c:v", "libx264", "-preset", swPreset);
          pushPixFmt("yuv420p10le");
          args.push("-profile:v", "high10");
          if (swLevel && swLevel !== 'auto') args.push("-level:v", swLevel);
          break;
        case 'hevc':
          args.push("-c:v", "libx265", "-preset", swPreset);
          pushPixFmt("yuv420p");
          if (swTune && swTune !== 'auto') args.push("-tune", swTune);
          args.push("-profile:v", "main");
          if (swLevel && swLevel !== 'auto') args.push("-level:v", swLevel);
          break;
        case 'hevc_10bit':
          args.push("-c:v", "libx265", "-preset", swPreset);
          pushPixFmt("yuv420p10le");
          if (swTune && swTune !== 'auto') args.push("-tune", swTune);
          args.push("-profile:v", "main10");
          if (swLevel && swLevel !== 'auto') args.push("-level:v", swLevel);
          break;
        case 'av1':
          if (capOk("libsvtav1")) {
            const svtP = presetToSvtPreset(swPreset);
            args.push("-c:v", "libsvtav1", "-preset", String(svtP));
          } else {
            const cpuUsed = presetToAomCpuUsed(swPreset);
            args.push("-c:v", "libaom-av1", "-cpu-used", String(cpuUsed), "-row-mt", "1");
          }
          break;
        case 'av1_10bit':
          if (capOk("libsvtav1")) {
            const svtP = presetToSvtPreset(swPreset);
            args.push("-c:v", "libsvtav1", "-preset", String(svtP), "-pix_fmt", "yuv420p10le");
          } else {
            const cpuUsed = presetToAomCpuUsed(swPreset);
            args.push("-c:v", "libaom-av1", "-cpu-used", String(cpuUsed), "-row-mt", "1", "-pix_fmt", "yuv420p10le");
          }
          break;
        case 'vp9': {
          const cpuUsed = presetToVp9CpuUsed(swPreset);
          const deadline = presetToVp9Deadline(swPreset);
          args.push("-c:v", "libvpx-vp9", "-cpu-used", String(cpuUsed), "-deadline", deadline, "-row-mt", "1", "-b:v", "0");
          const crf = swCrf != null ? String(swCrf) : String(swQuality || "30");
          args.push("-crf", crf);
          if (swTune && swTune !== 'auto') args.push("-tune", swTune);
          if (swProfile && swProfile !== '0') args.push("-profile:v", swProfile);
          if (swLevel && swLevel !== 'auto') {
            const lvlStr = String(swLevel);
            if (VP9_LEVELS.has(lvlStr)) {
              args.push("-level:v", lvlStr);
            } else {
              console.log(`⚠️ VP9 level "${lvlStr}" geçersiz → -level:v atlanıyor`);
            }
          }
         break;
        }
        case 'vp9_10bit': {
          const cpuUsed = presetToVp9CpuUsed(swPreset);
          const deadline = presetToVp9Deadline(swPreset);
          args.push(
            "-c:v",
            "libvpx-vp9",
            "-cpu-used",
            String(cpuUsed),
            "-deadline",
            deadline,
            "-row-mt",
            "1",
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p10le"
          );
          const crf = swCrf != null ? String(swCrf) : String(swQuality || "30");
          args.push("-crf", crf);
          if (swTune && swTune !== 'auto') args.push("-tune", swTune);
          if (swProfile && swProfile !== '2') args.push("-profile:v", swProfile);
          if (swLevel && swLevel !== 'auto') {
            const lvlStr = String(swLevel);
            if (VP9_LEVELS.has(lvlStr)) {
              args.push("-level:v", lvlStr);
            } else {
              console.log(`⚠️ VP9 10-bit level "${lvlStr}" geçersiz → -level:v atlanıyor`);
            }
          }
          break;
        }
       case 'prores': {
          const p = proresProfile;
          args.push("-c:v", "prores_ks", "-profile:v", String(p));
          if (p >= 4) pushPixFmt("yuv444p10le");
          else pushPixFmt("yuv422p10le");

          break;
        }
        case 'copy':
          args.push("-c:v", "copy");
          break;
        default:
          args.push("-c:v", "libx264", "-preset", VIDEO_PRESET);
          if (swTune && swTune !== 'auto') args.push("-tune", swTune);
          args.push("-profile:v", swProfile);
          if (swLevel && swLevel !== 'auto') args.push("-level:v", swLevel);
      }

      if (explicitBv && selectedCodec.encoder !== 'copy') {
        args.push("-b:v", explicitBv, "-maxrate", explicitBv, "-bufsize", `${explicitBv}*2`);
      } else if (!explicitBv && selectedCodec.encoder !== 'copy') {
        if (swCrf != null) {
          if (!['vp9', 'vp9_10bit', 'prores'].includes(selectedCodec.encoder)) {
            args.push("-crf", String(swCrf));
          }
        } else {
          const crf = br === "auto" || br === "0" ? "23" : "21";
          if (!['vp9', 'vp9_10bit', 'prores'].includes(selectedCodec.encoder)) {
            args.push("-crf", crf);
          }
        }
      }
    }

    const SRC_H2 = Number(resolvedMeta.__srcHeight) || 0;
    const tgtH = targetHeight > 0 ? targetHeight : 0;

    if (!useVaapi && selectedCodec.encoder !== 'copy') {

    if (!useNvenc && !useQsv && selectedCodec.encoder !== 'prores') {
      if (!pixFmtAlreadySet) {
      if (shouldSdrToHdr) {
          pushPixFmt("yuv420p10le");
        } else {
          if (!selectedCodec.bitDepth || selectedCodec.bitDepth === 8) pushPixFmt("yuv420p");
          else if (selectedCodec.bitDepth === 10) pushPixFmt("yuv420p10le");
        }
      }
    }

      if (format === "mp4") {
        args.push("-movflags", "+faststart+write_colr");
      }

      if (selectedCodec.encoder.includes('264') || selectedCodec.encoder.includes('265')) {
        args.push("-g", "60", "-keyint_min", "60", "-sc_threshold", "0");
      }
    } else if (useVaapi) {
        args.push(
          "-movflags", "+faststart",
          "-g", "60",
          "-keyint_min", "60",
          "-sc_threshold", "0"
        );
    }

    if (audioCodec === 'copy') {
        args.push("-c:a", "copy");
    } else {
        const aCodecRaw = String(audioCodec || '').toLowerCase();
        const aCodec = (aCodecRaw === 'dts') ? 'dca' : audioCodec;
        args.push("-c:a", aCodec);
        if (String(aCodec).toLowerCase() === 'dca') {
          args.push("-strict", "-2");
        }
        if (audioCodec === 'flac') {
            args.push("-compression_level", "5");
        } else if (audioBitrate !== 'original' && audioBitrate !== 'lossless') {
            args.push("-b:a", audioBitrate);
        }

        if (audioCodec !== 'copy' && audioCodec !== 'flac') {
            if (audioChannels === 'stereo') {
                args.push("-ac", "2");
            } else if (audioChannels === 'mono') {
                args.push("-ac", "1");
            }
        } else if (audioCodec === 'flac' && audioChannels !== 'original') {
            args.push("-ac", audioChannels === 'stereo' ? "2" : "1");
        }

        if (FINAL_SAMPLE_RATE !== null) {
            args.push("-ar", String(FINAL_SAMPLE_RATE));
        }
    }
}
    } else {
      switch (format) {
        case "mp3":
          if (bitrate === "auto" || bitrate === "0" || bitrate === "lossless") {
            args.push(
              "-acodec",
              "libmp3lame",
              "-q:a",
              "0",
              "-ar",
              FINAL_SAMPLE_RATE !== null ? String(FINAL_SAMPLE_RATE) : String(SR_NORM)
            );
          } else {
            args.push(
              "-acodec",
              "libmp3lame",
              "-b:a",
              bitrate,
              "-ar",
              FINAL_SAMPLE_RATE !== null ? String(FINAL_SAMPLE_RATE) : String(SR_NORM)
            );
          }
          args.push("-write_xing", (ringtone || shouldWriteMp3Xing()) ? "1" : "0");
          break;
        case "m4r": {
          const m4rBitrate =
            !bitrate || bitrate === "auto" || bitrate === "0" || bitrate === "lossless"
              ? "256k"
              : bitrate;
          args.push(
            "-acodec",
            "aac",
            "-b:a",
            m4rBitrate,
            "-ar",
            FINAL_SAMPLE_RATE !== null ? String(FINAL_SAMPLE_RATE) : "44100",
            "-movflags",
            "+faststart"
          );
          break;
        }
        case "flac": {
          let cl = Number(opts?.compressionLevel);
          if (!Number.isFinite(cl)) cl = 5;
          cl = Math.max(0, Math.min(12, cl));

          args.push(
            "-acodec",
            "flac",
            "-compression_level",
            String(cl),
            "-ar",
            FINAL_SAMPLE_RATE !== null ? String(FINAL_SAMPLE_RATE) : String(SR_NORM)
          );

          if (bitDepth === "16") {
            args.push("-sample_fmt", "s16");
          } else if (bitDepth === "24") {
            args.push("-sample_fmt", "s32");
          } else if (bitDepth === "32f") {
            args.push("-sample_fmt", "flt");
          }
          break;
        }
        case "wav": {
          let codec = "pcm_s16le";
          if (bitDepth === "24") {
            codec = "pcm_s24le";
          } else if (bitDepth === "32f") {
            codec = "pcm_f32le";
          }
          args.push("-acodec", codec, "-ar", FINAL_SAMPLE_RATE !== null ? String(FINAL_SAMPLE_RATE) : String(SR_NORM));
          break;
        }
        case "ogg":
          if (bitrate === "auto" || bitrate === "0") {
            args.push(
              "-acodec",
              "libvorbis",
              "-q:a",
              "6",
              "-ar",
              FINAL_SAMPLE_RATE !== null ? String(FINAL_SAMPLE_RATE) : String(SR_NORM)
            );
          } else {
            args.push(
              "-acodec",
              "libvorbis",
              "-b:a",
              bitrate,
              "-ar",
              FINAL_SAMPLE_RATE !== null ? String(FINAL_SAMPLE_RATE) : String(SR_NORM)
            );
          }
          break;
        case "eac3":
        case "aac":
        case "ac3":
          args.push(
            "-acodec",
            format,
            "-b:a",
            bitrate,
            "-ar",
            FINAL_SAMPLE_RATE !== null ? String(FINAL_SAMPLE_RATE) : String(SR_NORM)
          );
          if (stereoConvert === "force") args.push("-ac", "2");
          break;
        case "dts": {
          const br = (bitrate && bitrate !== "auto" && bitrate !== "0" && bitrate !== "lossless")
            ? bitrate
            : "1536k";
          args.push(
            "-acodec",
            "dca",
            "-strict",
            "-2",
            "-b:a",
            br
          );
          if (FINAL_SAMPLE_RATE !== null) {
            args.push("-ar", String(FINAL_SAMPLE_RATE));
          } else {
            args.push("-ar", String(SR_NORM));
          }
          if (stereoConvert === "force") args.push("-ac", "2");
          break;
        }
      }
    }

    const preLoudnormFilters = [];
    const postLoudnormFilters = [];
    let loudnormFilter = null;
    const hasAudioOutputSelected =
      !isVideo || !hasExplicitAudioSelection || selectedAudioStreams.length > 0;
    const canApplyAudioFilters =
      hasAudioOutputSelected &&
      (!isVideo || String(audioCodec || "").toLowerCase() !== "copy");

    const runLoudnormAnalysisPass = async (filterChain, config) => {
      if (!canApplyAudioFilters) return null;
      if (!config?.twoPass) return null;
      if (isVideo && selectedAudioStreams.length > 1) {
        console.warn("⚠️ Two-pass loudnorm requested with multiple selected audio streams; falling back to one-pass.");
        return null;
      }
      if (isCanceled()) throw new Error("CANCELED");

      const analysisArgs = [...analysisInputArgs];

      if (selectedAudioStreams.length > 0) {
        analysisArgs.push("-map", `0:${selectedAudioStreams[0]}`);
      } else if (!hasExplicitAudioSelection) {
        analysisArgs.push("-map", "0:a:0?");
      } else {
        return null;
      }

      analysisArgs.push("-vn", "-sn", "-dn", "-acodec", "pcm_s16le");
      if (filterChain.length > 0) {
        analysisArgs.push("-af", filterChain.join(","));
      }
      analysisArgs.push("-f", "null", "-");

      emitLog(opts.onLog, {
        fallback: `🎚 Loudnorm analysis started (${config.mode})`
      });
      // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
      console.log("🎚 Loudnorm analysis pass:", sanitizeLogValue(analysisArgs.join(" ")));

      return await new Promise((resolve, reject) => {
        const analysisProc = spawnSafe(ffmpegBin, analysisArgs);
        try {
          if (typeof opts.onProcess === "function") {
            opts.onProcess(analysisProc);
          }
        } catch {}

        let stderrData = "";
        let canceled = false;
        const cancelTimer = setInterval(() => {
          if (!canceled && isCanceled()) {
            canceled = true;
            try {
              analysisProc.kill("SIGTERM");
            } catch {}
          }
        }, 250);

        analysisProc.stderr.on("data", (chunk) => {
          stderrData += chunk.toString();
        });

        analysisProc.on("close", (code, signal) => {
          clearInterval(cancelTimer);

          const signalTerminated =
            signal === "SIGTERM" ||
            signal === "SIGKILL" ||
            (Number(code) === 255 && /received signal 15|sigterm|sigkill/i.test(String(stderrData || "")));

          if (canceled || isCanceled() || signalTerminated) {
            return reject(new Error("CANCELED"));
          }

          if (code !== 0) {
            const tail = stderrData.split("\n").slice(-12).join("\n");
            console.warn(`⚠️ Loudnorm analysis pass failed (code ${code}): ${tail}`);
            return resolve(null);
          }

          const stats = parseLoudnormAnalysisStats(stderrData);
          if (!stats) {
            console.warn("⚠️ Loudnorm analysis JSON could not be parsed; falling back to one-pass.");
            return resolve(null);
          }

          resolve(stats);
        });

        analysisProc.on("error", (error) => {
          clearInterval(cancelTimer);
          reject(new Error(`Loudnorm analysis spawn error: ${error.message}`));
        });
      });
    };

    if (atempoAdjust !== "none") {
      const ratioTable = {
        "24000_23976": 23976 / 24000,
        "23976_24000": 24000 / 23976,
        "23976_25000": 25000 / 23976,
        "24000_25000": 25000 / 24000,
        "25_24": 24 / 25,
        "25_23976": 23976 / 25000,
        "30_23976": 23976 / 30000,
        "30_24": 24 / 30,
        "30000_25000": 25000 / 30000
      };

      const target = ratioTable[atempoAdjust];
      if (Number.isFinite(target) && target > 0) {
        // Handles split atempo in the FFmpeg media conversion pipeline.
        const splitAtempo = (f) => {
          const parts = [];
          let x = f;
          while (x < 0.5) {
            parts.push(0.5);
            x = x / 0.5;
          }
          while (x > 2.0) {
            parts.push(2.0);
            x = x / 2.0;
          }
          parts.push(x);
          return parts.map((v) => +v.toFixed(6));
        };

        const chain = splitAtempo(target);
        if (chain.length) {
          const expr = chain.map((v) => `atempo=${v}`).join(",");
          preLoudnormFilters.push(expr);
        }
      }
    }

    if (Number.isFinite(volumeGain) && volumeGain > 0 && volumeGain !== 1) {
      const safeGain = Math.min(Math.max(volumeGain, 0.5), 5.0);
      preLoudnormFilters.push(`volume=${safeGain.toFixed(2)}`);
    }

    if (loudnormEnabled) {
      const analysisFilter = [
        ...preLoudnormFilters,
        buildLoudnormFilter(loudnormConfig, null, "json")
      ];

      const stats = await runLoudnormAnalysisPass(analysisFilter, loudnormConfig);
      loudnormFilter = stats
        ? buildLoudnormFilter(loudnormConfig, stats)
        : buildLoudnormFilter(loudnormConfig);
    }

    if (ringtoneSegment) {
      const clipLen = Number(ringtoneSegment.durationSec || 0) || 0;
      const fadeIn = Math.max(
        0,
        Math.min(Number(ringtone?.fadeInSec ?? 0.5) || 0, Math.max(0, clipLen / 4))
      );
      const fadeOut = Math.max(
        0,
        Math.min(Number(ringtone?.fadeOutSec ?? 1.0) || 0, Math.max(0, clipLen / 4))
      );

      if (fadeIn > 0) {
        postLoudnormFilters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
      }

      if (fadeOut > 0 && clipLen > (fadeOut + 0.05)) {
        const fadeOutStart = Math.max(0, clipLen - fadeOut);
        postLoudnormFilters.push(`afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(3)}`);
      }
    }

    const afilters = [...preLoudnormFilters];
    if (loudnormFilter) afilters.push(loudnormFilter);
    afilters.push(...postLoudnormFilters);

    if (afilters.length > 0 && canApplyAudioFilters) {
      const filterStr = afilters.join(",");
      args.push("-af", filterStr);
    } else if (afilters.length > 0) {
      console.warn("⚠️ Audio filters requested but no transcodable audio output is available; skipping audio filters.");
    }

    if (!outputPath || !outputFileName) {
      const built = buildUniqueOut(basename, format);
      outputFileName = built.fileName;
      outputPath = built.outPath;
    }

    if (format === "m4r") {
      args.push("-f", "ipod");
    }

    args.push(outputPath);

    // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
    console.log("🔧 FFmpeg arguments:", sanitizeLogValue(args.join(" ")));

    let triedFallback = false;
    let ffmpeg = spawnSafe(ffmpegBin, args);
    try {
      if (typeof opts.onProcess === "function") {
        opts.onProcess(ffmpeg);
      }
    } catch {}
    let duration = null;
    let lastElapsed = null;
    let lastFps = null;
    let elapsedBasedFps = null;
    let measuredEncodeFps = null;
    let lastFrame = null;
    let lastFrameAt = null;
    let sourceNominalFps =
      Number.isFinite(targetFps) && targetFps > 0 ? targetFps : null;
    let lastProgress = -1;
    let lastProgressAt = 0;
    let stderrData = "";
    let parseWindow = "";
    let canceledByFlag = false;
    let ffmpegWatchdogTimedOut = false;
    let ffmpegLastActivityAt = Date.now();
    let ffmpegWatchdog = null;
    const ffmpegStartedAt = Date.now();

    const stopFfmpegWatchdog = () => {
      if (ffmpegWatchdog) clearInterval(ffmpegWatchdog);
      ffmpegWatchdog = null;
    };

    const touchFfmpegWatchdog = () => {
      ffmpegLastActivityAt = Date.now();
    };

    ffmpegWatchdog = setInterval(() => {
      if ((Date.now() - ffmpegLastActivityAt) < FFMPEG_STALL_TIMEOUT_MS) return;
      ffmpegWatchdogTimedOut = true;
      stopFfmpegWatchdog();
      console.error(
        `❌ FFmpeg stalled for ${Math.round(FFMPEG_STALL_TIMEOUT_MS / 1000)}s; terminating worker`
      );
      try {
        ffmpeg.kill("SIGKILL");
      } catch {}
    }, FFMPEG_WATCHDOG_POLL_MS);
    ffmpegWatchdog.unref?.();

    // Formats seconds to HH:MM:SS for conversion progress display.
    const formatClock = (sec) => {
      if (!Number.isFinite(sec) || sec < 0) return "--:--:--";
      const total = Math.floor(sec);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    };

    // Handles try cancel in the FFmpeg media conversion pipeline.
    const tryCancel = () => {
      if (!canceledByFlag && isCanceled()) {
        canceledByFlag = true;
        try {
          ffmpeg.kill("SIGTERM");
        } catch {}
      }
    };

    // Returns smoothed encode fps (frame delta / real elapsed wall time).
    const pickLiveFps = () => {
      const n =
        Number.isFinite(elapsedBasedFps) && elapsedBasedFps > 0
          ? elapsedBasedFps
          : Number.isFinite(measuredEncodeFps) && measuredEncodeFps > 0
          ? measuredEncodeFps
          : Number.isFinite(lastFps) && lastFps > 0
          ? lastFps
          : null;
      return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : null;
    };

    // Tries to extract source fps from ffmpeg stream info text once.
    const tryCaptureSourceFps = () => {
      if (Number.isFinite(sourceNominalFps) && sourceNominalFps > 0) return;
      const matches = [...parseWindow.matchAll(/,\s*([0-9]+(?:\.[0-9]+)?)\s*fps(?:\s*,|\s)/gi)];
      if (!matches.length) return;
      for (const m of matches) {
        const n = Number(m?.[1]);
        if (Number.isFinite(n) && n >= 10 && n <= 120) {
          sourceNominalFps = n;
          break;
        }
      }
    };

    // Updates fps estimate based on encoded media time / wall elapsed.
    const updateElapsedBasedFps = () => {
      if (!Number.isFinite(lastElapsed) || lastElapsed <= 0) return;
      const wallElapsed = (Date.now() - ffmpegStartedAt) / 1000;
      if (!Number.isFinite(wallElapsed) || wallElapsed < 0.5) return;

      let nominalFps =
        Number.isFinite(sourceNominalFps) && sourceNominalFps > 0
          ? sourceNominalFps
          : null;

      if (!nominalFps && Number.isFinite(lastFrame) && lastFrame > 0 && lastElapsed >= 1) {
        const inferred = lastFrame / lastElapsed;
        if (Number.isFinite(inferred) && inferred >= 10 && inferred <= 120) {
          nominalFps = inferred;
          sourceNominalFps = inferred;
        }
      }

      if (!nominalFps) return;
      const speedRatio = lastElapsed / wallElapsed;
      if (!Number.isFinite(speedRatio) || speedRatio <= 0) return;

      const estimate = nominalFps * speedRatio;
      if (!Number.isFinite(estimate) || estimate <= 0 || estimate > 5000) return;

      elapsedBasedFps = Number.isFinite(elapsedBasedFps)
        ? elapsedBasedFps * 0.75 + estimate * 0.25
        : estimate;
    };

    // Returns smoothed encode fps (frame delta / real elapsed wall time).
    const fallbackFrameBasedFps = () => {
      const n =
        Number.isFinite(measuredEncodeFps) && measuredEncodeFps > 0
          ? measuredEncodeFps
          : lastFps;
      return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : null;
    };

    ffmpeg.stderr.on("data", (d) => {
      touchFfmpegWatchdog();
      const chunk = d.toString();
      stderrData += chunk;
      parseWindow += chunk;
      if (parseWindow.length > 8192) {
        parseWindow = parseWindow.slice(-8192);
      }
      tryCaptureSourceFps();

      if (!duration) {
        const m = chunk.match(/Duration:\s+(\d+):(\d+):(\d+\.\d+)/);
        if (m) {
          const [, h, mn, s] = m;
          duration = +h * 3600 + +mn * 60 + +s;
        }
      }

      tryCancel();

      const timeMatches = [...parseWindow.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)];
      const fpsMatches = [...parseWindow.matchAll(/fps=\s*([0-9.]+)/g)];
      const frameMatches = [...parseWindow.matchAll(/frame=\s*([0-9]+)/g)];
      const t = timeMatches.length ? timeMatches[timeMatches.length - 1] : null;
      const f = fpsMatches.length ? fpsMatches[fpsMatches.length - 1] : null;
      const fr = frameMatches.length
        ? frameMatches[frameMatches.length - 1]
        : null;

      if (f) {
        const parsedFps = Number(f[1]);
        if (Number.isFinite(parsedFps) && parsedFps > 0) {
          lastFps = parsedFps;
        }
      }

      if (fr) {
        const parsedFrame = Number(fr[1]);
        if (Number.isFinite(parsedFrame) && parsedFrame >= 0) {
          const now = Date.now();

          if (Number.isFinite(lastFrame) && Number.isFinite(lastFrameAt)) {
            const deltaFrame = parsedFrame - lastFrame;
            const deltaWall = (now - lastFrameAt) / 1000;
            if (deltaFrame >= 0 && deltaWall >= 0.35) {
              const instantEncodeFps = deltaFrame / deltaWall;
              if (
                Number.isFinite(instantEncodeFps) &&
                instantEncodeFps > 0 &&
                instantEncodeFps < 5000
              ) {
                measuredEncodeFps = Number.isFinite(measuredEncodeFps)
                  ? measuredEncodeFps * 0.7 + instantEncodeFps * 0.3
                  : instantEncodeFps;
              }
            }
          }

          const wallElapsed = (now - ffmpegStartedAt) / 1000;
          if (parsedFrame > 0 && wallElapsed >= 1) {
            const avgEncodeFps = parsedFrame / wallElapsed;
            if (
              Number.isFinite(avgEncodeFps) &&
              avgEncodeFps > 0 &&
              avgEncodeFps < 5000
            ) {
              measuredEncodeFps = Number.isFinite(measuredEncodeFps)
                ? measuredEncodeFps * 0.85 + avgEncodeFps * 0.15
                : avgEncodeFps;
            }
          }

          lastFrame = parsedFrame;
          lastFrameAt = now;
        }
      }

      if (t) {
        const [, h, mn, s] = t;
        const cur = +h * 3600 + +mn * 60 + +s;
        lastElapsed = cur;
        updateElapsedBasedFps();
      } else if (!Number.isFinite(elapsedBasedFps) || elapsedBasedFps <= 0) {
        elapsedBasedFps = fallbackFrameBasedFps();
      }

      if (t && duration) {
        const cur = Number(lastElapsed || 0);
        const progressDuration =
          (clipDuration != null && clipDuration > 0)
            ? clipDuration
            : duration;
        const p = Math.min(99, Math.floor((cur / progressDuration) * 100));
        const now = Date.now();
        const shouldEmit = p !== lastProgress || (now - lastProgressAt) >= 1200;
        if (shouldEmit) {
          lastProgress = p;
          lastProgressAt = now;
          progressCallback(p, {
            percent: p,
            elapsedSeconds: cur,
            durationSeconds: progressDuration,
            elapsedText: formatClock(cur),
            durationText: formatClock(progressDuration),
            fps: pickLiveFps()
          });
        }
        tryCancel();
      }
    });

    ffmpeg.on("close", async (code, signal) => {
      stopFfmpegWatchdog();
      const actualOut = outputPath;

      if (ffmpegWatchdogTimedOut) {
        try {
          if (actualOut && fs.existsSync(actualOut)) fs.unlinkSync(actualOut);
        } catch {}
        return reject(
          new Error(
            `FFmpeg stalled for ${Math.round(FFMPEG_STALL_TIMEOUT_MS / 1000)}s`
          )
        );
      }

      const signalTerminated =
        signal === "SIGTERM" ||
        signal === "SIGKILL" ||
        (Number(code) === 255 && /received signal 15|sigterm|sigkill/i.test(String(stderrData || "")));

      if (canceledByFlag || isCanceled() || signalTerminated) {
        try {
          // actualOut is the validated conversion output created under the confined outputDir.
          if (actualOut && fs.existsSync(actualOut)) fs.unlinkSync(actualOut);
        } catch {}
        return reject(new Error("CANCELED"));
      }

      // outputPath is generated by buildUniqueOut under the confined outputDir.
      if (code === 0 && fs.existsSync(outputPath)) {
        const finalElapsed = Number.isFinite(lastElapsed) ? lastElapsed : duration;
        const progressDuration =
          (clipDuration != null && clipDuration > 0)
            ? clipDuration
            : duration;
        progressCallback(100, {
          percent: 100,
          elapsedSeconds: Number.isFinite(finalElapsed) ? finalElapsed : null,
          durationSeconds: Number.isFinite(progressDuration) ? progressDuration : null,
          elapsedText: formatClock(finalElapsed),
          durationText: formatClock(progressDuration),
          fps: pickLiveFps()
        });
        // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
        console.log(`✅ Conversion completed: ${sanitizeLogValue(outputPath)}`);
        await ensureOwnership(outputPath);
        const downloadPath = toResultDownloadPath(outputPath);
        resolve({
          outputPath: downloadPath,
          // outputPath is generated by buildUniqueOut under the confined outputDir.
          fileSize: fs.statSync(outputPath).size,
          ringtone: ringtoneSegment || null
        });
      } else {
        try {
          // outputPath is generated by buildUniqueOut under the confined outputDir.
          if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch {}
        const tail = stderrData.split("\n").slice(-10).join("\n");
        console.error(`❌ FFmpeg error (code ${code}):\n${tail}`);
        reject(new Error(`FFmpeg error (code ${code}): ${tail}`));
      }
    });

    ffmpeg.on("error", (e) => {
      stopFfmpegWatchdog();
      console.error(`❌ FFmpeg spawn error: ${e.message}`);
      if (!triedFallback && /ENOENT/i.test(e.message)) {
        triedFallback = true;
        try {
          ffmpeg = spawnSafe(
            process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
            args
          );
          if (typeof opts.onProcess === "function") {
            try {
              opts.onProcess(ffmpeg);
            } catch {}
          }
          ffmpeg.stderr.on("data", (d) => {});
          ffmpeg.on("close", (code) => {});
          ffmpeg.on("error", (e2) => {
            reject(new Error(`FFmpeg spawn error (fallback): ${e2.message}`));
          });
          return;
        } catch (e2) {
          return reject(
            new Error(`FFmpeg spawn error (fallback init): ${e2.message}`)
          );
        }
      }
      reject(new Error(`FFmpeg spawn error: ${e.message}`));
    });
    })().catch(reject);
    });
  } catch (transcodeError) {
    const canRetryWithoutHardware =
      isVideo &&
      !opts?._hwFallbackAttempted &&
      ["nvenc", "qsv", "vaapi"].includes(effectiveHwMode) &&
      isRecoverableHardwareEncoderError(transcodeError?.message || "");

    for (const p of tempFilesToCleanup) {
      safeUnlink(p);
    }
    if (downloadedCoverPath) safeUnlink(downloadedCoverPath);

    if (canRetryWithoutHardware) {
      console.warn(
        `⚠️ ${effectiveHwMode.toUpperCase()} encode init failed; retrying with software encoder.`
      );
      return await convertMedia(
        inputPath,
        format,
        bitrate,
        jobId,
        progressCallback,
        metadata,
        origCoverPath,
        isVideo,
        outputDir,
        tempDir,
        {
          ...opts,
          _hwFallbackAttempted: true,
          videoSettings: {
            ...videoSettings,
            hwaccel: "off"
          }
        }
      );
    }

    throw transcodeError;
  }

  try {
    if (isCanceled()) {
      return result;
    }
    const includeLyricsFlag = opts.includeLyrics !== false;
    const embedLyricsFlag = opts.embedLyrics === true;
    const shouldProcessLyrics = includeLyricsFlag || embedLyricsFlag;

    // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
    const lyricsCheckLog = `🔍 Lyrics check → Will it be processed?: ${
        shouldProcessLyrics ? "yes" : "no"
      } | embed: ${embedLyricsFlag ? "yes" : "no"} | video: ${isVideo ? "yes" : "no"} | format: ${sanitizeLogValue(format)} | meta: ${[
        metadata.artist,
        metadata.title || metadata.track
      ]
        .filter(Boolean)
        .map((value) => sanitizeLogValue(value))
        .join(" - ")}`;
    console.log(lyricsCheckLog);

    if (shouldProcessLyrics && !isVideo && result && result.outputPath) {
      console.log("🎵 Adding lyrics...");
      const actualOutputPath = resolveResultDownloadPath(result.outputPath);
      if (!actualOutputPath) {
        console.warn("⚠️ Could not resolve output path for lyrics:", result.outputPath);
        return result;
      }

      if (isCanceled()) {
        return result;
      }

      // Handles lyrics metadata log callback in the FFmpeg media conversion pipeline.
      const lyricsLogCallback = (message) => {
        const line =
          typeof message === "object" && message?.fallback
            ? message.fallback
            : typeof message === "string"
            ? message
            : JSON.stringify(message);
        console.log(`[Lyrics ${jobId}] ${line}`);

        const job = jobs.get(jobId.split("_")[0]);
        if (job) {
          if (typeof message === "object" && message.logKey) {
            job.lastLogKey = message.logKey;
            job.lastLogVars = message.logVars || {};
            job.lastLog = message.fallback || "";
          } else {
            job.lastLog = line;
            job.lastLogKey = null;
            job.lastLogVars = null;
          }
        }
      };

      try {
        const lyricsPath = await attachLyricsToMedia(actualOutputPath, metadata, {
          includeLyrics: includeLyricsFlag,
          embedLyrics: embedLyricsFlag,
          jobId: jobId.split("_")[0],
          onLog: lyricsLogCallback,
          onLyricsStats: opts.onLyricsStats
        });

        if (lyricsPath) {
          console.log(`✅ lyrics added successfully: ${lyricsPath}`);
          result.lyricsPath = toResultDownloadPath(lyricsPath);

          const job = jobs.get(jobId.split("_")[0]);
          if (job) {
            job.lastLog = `🎼 Lyrics file added: ${path.basename(
              lyricsPath
            )}`;
            if (!job.metadata.lyricsStats) {
              job.metadata.lyricsStats = { found: 0, notFound: 0 };
            }
            job.metadata.lyricsStats.found++;
          }
        } else {
          console.log("ℹ️ Lyrics could not be found or added");
          const job = jobs.get(jobId.split("_")[0]);
          if (job) {
            job.lastLog = `🎼 Lyrics not found: ${
              metadata.title || "Unknown"
            }`;
            if (!job.metadata.lyricsStats) {
              job.metadata.lyricsStats = { found: 0, notFound: 0 };
            }
            job.metadata.lyricsStats.notFound++;
          }
        }
      } catch (lyricsError) {
        console.warn("❌ Error adding lyrics (main process in progress):", lyricsError);
        const job = jobs.get(jobId.split("_")[0]);
        if (job) {
         job.lastLog = `❌ Lyrics error: ${lyricsError.message}`;
        }
      }
    } else {
      console.log(
        `⚙️ no lyrics added → Will it be processed?: ${
          shouldProcessLyrics ? "yes" : "no"
        } | reason: ${isVideo ? "Video format" : "Disabled"}`
      );
    }

    if (!isVideo && String(format || "").toLowerCase() === "mp3" && result?.outputPath) {
      const actualOutputPath = resolveResultDownloadPath(result.outputPath);
      if (actualOutputPath) {
        writeRichId3v2Tag(actualOutputPath, {
          ...resolvedMeta,
          comment: getCommentText()
        });
        if (shouldWriteId3v1()) {
          rewriteId3v11Tag(actualOutputPath, {
            ...resolvedMeta,
            comment: getCommentText()
          });
        }
      }
    }

    await ensureResultOwnership(result);
    return result;
  } catch (error) {
    console.error("❌ Lyrics processing error:", error);
    await ensureResultOwnership(result);
    return result;
    } finally {
    for (const p of tempFilesToCleanup) {
      safeUnlink(p);
    }
    if (downloadedCoverPath) safeUnlink(downloadedCoverPath);
  }
}
