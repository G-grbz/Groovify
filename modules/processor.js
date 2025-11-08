import path from "path";
import fs from "fs";
import archiver from "archiver";
import { resolveId3StrictForYouTube } from "./tags.js";
import { resolveMarket } from "./market.js";
import { jobs, registerJobProcess, killJobProcesses } from "./store.js";
import { sanitizeFilename, toNFC } from "./utils.js";
import { processYouTubeVideoJob } from "./video.js";
import {
  isYouTubeAutomix,
  fetchYtMetadata,
  downloadYouTubeVideo,
  buildEntriesMap,
  parsePlaylistIndexFromPath
} from "./yt.js";
import { downloadThumbnail } from "./media.js";
import { convertMedia } from "./media.js";
import { buildId3FromYouTube } from "./tags.js";
import { probeYoutubeMusicMeta } from "./yt.js";
import { findSpotifyMetaByQuery } from "./spotify.js";

const OUTPUT_DIR = path.resolve(process.cwd(), "outputs");
const TEMP_DIR = path.resolve(process.cwd(), "temp");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

function clampInt(v, min, max) {
  v = Math.round(v || 0);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function bump(obj, key, inc = 1) {
  obj[key] = (obj[key] || 0) + inc;
}

function mergeMeta(base, extra) {
  if (!extra) return base;
  for (const [k, v] of Object.entries(extra)) {
    if (v == null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (base[k] == null || base[k] === "") base[k] = v;
  }
  return base;
}

export async function processJob(jobId, inputPath, format, bitrate) {
  try { killJobProcesses(jobId); } catch {}

  const job = jobs.get(jobId);
  if (!job) return;

  job.canceled = false;

  let skippedCount = 0;
  let errorsCount = 0;
  let lyricsFound = 0;
  let lyricsMiss = 0;

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
      target.notFound = Math.max(notFoundLive, Math.max(0, Number(totalCount) - foundSafe));
    }

    if (prev.found !== target.found || prev.notFound !== target.notFound) {
      job.metadata.lyricsStats = target;
    }
  };

  const handleSkipUpdate = (stats) => {
    skippedCount = stats.skippedCount || 0;
    errorsCount = stats.errorsCount || 0;
    job.skippedCount = skippedCount;
    job.errorsCount = errorsCount;
    job.metadata = job.metadata || {};
    job.metadata.skipStats = { skippedCount, errorsCount };
  };

  const handleLyricsLog = (_payload) => {};
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
    job.status = "running";
    job.progress = 0;
    job.downloadProgress = 0;
    job.convertProgress = 0;
    job.currentPhase = "preparing";
    job.metadata = job.metadata || {};
    job.counters = job.counters || { dlTotal: 0, dlDone: 0, cvTotal: 0, cvDone: 0 };
    if (format === "mp4" && job.metadata?.source === "youtube") {
      await processYouTubeVideoJob(job, { OUTPUT_DIR, TEMP_DIR });
      try {
        if (Array.isArray(job.resultPath) && job.resultPath.length > 1 && !job.clientBatch) {
          const titleHint =
            job.metadata?.frozenTitle ||
            job.metadata?.extracted?.title ||
            job.metadata?.extracted?.playlist_title ||
            (job.metadata?.isAutomix ? "YouTube Automix" : "Playlist");
          job.zipPath = await makeZipFromOutputs(
            jobId,
            job.resultPath,
            titleHint || "playlist",
            job.metadata?.includeLyrics
          );
        }
      } catch {}
      cleanupTempFiles(jobId, inputPath, null);
      return;
    }

    let actualInputPath = inputPath;
    let coverPath = null;

    if (job.metadata.source === "spotify") {
      job.currentPhase = "downloading";
      job.downloadProgress = 5;
      job.metadata.extracted = job.metadata.extracted || {
        title: toNFC(job.metadata.spotifyTitle || "Spotify Playlist"),
        uploader: "Spotify",
        playlist_title: toNFC(job.metadata.spotifyTitle || "Spotify Playlist")
      };

      const selectedIds = Array.isArray(job.metadata.selectedIds) ? job.metadata.selectedIds : [];
      if (!selectedIds.length) {
        throw new Error("Spotify URL listesi boş");
      }

      job.counters = job.counters || {};
      job.counters.dlTotal = Number(selectedIds.length);
      job.counters.cvTotal = Number(selectedIds.length);
      job.counters.dlDone = job.counters.dlDone || 0;
      job.counters.cvDone = job.counters.cvDone || 0;

      const files = await downloadYouTubeVideo(
        job.metadata.spotifyTitle || "Spotify",
        jobId,
        true,
        null,
        false,
        selectedIds,
        TEMP_DIR,
        (progress) => {
          job.downloadProgress = 20 + (progress * 0.8);
          const t = Number(job.counters?.dlTotal || selectedIds.length || 0);
          if (t > 0) {
            const approx = clampInt((job.downloadProgress / 100) * t, 0, t);
            if ((job.counters.dlDone || 0) < approx) job.counters.dlDone = approx;
          }
          job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
        },
        {
          video: (format === "mp4"),
          onSkipUpdate: handleSkipUpdate,
          maxHeight: (format === "mp4") ? qualityToHeight(bitrate) : undefined
        },
        { isCanceled: () => !!job.canceled }
      );

      job.counters.dlDone = job.counters.dlTotal;
      job.downloadProgress = 100;
      job.currentPhase = "converting";
      job.convertProgress = 0;

      if (!Array.isArray(files) || !files.length) throw new Error("Spotify indirildi ama dosya bulunamadı");

      const frozen = Array.isArray(job.metadata.frozenEntries) ? job.metadata.frozenEntries : [];
      const byId = new Map();
      for (const e of frozen) if (e?.id) byId.set(e.id, e);
      const sorted = files.map((fp, i) => ({ fp, auto: i + 1 })).sort((a, b) => a.auto - b.auto);
      const results = [];
      job.playlist = { total: sorted.length, done: 0 };
      job.counters.cvTotal = sorted.length;

      for (let i = 0; i < sorted.length; i++) {
        const { fp: filePath, auto } = sorted[i];
        const pinnedId = selectedIds[auto - 1];
        const entry = (pinnedId ? byId.get(pinnedId) : null) || {};
        const fallbackTitle = path.basename(filePath, path.extname(filePath)).replace(/^\d+\s*-\s*/, "");
        const title = toNFC(entry.title || fallbackTitle);
        const fileMeta = {
          title,
          track: title,
          uploader: entry.uploader || "",
          artist: entry.artist || entry.uploader || "",
          album: entry.album || "",
          album_artist: entry.album_artist || entry.artist || entry.uploader || "",
          playlist_title: job.metadata.spotifyTitle || "Spotify Playlist",
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
          copyright: entry.copyright || "",
        };

        let itemCover = null;
        const baseNoExt = filePath.replace(/\.[^.]+$/, "");
        const sidecarJpg = `${baseNoExt}.jpg`;
        if (fs.existsSync(sidecarJpg)) itemCover = sidecarJpg;

        const existingOut = findExistingOutput(`${jobId}_${i}`, format, OUTPUT_DIR);
        let r;
        if (existingOut) {
          r = { outputPath: `/download/${encodeURIComponent(path.basename(existingOut))}` };
          const fileProgress = (i / sorted.length) * 100;
          job.convertProgress = Math.floor(fileProgress + (100 / sorted.length));
          job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
        } else {
          r = await convertMedia(
            filePath,
            format,
            bitrate,
            `${jobId}_${i}`,
            (progress) => {
              const baseProgress = (i / sorted.length) * 100;
              const currentFileProgress = (progress / 100) * (100 / sorted.length);
              job.convertProgress = Math.floor(baseProgress + currentFileProgress);

              if (job.playlist) {
                job.playlist.current = i;
              }
              job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
            },
            fileMeta,
            itemCover,
            (format === "mp4"),
            OUTPUT_DIR,
            TEMP_DIR,
            {
              onProcess: (child) => {
                try { registerJobProcess(jobId, child); } catch {}
              },
              includeLyrics: job.metadata.includeLyrics,
              sampleRate: sampleRate,
              isCanceled: () => !!jobs.get(jobId)?.canceled,
              onLog: handleLyricsLog,
              onLyricsStats: handleLyricsStats
            }
          );
        }

        const hasLrc = !!r?.lyricsPath;
        if (Array.isArray(job.metadata.frozenEntries)) {
          const fe = job.metadata.frozenEntries.find(x => x.index === (i + 1));
          if (fe) fe.hasLyrics = hasLrc;
        }

        results.push(r);
        job.playlist.done = i + 1;
        bump(job.counters, "cvDone", 1);
        updateLyricsStatsLive(job.playlist.done);
      }

      if (results.length === 1) {
        job.resultPath = results[0]?.outputPath || null;
      } else {
        job.resultPath = results;
        if (!job.clientBatch) {
          try {
            const zipTitle = job.metadata.spotifyTitle || "Spotify Playlist";
            job.zipPath = await makeZipFromOutputs(jobId, results, zipTitle, job.metadata.includeLyrics);
          } catch (e) {}
        }
      }

      if (job.metadata?.includeLyrics) {
        updateLyricsStatsLive(job.playlist?.done || results.length, job.playlist?.total || results.length);
      }

      job.status = "completed";
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
        ytMeta = { title: "YouTube Automix", uploader: "YouTube", playlist_title: "Automix" };
      } else {
        ytMeta = await fetchYtMetadata(job.metadata.url, job.metadata.isPlaylist);
      }

      const flat = {
        title: toNFC(ytMeta?.title || ""),
        uploader: toNFC(ytMeta?.uploader || ytMeta?.channel || ""),
        artist: toNFC(ytMeta?.artist || ytMeta?.creator || ytMeta?.uploader || ytMeta?.channel || ""),
        track: ytMeta?.track || "",
        album: toNFC(ytMeta?.album || ""),
        release_year: (ytMeta?.release_year && String(ytMeta.release_year)) ||
          (ytMeta?.release_date && String(ytMeta.release_date).slice(0, 4)) || "",
        upload_date: ytMeta?.upload_date || "",
        webpage_url: ytMeta?.webpage_url || job.metadata.url,
        thumbnail: (ytMeta?.thumbnails && ytMeta.thumbnails.length
          ? ytMeta.thumbnails[ytMeta.thumbnails.length - 1].url
          : ytMeta?.thumbnail) || "",
        playlist_title: toNFC(ytMeta?.playlist_title || "")
      };
      job.metadata.extracted = flat;

      try {
        const id3Guess = buildId3FromYouTube({
          title: flat.title,
          uploader: flat.uploader,
          thumbnail: flat.thumbnail,
          webpage_url: flat.webpage_url
        });
        if (id3Guess) {
          flat.artist = id3Guess.artist || flat.artist || "";
          flat.title = id3Guess.title || flat.title || "";
          flat.track = id3Guess.track || flat.title || "";
        }
      } catch {}

      if (flat.thumbnail && !isAutomix) {
        const thumbBase = path.join(TEMP_DIR, `${jobId}.cover`);
        coverPath = await downloadThumbnail(flat.thumbnail, thumbBase);
      }

      if (job.metadata.isPlaylist || isAutomix) {
        job.downloadProgress = 10;

        const selectedIndicesVar =
          (job.metadata.selectedIndices === "all" || !job.metadata.selectedIndices)
            ? null
            : job.metadata.selectedIndices;
        const selectedIdsVar = Array.isArray(job.metadata.selectedIds) ? job.metadata.selectedIds : null;

        const totalGuess =
          (selectedIdsVar && selectedIdsVar.length) ? selectedIdsVar.length :
          (selectedIndicesVar && selectedIndicesVar.length) ? selectedIndicesVar.length :
          (Number.isFinite(ytMeta?.n_entries) ? ytMeta.n_entries :
            Number.isFinite(ytMeta?.playlist_count) ? ytMeta.playlist_count :
              (Array.isArray(ytMeta?.entries) ? ytMeta.entries.length : null));

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

        const files = await downloadYouTubeVideo(
          job.metadata.url,
          jobId,
          true,
          indices,
          isAutomix,
          selectedIds,
          TEMP_DIR,
          (progress) => {
            job.downloadProgress = Math.max(10, Math.min(100, 10 + (progress * 0.9)));
            const t = Number(job.counters?.dlTotal || job.playlist?.total || 0);
            if (t > 0) {
              const approx = clampInt((job.downloadProgress / 100) * t, 0, t);
              if ((job.counters.dlDone || 0) < approx) job.counters.dlDone = approx;
            }
            if (job.playlist && job.currentPhase === 'downloading') {
              job.playlist.current = Math.max(0, Math.min(t - 1, Math.floor((progress / 100) * t)));
            }
            job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
          },
          {
            video: (format === "mp4"),
            onSkipUpdate: handleSkipUpdate,
            maxHeight: (format === "mp4") ? qualityToHeight(bitrate) : undefined
          },
          { isCanceled: () => !!job.canceled }
        );

        job.counters.dlDone = job.counters.dlTotal;
        job.downloadProgress = 100;
        job.currentPhase = "converting";
        job.convertProgress = 0;

        if (!Array.isArray(files) || !files.length) throw new Error("Playlist/Automix dosyaları bulunamadı.");

        const entryById = new Map();
        if (Array.isArray(job.metadata.frozenEntries)) {
          for (const e of job.metadata.frozenEntries) if (e?.id) entryById.set(e.id, e);
        }
        if (!Array.isArray(job.metadata.frozenEntries) || job.metadata.frozenEntries.length === 0) {
          const fe = [];
          const byIndex = buildEntriesMap(ytMeta);
          const byId = new Map();
          const metaEntries = Array.isArray(ytMeta?.entries) ? ytMeta.entries : [];
          for (const e of metaEntries) {
            if (e?.id) byId.set(e.id, e);
          }
          for (let i = 0; i < files.length; i++) {
            const filePath = files[i];
            const idxFromName = parsePlaylistIndexFromPath(filePath);
            let src = null;
            if (Number.isFinite(idxFromName) && byIndex.has(idxFromName)) {
              src = byIndex.get(idxFromName);
            } else if (Array.isArray(selectedIds) && selectedIds[i] && byId.has(selectedIds[i])) {
              src = byId.get(selectedIds[i]);
            }
            const title = (src?.title || src?.alt_title || path.basename(filePath, path.extname(filePath)).replace(/^\d+\s*-\s*/, "") || "").toString();
            const uploader = (src?.uploader || src?.channel || ytMeta?.uploader || ytMeta?.channel || "").toString();
            const id = (src?.id || (Array.isArray(selectedIds) ? selectedIds[i] : null) || "").toString();
            const webpage_url = (src?.webpage_url || src?.url || job.metadata.url || "").toString();
            const index = Number.isFinite(idxFromName) ? idxFromName : (i + 1);
            fe.push({ index, id, title, uploader, webpage_url });
            if (id) entryById.set(id, fe[fe.length - 1]);
          }
          job.metadata.frozenEntries = fe;
          job.metadata.frozenTitle =
            job.metadata.frozenTitle ||
            ytMeta?.title ||
            ytMeta?.playlist_title ||
            (isAutomix ? "YouTube Automix" : "");
        }

        const sorted = files
          .map((fp, i) => ({ fp, auto: i + 1 }))
          .sort((a, b) => a.auto - b.auto);

        const results = [];
        job.playlist = { total: sorted.length, done: 0 };
        job.counters.cvTotal = sorted.length;

        for (let i = 0; i < sorted.length; i++) {
          const { fp: filePath, auto } = sorted[i];
          let entry = {};
          if (Array.isArray(selectedIds) && selectedIds.length) {
            const pinnedId = selectedIds[(auto - 1)];
            entry = (pinnedId ? entryById.get(pinnedId) : null) || {};
          }

          const fallbackTitle = path.basename(filePath, path.extname(filePath)).replace(/^\d+\s*-\s*/, "");
          const title = toNFC(entry.title || fallbackTitle);

          let fileMeta = {
            ...flat,
            title,
            track: title,
            uploader: toNFC(entry.uploader || flat.uploader),
            artist: toNFC(entry.artist || entry.uploader || flat.artist || flat.uploader),
            album: flat.album || (ytMeta?.title || ytMeta?.playlist_title || job.metadata.frozenTitle || ""),
            webpage_url: entry.webpage_url || entry.url || flat.webpage_url,
            genre: "",
            label: "",
            publisher: "",
            copyright: "",
            album_artist: ""
          };
          fileMeta.album_artist = toNFC((entry && entry.album_artist) || fileMeta.artist || "");
          if (/^(youtube|youtube\s+mix)$/i.test((fileMeta.artist || "").trim())) {
            fileMeta.artist = "";
          }

          try {
            const ytMusic = await probeYoutubeMusicMeta(entry?.webpage_url || entry?.id);
            fileMeta = mergeMeta(fileMeta, ytMusic);
          } catch {}

          if (process.env.ENRICH_SPOTIFY_FOR_YT === "1") {
            try {
              const spMeta = await findSpotifyMetaByQuery(fileMeta.artist, fileMeta.track, job?.metadata?.market);
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
              console.warn(`Spotify metadata zenginleştirme hatası: ${error.message}`);
            }
          }

          let itemCover = null;
          const baseNoExt = filePath.replace(/\.[^.]+$/, "");
          const sidecarJpg = `${baseNoExt}.jpg`;
          if (fs.existsSync(sidecarJpg)) itemCover = sidecarJpg;
          else if (coverPath && fs.existsSync(coverPath)) itemCover = coverPath;
          else if (fileMeta?.coverUrl) {
            try {
              const dl = await downloadThumbnail(fileMeta.coverUrl, `${baseNoExt}.cover`);
              if (dl) itemCover = dl;
            } catch {}
          }

          try {
            const strictMeta = await resolveId3StrictForYouTube(
              {
                title: fileMeta.title,
                uploader: fileMeta.artist || fileMeta.uploader,
                thumbnail: itemCover ? null : flat.thumbnail,
                webpage_url: fileMeta.webpage_url
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
              fileMeta.album_artist = toNFC(fileMeta.album_artist || fileMeta.artist || "");
              if (strictMeta.label) {
                if (!fileMeta.label) fileMeta.label = strictMeta.label;
                if (!fileMeta.publisher) fileMeta.publisher = strictMeta.label;
              }
            }
          } catch (error) {
            console.warn(`ID3 strict çözümleme hatası: ${error.message}`);
          }

          const existingOut = findExistingOutput(`${jobId}_${i}`, format, OUTPUT_DIR);
          let r;
          if (existingOut) {
            r = { outputPath: `/download/${encodeURIComponent(path.basename(existingOut))}` };
            const fileProgress = (i / sorted.length) * 100;
            job.convertProgress = Math.floor(fileProgress + (100 / sorted.length));
            job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
            if (job.canceled) throw new Error("CANCELED");
          } else {
            r = await convertMedia(
              filePath,
              format,
              bitrate,
              `${jobId}_${i}`,
              (progress) => {
                const baseProgress = (i / sorted.length) * 100;
                const currentFileProgress = (progress / 100) * (100 / sorted.length);
                job.convertProgress = Math.floor(baseProgress + currentFileProgress);
                if (job.playlist) {
                  job.playlist.current = i;
                }
                job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
              },
              fileMeta,
              itemCover,
              (format === "mp4"),
              OUTPUT_DIR,
              TEMP_DIR,
              {
                onProcess: (child) => {
                  try { registerJobProcess(jobId, child); } catch {}
                },
                includeLyrics: job.metadata.includeLyrics,
                sampleRate: sampleRate,
                isCanceled: () => !!jobs.get(jobId)?.canceled,
                onLog: handleLyricsLog,
                onLyricsStats: handleLyricsStats
              }
            );
          }

          const hasLrc = !!r?.lyricsPath;
          if (Array.isArray(job.metadata.frozenEntries)) {
            const fe = job.metadata.frozenEntries.find(x => x.index === (auto));
            if (fe) fe.hasLyrics = hasLrc;
          }

          results.push(r);
          job.playlist.done = i + 1;
          bump(job.counters, "cvDone", 1);
          updateLyricsStatsLive(job.playlist.done);
        }

        if (results.length === 1) {
          job.resultPath = results[0]?.outputPath || null;
        } else {
          job.resultPath = results;
          if (!job.clientBatch) {
            try {
              const zipTitle = ytMeta?.title || ytMeta?.playlist_title || (isAutomix ? "YouTube Automix" : "Playlist");
              job.zipPath = await makeZipFromOutputs(jobId, results, zipTitle, job.metadata.includeLyrics);
            } catch (e) {}
          }
        }

        if (job.metadata?.includeLyrics) {
          updateLyricsStatsLive(job.playlist?.done || results.length, job.playlist?.total || results.length);
        }

        job.status = "completed";
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
          if ((job.counters.dlDone || 0) < approx) job.counters.dlDone = approx;
          job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
        },
        {
          video: (format === "mp4"),
          onSkipUpdate: handleSkipUpdate,
          maxHeight: (format === "mp4") ? qualityToHeight(bitrate) : undefined
        },
        { isCanceled: () => !!job.canceled }
      );

      job.counters.dlTotal = 1;
      job.counters.dlDone = 1;
      job.downloadProgress = 100;
      job.currentPhase = "converting";
      actualInputPath = filePath;
    }

    const isVideo = format === "mp4";
    if (!coverPath && typeof actualInputPath === "string") {
      const baseNoExt = actualInputPath.replace(/\.[^.]+$/, "");
      const sidecar = `${baseNoExt}.jpg`;
      if (fs.existsSync(sidecar)) coverPath = sidecar;
    }

    let singleMeta = { ...(job.metadata.extracted || {}) };
    try {
      const ytMusicSingle = await probeYoutubeMusicMeta(singleMeta.webpage_url || job.metadata.url);
      singleMeta = mergeMeta(singleMeta, ytMusicSingle);
    } catch {}
    if (process.env.ENRICH_SPOTIFY_FOR_YT === "1") {
      try {
        const spSingle = await findSpotifyMetaByQuery(singleMeta.artist, singleMeta.track, job?.metadata?.market);
        singleMeta = mergeMeta(singleMeta, spSingle);
        if (!singleMeta.publisher && spSingle?.label) singleMeta.publisher = spSingle.label;
      } catch {}
    }
    singleMeta.album_artist = singleMeta.album_artist || singleMeta.artist || "";

    if (!coverPath && singleMeta?.coverUrl && typeof actualInputPath === "string") {
      try {
        const baseNoExt = actualInputPath.replace(/\.[^.]+$/, "");
        const dl = await downloadThumbnail(singleMeta.coverUrl, `${baseNoExt}.cover`);
        if (dl) coverPath = dl;
      } catch {}
    }

    job.counters = job.counters || {};
    job.counters.cvTotal = 1;

    const existingSingle = findExistingOutput(jobId, format, OUTPUT_DIR);
    const r = existingSingle
      ? { outputPath: `/download/${encodeURIComponent(path.basename(existingSingle))}` }
      : await convertMedia(
          actualInputPath,
          format,
          bitrate,
          jobId,
          (p) => {
            job.convertProgress = Math.floor(p);
            job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
          },
          {
            ...singleMeta,
            __maxHeight: (format === "mp4") ? qualityToHeight(bitrate) : undefined
          },
          coverPath,
          isVideo,
          OUTPUT_DIR,
          TEMP_DIR,
          {
            onProcess: (child) => { try { registerJobProcess(jobId, child); } catch {} },
            includeLyrics: !!job.metadata.includeLyrics,
            sampleRate: sampleRate,
            isCanceled: () => !!jobs.get(jobId)?.canceled,
            onLog: handleLyricsLog,
            onLyricsStats: handleLyricsStats
          }
        );

    job.resultPath = r;
    try {
      if (job.metadata?.source === "file" && r?.outputPath) {
        const extMap = { mp3: ".mp3", flac: ".flac", wav: ".wav", ogg: ".ogg", mp4: ".mp4" };
        const desiredExt = extMap[format] || ('.' + String(format || 'mp3'));
        const originalBase = (job.metadata.originalName || "output")
          .replace(/\.[^.]*$/, "");
        const safeBase = sanitizeFilename(toNFC(originalBase));
        let targetName = `${safeBase}${desiredExt}`;
        const currentRel = decodeURIComponent(String(r.outputPath).replace(/^\/download\//, ""));
        const currentAbs = path.join(OUTPUT_DIR, currentRel);
        let targetAbs = path.join(OUTPUT_DIR, targetName);
        if (fs.existsSync(targetAbs)) {
          let i = 1;
          const stem = safeBase;
          const ext = desiredExt;
          while (fs.existsSync(targetAbs) && i < 1000) {
            targetName = `${stem} (${i})${ext}`;
            targetAbs = path.join(OUTPUT_DIR, targetName);
            i++;
          }
        }
        fs.renameSync(currentAbs, targetAbs);
        job.resultPath = { outputPath: `/download/${encodeURIComponent(targetName)}` };
        const oldLrc = currentAbs.replace(/\.[^/.]+$/, "") + ".lrc";
        if (fs.existsSync(oldLrc)) {
          const newLrc = targetAbs.replace(/\.[^/.]+$/, "") + ".lrc";
          try { fs.renameSync(oldLrc, newLrc); } catch {}
        }
      }
    } catch (e) {
      console.warn("Output rename warning:", e.message);
    }
    job.counters.cvDone = 1;
    if (job.metadata?.includeLyrics) {
      updateLyricsStatsLive(1, 1);
    }

    job.status = "completed";
    job.progress = 100;
    job.downloadProgress = 100;
    job.convertProgress = 100;
    job.currentPhase = "completed";
    cleanupTempFiles(jobId, inputPath, actualInputPath);
  } catch (error) {
    const jobRef = jobs.get(jobId);
    if (jobRef) {
      if (error && String(error.message).toUpperCase() === "CANCELED") {
        jobRef.status = "canceled";
        jobRef.error = null;
        jobRef.currentPhase = "canceled";
      } else {
        jobRef.status = "error";
        jobRef.error = error.message;
        jobRef.currentPhase = "error";
      }
    }
    if (!error || String(error.message).toUpperCase() !== "CANCELED") {
      console.error("Job error:", error);
    }
    try { killJobProcesses(jobId); } catch {}
    cleanupTempFiles(jobId, inputPath);
  }
}

function findExistingOutput(idPrefix, format, outDir) {
  try {
    const exts = {
      mp3: ["mp3"],
      flac: ["flac"],
      wav: ["wav"],
      ogg: ["ogg", "oga"],
      mp4: ["mp4", "m4a"]
    }[format] || [format];
    const files = fs.readdirSync(outDir);
    const hit = files.find(f =>
      f.startsWith(`${idPrefix}.`) && exts.some(e => f.toLowerCase().endsWith(`.${e}`))
    );
    return hit ? path.join(outDir, hit) : null;
  } catch {
    return null;
  }
}

async function makeZipFromOutputs(jobId, outputs, titleHint = "playlist", includeLyrics = false) {
  const safeBase = sanitizeFilename(`${titleHint || "playlist"}_${jobId}`).normalize("NFC");
  const zipName = `${safeBase}.zip`;
  const zipAbs = path.join(OUTPUT_DIR, zipName);

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipAbs);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve(`/download/${encodeURIComponent(zipName)}`));
    archive.on("error", err => reject(err));

    archive.pipe(output);

    for (const r of outputs) {
      if (!r?.outputPath) continue;
      const rel = decodeURIComponent(r.outputPath.replace(/^\/download\//, ""));
      const abs = path.join(OUTPUT_DIR, rel);
      if (fs.existsSync(abs)) {
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

function cleanupTempFiles(jobId, originalInputPath, downloadedPath = null) {
  try {
    if (
      typeof originalInputPath === "string" &&
      fs.existsSync(originalInputPath) &&
      originalInputPath.includes(path.resolve(process.cwd(), "uploads"))
    ) {
      try { fs.unlinkSync(originalInputPath); } catch {}
    }

    if (Array.isArray(downloadedPath)) {
      downloadedPath.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
      const playlistDir = path.join(TEMP_DIR, jobId);
      if (fs.existsSync(playlistDir)) {
        try { fs.rmSync(playlistDir, { recursive: true, force: true }); } catch {}
      }
    } else if (typeof downloadedPath === "string" && fs.existsSync(downloadedPath)) {
      try { fs.unlinkSync(downloadedPath); } catch {}
    }

    try {
      const files = fs.readdirSync(TEMP_DIR);
      files.forEach((f) => {
        if (f.startsWith(jobId)) {
          try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch {}
        }
      });
    } catch {}
  } catch (e) {
    console.warn("Temizleme uyarısı:", e.message);
  }
}

function qualityToHeight(q) {
  const v = String(q || "").toLowerCase();
  if (v.includes("1080")) return 1080;
  if (v.includes("720")) return 720;
  if (v.includes("480")) return 480;
  if (v.includes("360")) return 360;
  return 1080;
}
