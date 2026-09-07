import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { sendOk, sendError, uniqueId } from "../modules/utils.js";
import { sanitizeLogValue } from "../modules/security.js";
import { createDownloadQueue } from "../modules/sp.js";
import { mapMappedMusicWithCache } from "../modules/mappedMusicCache.js";
import {
  isSpotifyUrl,
  resolveSpotifyUrl,
  resolveSpotifyUrlLite,
  resolveSpotifyUrlTitle,
  findSpotifyMetaById,
  findSpotifyMetaByQuery
} from "../modules/spotify.js";
import { spotifyMapTasks, jobs, killJobProcesses, createJob, registerJobProcess, getJobProcessCount, markJobCompleted } from "../modules/store.js";
import { convertMedia, downloadThumbnail, retagMediaFile } from "../modules/media.js";
import { ZipArchive } from "archiver";
import { resolveMarket } from "../modules/market.js";
import { isVideoFormat, processYouTubeVideoJob } from "../modules/video.js";
import {
  findAppleTrackMetaById,
  findAppleTrackMetaByQuery,
  isAppleMusicUrl,
  resolveAppleMusicUrl,
  resolveAppleMusicUrlLite,
  resolveAppleMusicUrlTitle
} from "../modules/apple.js";
import {
  findDeezerTrackMetaById,
  findDeezerTrackMetaByQuery,
  isDeezerUrl,
  resolveDeezerUrl,
  resolveDeezerUrlLite,
  resolveDeezerUrlTitle
} from "../modules/deezer.js";
import {
  findTidalTrackMetaById,
  findTidalTrackMetaByQuery,
  isTidalUrl,
  resolveTidalUrl,
  resolveTidalUrlLite,
  resolveTidalUrlTitle
} from "../modules/tidal.js";
import {
  findSoundCloudTrackMetaById,
  findSoundCloudTrackMetaByQuery,
  isSoundCloudUrl,
  resolveSoundCloudUrl,
  resolveSoundCloudUrlLite,
  resolveSoundCloudUrlTitle
} from "../modules/soundcloud.js";
import {
  resolveJobOutputDir,
  toDownloadPath,
  resolveDownloadPathToAbs
} from "../modules/outputPaths.js";
import { queueOwnershipFix } from "../modules/fsOwnership.js";
import {
  normalizeRingtoneConfig,
  resolveRingtoneBitrate,
  resolveRingtoneOutputFormat,
  resolveRingtoneSampleRate
} from "../modules/ringtone.js";
import {
  resolveSpotifyConcurrency
} from "../modules/concurrency.js";

const router = express.Router();

const BASE_DIR   = process.env.DATA_DIR || process.cwd();
const OUTPUT_DIR = path.resolve(BASE_DIR, "outputs");
const TEMP_DIR   = path.resolve(BASE_DIR, "temp");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

console.log("[spotify] BASE_DIR   =", BASE_DIR);
console.log("[spotify] OUTPUT_DIR =", OUTPUT_DIR);
console.log("[spotify] TEMP_DIR   =", TEMP_DIR);

// Converts absolute output path to public download path with fallback.
function toDownloadPathSafe(absPath) {
  return (
    toDownloadPath(absPath, OUTPUT_DIR) ||
    `/download/${encodeURIComponent(path.basename(absPath || ""))}`
  );
}

// Handles make map id in Spotify mapping and metadata flow.
function makeMapId() { return uniqueId("map"); }

// Removes Spotify temp files or directories with safe existence checks.
function safeRmTempPath(targetPath) {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return;
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(targetPath);
    }
  } catch {}
}

// Resolves cover for retag for Spotify mapping and metadata flow.
async function resolveCoverForRetag({
  absOutputPath,
  preferUrl,
  jobId,
  logicalIndex
}) {
  try {
    const baseNoExt = absOutputPath.replace(/\.[^.]+$/, "");
    for (const ext of [".jpg", ".jpeg", ".png", ".webp"]) {
      const cand = `${baseNoExt}${ext}`;
      if (fs.existsSync(cand)) return cand;
    }

    if (preferUrl) {
      const jobTempDir = path.join(TEMP_DIR, jobId);
      try { fs.mkdirSync(jobTempDir, { recursive: true }); } catch {}
      const outBase = path.join(
        jobTempDir,
        `.retag_cover_${logicalIndex}_${Date.now()}`
      );
      const dl = await downloadThumbnail(preferUrl, outBase);
      if (dl && fs.existsSync(dl)) return dl;
    }
  } catch {}
  return null;
}

// Handles make bg access token in Spotify mapping and metadata flow.
function makeBgToken() {
  try { return crypto.randomBytes(8).toString("hex"); }
  catch { return String(Date.now()); }
}

// Formats fps text for live conversion logs in Spotify mapping and metadata flow.
function formatLiveFps(fps) {
  const n = Number(fps);
  if (!Number.isFinite(n) || n <= 0) return "--";
  return n.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

// Builds live conversion log line with duration and real fps.
function buildLiveConvertLog(progress, details = {}, label = "") {
  const pct = Math.max(0, Math.min(100, Math.floor(Number(progress) || 0)));
  const elapsed = details?.elapsedText || "--:--:--";
  const duration = details?.durationText || "--:--:--";
  const fps = formatLiveFps(details?.fps);
  const suffix = label ? `: ${label}` : "";
  return `⚙️ Converting ${pct}% (${elapsed}/${duration} • ${fps} FPS)${suffix}`;
}

// Fills missing metadata fields from a secondary metadata payload.
function mergeMissingMeta(base, extra) {
  if (!extra) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value == null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    if (out[key] == null || out[key] === "") {
      out[key] = value;
    }
  }
  return out;
}

// Enriches mapped metadata with Apple Music fallback data when available.
async function enrichMetaWithApple(meta, { fallbackArtist = "", fallbackTitle = "", market = "" } = {}) {
  if (process.env.APPLE_TAG_FALLBACK === "0") return meta;

  const artist = String(meta?.artist || meta?.album_artist || fallbackArtist || "").trim();
  const title = String(meta?.track || meta?.title || fallbackTitle || "").trim();
  if (!title) return meta;

  try {
    const appleMeta = await findAppleTrackMetaByQuery(artist, title, {
      album: meta?.album || "",
      market,
      targetDurationMs: Number(meta?.duration_ms || 0) || null
    });
    let fallbackMeta = appleMeta;
    if (!fallbackMeta) {
      try {
        fallbackMeta = await findDeezerTrackMetaByQuery(artist, title, {
          album: meta?.album || "",
          targetDurationMs: Number(meta?.duration_ms || 0) || null
        });
      } catch {}
    }
    return mergeMissingMeta(meta, fallbackMeta);
  } catch {
    return meta;
  }
}

// Checks whether the URL belongs to Spotify or Apple Music mapped sources.
function isMappedMusicUrl(url) {
  return isSpotifyUrl(url) || isAppleMusicUrl(url) || isDeezerUrl(url) || isTidalUrl(url) || isSoundCloudUrl(url);
}

// Resolves the mapped music source from Spotify or Apple Music URLs.
function musicSourceFromUrl(url) {
  if (isAppleMusicUrl(url)) return "apple_music";
  if (isDeezerUrl(url)) return "deezer";
  if (isTidalUrl(url)) return "tidal";
  if (isSoundCloudUrl(url)) return "soundcloud";
  return "spotify";
}

// Returns the mapped music source label for Spotify mapping and metadata flow.
function musicSourceLabel(source = "") {
  const value = String(source || "").toLowerCase();
  if (value === "apple_music") return "Apple Music";
  if (value === "deezer") return "Deezer";
  if (value === "tidal") return "TIDAL";
  if (value === "soundcloud") return "SoundCloud";
  return "Spotify";
}

// Builds the default playlist title for mapped Spotify or Apple Music sources.
function musicPlaylistFallback(source = "") {
  return `${musicSourceLabel(source)} Playlist`;
}

// Resolves mapped music URLs with the lightweight Spotify or Apple Music resolver.
async function resolveMappedMusicUrlLite(
  url,
  { market, streamDeezerSearch = false, maxItems = 1000 } = {}
) {
  if (isAppleMusicUrl(url)) return resolveAppleMusicUrlLite(url, { market });
  if (isDeezerUrl(url)) {
    return resolveDeezerUrlLite(url, {
      market,
      streamBatches: streamDeezerSearch,
      maxItems
    });
  }
  if (isTidalUrl(url)) return resolveTidalUrlLite(url, { market, maxItems });
  if (isSoundCloudUrl(url)) return resolveSoundCloudUrlLite(url, { maxItems });
  return resolveSpotifyUrlLite(url, { market });
}

// Resolves mapped music URLs with the full Spotify or Apple Music resolver.
async function resolveMappedMusicUrl(url, { market } = {}) {
  if (isAppleMusicUrl(url)) return resolveAppleMusicUrl(url, { market });
  if (isDeezerUrl(url)) return resolveDeezerUrl(url, { market });
  if (isTidalUrl(url)) return resolveTidalUrl(url, { market, maxItems: 1000 });
  if (isSoundCloudUrl(url)) return resolveSoundCloudUrl(url, { maxItems: 1000 });
  return resolveSpotifyUrl(url, { market });
}

// Finds track metadata from the active mapped source for Spotify mapping and metadata flow.
async function findMappedTrackMeta(itemLite, source, market) {
  if (source === "apple_music") {
    if (itemLite?.apple_track_id) {
      return findAppleTrackMetaById(itemLite.apple_track_id, { market });
    }
    return findAppleTrackMetaByQuery(itemLite?.artist, itemLite?.title, {
      album: itemLite?.album || "",
      market,
      targetDurationMs: Number(itemLite?.duration_ms || 0) || null
    });
  }

  if (source === "deezer") {
    if (itemLite?.deezer_track_id) {
      return findDeezerTrackMetaById(itemLite.deezer_track_id);
    }
    return findDeezerTrackMetaByQuery(itemLite?.artist, itemLite?.title, {
      album: itemLite?.album || "",
      targetDurationMs: Number(itemLite?.duration_ms || 0) || null
    });
  }

  if (source === "tidal") {
    const title = String(itemLite?.title || "").trim();
    const artist = String(itemLite?.artist || itemLite?.uploader || "").trim();
    if (title && artist) {
      return {
        title,
        track: title,
        artist,
        uploader: artist,
        album: itemLite?.album || "",
        album_artist: itemLite?.album_artist || artist,
        release_year: itemLite?.year || "",
        release_date: itemLite?.date || "",
        track_number: itemLite?.track_number ?? null,
        disc_number: itemLite?.disc_number ?? null,
        track_total: itemLite?.track_total ?? null,
        disc_total: itemLite?.disc_total ?? null,
        isrc: itemLite?.isrc || "",
        coverUrl: itemLite?.coverUrl || "",
        duration_ms: itemLite?.duration_ms ?? null,
        webpage_url: itemLite?.tidalUrl || itemLite?.webpage_url || "",
        tidal_track_id: itemLite?.tidal_track_id ?? null,
        tidal_album_id: itemLite?.tidal_album_id ?? null,
        tidal_artist_id: itemLite?.tidal_artist_id ?? null,
        source_provider: "tidal",
        source_store: "tidal"
      };
    }
    if (itemLite?.tidal_track_id) {
      return findTidalTrackMetaById(itemLite.tidal_track_id, {
        market,
        albumId: itemLite?.tidal_album_id || null
      });
    }
    return findTidalTrackMetaByQuery(itemLite?.artist, itemLite?.title, {
      album: itemLite?.album || "",
      market,
      targetDurationMs: Number(itemLite?.duration_ms || 0) || null
    });
  }

  if (source === "soundcloud") {
    if (itemLite?.soundcloud_track_id || itemLite?.soundcloud_urn) {
      return findSoundCloudTrackMetaById(itemLite.soundcloud_urn || itemLite.soundcloud_track_id, { item: itemLite });
    }
    return findSoundCloudTrackMetaByQuery(itemLite?.artist, itemLite?.title, { item: itemLite });
  }

  if (itemLite?.spId) {
    return findSpotifyMetaById(itemLite.spId);
  }

  return findSpotifyMetaByQuery(itemLite?.artist, itemLite?.title, market);
}

router.post("/api/spotify/url-title", async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();
    const market = resolveMarket(req.body?.market);
    if (!url || !isMappedMusicUrl(url)) {
      return sendError(res, "UNSUPPORTED_MUSIC_URL", "Unsupported mapped music URL", 400);
    }

    let title = "";
    if (isAppleMusicUrl(url)) {
      title = await resolveAppleMusicUrlTitle(url, { market });
    } else if (isDeezerUrl(url)) {
      title = await resolveDeezerUrlTitle(url);
    } else if (isTidalUrl(url)) {
      title = await resolveTidalUrlTitle(url, { market });
    } else if (isSoundCloudUrl(url)) {
      title = await resolveSoundCloudUrlTitle(url);
    } else {
      title = await resolveSpotifyUrlTitle(url);
    }

    title = String(title || "").trim();
    if (!title) {
      return sendError(res, "MUSIC_URL_TITLE_NOT_FOUND", "Music URL title could not be resolved", 404);
    }

    return sendOk(res, {
      title,
      provider: musicSourceFromUrl(url)
    });
  } catch (error) {
    return sendError(
      res,
      "MUSIC_URL_TITLE_FAILED",
      sanitizeLogValue(error?.message || "Music URL title could not be resolved"),
      502
    );
  }
});

router.post("/api/spotify/process/start", async (req, res) => {
  try {
    const {
      url,
      format: rawFormat = "mp3",
      bitrate: rawBitrate = "192k",
      sampleRate: rawSampleRate = "48000",
      market: marketIn,
      includeLyrics,
      embedLyrics,
      volumeGain,
      loudnorm,
      loudnormMode,
      compressionLevel,
      bitDepth,
      videoSettings = {},
      spotifyConcurrency,
      autoCreateZip
    } = req.body || {};
    let format = rawFormat;
    let bitrate = rawBitrate;
    let sampleRate = rawSampleRate;
    const ringtone = normalizeRingtoneConfig(
      req.body?.ringtone || {
        outputMode: req.body?.outputMode,
        enabled: req.body?.outputMode === "ringtone",
        target: req.body?.ringtoneTarget,
        mode: req.body?.ringtoneMode,
        durationSec: req.body?.ringtoneDurationSec,
        startSec: req.body?.ringtoneStartSec,
        endSec: req.body?.ringtoneEndSec,
        fadeInSec: req.body?.ringtoneFadeInSec,
        fadeOutSec: req.body?.ringtoneFadeOutSec
      }
    );

    if (ringtone?.enabled) {
      format = resolveRingtoneOutputFormat(ringtone, format);
      bitrate = resolveRingtoneBitrate(ringtone, bitrate);
      sampleRate = String(resolveRingtoneSampleRate(ringtone, sampleRate));
    }

    let includeLyricsFlag =
      includeLyrics === true || includeLyrics === "true" || includeLyrics === "1";
    let embedLyricsFlag =
      embedLyrics === true || embedLyrics === "true" || embedLyrics === "1";
    if (ringtone?.enabled) {
      includeLyricsFlag = false;
      embedLyricsFlag = false;
    }
    const isVideoOutput = isVideoFormat(format);
    const isEnabledFlag = (value) =>
      value === true || value === "true" || value === "1" || value === 1;
    const normalizeLoudnormMode = (value) => {
      const mode = String(value || "").trim().toLowerCase();
      if (mode === "two_pass") return "two_pass";
      if (mode === "dynamic") return "dynamic";
      return "ebu_r128";
    };

    const autoCreateZipFlag =
      !isVideoOutput && (
        autoCreateZip === undefined
          ? true
          : (autoCreateZip === true || autoCreateZip === "true")
      );

    // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
    console.log('[music-match] UI sent spotifyConcurrency =', sanitizeLogValue(spotifyConcurrency));

    const volumeGainNum = volumeGain != null ? Number(volumeGain) : null;
    const loudnormFlag = isEnabledFlag(loudnorm);
    const loudnormModeNormalized = normalizeLoudnormMode(loudnormMode);
    if (!url || !isMappedMusicUrl(url)) {
      return sendError(res, 'UNSUPPORTED_URL_FORMAT', "Spotify, Apple Music, Deezer, TIDAL, or SoundCloud URL is required", 400);
    }

    const source = musicSourceFromUrl(url);
    const sourceLabel = musicSourceLabel(source);

    const effectiveSpotifyConcurrency = resolveSpotifyConcurrency(spotifyConcurrency);

    console.log('[music-match] effectiveSpotifyConcurrency =', {
      effectiveSpotifyConcurrency
    });

	    const bgToken = makeBgToken();
	    const job = createJob({
	    status: "queued",
	    progress: 0,
    format,
    bitrate,
    sampleRate: parseInt(sampleRate) || 48000,
    volumeGain: volumeGainNum,
    loudnorm: loudnormFlag,
    loudnormMode: loudnormFlag ? loudnormModeNormalized : null,
    compressionLevel: compressionLevel != null ? Number(compressionLevel) : null,
    bitDepth: bitDepth || null,
    videoSettings: isVideoOutput ? videoSettings : null,
	    metadata: {
	      source,
	      spotifyUrl: url,
	      spotifyKind: null,
	      spotifyTitle: null,
	      isPlaylist: false,
	      isAlbum: false,
	      isAutomix: false,
      includeLyrics: includeLyricsFlag,
      embedLyrics: embedLyricsFlag,
      volumeGain: volumeGainNum,
      loudnorm: loudnormFlag,
      loudnormMode: loudnormFlag ? loudnormModeNormalized : null,
      compressionLevel: compressionLevel != null ? Number(compressionLevel) : null,
      bitDepth: bitDepth || null,
      ringtone: ringtone || null,
      autoCreateZip: autoCreateZipFlag,
      spotifyConcurrency: effectiveSpotifyConcurrency,
      bgToken
    },
	        resultPath: null,
	        error: null,
	        playlist: { total: 0, done: 0 },
	        phase: "preparing",
	        currentPhase: "preparing",
	        lastLogKey: "log.starting",
	        lastLogVars: {},
	        lastLog: `⏳ Starting ${sourceLabel} job...`
      });
      const jobId = job.id;

      sendOk(res, {
        jobId,
        id: jobId,
        title: "-",
        total: 0,
        message: `${sourceLabel} processing started`
      });

      setImmediate(async () => {
        const j = jobs.get(jobId);
        if (!j) return;
        if (j.metadata?.bgToken !== bgToken) return;

        try {
          let sp;
          try {
            sp = await resolveMappedMusicUrlLite(url, {
              market: resolveMarket(marketIn),
              streamDeezerSearch: source === "deezer",
              maxItems: 1000
            });
          } catch (e) {
            const msg = String(e?.message || "");
            if (msg.startsWith("SPOTIFY_MIX_UNSUPPORTED")) {
              j.status = "error";
              j.error = "SPOTIFY_MIX_UNSUPPORTED";
              j.phase = "error"; j.currentPhase = "error";
              j.lastLogKey = "SPOTIFY_MIX_UNSUPPORTED";
              j.lastLogVars = {};
              j.lastLog = "❌ Spotify Mix unsupported (404). Copy tracks to a normal playlist and retry.";
              return;
            }
            throw e;
          }

	          j.status = "processing";
	          j.phase = "mapping";
	          j.currentPhase = "mapping";
	          j.metadata.spotifyKind  = sp.kind;
	          j.metadata.spotifyTitle = sp.title;
	          j.metadata.isPlaylist   = sp.kind === "playlist";
          j.metadata.isAlbum      = sp.kind === "album";
          j.playlist.total = Math.max(
            sp.items?.length || 0,
            Number(sp.totalHint) || 0
          );
          j.lastLogKey = "status.mappingStarted";
          j.lastLogVars = { title: sp.title, total: j.playlist.total };
          j.lastLog = `🔍 Mapping started: ${sp.title} (${j.playlist.total} track)`;

          await processSpotifyIntegrated(jobId, sp, format, bitrate, { market: marketIn });
        } catch (err) {
          const jj = jobs.get(jobId);
          if (!jj) return;
          jj.status = "error";
          jj.error = err?.message || String(err);
          jj.phase = "error"; jj.currentPhase = "error";
          jj.lastLogKey = "log.error";
          jj.lastLogVars = { err: jj.error };
          jj.lastLog = `❌ Error: ${jj.error}`;
          console.error("[music-match/process/start bg] error:", sanitizeLogValue(err?.message || err));
        }
      });

    } catch (e) {
      return sendError(res, 'PROCESS_FAILED', e.message || "Music matching processing error", 400);
    }
});

// Creates limiter for Spotify mapping and metadata flow.
function createLimiter(max) {
  let active = 0;
  const queue = [];

  const run = (fn) => new Promise((resolve, reject) => {
    // Handles task in Spotify mapping and metadata flow.
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

// Processes Spotify metadata integrated in Spotify mapping and metadata flow.
async function processSpotifyIntegrated(jobId, sp, format, bitrate, { market } = {}) {
  const job = jobs.get(jobId);
  if (!job) return;
  const allFiles = [];

  try {
    const source = String(job.metadata?.source || "spotify").toLowerCase();
    const sourceLabel = musicSourceLabel(source);
    const playlistFallback = musicPlaylistFallback(source);
    const outputDir = resolveJobOutputDir(job, OUTPUT_DIR);
    const effectiveVolumeGain =
      job.metadata?.volumeGain != null
        ? job.metadata.volumeGain
        : (job.volumeGain != null ? job.volumeGain : null);

    job.phase = "mapping";
    job.currentPhase = "mapping";
    job.progress = 5;
    job.downloadProgress = 0;
    job.convertProgress = 0;
    job.metadata.selectedIds   = job.metadata.selectedIds   || [];
    job.metadata.frozenEntries = job.metadata.frozenEntries || [];
    job.metadata.frozenTitle   = job.metadata.frozenTitle   || job.metadata.spotifyTitle;

    const isVideoFormatFlag = isVideoFormat(format);

    let matchedCount = 0;
    const initialItems = Array.isArray(sp?.items) ? sp.items : [];
    let totalItems = Math.max(
      initialItems.length,
      Number(sp?.totalHint) || 0
    );

    if (initialItems.length <= 0) {
      throw new Error(`${sourceLabel} playlist has no readable tracks`);
    }

    job.playlist.total = totalItems;
    job.playlist.done = 0;
    job.playlist.downloaded = 0;
    job.playlist.converted = 0;
    job.playlist.downloadTotal = 0;
    job.playlist.convertTotal = 0;
    job.playlist.matched = 0;
    job.playlist.mappingDone = 0;
    job.playlist.mappingTotal = totalItems;
    job.playlist.mappingProgress = 0;
    job.playlist.mappingCompleted = false;

    // Determines whether cancel should run for Spotify mapping and metadata flow.
    const shouldCancel = () => {
    const j = jobs.get(jobId);
    return !!(j && (j.canceled || j.status === "canceled"));
  };

  const isCanceledError = (err) =>
    String(err?.message || "").toUpperCase() === "CANCELED";

    const parallel = Math.max(
      1,
      Math.min(
        16,
        resolveSpotifyConcurrency(job.metadata?.spotifyConcurrency)
      )
    );

    console.log(`[music-match ${jobId}] download/convert parallel =`, parallel);

    const results = new Array(totalItems);
    const convertPromises = [];
    const runLimitedConvert = createLimiter(parallel);
    const richMetaByIndex = new Map();
    const outputAbsByIndex = new Map();
    const coverUrlByIndex = new Map();
    const matchedLogicalIndices = new Set();
    const mappedLogicalIndices = new Set();
    const runMetaLimited = createLimiter(Math.max(1, Math.min(8, Math.floor(parallel * 2))));
    const mktResolved = resolveMarket(market);

    const metadataPromises = [];
    const queueMetadataForItems = (items, indexOffset = 0) => {
      for (let localIndex = 0; localIndex < items.length; localIndex++) {
        const itemLite = items[localIndex];
        const logicalIndex = indexOffset + localIndex;
        metadataPromises[logicalIndex] = runMetaLimited(async () => {
          if (shouldCancel()) return null;
          let rich = null;
          try {
            rich = await findMappedTrackMeta(itemLite, source, mktResolved);
          } catch {}

          const baseMeta = {
            title: itemLite.title,
            track: itemLite.title,
            artist: itemLite.artist,
            uploader: itemLite.artist,
            album: itemLite.album || "",
            album_artist: itemLite.album_artist || itemLite.artist,
            track_number: itemLite.track_number ?? null,
            disc_number: itemLite.disc_number ?? null,
            track_total: itemLite.track_total ?? null,
            disc_total: itemLite.disc_total ?? null,
            isrc: itemLite.isrc || "",
            release_year: itemLite.year || "",
            release_date: itemLite.date || "",
            webpage_url: itemLite.spUrl || itemLite.amUrl || itemLite.deezerUrl || itemLite.dzUrl || itemLite.tidalUrl || itemLite.soundcloudUrl || itemLite.scUrl || itemLite.webpage_url || "",
            genre: itemLite.genre || "",
            label: itemLite.label || "",
            publisher: itemLite.label || "",
            copyright: itemLite.copyright || "",
            coverUrl: itemLite.coverUrl || "",
            duration_ms: itemLite.duration_ms ?? null
          };

          let merged = { ...baseMeta };
          for (const [k, v] of Object.entries(rich || {})) {
            if (v == null) continue;
            if (typeof v === "string" && !v.trim()) continue;
            merged[k] = v;
          }
          try {
            merged = await enrichMetaWithApple(merged, {
              fallbackArtist: itemLite.artist,
              fallbackTitle: itemLite.title,
              market: mktResolved
            });
          } catch {}

          richMetaByIndex.set(logicalIndex, merged);
          if (merged.coverUrl) coverUrlByIndex.set(logicalIndex, merged.coverUrl);
          return merged;
        }).catch(() => null);
      }
    };

    queueMetadataForItems(initialItems, 0);

    // Converts downloaded item for Spotify mapping and metadata flow.
    const convertDownloadedItem = async (dlResult, idxZeroBased) => {
      if (shouldCancel()) {
        console.log(`[music-match ${jobId}] convertDownloadedItem → canceled before start, skipping`);
        return;
      }

      const filePath = dlResult.filePath;
      const entry = dlResult.item;
      const logicalIndex = (dlResult.index != null ? dlResult.index - 1 : idxZeroBased);

      let spInfo = Array.isArray(sp.items) ? (sp.items[logicalIndex] || null) : null;
      if (!spInfo && Array.isArray(sp.items) && sp.items.length) {
        spInfo = sp.items.find((item) =>
          item.title?.toLowerCase() === entry.title?.toLowerCase() &&
          (item.artist || "").toLowerCase().includes((entry.uploader || "").toLowerCase())
        ) || null;
      }

      const preferSpotify = process.env.PREFER_SPOTIFY_TAGS === "1";
      const richNow = richMetaByIndex.get(logicalIndex) || null;
      let fileMeta = (preferSpotify && (richNow || spInfo)) ? {
        title: (richNow?.title || spInfo?.title || entry.title),
        track: (richNow?.title || spInfo?.title || entry.title),
        artist: (richNow?.artist || spInfo?.artist || entry.uploader),
        uploader: (richNow?.artist || spInfo?.artist || entry.uploader),
        album: (richNow?.album || spInfo?.album || ""),
        playlist_title: job.metadata.spotifyTitle,
        webpage_url: (
          richNow?.webpage_url ||
          richNow?.spUrl ||
          richNow?.amUrl ||
          spInfo?.spUrl ||
          spInfo?.amUrl ||
          spInfo?.webpage_url ||
          entry.webpage_url
        ),
        release_year: (richNow?.release_year || spInfo?.year || ""),
        release_date: (richNow?.release_date || spInfo?.date || ""),
        track_number: (richNow?.track_number ?? spInfo?.track_number),
        disc_number:  (richNow?.disc_number ?? spInfo?.disc_number),
        track_total:  (richNow?.track_total ?? spInfo?.track_total),
        disc_total:   (richNow?.disc_total ?? spInfo?.disc_total),
        isrc:         (richNow?.isrc || spInfo?.isrc || ""),
        album_artist: (richNow?.album_artist || spInfo?.album_artist || ""),
        genre:        (richNow?.genre || spInfo?.genre || ""),
        label:        (richNow?.label || spInfo?.label || ""),
        publisher:    (richNow?.publisher || richNow?.label || spInfo?.label || ""),
        copyright:    (richNow?.copyright || spInfo?.copyright || ""),
        coverUrl:     (richNow?.coverUrl || spInfo?.coverUrl || ""),
        duration_ms:  (richNow?.duration_ms ?? spInfo?.duration_ms ?? null)
      } : {
        title: entry.title,
        track: entry.title,
        uploader: entry.uploader,
        artist: entry.uploader,
        album: job.metadata.spotifyTitle,
        playlist_title: job.metadata.spotifyTitle,
        webpage_url: entry.webpage_url,
        duration_ms: null
      };

      fileMeta = await enrichMetaWithApple(fileMeta, {
        fallbackArtist: spInfo?.artist || entry.uploader,
        fallbackTitle: spInfo?.title || entry.title,
        market: mktResolved
      });

      const preferredCoverUrl =
        richNow?.coverUrl ||
        spInfo?.coverUrl ||
        fileMeta?.coverUrl ||
        null;

      if (preferSpotify) {
        if (preferredCoverUrl) fileMeta.coverUrl = preferredCoverUrl;
        fileMeta.thumbnailUrl = undefined;
        fileMeta.imageUrl = undefined;
      }

      let itemCover = null;
      const baseNoExt = filePath.replace(/\.[^.]+$/, "");

      if (preferSpotify && preferredCoverUrl) {
          try {
            const dl = await downloadThumbnail(preferredCoverUrl, `${baseNoExt}.spotify_cover`);
            if (dl && fs.existsSync(dl)) itemCover = dl;
          } catch {}
      }

      if (!itemCover) {
        for (const ext of [".jpg", ".jpeg", ".png", ".webp"]) {
          const cand = `${baseNoExt}${ext}`;
          if (fs.existsSync(cand)) { itemCover = cand; break; }
        }
      }

      try {
        if (shouldCancel()) { throw new Error("CANCELED"); }
        if (job.phase !== "converting") {
          job.phase = "converting";
          job.currentPhase = "converting";
          job.progress = Math.max(job.progress, 70);
          job.downloadProgress = Math.max(job.downloadProgress || 0, 100);
          job.convertProgress = job.convertProgress || 0;
          job.playlist.total = job.playlist.total || totalItems;
          job.playlist.done = job.playlist.done || 0;
          job.lastLogKey = 'log.converting.batch';
          job.lastLogVars = { total: job.playlist.total };
          job.lastLog = `⚙️ Converting ${job.playlist.total} track(s)...`;
        }

        job.lastLogKey = 'log.converting.single';
        job.lastLogVars = { title: entry.title };
        job.lastLog = `⚙️ Converting: ${entry.title}`;

        const result = await convertMedia(
          filePath, format, bitrate, `${jobId}_${logicalIndex}`,
          (progress, details) => {
            const totalForProgress = job.playlist.total || totalItems || 1;
            const fileProgress = (logicalIndex / totalForProgress) * 25;
            const cur = (progress / 100) * (25 / totalForProgress);
            job.convertProgress = Math.min(
              100,
              Math.floor(70 + fileProgress + cur)
            );
            job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);

            if (isVideoFormat(format)) {
              const label = [entry?.uploader || entry?.artist || "", entry?.title || ""]
                .map((s) => String(s || "").trim())
                .filter(Boolean)
                .join(" - ");
              job.lastLogKey = null;
              job.lastLogVars = null;
              job.lastLog = buildLiveConvertLog(progress, details, label);
            }
          },
          fileMeta,
          itemCover,
          isVideoFormat(format),
          outputDir,
          TEMP_DIR,
          {
            outputRootDir: OUTPUT_DIR,
            onProcess: (child) => { try { registerJobProcess(jobId, child); } catch {} },
            includeLyrics: !!job.metadata.includeLyrics,
            embedLyrics: !!job.metadata.embedLyrics,
            sampleRate: job.sampleRate || 48000,
            volumeGain: job.metadata?.volumeGain ?? job.volumeGain ?? null,
            loudnorm: !!job.metadata?.loudnorm,
            loudnormMode: job.metadata?.loudnormMode || null,
            compressionLevel: job.metadata?.compressionLevel ?? job.compressionLevel ?? undefined,
            bitDepth: job.metadata?.bitDepth ?? job.bitDepth ?? undefined,
            ringtone: job.metadata?.ringtone || null,
            onLyricsStats: (delta) => {
              if (!delta) return;
              const m = job.metadata || (job.metadata = {});
              const cur = m.lyricsStats || { found: 0, notFound: 0 };
              cur.found += Number(delta.found || 0);
              cur.notFound += Number(delta.notFound || 0);
              m.lyricsStats = cur;
            }
          }
        );

        if (job.metadata.includeLyrics) {
          if (result && result.lyricsPath) {
            job.lastLog = `🎼 Lyrics added: ${path.basename(result.lyricsPath)}`;
          } else {
            job.lastLog = `🎼 Lyrics not found: ${entry.title}`;
          }
        }

        results[logicalIndex] = result;

        try {
          if (result?.outputPath) {
            const abs = resolveDownloadPathToAbs(result.outputPath, OUTPUT_DIR);
            outputAbsByIndex.set(logicalIndex, abs);
          }
        } catch {}

        try {
          const abs = outputAbsByIndex.get(logicalIndex);
          const rich = await metadataPromises[logicalIndex];
          if (abs && rich && fs.existsSync(abs)) {
            const coverPath = await resolveCoverForRetag({
              absOutputPath: abs,
              preferUrl: rich.coverUrl || coverUrlByIndex.get(logicalIndex) || null,
              jobId,
              logicalIndex
            });
            await retagMediaFile(
              abs,
              format,
              { ...rich, playlist_title: job.metadata.spotifyTitle },
              coverPath,
              {
                jobId,
                tempDir: TEMP_DIR,
                onProcess: (child) => {
                  try { registerJobProcess(jobId, child); } catch {}
                }
              }
            );
          }
        } catch {}

        job.lastLogKey = 'log.converting.ok';
        job.lastLogVars = { title: entry.title };
        job.lastLog = `✅ Converted: ${entry.title}`;
      } catch (convertError) {
        if (isCanceledError(convertError)) {
          console.log(`[music-match ${jobId}] Conversion canceled for: ${entry.title}`);
          return;
        }

        // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
        console.error(`Conversion error (${sanitizeLogValue(entry.title)}):`, sanitizeLogValue(convertError?.message || convertError));
        job.lastLogKey = 'log.converting.err';
        job.lastLogVars = { title: entry.title, err: convertError.message };
        job.lastLog = `❌ Conversion error: ${entry.title} - ${convertError.message}`;
        results[logicalIndex] = { outputPath: null, error: convertError.message };
      } finally {
        job.playlist.converted = (job.playlist.converted || 0) + 1;
        job.playlist.done = job.playlist.converted;
      }
    };

    const dlQueue = !isVideoFormatFlag
      ? createDownloadQueue(jobId, {
          concurrency: parallel,
          onProgress: (done, _queueTotal) => {
          job.playlist.downloaded = done;
          const totalForProgress = Math.max(1, Number(job.playlist.total) || totalItems || 1);
          job.downloadProgress = Math.floor((done / totalForProgress) * 100);
          job.lastLogKey = 'log.downloading.progress';
          job.lastLogVars = { done, total: totalForProgress };
          job.lastLog = `📥 Downloading: ${done}/${totalForProgress}`;

          const dlPct = done / totalForProgress;
          if (job.phase === "downloading") {
            job.progress = Math.max(job.progress, Math.floor(30 + dlPct * 40));
          }
        },
          onLog: (payload) => {
            const { logKey, logVars, fallback } =
              (typeof payload === 'string')
                ? { logKey: null, logVars: null, fallback: payload }
                : payload;
            job.lastLogKey  = logKey || null;
            job.lastLogVars = logVars || null;
            job.lastLog     = fallback || '';
            console.log(`[music-match ${jobId}] ${fallback || job.lastLogKey || ''}`);
          },
          shouldCancel,
          onItemDone: (dlResult, idx) => {
            if (!dlResult || !dlResult.filePath) return;
            if (shouldCancel()) {
              console.log(`[music-match ${jobId}] onItemDone → job canceled, skipping convert enqueue`);
              return;
            }

            allFiles.push(dlResult.filePath);

            const p = runLimitedConvert(() => convertDownloadedItem(dlResult, idx))
              .catch(err => {
                if (!isCanceledError(err)) {
                  console.error(`[music-match ${jobId}] convert pipeline error:`, err);
                }
              });

            convertPromises.push(p);
          }
        })
      : null;
    const mapBatch = async (batchItems, indexOffset = 0, replaceManifest = true) => {
      if (!Array.isArray(batchItems) || !batchItems.length) return;

      await mapMappedMusicWithCache(
        { ...sp, items: batchItems },
        {
          url: job.metadata?.spotifyUrl || "",
          source,
          concurrency: parallel,
          shouldCancel,
          replaceManifest,
          indexOffset,
          onUpdate: (localIdx, item) => {
            if (shouldCancel()) return;
            const idx = indexOffset + localIdx;
            const totalForProgress = Math.max(1, Number(job.playlist.total) || totalItems || 1);

            // Mapping callbacks run concurrently and therefore arrive out of
            // source order. Track completed logical indexes instead of using
            // idx as progress; idx-based progress can jump backwards.
            mappedLogicalIndices.add(idx);
            job.playlist.mappingDone = mappedLogicalIndices.size;
            job.playlist.mappingTotal = totalForProgress;
            const mappingProgress = Math.max(
              0,
              Math.min(100, Math.floor((mappedLogicalIndices.size / totalForProgress) * 100))
            );
            job.playlist.mappingProgress = Math.max(
              Number(job.playlist.mappingProgress) || 0,
              mappingProgress
            );
            job.progress = Math.max(
              Number(job.progress) || 0,
              5 + Math.floor((job.playlist.mappingProgress / 100) * 25)
            );
            job.lastLogKey = 'log.searchingTrack';
            job.lastLogVars = { artist: item.uploader, title: item.title };
            job.lastLog = `🔍 Searching: ${item.uploader} - ${item.title}`;

            if (item.id) {
              const firstMatchForIndex = !matchedLogicalIndices.has(idx);
              matchedLogicalIndices.add(idx);
              matchedCount = matchedLogicalIndices.size;
              job.playlist.matched = matchedCount;
              job.metadata.selectedIds[idx] = item.id;
              job.metadata.frozenEntries[idx] = {
                index: item.index,
                id: item.id,
                title: item.title,
                uploader: item.uploader,
                webpage_url: item.webpage_url
              };

              // A mapper callback may be retried/replayed for the same logical
              // track. Count and enqueue each source position only once.
              if (dlQueue && firstMatchForIndex) {
                dlQueue.enqueue(
                  {
                    index: item.index,
                    id: item.id,
                    title: item.title,
                    uploader: item.uploader,
                    webpage_url: item.webpage_url
                  },
                  idx
                );
              }
            }
          },
          onLog: (payload) => {
            const { logKey, logVars, fallback } =
              (typeof payload === 'string')
                ? { logKey: null, logVars: null, fallback: payload }
                : payload;
            job.lastLogKey  = logKey || null;
            job.lastLogVars = logVars || null;
            job.lastLog     = fallback || '';
            console.log(`[music-match ${jobId}] ${fallback || job.lastLogKey || ''}`);
          }
        }
      );
    };

    const batchIterator = sp?.itemBatches?.[Symbol.asyncIterator]?.();
    let prefetchedBatch = batchIterator ? batchIterator.next() : null;

    await mapBatch(initialItems, 0, true);

    while (prefetchedBatch) {
      if (shouldCancel()) throw new Error("CANCELED");
      const next = await prefetchedBatch;
      if (next.done) break;

      // Prefetch only one Deezer page ahead: bounded memory, no API burst.
      prefetchedBatch = batchIterator.next();
      const batchItems = Array.isArray(next.value?.items) ? next.value.items : [];
      if (!batchItems.length) continue;

      const indexOffset = sp.items.length;
      sp.items.push(...batchItems);
      totalItems = Math.max(
        sp.items.length,
        Number(next.value?.total) || 0
      );
      job.playlist.total = totalItems;
      job.playlist.mappingTotal = totalItems;
      if (results.length < totalItems) results.length = totalItems;
      queueMetadataForItems(batchItems, indexOffset);

      job.lastLogKey = null;
      job.lastLogVars = null;
      job.lastLog = `📚 Deezer results loaded: ${sp.items.length}/${totalItems}`;
      await mapBatch(batchItems, indexOffset, false);
    }

    // Once discovery is finished, use the exact discovered count for final progress/ZIP stats.
    totalItems = sp.items.length;
    job.playlist.total = totalItems;
    job.playlist.mappingTotal = totalItems;
    job.playlist.mappingDone = totalItems;
    job.playlist.mappingProgress = 100;
    job.playlist.mappingCompleted = true;
    job.progress = Math.max(Number(job.progress) || 0, 30);
    results.length = Math.max(results.length, totalItems);

    if (shouldCancel()) { throw new Error("CANCELED"); }

    job.metadata.selectedIds = (job.metadata.selectedIds || []).filter(Boolean);
    job.metadata.frozenEntries = (job.metadata.frozenEntries || []).filter(Boolean);
    matchedCount = job.metadata.frozenEntries.length;
    job.playlist.matched = matchedCount;

    if (matchedCount === 0) {
      throw new Error("No matching tracks found");
    }

    job.playlist.downloadTotal = matchedCount;
    job.playlist.convertTotal  = matchedCount;

    if (isVideoFormatFlag && ["spotify", "apple_music", "deezer", "tidal", "soundcloud"].includes(job.metadata?.source)) {
      console.log(`🎬 Redirecting ${sourceLabel} to video processing: ${matchedCount} track(s)`);

      const trackCount = matchedCount;
      const playlistTitle = job.metadata.spotifyTitle || playlistFallback;

      job.lastLogKey = 'log.spotify.videoProcessing';
      job.lastLogVars = {
        title: playlistTitle,
        count: trackCount
      };
      job.lastLog = `🎬 Starting ${sourceLabel} video processing: ${playlistTitle} (${trackCount} track(s))`;

      await processYouTubeVideoJob(job, { OUTPUT_DIR: outputDir, OUTPUT_ROOT_DIR: OUTPUT_DIR, TEMP_DIR });

      cleanupSpotifyTempFiles(jobId, null, null);
      return;
    }

    dlQueue.end();
    job.phase = "downloading";
    job.currentPhase = "downloading";
    job.lastLogKey = 'log.downloading.waitAll';
    job.lastLogVars = {};
    job.lastLog = `⏳ Matching completed. Starting download + convert pipeline...`;

    await dlQueue.waitForIdle();
    if (shouldCancel()) { throw new Error("CANCELED"); }

    await Promise.all(convertPromises);
    if (shouldCancel()) { throw new Error("CANCELED"); }

    const downloadResults = dlQueue.getResults();
    for (const dlResult of downloadResults) {
      const logicalIndex = Number(dlResult?.idxZeroBased);
      if (!Number.isFinite(logicalIndex) || logicalIndex < 0) continue;
      if (!matchedLogicalIndices.has(logicalIndex)) continue;
      if (!dlResult?.error) continue;
      if (Object.prototype.hasOwnProperty.call(results, logicalIndex)) continue;

      results[logicalIndex] = {
        outputPath: null,
        error: dlResult.error,
        stage: "download"
      };
    }

    for (const logicalIndex of matchedLogicalIndices) {
      if (Object.prototype.hasOwnProperty.call(results, logicalIndex)) continue;
      results[logicalIndex] = {
        outputPath: null,
        error: "Matched track did not reach conversion",
        stage: "pipeline"
      };
    }

    if (job.metadata.includeLyrics && job.metadata.lyricsStats) {
      const stats = job.metadata.lyricsStats;
      job.lastLog = `📊 Lyrics summary: ${stats.found} found, ${stats.notFound} not found`;
    }

    const failedResults = results.filter((r) => r && r.error);
    const successfulResults = results.filter(r => r && r.outputPath && !r.error);
    if (!successfulResults.length) {
      throw new Error("No tracks could be converted");
    }

    job.errorsCount = failedResults.length;
    job.playlist.skipped = failedResults.length;
    job.playlist.done = Math.max(job.playlist.done || 0, successfulResults.length + failedResults.length);
    job.resultPath = successfulResults;

    if (job.metadata?.autoCreateZip) {
      try {
        const zipTitle = job.metadata.spotifyTitle || playlistFallback;
        job.lastLogKey = 'log.zip.creating';
        job.lastLogVars = {};
        job.lastLog = `📦 Creating ZIP file...`;
        job.zipPath = await makeZipFromOutputs(
          jobId,
          successfulResults,
          zipTitle,
          !!job.metadata.includeLyrics,
          outputDir
        );
        job.lastLogKey = 'log.zip.ready';
        job.lastLogVars = { title: zipTitle };
        job.lastLog = `✅ ZIP file is ready: ${zipTitle}`;
      } catch (e) {
        console.warn("ZIP creation error:", e);
        job.lastLogKey = 'log.zip.error';
        job.lastLogVars = { err: e.message };
        job.lastLog = `❌ ZIP creation error: ${e.message}`;
      }
    } else {
    }

    markJobCompleted(job);
    job.progress = 100;
    job.downloadProgress = 100;
    job.convertProgress = 100;
    job.phase = "completed";
    job.currentPhase = "completed";
    if (failedResults.length > 0) {
      job.lastLogKey = null;
      job.lastLogVars = null;
      job.lastLog = `🎉 All operations completed! ${successfulResults.length} track(s) converted successfully, ${failedResults.length} failed.`;
    } else {
      job.lastLogKey = 'log.done';
      job.lastLogVars = { ok: successfulResults.length };
      job.lastLog = `🎉 All operations completed! ${successfulResults.length} track(s) converted successfully.`;
    }

    cleanupSpotifyTempFiles(jobId, allFiles);

  } catch (error) {
	    if (String(error?.message || "").toUpperCase() === "CANCELED") {
	      job.status = "canceled";
	      job.error = null;
      job.phase = "canceled"; job.currentPhase = "canceled";
      job.downloadProgress = 0;
      job.convertProgress = 0;
	      job.lastLogKey = 'status.canceled';
	      job.lastLogVars = {};
	      job.lastLog = "⛔ Canceled";
	      try { killJobProcesses(jobId); } catch {}
	      scheduleSpotifyTempCleanup(jobId, allFiles);
	    } else {
      job.status = "error";
      job.error = error.message;
      job.phase = "error"; job.currentPhase = "error";
      job.downloadProgress = 0;
      job.convertProgress = 0;
      job.lastLogKey = 'log.error';
      job.lastLogVars = { err: error.message };
      job.lastLog = `❌ Error: ${error.message}`;
      console.error("Spotify integrated processing error:", error);
    }
  }
}

// Processes single track in Spotify mapping and metadata flow.
async function processSingleTrack(jobId, sp, format, bitrate) {
  const job = jobs.get(jobId);
  if (!job) return;
  let filePath = null;
  const source = String(job.metadata?.source || "spotify").toLowerCase();

  try {
    const outputDir = resolveJobOutputDir(job, OUTPUT_DIR);
    job.phase = "mapping"; job.currentPhase = "mapping";
    job.progress = 10;
    job.lastLogKey = 'log.searchingSingleTrack';
    job.lastLogVars = { artist: sp.items[0]?.artist, title: sp.items[0]?.title };
    job.lastLog = `🔍 Searching: ${sp.items[0]?.artist} - ${sp.items[0]?.title}`;

    let matchedItem = null;
    // Determines whether cancel should run for Spotify mapping and metadata flow.
    const shouldCancel = () => {
      const j = jobs.get(jobId);
      return !!(j && (j.canceled || j.status === "canceled"));
    };

    await mapMappedMusicWithCache(sp, {
      url: job.metadata?.spotifyUrl || "",
      source,
      concurrency: 1,
      shouldCancel,
      onUpdate: (_idx, item) => {
      if (shouldCancel()) return;
      if (item.id) {
        matchedItem = item;
        job.metadata.selectedIds = [item.id];
        job.metadata.frozenEntries = [{
          index: 1,
          id: item.id,
          title: item.title,
          uploader: item.uploader,
          webpage_url: item.webpage_url
        }];
      }
    },
      onLog: (payload) => {
        const { logKey, logVars, fallback } = (typeof payload === 'string')
          ? { logKey: null, logVars: null, fallback: payload }
          : payload;
        job.lastLogKey = logKey || null;
        job.lastLogVars = logVars || null;
        job.lastLog = fallback || '';
      }
    });

    if (shouldCancel()) { throw new Error("CANCELED"); }
    if (!matchedItem) {
      throw new Error("Track could not be matched");
    }

    job.phase = "downloading"; job.currentPhase = "downloading";
    job.progress = 30;
    job.lastLogKey = 'log.downloading.single';
    job.lastLogVars = { title: matchedItem.title };
    job.lastLog = `📥 Downloading: ${matchedItem.title}`;

    const dlQueue = createDownloadQueue(jobId, {
      concurrency: 1,
      shouldCancel,
      onProgress: (done, total) => {
        job.playlist.done = done;
        job.progress = 30 + (done * 40);
      },
      onLog: (payload) => {
        const { logKey, logVars, fallback } = (typeof payload === 'string')
          ? { logKey: null, logVars: null, fallback: payload }
          : payload;
        job.lastLogKey = logKey || null;
        job.lastLogVars = logVars || null;
        job.lastLog = fallback || '';
      }
    });

    dlQueue.enqueue({
      index: 1,
      id: matchedItem.id,
      title: matchedItem.title,
      uploader: matchedItem.uploader,
      webpage_url: matchedItem.webpage_url
    }, 0);
    dlQueue.end();
    await dlQueue.waitForIdle();
    if (shouldCancel()) { throw new Error("CANCELED"); }

    const downloadResults = dlQueue.getResults();
    const successfulDownload = downloadResults.find(r => r.filePath);

    if (!successfulDownload) {
      const firstErr = downloadResults.find(r => r?.error)?.error || "unknown download error";
      job.lastLogKey  = 'log.downloading.err';
      job.lastLogVars = { err: firstErr };
      job.lastLog     = `❌ Download error: ${firstErr}`;
      throw new Error(`Track could not be downloaded: ${firstErr}`);
    }

    job.phase = "converting"; job.currentPhase = "converting";
    job.progress = 80;
    job.lastLogKey = 'log.converting.single';
    job.lastLogVars = { title: matchedItem.title };
    job.lastLog = `⚙️ Converting: ${matchedItem.title}`;

    filePath = successfulDownload.filePath;
    const preferSpotify = process.env.PREFER_SPOTIFY_TAGS === "1";
    const spInfo = sp.items[0];
    let richNow = null;
    try {
      richNow = await findMappedTrackMeta(
        spInfo,
        source,
        resolveMarket(job.metadata?.market)
      );
    } catch {}

    let fileMeta = preferSpotify ? {
      title: spInfo.title,
      track: spInfo.title,
      artist: spInfo.artist,
      uploader: spInfo.artist,
      album: spInfo.album || "",
      webpage_url:
        spInfo.webpage_url ||
        spInfo.spUrl ||
        spInfo.amUrl ||
        spInfo.dzUrl ||
        matchedItem.webpage_url,
      release_year: spInfo.year || "",
      release_date: spInfo.date || "",
      track_number: spInfo.track_number,
      disc_number: spInfo.disc_number,
      track_total: spInfo.track_total,
      disc_total: spInfo.disc_total,
      isrc: spInfo.isrc,
      album_artist: spInfo.album_artist || "",
      genre:        spInfo.genre || "",
      label:        spInfo.label || "",
      publisher:    spInfo.label || "",
      copyright:    spInfo.copyright || "",
      coverUrl:     richNow?.coverUrl || spInfo.coverUrl || "",
      duration_ms:  richNow?.duration_ms ?? spInfo?.duration_ms ?? null
    } : {
      title: matchedItem.title,
      track: matchedItem.title,
      uploader: matchedItem.uploader,
      artist: matchedItem.uploader,
      webpage_url: matchedItem.webpage_url,
      duration_ms: null
    };

    fileMeta = mergeMissingMeta(fileMeta, richNow);
    fileMeta = await enrichMetaWithApple(fileMeta, {
      fallbackArtist: spInfo?.artist || matchedItem.uploader,
      fallbackTitle: spInfo?.title || matchedItem.title,
      market: resolveMarket(job.metadata?.market)
    });

      const preferredCoverUrl =
        richNow?.coverUrl ||
        spInfo?.coverUrl ||
        fileMeta?.coverUrl ||
        null;

      if (preferSpotify) {
        if (preferredCoverUrl) fileMeta.coverUrl = preferredCoverUrl;
        fileMeta.thumbnailUrl = undefined;
        fileMeta.imageUrl = undefined;
      }

      let itemCover = null;
      const baseNoExt = filePath.replace(/\.[^.]+$/, "");

      if (preferSpotify && preferredCoverUrl) {
          try {
            const dl = await downloadThumbnail(preferredCoverUrl, `${baseNoExt}.spotify_cover`);
            if (dl && fs.existsSync(dl)) itemCover = dl;
          } catch {}
      }

      if (!itemCover) {
        for (const ext of [".jpg", ".jpeg", ".png", ".webp"]) {
          const cand = `${baseNoExt}${ext}`;
          if (fs.existsSync(cand)) { itemCover = cand; break; }
        }
      }

    const result = await convertMedia(
      filePath, format, bitrate, jobId,
      (progress, details) => {
        job.progress = 80 + Math.floor(progress * 0.2);

        if (isVideoFormat(format)) {
          const label = [matchedItem?.uploader || matchedItem?.artist || "", matchedItem?.title || ""]
            .map((s) => String(s || "").trim())
            .filter(Boolean)
            .join(" - ");
          job.lastLogKey = null;
          job.lastLogVars = null;
          job.lastLog = buildLiveConvertLog(progress, details, label);
        }
      },
      fileMeta, itemCover, isVideoFormat(format),
      outputDir,
      TEMP_DIR,
      {
        outputRootDir: OUTPUT_DIR,
        onProcess: (child) => { try { registerJobProcess(jobId, child); } catch {} },
        includeLyrics: !!job.metadata.includeLyrics,
        embedLyrics: !!job.metadata.embedLyrics,
        sampleRate: job.sampleRate || 48000,
        volumeGain: job.metadata?.volumeGain ?? job.volumeGain ?? null,
        loudnorm: !!job.metadata?.loudnorm,
        loudnormMode: job.metadata?.loudnormMode || null,
        compressionLevel: job.metadata?.compressionLevel ?? job.compressionLevel ?? undefined,
        bitDepth: job.metadata?.bitDepth ?? job.bitDepth ?? undefined,
        ringtone: job.metadata?.ringtone || null,
        onLyricsStats: (delta) => {
          if (!delta) return;
          const m = job.metadata || (job.metadata = {});
          const cur = m.lyricsStats || { found: 0, notFound: 0 };
          cur.found += Number(delta.found || 0);
          cur.notFound += Number(delta.notFound || 0);
          m.lyricsStats = cur;
        }
      }
    );

    job.resultPath = result;
    markJobCompleted(job);
    job.progress = 100;
    job.phase = "completed"; job.currentPhase = "completed";
    job.playlist.done = 1;
    job.lastLogKey = 'log.done.single';
    job.lastLogVars = { title: matchedItem.title };
    job.lastLog = `🎉 Processing completed: ${matchedItem.title}`;

    cleanupSpotifyTempFiles(jobId, [filePath]);

  } catch (error) {
	    if (String(error?.message || "").toUpperCase() === "CANCELED") {
	      job.status = "canceled";
	      job.error = null;
      job.phase = "canceled"; job.currentPhase = "canceled";
	      job.lastLogKey = 'status.canceled';
	      job.lastLogVars = {};
	      job.lastLog = "⛔ Canceled";
	      try { killJobProcesses(jobId); } catch {}
	      scheduleSpotifyTempCleanup(jobId, [filePath]);
	    } else {
      job.status = "error";
      job.error = error.message;
      job.phase = "error"; job.currentPhase = "error";
      job.lastLogKey = 'log.error';
      job.lastLogVars = { err: error.message };
      job.lastLog = `❌ Error: ${error.message}`;
      console.error("Single track processing error:", error);
    }
  }
}

// Handles make zip from outputs in Spotify mapping and metadata flow.
async function makeZipFromOutputs(
  jobId,
  outputs,
  titleHint = "playlist",
  includeLyrics = false,
  outputDir = OUTPUT_DIR
) {
  const outDir = path.resolve(outputDir || OUTPUT_DIR);
  fs.mkdirSync(outDir, { recursive: true });

  const safeBase = `${(titleHint || 'playlist')}_${jobId}`
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .slice(0, 200);

  const zipName = `${safeBase}.zip`;
  const zipAbs  = path.join(outDir, zipName);

  return new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(zipAbs);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on("close", async () => {
      await queueOwnershipFix(zipAbs);
      resolve(toDownloadPathSafe(zipAbs));
    });
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);

    for (const r of outputs) {
      if (!r?.outputPath) continue;
      const abs = resolveDownloadPathToAbs(r.outputPath, OUTPUT_DIR);
      if (abs && fs.existsSync(abs)) {
        archive.file(abs, { name: path.basename(abs).normalize("NFC") });
        if (includeLyrics) {
          const lrcPath = abs.replace(/\.[^/.]+$/, "") + ".lrc";
          if (fs.existsSync(lrcPath)) {
            archive.file(lrcPath, { name: path.basename(lrcPath).normalize("NFC") });
          }
        }
      }
    }
    archive.finalize();
  });
}

// Cleans up Spotify metadata temp files for Spotify mapping and metadata flow.
function cleanupSpotifyTempFiles(jobId, files) {
  try {
    if (Array.isArray(files)) {
      files.forEach(f => {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
      });
    }

    try {
      const jobIdText = String(jobId || "").trim();
      for (const name of fs.readdirSync(TEMP_DIR)) {
        if (!name) continue;
        const isJobArtifact =
          name === `${jobIdText}.urls.txt` ||
          name.startsWith(jobIdText) ||
          name.startsWith(`.cover_${jobIdText}_`) ||
          name.startsWith(`.${jobIdText}_`);
        if (!isJobArtifact) continue;
        safeRmTempPath(path.join(TEMP_DIR, name));
      }
    } catch {}

    const jobDir = path.join(TEMP_DIR, jobId);
    if (fs.existsSync(jobDir)) {
      safeRmTempPath(jobDir);
    }
  } catch (e) {
    console.warn("Cleanup error:", e);
  }
}

// Schedules Spotify temp cleanup after active job processes have fully exited.
function scheduleSpotifyTempCleanup(jobId, files) {
  let attemptsLeft = 15;
  let finalized = false;
  const tick = () => {
    const activeCount = Number(getJobProcessCount(jobId) || 0) || 0;
    attemptsLeft -= 1;
    if (activeCount <= 0) {
      try { cleanupSpotifyTempFiles(jobId, files); } catch {}
      if (!finalized) {
        finalized = true;
        const finalTimer = setTimeout(() => {
          try { cleanupSpotifyTempFiles(jobId, files); } catch {}
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

router.post("/api/spotify/preview/start", async (req, res) => {
  try {
    const { url, market: marketIn } = req.body || {};
    if (!url || !isMappedMusicUrl(url)) {
      return sendError(res, 'UNSUPPORTED_URL_FORMAT', "Spotify, Apple Music, Deezer, TIDAL, or SoundCloud URL is required", 400);
    }

    const source = musicSourceFromUrl(url);
    const sourceLabel = musicSourceLabel(source);
    const effectiveMapConcurrency = resolveSpotifyConcurrency(
      req.body?.spotifyConcurrency,
      req.body?.youtubeConcurrency,
      req.body?.concurrency
    );

    let sp;
    try {
      sp = source === "deezer"
        ? await resolveMappedMusicUrlLite(url, {
            market: resolveMarket(marketIn),
            streamDeezerSearch: true,
            maxItems: 1000
          })
        : await resolveMappedMusicUrl(url, { market: resolveMarket(marketIn) });
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.startsWith("SPOTIFY_MIX_UNSUPPORTED")) {
        return sendError(
          res,
          'SPOTIFY_MIX_UNSUPPORTED',
          "This link is a personalized Spotify Mix. The Spotify Web API cannot provide this content (404). Please copy the tracks from the Mix into a new playlist in the Spotify app and send that playlist URL instead.",
          400
        );
      }
      throw e;
    }
    const id = makeMapId();
    const task = {
      id,
      url,
      source,
      status: "running",
      title: sp.title || (sp.kind === "track" ? `${sourceLabel} Track` : `${sourceLabel} Playlist`),
      total: Math.max((sp.items || []).length, Number(sp.totalHint) || 0),
      done: 0,
      items: [],
      logs: [],
      createdAt: new Date(),
      validItems: [],
      matchedIndexes: new Set(),
      matchedCount: 0,
      jobId: null
    };
    spotifyMapTasks.set(id, task);

    (async () => {
      let cacheHits = 0;
      let newlyMapped = 0;
      let lastResult = null;

      const mapPreviewBatch = async (batchItems, indexOffset = 0, replaceManifest = true) => {
        if (!Array.isArray(batchItems) || !batchItems.length) return;
        const result = await mapMappedMusicWithCache(
          { ...sp, items: batchItems },
          {
            url,
            source,
            concurrency: effectiveMapConcurrency,
            replaceManifest,
            indexOffset,
            onUpdate: (localIdx, item) => {
              const idx = indexOffset + localIdx;
              task.items[idx] = item;
              task.done++;
              if (item?.id) {
                task.matchedIndexes.add(idx);
                task.matchedCount = task.matchedIndexes.size;
                task.validItems[idx] = item;
              }
            },
            onLog: (log) => {
              task.logs.push({ time: new Date(), message: log });
              console.log(`[music-match ${id}] ${typeof log === "string" ? log : (log?.fallback || log?.logKey || "")}`);
            }
          }
        );
        cacheHits += Number(result?.cacheHits || 0);
        newlyMapped += Number(result?.newlyMapped || 0);
        lastResult = result;
      };

      const initialItems = Array.isArray(sp.items) ? sp.items : [];
      const batchIterator = sp?.itemBatches?.[Symbol.asyncIterator]?.();
      let prefetchedBatch = batchIterator ? batchIterator.next() : null;

      await mapPreviewBatch(initialItems, 0, true);

      while (prefetchedBatch) {
        const next = await prefetchedBatch;
        if (next.done) break;
        prefetchedBatch = batchIterator.next();

        const batchItems = Array.isArray(next.value?.items) ? next.value.items : [];
        if (!batchItems.length) continue;
        const indexOffset = sp.items.length;
        sp.items.push(...batchItems);
        task.total = Math.max(
          sp.items.length,
          Number(next.value?.total) || 0
        );
        await mapPreviewBatch(batchItems, indexOffset, false);
      }

      task.total = sp.items.length;
      task.status = "completed";
      task.validItems = (task.items || []).filter((item) => item?.id);
      task.matchedCount = task.validItems.length;
      if (lastResult) {
        task.cache = {
          sourceKey: lastResult.sourceKey,
          jsonFile: lastResult.jsonFile,
          urlListFile: lastResult.urlListFile,
          cacheHits,
          newlyMapped
        };
        task.urlListFile = lastResult.urlListFile;
        // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
        console.log(`✅ ${sanitizeLogValue(sourceLabel)} URL list ready: ${sanitizeLogValue(lastResult.urlListFile)}`);
      }
    })().catch((e) => { task.status = "error"; task.error = e.message; });

    return sendOk(res, { mapId: id, title: task.title, total: task.total, source, concurrency: effectiveMapConcurrency });
  } catch (e) {
    return sendError(res, 'PREVIEW_FAILED', e.message || "Music matching start error", 400);
  }
});

router.get("/api/spotify/preview/stream/:id", (req, res) => {
  const { id } = req.params || {};
  const task = spotifyMapTasks.get(id);
  if (!task) return sendError(res, 'JOB_NOT_FOUND', "Map task not found", 404);

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: "init", title: task.title, total: task.total, done: task.done, matched: task.matchedCount || 0, items: (task.items || []).filter(Boolean) });
  const sentItems = new Set();
  (task.items || []).forEach((item, index) => {
    if (item) sentItems.add(index);
  });
  const sendPendingItems = () => {
    (task.items || []).forEach((item, index) => {
      if (!item || sentItems.has(index)) return;
      send({ type: "item", item });
      sentItems.add(index);
    });
  };
  const interval = setInterval(() => {
    sendPendingItems();
    send({ type: "progress", done: task.done, total: task.total, matched: task.matchedCount || 0, status: task.status });
    if (task.status === "completed" || task.status === "error") { send({ type: "done", status: task.status, error: task.error || null }); clearInterval(interval); res.end(); }
  }, 800);
  req.on("close", () => clearInterval(interval));
});

router.get("/api/spotify/preview/stream-logs/:id", (req, res) => {
  const { id } = req.params || {};
  const task = spotifyMapTasks.get(id);
  if (!task) return sendError(res, 'JOB_NOT_FOUND', "Map task not found", 404);

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: "init", title: task.title, total: task.total, done: task.done, matched: task.matchedCount || 0, items: (task.items || []).filter(Boolean) });
  const sentItems = new Set();
  (task.items || []).forEach((item, index) => {
    if (item) sentItems.add(index);
  });
  const sendPendingItems = () => {
    (task.items || []).forEach((item, index) => {
      if (!item || sentItems.has(index)) return;
      send({
        type: "item",
        item,
        logKey: "log.matchFound",
        logVars: { artist: item.uploader, title: item.title },
        log: `✅ Match found: ${item.uploader} - ${item.title}`
      });
      sentItems.add(index);
    });
  };
  const interval = setInterval(() => {
    sendPendingItems();
    send({ type: "progress", done: task.done, total: task.total, matched: task.matchedCount || 0, status: task.status });
    if (task.status === "completed" || task.status === "error") {
      send({
        type: "done",
        status: task.status,
        error: task.error || null,
        logKey: task.status === "completed" ? "status.allMatchesCompleted" : "log.error",
        logVars: task.status === "completed" ? {} : { err: task.error },
        log: task.status === "completed" ? "🎉 All matches completed!" : `❌ Error: ${task.error}`
      });
      clearInterval(interval); res.end();
    }
  }, 500);
  req.on("close", () => clearInterval(interval));
});

export default router;
