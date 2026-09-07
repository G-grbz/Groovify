import express from "express";
import { sanitizeLogValue } from "../modules/security.js";
import { sendOk, sendError } from "../modules/utils.js";
import { getCache, setCache } from "../modules/cache.js";
import {
  isYouTubeUrl,
  isDailymotionUrl,
  isYouTubePlaylist,
  isDailymotionPlaylist,
  isYouTubeAutomix,
  normalizeYouTubeUrl,
  extractPlaylistAllFlat,
  extractPlaylistPage,
  getPlaylistMetaLite,
  extractAutomixAllFlat,
  extractAutomixPage,
  searchYouTubeContent,
  discoverYouTubeContent,
  getYouTubeMusicHomeShelves
} from "../modules/yt.js";
import { isSpotifyUrl, resolveSpotifyUrl } from "../modules/spotify.js";
import { isAppleMusicUrl, resolveAppleMusicUrl } from "../modules/apple.js";
import { isDeezerUrl, resolveDeezerUrl } from "../modules/deezer.js";
import { isTidalUrl, resolveTidalUrl } from "../modules/tidal.js";
import { isSoundCloudUrl, resolveSoundCloudUrl } from "../modules/soundcloud.js";
import { mapMappedMusicWithCache } from "../modules/mappedMusicCache.js";
import { resolveMarket } from "../modules/market.js";
import { resolveSpotifyConcurrency } from "../modules/concurrency.js";

const router = express.Router();

function mappedSourceValue(url) {
  if (isAppleMusicUrl(url)) return "apple_music";
  if (isDeezerUrl(url)) return "deezer";
  if (isTidalUrl(url)) return "tidal";
  if (isSoundCloudUrl(url)) return "soundcloud";
  return "spotify";
}

function mappedItemUrl(item = {}, source = "") {
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

function mappedItemId(item = {}, source = "") {
  if (source === "apple_music") return item.apple_track_id || null;
  if (source === "deezer") return item.deezer_track_id || null;
  if (source === "tidal") return item.tidal_track_id || null;
  if (source === "soundcloud") return item.soundcloud_urn || item.soundcloud_track_id || null;
  return item.spId || null;
}

function mappedPreviewMetadataItem(item = {}, index, source, sourceUrl) {
  item = item || {};
  const url = mappedItemUrl(item, source) || sourceUrl || "";
  const durationMs = Number(item.duration_ms || 0);
  const duration = Number.isFinite(durationMs) && durationMs > 0
    ? Math.round(durationMs / 1000)
    : null;

  return {
    index,
    id: null,
    providerId: mappedItemId(item, source),
    sourceProvider: source,
    sourceUrl,
    sourceItemUrl: url,
    title: item.title || "",
    uploader: item.artist || item.uploader || "",
    artist: item.artist || item.uploader || "",
    album: item.album || "",
    duration,
    duration_ms: durationMs || null,
    duration_string: null,
    webpage_url: url,
    url,
    thumbnail: item.coverUrl || null
  };
}

router.get("/api/youtube/discover", async (req, res) => {
  try {
    const preset = String(req.query.preset || "energizing").trim().toLowerCase();
    const limit = Number(req.query.limit || 18);
    const page = Number(req.query.page || 1);
    const lang = String(req.query.lang || "").trim().toLowerCase();
    const region = String(req.query.region || "").trim().toUpperCase();
    const result = await discoverYouTubeContent({ preset, limit, page, lang, region });
    return sendOk(res, result);
  } catch (e) {
    console.error("YouTube discover error:", e);
    return sendError(res, "DISCOVER_FAILED", e.message || "YouTube discover failed", 500);
  }
});

router.get("/api/youtube/search", async (req, res) => {
  try {
    const query = String(req.query.q || req.query.query || "").trim();
    const limit = Number(req.query.limit || 12);
    const type = String(req.query.type || req.query.kind || "").trim().toLowerCase();
    const sort = String(req.query.sort || "").trim().toLowerCase();
    const lang = String(req.query.lang || "").trim().toLowerCase();
    const region = String(req.query.region || "").trim().toUpperCase();

    if (!query) {
      return sendError(res, "SEARCH_QUERY_REQUIRED", "Search query is required", 400);
    }

    const result = await searchYouTubeContent(query, { limit, type, sort, lang, region });
    return sendOk(res, result);
  } catch (e) {
    // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
    console.error("YouTube search error:", sanitizeLogValue(e?.message || e));
    return sendError(res, "SEARCH_FAILED", e.message || "YouTube search failed", 500);
  }
});

router.get("/api/youtube/music-home", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 12);
    const shelves = Number(req.query.shelves || 6);
    const lang = String(req.query.lang || "").trim().toLowerCase();
    const region = String(req.query.region || "").trim().toUpperCase();
    const forceRefresh = String(req.query.refresh || "").trim() === "1";
    const result = await getYouTubeMusicHomeShelves({ limit, shelves, lang, region, forceRefresh });
    return sendOk(res, result);
  } catch (e) {
    console.warn("YouTube Music home unavailable:", e?.message || e);
    return sendOk(res, {
      personalized: false,
      cookieAvailable: true,
      shelves: [],
      warning: e.message || "YouTube Music home failed"
    });
  }
});

router.get("/api/youtube/music-home-stream", async (req, res) => {
  const limit = Number(req.query.limit || 12);
  const shelves = Number(req.query.shelves || 6);
  const lang = String(req.query.lang || "").trim().toLowerCase();
  const region = String(req.query.region || "").trim().toUpperCase();
  const forceRefresh = String(req.query.refresh || "").trim() === "1";

  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const writeFrame = (payload) => {
    if (res.writableEnded || res.destroyed) return false;
    res.write(`${JSON.stringify(payload)}\n`);
    res.flush?.();
    return true;
  };

  try {
    const result = await getYouTubeMusicHomeShelves({
      limit,
      shelves,
      lang,
      region,
      forceRefresh,
      onProgress: (progress) => writeFrame({ type: "progress", ...progress })
    });
    writeFrame({ type: "done", ...result });
  } catch (e) {
    console.warn("YouTube Music home stream unavailable:", e?.message || e);
    writeFrame({
      type: "error",
      error: { message: e?.message || "YouTube Music home failed" }
    });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

router.post("/api/playlist/preview", async (req, res) => {
  try {
    const { url, page = 1, pageSize = 25 } = req.body || {};

    if (url && (isSpotifyUrl(url) || isAppleMusicUrl(url) || isDeezerUrl(url) || isTidalUrl(url) || isSoundCloudUrl(url))) {
      const shouldMatch = req.body?.match !== false && req.body?.metadataOnly !== true;
      const source = mappedSourceValue(url);
      const sourceLabel = isAppleMusicUrl(url)
        ? "Apple Music"
        : isDeezerUrl(url)
        ? "Deezer"
        : isTidalUrl(url)
        ? "TIDAL"
        : isSoundCloudUrl(url)
        ? "SoundCloud"
        : "Spotify";
      try {
        const sp = isAppleMusicUrl(url)
          ? await resolveAppleMusicUrl(url, { market: resolveMarket(req.body?.market) })
          : isDeezerUrl(url)
          ? await resolveDeezerUrl(url, { market: resolveMarket(req.body?.market) })
          : isTidalUrl(url)
          ? await resolveTidalUrl(url, { market: resolveMarket(req.body?.market), maxItems: 1000 })
          : isSoundCloudUrl(url)
          ? await resolveSoundCloudUrl(url, { maxItems: 1000 })
          : await resolveSpotifyUrl(url, { market: resolveMarket(req.body?.market) });
        const ps = Math.max(1, Math.min(100, Number(pageSize) || 25));
        const p  = Math.max(1, Number(page) || 1);
        const start = (p - 1) * ps; const slice = (sp.items || []).slice(start, start + ps);
        const totalCount = (sp.items || []).length;
        const title = sp.title || (sp.kind === "track" ? `${sourceLabel} Track` : `${sourceLabel} Playlist`);
        if (!shouldMatch) {
          const items = slice.map((it, i) =>
            mappedPreviewMetadataItem(it, start + i + 1, source, url)
          );
          return sendOk(res, {
            playlist: {
              title,
              count: totalCount,
              isAutomix: false,
              isSpotify: source === "spotify",
              source
            },
            page: p,
            pageSize: ps,
            items
          });
        }
        const items = [];
        await mapMappedMusicWithCache(
          { ...sp, items: slice },
          {
            url,
            source,
            replaceManifest: false,
            indexOffset: start,
            concurrency: resolveSpotifyConcurrency(
              req.body?.spotifyConcurrency,
              req.body?.youtubeConcurrency,
              req.body?.concurrency
            ),
            onUpdate: (idx, item) => {
            if (!item) return;
            items[idx] = {
              ...item,
              index: start + idx + 1
            };
          }
        });
        return sendOk(res, {
          playlist: { title, count: totalCount, isAutomix: false, isSpotify: source === "spotify", source },
          page: p,
          pageSize: ps,
          items: items.filter(Boolean)
        });
      } catch (e) { return sendError(res, 'PREVIEW_FAILED', e.message || "Music matching preview error", 400); }
    }

    const isYouTubeSource = isYouTubeUrl(url);
    const isDailymotionSource = !isYouTubeSource && isDailymotionUrl(url);
    if (!url || (!isYouTubeSource && !isDailymotionSource)) {
      return sendError(res, 'PREVIEW_NEED_YT_URL', "A valid YouTube or Dailymotion URL is required", 400);
    }

    const keyUrl = isYouTubeSource ? normalizeYouTubeUrl(url) : String(url).trim();
    const isAutomix = isYouTubeSource && isYouTubeAutomix(keyUrl);
    const ps = Math.max(1, Math.min(100, Number(pageSize) || (isAutomix ? 50 : 25)));
    const p  = Math.max(1, Number(page) || 1);

    if (isAutomix) {
    console.log("[AUTOMIX] preview request", {
    url: keyUrl,
    page: p,
    pageSize: ps
  });

  let cached = getCache(keyUrl);

  if (!cached) {
    console.log("[AUTOMIX] no cache, calling extractAutomixAllFlat...");
    try {
      const t0 = Date.now();
      const all = await extractAutomixAllFlat(keyUrl);
      const entries = Array.isArray(all.items) ? all.items : [];

      const effectiveCount =
        entries.length > 0
          ? Math.min(all.count || entries.length, entries.length)
          : (all.count || 0);

      cached = {
        title: all.title,
        count: effectiveCount,
        isAutomix: true,
        entries,
        paged: false
      };

      console.log("[AUTOMIX] extractAutomixAllFlat done", {
        ms: Date.now() - t0,
        allCount: all.count,
        entriesLen: entries.length,
        effectiveCount
      });

      setCache(keyUrl, cached);
    } catch (e) {
      // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
      console.error("[AUTOMIX] extractAutomixAllFlat FAILED:", sanitizeLogValue(e?.message || e));

      const meta = await getPlaylistMetaLite(keyUrl);
      const total = meta.count || 50;
      const start = (p - 1) * ps + 1;
      const end   = Math.min(p * ps, total);
      const pageData = await extractAutomixPage(keyUrl, start, end);

      if (pageData) {
        setCache(keyUrl, {
          title: pageData.title || meta.title || "YouTube Automix",
          count: total,
          isAutomix: true,
          entries: [],
          paged: true
        });

        console.log("[AUTOMIX] fallback extractAutomixPage ok (paged mode init)", {
          total,
          itemsLen: pageData.items?.length || 0
        });

        return sendOk(res, {
          playlist: {
            title: pageData.title || meta.title || "YouTube Automix",
            count: total,
            isAutomix: true
          },
          page: p,
          pageSize: ps,
          items: pageData.items || []
        });
      }

      console.warn("[AUTOMIX] fallback pageData empty (paged init)");
      return sendOk(res, {
        playlist: {
          title: meta.title || "YouTube Automix",
          count: total,
          isAutomix: true
        },
        page: p,
        pageSize: ps,
        items: []
      });
    }
    cached = getCache(keyUrl) || cached;
  }

    if (cached?.paged) {
      try {
        const total = cached.count || 50;
        const start = (p - 1) * ps + 1;
        const end   = Math.min(p * ps, total);
        const pageData = await extractAutomixPage(keyUrl, start, end);

        console.log("[AUTOMIX] paged mode serve page", {
          page: p,
          pageSize: ps,
          total,
          start,
          end,
          itemsLen: pageData?.items?.length || 0
        });

        return sendOk(res, {
          playlist: {
            title: pageData?.title || cached.title || "YouTube Automix",
            count: total,
            isAutomix: true
          },
          page: p,
          pageSize: ps,
          items: pageData?.items || []
        });
      } catch (err) {
        // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
        console.error("[AUTOMIX] paged mode error:", sanitizeLogValue(err?.message || err));
        return sendError(res, 'PREVIEW_FAILED', err.message || "Automix preview failed", 500);
      }
    }

    const entries = Array.isArray(cached.entries) ? cached.entries : [];
    const total   = cached.count ?? entries.length;

    const startIdx = (p - 1) * ps;
    const endIdx   = Math.min(p * ps, entries.length);
    const slice    = startIdx < entries.length ? entries.slice(startIdx, endIdx) : [];

    console.log("[AUTOMIX] serve page (flat mode)", {
      page: p,
      pageSize: ps,
      total,
      entriesLen: entries.length,
      startIdx,
      endIdx,
      sliceLen: slice.length
    });

    return sendOk(res, {
      playlist: {
        title: cached.title,
        count: total,
        isAutomix: true
      },
      page: p,
      pageSize: ps,
      items: slice
    });
  }

    if (!isYouTubePlaylist(keyUrl) && !isDailymotionPlaylist(keyUrl)) {
      return sendError(res, 'PLAYLIST_REQUIRED', "This URL is not a playlist", 400);
    }

    let cached = getCache(keyUrl);
    if (!cached) {
      try {
        const all = await extractPlaylistAllFlat(keyUrl);
        if (!all.count) {
          return sendError(res, 'PREVIEW_FAILED', "Playlist is empty or could not be read", 404);
        }
        const entries = Array.isArray(all.items) ? all.items : [];
        const effectiveCount =
          entries.length > 0
            ? Math.min(all.count || entries.length, entries.length)
            : (all.count || 0);

        cached = {
          title: all.title,
          count: effectiveCount,
          isAutomix: false,
          entries
        };
        setCache(keyUrl, cached);
      } catch (e) {
        const meta = await getPlaylistMetaLite(keyUrl);
        if (!meta.count) return sendError(res, 'PREVIEW_FAILED', "Playlist is empty or could not be read", 404);
        const start = (p - 1) * ps + 1; const end = Math.min(p * ps, meta.count);
        const pageData = await extractPlaylistPage(keyUrl, start, end);
        return sendOk(res, { playlist: { title: pageData.title || meta.title, count: meta.count, isAutomix: false }, page: p, pageSize: ps, items: pageData.items });
      }
    }
    const startIdx = (p - 1) * ps; const endIdx = Math.min(p * ps, cached.entries.length);
    const slice = cached.entries.slice(startIdx, endIdx);
    sendOk(res, { playlist: { title: cached.title, count: cached.count, isAutomix: false }, page: p, pageSize: ps, items: slice });
  } catch (e) {
    // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
    console.error("Playlist preview error:", sanitizeLogValue(e?.message || e));
    return sendError(res, 'PREVIEW_FAILED', String(e.message || e), 500);
  }
});

export default router;
