import crypto from "crypto";
import fs from "fs";
import path from "path";
import { parseAppleMusicUrl } from "./apple.js";
import { parseDeezerUrl } from "./deezer.js";
import { parseTidalUrl } from "./tidal.js";
import { parseSoundCloudUrl } from "./soundcloud.js";
import { idsToMusicUrls, mapSpotifyToYtm } from "./sp.js";
import { isCatalogMusicProvider } from "./mappedMusicMatcher.js";
import { parseSpotifyUrl } from "./spotify.js";

const BASE_DIR = process.env.DATA_DIR || process.cwd();
const TEMP_DIR = path.resolve(BASE_DIR, "temp");
const CACHE_DIR = path.join(TEMP_DIR, "mapped-music-cache");
const MANIFEST_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function sha1(value = "") {
  return crypto
    .createHash("sha1")
    .update(String(value || ""))
    .digest("hex");
}

function trimUnderscoreEdges(value = "") {
  const text = String(value || "");
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === 95) start += 1;
  while (end > start && text.charCodeAt(end - 1) === 95) end -= 1;
  return text.slice(start, end);
}

function safeFilePart(value = "") {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_");
  const out = trimUnderscoreEdges(normalized).slice(0, 120);
  return out || "mapped_music";
}

function safeString(value, max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function toDurationMs(value = null) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function formatDurationMs(value = null) {
  const ms = toDurationMs(value);
  if (!ms) return null;
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function norm(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  return CACHE_DIR;
}

function detectSource(url = "") {
  const raw = String(url || "").trim();
  if (/^spotify:/i.test(raw)) return "spotify";
  if (/^deezer:/i.test(raw)) return "deezer";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return "mapped_music";
    const host = parsed.hostname.toLowerCase();
    if (host === "open.spotify.com") return "spotify";
    if (
      host === "deezer.com" ||
      host.endsWith(".deezer.com") ||
      host === "deezer.page.link" ||
      host.endsWith(".deezer.page.link")
    ) return "deezer";
    if (host === "music.apple.com" || host === "embed.music.apple.com") return "apple_music";
    if (host === "tidal.com" || host === "www.tidal.com" || host === "listen.tidal.com") return "tidal";
    if (host === "soundcloud.com" || host.endsWith(".soundcloud.com")) return "soundcloud";
  } catch {}
  return "mapped_music";
}

export function getMappedMusicSourceKey(rawUrl = "", sourceHint = "") {
  const source = String(sourceHint || detectSource(rawUrl)).toLowerCase();
  const url = String(rawUrl || "").trim();

  if (source === "spotify") {
    const parsed = parseSpotifyUrl(url);
    if (parsed?.type && parsed?.id && parsed.type !== "unknown") {
      return `spotify:${parsed.type}:${parsed.id}`;
    }
  }

  if (source === "deezer") {
    const parsed = parseDeezerUrl(url);
    if (parsed?.type === "artist_search" && parsed?.query) {
      return `deezer:artist_search:${sha1(String(parsed.query).trim().toLowerCase()).slice(0, 20)}`;
    }
    if (parsed?.type && parsed?.id && parsed.type !== "unknown") {
      return `deezer:${parsed.type}:${parsed.id}`;
    }
  }

  if (source === "apple_music") {
    const parsed = parseAppleMusicUrl(url);
    if (parsed?.type && parsed?.id && parsed.type !== "unknown") {
      return `apple_music:${parsed.type}:${parsed.id}`;
    }
  }

  if (source === "tidal") {
    const parsed = parseTidalUrl(url);
    if (parsed?.type && parsed?.id && parsed.type !== "unknown") {
      const id = parsed.type === "track" && parsed.albumId
        ? `${parsed.albumId}:${parsed.id}`
        : parsed.id;
      return `tidal:${parsed.type}:${id}`;
    }
  }

  if (source === "soundcloud") {
    const parsed = parseSoundCloudUrl(url);
    if (parsed?.type && parsed?.id && parsed.type !== "unknown") {
      return `soundcloud:${parsed.type}:${parsed.id}`;
    }
  }

  return `${source || "mapped_music"}:url:${sha1(url).slice(0, 20)}`;
}

export function parseMappedMusicSourceKey(sourceKey = "") {
  const parts = String(sourceKey || "").split(":");
  return {
    source: parts[0] || "mapped_music",
    type: parts[1] || "unknown",
    id: parts.slice(2).join(":") || ""
  };
}

export function getMappedMusicCachePaths(sourceKey = "") {
  const key = String(sourceKey || "").trim();
  const hash = sha1(key).slice(0, 12);
  const stem = `${safeFilePart(key)}.${hash}`;
  const dir = ensureCacheDir();
  return {
    dir,
    jsonFile: path.join(dir, `${stem}.json`),
    urlListFile: path.join(dir, `${stem}.urls.txt`)
  };
}

function readJsonFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn("[mapped-music-cache] failed to read manifest:", error?.message || error);
    return null;
  }
}

function atomicCacheTempPath(filePath) {
  const target = path.resolve(filePath);
  const dir = path.dirname(target);
  if (dir !== path.resolve(CACHE_DIR)) throw new Error("Mapped music cache path escapes cache root");
  return path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
}

function writeJsonAtomic(filePath, payload) {
  ensureCacheDir();
  const tmp = atomicCacheTempPath(filePath);
  try {
    // Cache destination is fixed under CACHE_DIR and uses randomized exclusive temporary creation.
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, filePath);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function writeTextAtomic(filePath, value = "") {
  ensureCacheDir();
  const tmp = atomicCacheTempPath(filePath);
  try {
    fs.writeFileSync(tmp, String(value || ""), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, filePath);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function normalizeManifest(raw = {}, sourceKey = "") {
  const parsed = parseMappedMusicSourceKey(raw?.sourceKey || sourceKey);
  const tracks = (Array.isArray(raw?.tracks) ? raw.tracks : [])
    .map((entry, index) => normalizeManifestEntry(entry, index))
    .filter((entry) => entry.sourceItemKey);

  return {
    version: MANIFEST_VERSION,
    sourceKey: safeString(raw?.sourceKey || sourceKey, 500),
    sourceProvider: safeString(raw?.sourceProvider || parsed.source, 80),
    sourceType: safeString(raw?.sourceType || parsed.type, 80),
    sourceId: safeString(raw?.sourceId || parsed.id, 240),
    title: safeString(raw?.title, 500),
    originalUrl: safeString(raw?.originalUrl, 1500),
    createdAt: raw?.createdAt || nowIso(),
    updatedAt: raw?.updatedAt || nowIso(),
    itemCount: Number(raw?.itemCount || tracks.length || 0) || tracks.length,
    matchedCount: Number(raw?.matchedCount || tracks.filter((entry) => entry.youtubeId).length || 0),
    tracks
  };
}

function normalizeManifestEntry(raw = {}, fallbackIndex = 0) {
  const youtubeId = safeString(raw.youtubeId || raw.id, 120);
  const youtubeUrl = safeString(raw.youtubeUrl || raw.webpage_url || raw.url, 1500);
  const durationMs = toDurationMs(raw.duration_ms ?? raw.durationMs) ||
    (Number.isFinite(Number(raw.duration)) && Number(raw.duration) > 0
      ? Number(raw.duration) * 1000
      : null);
  return {
    sourceItemKey: safeString(raw.sourceItemKey, 500),
    sourceProvider: safeString(raw.sourceProvider, 80),
    sourceItemId: safeString(raw.sourceItemId, 240),
    sourceItemUrl: safeString(raw.sourceItemUrl, 1500),
    sourceTitle: safeString(raw.sourceTitle || raw.title, 500),
    sourceArtist: safeString(raw.sourceArtist || raw.artist || raw.uploader, 500),
    sourceAlbum: safeString(raw.sourceAlbum || raw.album, 500),
    sourceCoverUrl: safeString(raw.sourceCoverUrl || raw.coverUrl || raw.thumbnailUrl || raw.imageUrl, 1500) || null,
    duration_ms: durationMs,
    index: Number(raw.index || fallbackIndex + 1) || fallbackIndex + 1,
    matchStatus: youtubeId ? "matched" : "unmatched",
    youtubeId: youtubeId || null,
    youtubeTitle: safeString(raw.youtubeTitle || raw.title, 500),
    youtubeUploader: safeString(raw.youtubeUploader || raw.uploader, 500),
    youtubeDuration_ms: toDurationMs(raw.youtubeDuration_ms ?? raw.youtubeDurationMs) ||
      (Number.isFinite(Number(raw.youtubeDuration)) && Number(raw.youtubeDuration) > 0
        ? Number(raw.youtubeDuration) * 1000
        : null),
    matchValidationVersion: Math.max(0, Number(raw.matchValidationVersion || 0) || 0),
    youtubeUrl,
    thumbnail: safeString(raw.thumbnail, 1500) || null,
    matchedAt: raw.matchedAt || nowIso(),
    updatedAt: raw.updatedAt || raw.matchedAt || nowIso()
  };
}

export function readMappedMusicManifest(sourceKey = "") {
  const paths = getMappedMusicCachePaths(sourceKey);
  return normalizeManifest(readJsonFile(paths.jsonFile) || { sourceKey }, sourceKey);
}

function writeMappedMusicManifest(manifest) {
  const normalized = normalizeManifest({
    ...manifest,
    updatedAt: nowIso(),
    itemCount: Array.isArray(manifest?.tracks) ? manifest.tracks.length : 0,
    matchedCount: (Array.isArray(manifest?.tracks) ? manifest.tracks : []).filter((entry) => entry?.youtubeId).length
  }, manifest?.sourceKey);
  const paths = getMappedMusicCachePaths(normalized.sourceKey);
  const urls = idsToMusicUrls(
    normalized.tracks
      .map((entry) => entry.youtubeId)
      .filter(Boolean)
  );
  writeJsonAtomic(paths.jsonFile, normalized);
  writeTextAtomic(paths.urlListFile, urls.join("\n"));
  return {
    manifest: normalized,
    jsonFile: paths.jsonFile,
    urlListFile: paths.urlListFile
  };
}

function parseProviderTrackIdFromUrl(rawUrl = "", source = "") {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  if (source === "spotify") {
    const parsed = parseSpotifyUrl(value);
    return parsed?.type === "track" ? parsed.id || "" : "";
  }
  if (source === "deezer") {
    const parsed = parseDeezerUrl(value);
    return parsed?.type === "track" ? String(parsed.id || "") : "";
  }
  if (source === "apple_music") {
    const parsed = parseAppleMusicUrl(value);
    return parsed?.type === "track" ? String(parsed.id || "") : "";
  }
  if (source === "tidal") {
    const parsed = parseTidalUrl(value);
    return parsed?.type === "track" ? String(parsed.id || "") : "";
  }
  if (source === "soundcloud") {
    const parsed = parseSoundCloudUrl(value);
    return parsed?.type === "track" ? String(parsed.id || "") : "";
  }
  return "";
}

export function getMappedMusicSourceItemUrl(item = {}, source = "") {
  if (source === "apple_music") {
    return item.amUrl || item.webpage_url || item.spUrl || "";
  }
  if (source === "deezer") {
    return item.deezerUrl || item.dzUrl || item.webpage_url || "";
  }
  if (source === "tidal") {
    return item.tidalUrl || item.webpage_url || "";
  }
  if (source === "soundcloud") return item.soundcloudUrl || item.scUrl || item.webpage_url || "";
  return item.spUrl || item.webpage_url || "";
}

export function getMappedMusicSourceItemId(item = {}, source = "") {
  if (source === "apple_music") {
    return String(item.apple_track_id || parseProviderTrackIdFromUrl(getMappedMusicSourceItemUrl(item, source), source) || "").trim();
  }
  if (source === "deezer") {
    return String(item.deezer_track_id || parseProviderTrackIdFromUrl(getMappedMusicSourceItemUrl(item, source), source) || "").trim();
  }
  if (source === "tidal") {
    return String(item.tidal_track_id || parseProviderTrackIdFromUrl(getMappedMusicSourceItemUrl(item, source), source) || "").trim();
  }
  if (source === "soundcloud") {
    return String(item.soundcloud_urn || item.soundcloud_track_id || parseProviderTrackIdFromUrl(getMappedMusicSourceItemUrl(item, source), source) || "").trim();
  }
  return String(item.spId || parseProviderTrackIdFromUrl(getMappedMusicSourceItemUrl(item, source), source) || "").trim();
}

export function getMappedMusicSourceItemKey(item = {}, source = "") {
  const provider = String(source || item.sourceProvider || item.source_provider || "mapped_music").toLowerCase();
  const id = getMappedMusicSourceItemId(item, provider);
  if (id) return `${provider}:track:${id}`;

  const fallback = [
    provider,
    norm(item.artist || item.uploader || ""),
    norm(item.title || item.track || ""),
    norm(item.album || ""),
    Number.isFinite(Number(item.duration_ms)) ? Math.round(Number(item.duration_ms)) : ""
  ].join("|");

  return `${provider}:track-fallback:${sha1(fallback).slice(0, 24)}`;
}

function manifestEntryFromMatch({
  sourceItem,
  matchItem,
  source,
  index
}) {
  const sourceItemUrl = getMappedMusicSourceItemUrl(sourceItem, source);
  const youtubeId = safeString(matchItem?.id, 120);
  return normalizeManifestEntry({
    sourceItemKey: getMappedMusicSourceItemKey(sourceItem, source),
    sourceProvider: source,
    sourceItemId: getMappedMusicSourceItemId(sourceItem, source),
    sourceItemUrl,
    sourceTitle: sourceItem?.title || sourceItem?.track || "",
    sourceArtist: sourceItem?.artist || sourceItem?.uploader || "",
    sourceAlbum: sourceItem?.album || "",
    sourceCoverUrl: sourceItem?.coverUrl || sourceItem?.thumbnailUrl || sourceItem?.imageUrl || "",
    duration_ms: toDurationMs(sourceItem?.duration_ms),
    index,
    youtubeId,
    youtubeTitle: matchItem?.title || "",
    youtubeUploader: matchItem?.uploader || "",
    youtubeDuration_ms: Number.isFinite(Number(matchItem?.duration)) && Number(matchItem?.duration) > 0
      ? Number(matchItem.duration) * 1000
      : null,
    matchValidationVersion: source === "soundcloud" ? 1 : (isCatalogMusicProvider(source) ? 2 : 0),
    youtubeUrl: matchItem?.webpage_url || (youtubeId ? idsToMusicUrls([youtubeId])[0] : ""),
    thumbnail: matchItem?.thumbnail || null,
    matchedAt: nowIso(),
    updatedAt: nowIso()
  }, Math.max(0, Number(index || 1) - 1));
}

export function mappedItemFromManifestEntry(entry = {}, index = 0) {
  const normalized = normalizeManifestEntry(entry, index);
  const duration = normalized.duration_ms
    ? Math.max(1, Math.round(normalized.duration_ms / 1000))
    : null;
  return {
    index: index + 1,
    id: normalized.youtubeId || null,
    title: normalized.youtubeTitle || normalized.sourceTitle || "",
    uploader: normalized.youtubeUploader || normalized.sourceArtist || "",
    duration,
    duration_string: formatDurationMs(normalized.duration_ms),
    webpage_url: normalized.youtubeUrl || "",
    thumbnail: normalized.thumbnail || normalized.sourceCoverUrl || null,
    sourceProvider: normalized.sourceProvider || null,
    sourceItemKey: normalized.sourceItemKey || null,
    sourceItemId: normalized.sourceItemId || null,
    sourceItemUrl: normalized.sourceItemUrl || null,
    sourceTitle: normalized.sourceTitle || null,
    sourceArtist: normalized.sourceArtist || null,
    sourceCoverUrl: normalized.sourceCoverUrl || null,
    album: normalized.sourceAlbum || null,
    duration_ms: normalized.duration_ms ?? null
  };
}

export async function mapMappedMusicWithCache(
  sp,
  {
    url = "",
    source = "",
    concurrency = 4,
    onUpdate = null,
    onLog = null,
    shouldCancel = null,
    forceRefresh = false,
    // A missing match can be caused by a transient yt-dlp/network/configuration
    // failure. Do not make that negative result permanent across later jobs.
    refreshUnmatched = true,
    replaceManifest = true,
    indexOffset = 0
  } = {}
) {
  const sourceProvider = String(source || sp?.provider || detectSource(url) || "spotify").toLowerCase();
  const sourceKey = getMappedMusicSourceKey(url, sourceProvider);
  const sourceInfo = parseMappedMusicSourceKey(sourceKey);
  const manifest = readMappedMusicManifest(sourceKey);
  const existingByKey = new Map(manifest.tracks.map((entry) => [entry.sourceItemKey, entry]));
  const items = Array.isArray(sp?.items) ? sp.items : [];
  const output = new Array(items.length);
  const currentEntries = new Array(items.length);
  const missingItems = [];
  const missingIndexes = [];
  let cacheHits = 0;

  for (let localIndex = 0; localIndex < items.length; localIndex++) {
    const sourceItem = items[localIndex];
    const sourceItemKey = getMappedMusicSourceItemKey(sourceItem, sourceProvider);
    const cached = existingByKey.get(sourceItemKey);
    const requiredMatchValidationVersion = sourceProvider === "soundcloud"
      ? 1
      : (isCatalogMusicProvider(sourceProvider) ? 2 : 0);
    const needsMatchRevalidation =
      cached &&
      requiredMatchValidationVersion > 0 &&
      Number(cached.matchValidationVersion || 0) < requiredMatchValidationVersion;
    const useCached =
      cached &&
      !forceRefresh &&
      !needsMatchRevalidation &&
      !(refreshUnmatched && !cached.youtubeId);

    if (useCached) {
      const entry = normalizeManifestEntry({
        ...cached,
        index: indexOffset + localIndex + 1,
        sourceProvider,
        sourceItemKey,
        sourceItemId: getMappedMusicSourceItemId(sourceItem, sourceProvider) || cached.sourceItemId,
        sourceItemUrl: getMappedMusicSourceItemUrl(sourceItem, sourceProvider) || cached.sourceItemUrl,
        sourceTitle: sourceItem?.title || sourceItem?.track || cached.sourceTitle,
        sourceArtist: sourceItem?.artist || sourceItem?.uploader || cached.sourceArtist,
        sourceAlbum: sourceItem?.album || cached.sourceAlbum,
        sourceCoverUrl: sourceItem?.coverUrl || sourceItem?.thumbnailUrl || sourceItem?.imageUrl || cached.sourceCoverUrl,
        duration_ms: toDurationMs(sourceItem?.duration_ms) || cached.duration_ms
      }, indexOffset + localIndex);
      const mapped = mappedItemFromManifestEntry(entry, indexOffset + localIndex);
      output[localIndex] = mapped;
      currentEntries[localIndex] = entry;
      cacheHits++;
      if (onUpdate) onUpdate(localIndex, mapped, { cached: true, sourceItemKey, entry });
      continue;
    }

    missingIndexes.push(localIndex);
    missingItems.push(sourceItem);
  }

  if (missingItems.length > 0) {
    await mapSpotifyToYtm(
      { ...sp, provider: sourceProvider, items: missingItems },
      (missingLocalIndex, matchItem) => {
        const localIndex = missingIndexes[missingLocalIndex];
        const sourceItem = items[localIndex];
        const entry = manifestEntryFromMatch({
          sourceItem,
          matchItem,
          source: sourceProvider,
          index: indexOffset + localIndex + 1
        });
        const mapped = mappedItemFromManifestEntry(entry, indexOffset + localIndex);
        output[localIndex] = mapped;
        currentEntries[localIndex] = entry;
        if (onUpdate) onUpdate(localIndex, mapped, {
          cached: false,
          sourceItemKey: entry.sourceItemKey,
          entry
        });
      },
      {
        concurrency,
        onLog,
        shouldCancel
      }
    );
  }

  const mergedByKey = new Map(replaceManifest
    ? []
    : manifest.tracks.map((entry) => [entry.sourceItemKey, entry]));

  currentEntries
    .filter(Boolean)
    .forEach((entry) => mergedByKey.set(entry.sourceItemKey, entry));

  const nextTracks = replaceManifest
    ? currentEntries.filter(Boolean)
    : Array.from(mergedByKey.values()).sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));

  const writeResult = writeMappedMusicManifest({
    ...manifest,
    sourceKey,
    sourceProvider,
    sourceType: sourceInfo.type,
    sourceId: sourceInfo.id,
    title: safeString(sp?.title || manifest.title, 500),
    originalUrl: safeString(url || manifest.originalUrl, 1500),
    tracks: nextTracks,
    createdAt: manifest.createdAt || nowIso()
  });

  return {
    items: output,
    manifest: writeResult.manifest,
    sourceKey,
    jsonFile: writeResult.jsonFile,
    urlListFile: writeResult.urlListFile,
    cacheHits,
    newlyMapped: missingItems.length,
    matchedCount: output.filter((item) => item?.id).length
  };
}
