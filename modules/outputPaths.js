import fs from "fs";
import path from "path";
import {
  isYtMusicAlbumContext,
  normalizeYtMusicAlbumTitle,
  pickYtMusicAlbumArtist
} from "./ytMusicMetadata.js";

const BASE_DIR = process.env.DATA_DIR || process.cwd();
export const OUTPUT_ROOT_DIR = path.resolve(BASE_DIR, "outputs");

const SUPPORTED_LANGS = new Set(["en", "tr", "de", "fr"]);
const LOCALE_BY_LANG = {
  en: "en-US",
  tr: "tr-TR",
  de: "de-DE",
  fr: "fr-FR"
};

// Normalizes UI language key for output folder naming.
export function normalizeUiLang(input) {
  const v = String(input || "").toLowerCase().trim();
  if (SUPPORTED_LANGS.has(v)) return v;
  const short = v.split(/[-_]/)[0];
  return SUPPORTED_LANGS.has(short) ? short : "en";
}

// Resolves locale by normalized UI language key.
export function localeForLang(lang) {
  return LOCALE_BY_LANG[normalizeUiLang(lang)] || LOCALE_BY_LANG.en;
}

function safeDecode(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return String(v || "");
  }
}

function normalizeOutputCompare(value = "") {
  return String(value || "")
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sanitizeSegment(v, fallback = "output") {
  const src = String(v || "").trim();
  const cleaned = src
    .replace(/[<>:"|?*\\/]+/g, "-")
    .replace(/\s+/g, "_")
    .replace(/-+/g, "-")
    .replace(/_+/g, "_")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}

function parseCookieHeader(rawCookie = "") {
  const out = {};
  for (const part of String(rawCookie || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = safeDecode(v);
  }
  return out;
}

// Picks language from request headers/cookies in server routes.
export function pickLangFromRequest(req) {
  const hxRaw = String(req?.get?.("x-lang") || "").trim();
  if (hxRaw) return normalizeUiLang(hxRaw);

  const qRaw = String(req?.query?.lang || "").trim();
  if (qRaw) return normalizeUiLang(qRaw);

  const cookies = parseCookieHeader(req?.headers?.cookie || "");
  const cRaw = String(cookies.lang || "").trim();
  if (cRaw) return normalizeUiLang(cRaw);

  const al = String(req?.get?.("accept-language") || "").toLowerCase();
  if (al.includes("tr")) return "tr";
  if (al.includes("de")) return "de";
  if (al.includes("fr")) return "fr";
  return "en";
}

// Creates language-aware UTC timestamp segment for output folder naming.
export function formatOutputTimestamp(inputDate, lang = "en") {
  const d = inputDate ? new Date(inputDate) : new Date();
  const date = Number.isFinite(d.getTime()) ? d : new Date();

  const locale = localeForLang(lang);
  const raw = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC"
  }).format(date);

  const stamp = sanitizeSegment(raw, "timestamp");
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${stamp}_${ms}_UTC`;
}

function normalizeRelPath(relPath) {
  const rel = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(rel).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("..")) return null;
  return normalized;
}

// Checks whether job should use dedicated playlist output folder.
export function shouldUsePlaylistOutputDir(job) {
  return !!job?.metadata?.isPlaylist;
}

// Picks display title used for playlist output folder naming.
export function pickPlaylistOutputName(job) {
  const meta = job?.metadata || {};
  const extracted = meta.extracted || {};
  const frozenEntries = Array.isArray(meta.frozenEntries) ? meta.frozenEntries : [];
  const candidates = [
    meta.frozenTitle,
    meta.spotifyTitle,
    extracted.playlist_title,
    extracted.title,
    meta.originalName
  ];
  const first = candidates.find((v) => typeof v === "string" && v.trim());
  const normalizedFirst = meta.source === "youtube"
    ? normalizeYtMusicAlbumTitle(first || "", {
        meta: {
          ...(extracted || {}),
          title: first || extracted.title || "",
          playlist_title: extracted.playlist_title || ""
        },
        sourceUrl: meta.url || meta.originalUrl || ""
      })
    : first;
  const albumContext = meta.source === "youtube" && (
    isYtMusicAlbumContext({
      ...(extracted || {}),
      title: first || extracted.title || "",
      playlist_title: extracted.playlist_title || "",
      url: meta.url || meta.originalUrl || "",
      webpage_url: meta.url || meta.originalUrl || ""
    }, meta.url || meta.originalUrl || "") ||
    normalizedFirst !== first
  );
  const albumArtist = albumContext
    ? pickYtMusicAlbumArtist(
        {
          album_artist: meta.albumArtist || meta.album_artist,
          artist: meta.artist,
          uploader: meta.uploader
        },
        extracted,
        ...frozenEntries.slice(0, 8)
      )
    : "";
  const albumAlreadyHasArtist = albumArtist && normalizedFirst
    ? normalizeOutputCompare(normalizedFirst).startsWith(`${normalizeOutputCompare(albumArtist)} `)
    : false;
  const albumTitle =
    albumContext && albumArtist && normalizedFirst && !albumAlreadyHasArtist
      ? `${albumArtist} - ${normalizedFirst}`
      : normalizedFirst;
  const baseTitle =
    albumTitle ||
    (meta.source === "spotify"
      ? "Spotify Playlist"
      : meta.source === "apple_music"
      ? "Apple Music Playlist"
      : meta.source === "deezer"
      ? "Deezer Playlist"
      : meta.source === "tidal"
      ? "TIDAL Playlist"
      : meta.source === "soundcloud"
      ? "SoundCloud Playlist"
      : "Playlist");

  const fmt = String(job?.format || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (!fmt) return baseTitle;

  const suffix = ` - ${fmt}`;
  if (String(baseTitle).toLowerCase().endsWith(suffix)) return baseTitle;
  return `${baseTitle}${suffix}`;
}

function ensureSafeAbs(root, rel) {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("Invalid output directory");
  }
  return abs;
}

function allocateUniquePlaylistSubdir(root, preferredName) {
  const sanitizePlaylistFolderName = (value, fallback = "playlist") => {
    const src = String(value || "").trim();
    const cleaned = src
      .replace(/[<>:"|?*\\/]+/g, "-")
      .replace(/\s+/g, " ")
      .replace(/-+/g, "-")
      .replace(/^[-_.\s]+|[-_.\s]+$/g, "")
      .slice(0, 120);
    return cleaned || fallback;
  };

  const safeBase = sanitizePlaylistFolderName(preferredName, "playlist");
  let rel = safeBase;
  let abs = ensureSafeAbs(root, rel);
  let index = 2;
  while (fs.existsSync(abs) && index < 1000) {
    rel = sanitizePlaylistFolderName(`${safeBase} (${index})`, `${safeBase}_${index}`);
    abs = ensureSafeAbs(root, rel);
    index += 1;
  }
  return { rel, abs };
}

// Ensures playlist output directory exists and stores relative subdir on job metadata.
export function ensurePlaylistOutputDir(job, outputRootDir = OUTPUT_ROOT_DIR) {
  const root = path.resolve(outputRootDir || OUTPUT_ROOT_DIR);
  fs.mkdirSync(root, { recursive: true });

  const meta = job?.metadata || (job.metadata = {});
  let rel = normalizeRelPath(meta.outputSubdir);

  if (!rel) {
    const title = pickPlaylistOutputName(job);
    const allocated = allocateUniquePlaylistSubdir(root, title);
    rel = allocated.rel;
  }

  const abs = ensureSafeAbs(root, rel);
  fs.mkdirSync(abs, { recursive: true });
  meta.outputSubdir = rel;
  return abs;
}

// Resolves effective output directory for job based on playlist/single mode.
export function resolveJobOutputDir(job, outputRootDir = OUTPUT_ROOT_DIR) {
  const root = path.resolve(outputRootDir || OUTPUT_ROOT_DIR);
  fs.mkdirSync(root, { recursive: true });
  if (!shouldUsePlaylistOutputDir(job)) return root;
  return ensurePlaylistOutputDir(job, root);
}

// Builds stable output subdirectory for a job.
export function buildJobOutputSubdir({ lang = "en", createdAt = Date.now(), jobId = "job" } = {}) {
  const safeLang = sanitizeSegment(normalizeUiLang(lang), "en");
  const stamp = sanitizeSegment(formatOutputTimestamp(createdAt, safeLang), "timestamp");
  const safeJobId = sanitizeSegment(jobId, "job");
  return path.posix.join(safeLang, `${stamp}_${safeJobId}`);
}

// Ensures per-job output directory exists and returns absolute path.
export function ensureJobOutputDir(job, outputRootDir = OUTPUT_ROOT_DIR) {
  const root = path.resolve(outputRootDir || OUTPUT_ROOT_DIR);
  fs.mkdirSync(root, { recursive: true });

  const meta = job?.metadata || (job.metadata = {});
  const lang = normalizeUiLang(meta.lang || "en");

  let rel = normalizeRelPath(meta.outputSubdir);
  if (!rel) {
    rel = buildJobOutputSubdir({
      lang,
      createdAt: job?.createdAt || Date.now(),
      jobId: job?.id || "job"
    });
  }

  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("Invalid output directory");
  }

  fs.mkdirSync(abs, { recursive: true });

  meta.lang = lang;
  meta.outputSubdir = rel;
  return abs;
}

// Converts absolute output path to public download URL.
export function toDownloadPath(absPath, outputRootDir = OUTPUT_ROOT_DIR) {
  const root = path.resolve(outputRootDir || OUTPUT_ROOT_DIR);
  const abs = path.resolve(String(absPath || ""));

  if (abs !== root && !abs.startsWith(root + path.sep)) return null;

  const relFs = path.relative(root, abs);
  const rel = normalizeRelPath(relFs);
  if (!rel) return null;

  const encoded = rel
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `/download/${encoded}`;
}

// Extracts normalized relative output path from /download URL-like input.
export function extractRelativeDownloadPath(rawPath) {
  const src = String(rawPath || "").trim();
  if (!src) return null;

  let pathname = src;
  if (/^https?:\/\//i.test(src)) {
    try {
      pathname = new URL(src).pathname || "";
    } catch {
      pathname = src;
    }
  }

  let normalized = String(pathname || "");
  normalized = normalized.split(/[?#]/)[0] || "";
  normalized = normalized.replace(/^\/+/, "");

  let decoded = safeDecode(normalized);

  if (decoded.startsWith("download/")) {
    decoded = decoded.slice("download/".length);
  }

  return normalizeRelPath(decoded);
}

// Resolves /download URL-like input to absolute output path.
export function resolveDownloadPathToAbs(rawPath, outputRootDir = OUTPUT_ROOT_DIR) {
  const root = path.resolve(outputRootDir || OUTPUT_ROOT_DIR);
  const rel = extractRelativeDownloadPath(rawPath);
  if (!rel) return null;

  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}
