import express from "express";
import { sendError, sendOk, uniqueId } from "../modules/utils.js";
import {
  addItemsToDownloadList,
  createDownloadList,
  deleteDownloadList,
  getDownloadListsState,
  removeDownloadListItem
} from "../modules/ytliveDownloadLists.js";
import { isSpotifyUrl, resolveSpotifyUrl } from "../modules/spotify.js";
import { isAppleMusicUrl, resolveAppleMusicUrl } from "../modules/apple.js";
import { isDeezerUrl, resolveDeezerUrl } from "../modules/deezer.js";
import { isTidalUrl, resolveTidalUrl } from "../modules/tidal.js";
import { isSoundCloudUrl, resolveSoundCloudUrl } from "../modules/soundcloud.js";
import {
  getMappedMusicSourceItemId,
  getMappedMusicSourceItemUrl,
  mapMappedMusicWithCache
} from "../modules/mappedMusicCache.js";
import { resolveMarket } from "../modules/market.js";
import { spotifyMapTasks } from "../modules/store.js";
import { resolveSpotifyConcurrency } from "../modules/concurrency.js";

const router = express.Router();

function isMappedMusicUrl(url = "") {
  return isSpotifyUrl(url) || isAppleMusicUrl(url) || isDeezerUrl(url) || isTidalUrl(url) || isSoundCloudUrl(url);
}

function mappedMusicSource(url = "") {
  if (isAppleMusicUrl(url)) return "apple_music";
  if (isDeezerUrl(url)) return "deezer";
  if (isTidalUrl(url)) return "tidal";
  if (isSoundCloudUrl(url)) return "soundcloud";
  return "spotify";
}

async function resolveMappedMusicUrl(url, { market } = {}) {
  if (isAppleMusicUrl(url)) return resolveAppleMusicUrl(url, { market });
  if (isDeezerUrl(url)) return resolveDeezerUrl(url, { market });
  if (isTidalUrl(url)) return resolveTidalUrl(url, { market, maxItems: 1000 });
  if (isSoundCloudUrl(url)) return resolveSoundCloudUrl(url, { maxItems: 1000 });
  return resolveSpotifyUrl(url, { market });
}

function getMappedListSourceUrl(list = {}) {
  const items = Array.isArray(list?.items) ? list.items : [];
  const sourceUrls = items
    .map((item) => item?.sourceUrl || "")
    .filter((url) => isMappedMusicUrl(url));
  const uniqueSourceUrls = Array.from(new Set(sourceUrls));
  if (uniqueSourceUrls.length === 1) return uniqueSourceUrls[0];

  const itemUrls = items
    .map((item) => item?.webpage_url || item?.url || "")
    .filter((url) => isMappedMusicUrl(url));
  const uniqueItemUrls = Array.from(new Set(itemUrls));
  return uniqueItemUrls.length === 1 ? uniqueItemUrls[0] : "";
}

function mappedItemToDownloadListItem(item = {}, index = 0, { source, sourceUrl, sourceTitle } = {}) {
  const sourceItemUrl = getMappedMusicSourceItemUrl(item, source);
  return {
    type: "track",
    index: index + 1,
    id: null,
    title: item.title || item.track || `Track ${index + 1}`,
    uploader: item.artist || item.uploader || "",
    duration: Number.isFinite(Number(item.duration_ms)) ? Math.round(Number(item.duration_ms) / 1000) : null,
    duration_ms: Number.isFinite(Number(item.duration_ms)) ? Number(item.duration_ms) : null,
    thumbnail: item.coverUrl || null,
    webpage_url: sourceItemUrl,
    url: sourceItemUrl,
    sourceProvider: source,
    sourceItemId: getMappedMusicSourceItemId(item, source) || null,
    sourceItemUrl,
    album: item.album || null,
    sourceTitle: sourceTitle || null,
    sourceUrl
  };
}

function downloadListItemToMappedSourceItem(item = {}, source = "") {
  const sourceItemUrl = item.sourceItemUrl || item.webpage_url || item.url || "";
  const out = {
    title: item.title || "",
    artist: item.uploader || item.artist || "",
    uploader: item.uploader || item.artist || "",
    album: item.album || "",
    duration_ms: Number.isFinite(Number(item.duration_ms)) ? Number(item.duration_ms) : null,
    coverUrl: item.coverUrl || item.thumbnail || item.thumbnailUrl || item.imageUrl || "",
    thumbnailUrl: item.thumbnail || item.coverUrl || item.thumbnailUrl || item.imageUrl || "",
    imageUrl: item.imageUrl || item.thumbnail || item.coverUrl || item.thumbnailUrl || "",
    webpage_url: sourceItemUrl
  };

  if (source === "spotify") {
    out.spId = item.sourceItemId || null;
    out.spUrl = sourceItemUrl;
  } else if (source === "deezer") {
    out.deezer_track_id = item.sourceItemId || null;
    out.deezerUrl = sourceItemUrl;
    out.dzUrl = sourceItemUrl;
  } else if (source === "apple_music") {
    out.apple_track_id = item.sourceItemId || null;
    out.amUrl = sourceItemUrl;
  } else if (source === "tidal") {
    out.tidal_track_id = item.sourceItemId || null;
    out.tidalUrl = sourceItemUrl;
  } else if (source === "soundcloud") {
    out.soundcloud_track_id = item.sourceItemId || null;
    out.soundcloudUrl = sourceItemUrl;
    out.scUrl = sourceItemUrl;
  }

  return out;
}

function mappedCacheItemToSavedListTrack(item = {}, index = 0) {
  const duration = Number(item.duration);
  const durationMs = Number(item.duration_ms);
  return {
    ...item,
    index: index + 1,
    title: item.sourceTitle || item.title || "",
    uploader: item.sourceArtist || item.uploader || "",
    artist: item.sourceArtist || item.uploader || "",
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    duration_ms: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null,
    duration_string: item.duration_string || null,
    thumbnail: item.thumbnail || item.sourceCoverUrl || null,
    webpage_url: item.webpage_url || item.url || "",
    url: item.webpage_url || item.url || ""
  };
}

router.get("/api/ytlive/download-lists", (_req, res) => {
  return sendOk(res, getDownloadListsState());
});

router.post("/api/ytlive/download-lists", (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) {
      return sendError(res, "LIST_NAME_REQUIRED", "List name is required", 400);
    }
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const state = createDownloadList({ name, items });
    return sendOk(res, state);
  } catch (error) {
    console.error("[ytlive-download-lists] create failed:", error);
    return sendError(res, "LIST_CREATE_FAILED", error.message || "List could not be created", 500);
  }
});

router.post("/api/ytlive/download-lists/:id/items", (req, res) => {
  try {
    const items = Array.isArray(req.body?.items)
      ? req.body.items
      : (req.body?.item ? [req.body.item] : []);
    if (!items.length) {
      return sendError(res, "LIST_ITEMS_REQUIRED", "At least one item is required", 400);
    }
    const state = addItemsToDownloadList(req.params.id, items);
    if (!state) {
      return sendError(res, "LIST_NOT_FOUND", "Download list not found", 404);
    }
    return sendOk(res, state);
  } catch (error) {
    console.error("[ytlive-download-lists] add items failed:", error);
    return sendError(res, "LIST_ADD_FAILED", error.message || "Items could not be added", 500);
  }
});

router.post("/api/ytlive/download-lists/:id/resolve", async (req, res) => {
  try {
    const state = getDownloadListsState();
    const list = state.lists.find((entry) => entry.id === req.params.id);
    if (!list) {
      return sendError(res, "LIST_NOT_FOUND", "Download list not found", 404);
    }

    const sourceUrl = getMappedListSourceUrl(list);
    if (!sourceUrl) {
      return sendError(res, "LIST_RESOLVE_UNSUPPORTED", "This list cannot be resolved as a mapped music list", 400);
    }

    const source = mappedMusicSource(sourceUrl);
    const sourceItems = (Array.isArray(list.items) ? list.items : [])
      .map((item) => downloadListItemToMappedSourceItem(item, source))
      .filter((item) => item.title && (item.webpage_url || item.spId || item.deezer_track_id || item.apple_track_id || item.tidal_track_id || item.soundcloud_track_id));

    if (!sourceItems.length) {
      return sendError(res, "LIST_RESOLVE_EMPTY", "No resolvable items were found", 404);
    }

    const result = await mapMappedMusicWithCache(
      {
        kind: "playlist",
        provider: source,
        title: list.name || "",
        items: sourceItems
      },
      {
        url: sourceUrl,
        source,
        replaceManifest: false,
        concurrency: resolveSpotifyConcurrency(
          req.body?.spotifyConcurrency,
          req.body?.youtubeConcurrency,
          req.body?.concurrency
        )
      }
    );

    const items = result.items
      .map((item, index) => mappedCacheItemToSavedListTrack(item, index))
      .filter((item) => item.id && item.webpage_url);

    return sendOk(res, {
      playlist: {
        title: list.name || "",
        count: sourceItems.length,
        source
      },
      items,
      cache: {
        sourceKey: result.sourceKey,
        jsonFile: result.jsonFile,
        urlListFile: result.urlListFile,
        cacheHits: result.cacheHits,
        newlyMapped: result.newlyMapped,
        matched: result.matchedCount
      }
    });
  } catch (error) {
    console.error("[ytlive-download-lists] resolve failed:", error);
    return sendError(res, "LIST_RESOLVE_FAILED", error.message || "List could not be resolved", 500);
  }
});

router.post("/api/ytlive/download-lists/:id/resolve/start", async (req, res) => {
  try {
    const state = getDownloadListsState();
    const list = state.lists.find((entry) => entry.id === req.params.id);
    if (!list) {
      return sendError(res, "LIST_NOT_FOUND", "Download list not found", 404);
    }

    const sourceUrl = getMappedListSourceUrl(list);
    if (!sourceUrl) {
      return sendError(res, "LIST_RESOLVE_UNSUPPORTED", "This list cannot be resolved as a mapped music list", 400);
    }

    const source = mappedMusicSource(sourceUrl);
    const sourceItems = (Array.isArray(list.items) ? list.items : [])
      .map((item) => downloadListItemToMappedSourceItem(item, source))
      .filter((item) => item.title && (item.webpage_url || item.spId || item.deezer_track_id || item.apple_track_id || item.tidal_track_id || item.soundcloud_track_id));

    if (!sourceItems.length) {
      return sendError(res, "LIST_RESOLVE_EMPTY", "No resolvable items were found", 404);
    }

    const id = uniqueId("map");
    const task = {
      id,
      url: sourceUrl,
      source,
      status: "running",
      title: list.name || "",
      total: sourceItems.length,
      done: 0,
      items: [],
      logs: [],
      createdAt: new Date(),
      validItems: [],
      jobId: null,
      downloadListId: list.id
    };
    spotifyMapTasks.set(id, task);

    const concurrency = resolveSpotifyConcurrency(
      req.body?.spotifyConcurrency,
      req.body?.youtubeConcurrency,
      req.body?.concurrency
    );

    setImmediate(async () => {
      try {
        const result = await mapMappedMusicWithCache(
          {
            kind: "playlist",
            provider: source,
            title: list.name || "",
            items: sourceItems
          },
          {
            url: sourceUrl,
            source,
            replaceManifest: false,
            concurrency,
            onUpdate: (idx, item, meta = {}) => {
              const resolved = mappedCacheItemToSavedListTrack(item, idx);
              task.items[idx] = resolved;
              task.done++;
              if (resolved?.id) task.validItems.push(resolved);
              if (meta.cached) {
                task.logs.push({ time: new Date(), message: "cache-hit" });
              }
            },
            onLog: (log) => {
              task.logs.push({ time: new Date(), message: log });
              console.log(`[ytlive-list-map ${id}] ${log}`);
            }
          }
        );

        task.status = "completed";
        task.done = task.total;
        task.validItems = (task.items || []).filter((item) => item?.id);
        task.cache = {
          sourceKey: result.sourceKey,
          jsonFile: result.jsonFile,
          urlListFile: result.urlListFile,
          cacheHits: result.cacheHits,
          newlyMapped: result.newlyMapped,
          matched: result.matchedCount
        };
      } catch (error) {
        task.status = "error";
        task.error = error.message || String(error);
        console.error("[ytlive-download-lists] resolve task failed:", error);
      }
    });

    return sendOk(res, {
      mapId: id,
      title: task.title,
      total: task.total,
      source,
      concurrency
    });
  } catch (error) {
    console.error("[ytlive-download-lists] resolve start failed:", error);
    return sendError(res, "LIST_RESOLVE_FAILED", error.message || "List could not be resolved", 500);
  }
});

router.post("/api/ytlive/download-lists/:id/sync", async (req, res) => {
  try {
    const state = getDownloadListsState();
    const list = state.lists.find((entry) => entry.id === req.params.id);
    if (!list) {
      return sendError(res, "LIST_NOT_FOUND", "Download list not found", 404);
    }

    const sourceUrl = getMappedListSourceUrl(list);
    if (!sourceUrl) {
      return sendError(res, "LIST_SYNC_UNSUPPORTED", "This list cannot be synchronized", 400);
    }

    const source = mappedMusicSource(sourceUrl);
    const sp = await resolveMappedMusicUrl(sourceUrl, {
      market: resolveMarket(req.body?.market)
    });
    const sourceTitle = sp.title || list.name || "";
    const items = (Array.isArray(sp.items) ? sp.items : [])
      .map((item, index) => mappedItemToDownloadListItem(item, index, {
        source,
        sourceUrl,
        sourceTitle
      }))
      .filter((item) => item.webpage_url || item.sourceItemUrl);

    if (!items.length) {
      return sendError(res, "LIST_SYNC_EMPTY", "No synchronized items were found", 404);
    }

    const beforeCount = Array.isArray(list.items) ? list.items.length : 0;
    const updatedState = addItemsToDownloadList(req.params.id, items);
    if (!updatedState) {
      return sendError(res, "LIST_NOT_FOUND", "Download list not found", 404);
    }
    const updatedList = updatedState.lists.find((entry) => entry.id === req.params.id);
    const afterCount = Array.isArray(updatedList?.items) ? updatedList.items.length : beforeCount;

    const cacheResult = await mapMappedMusicWithCache(sp, {
      url: sourceUrl,
      source,
      concurrency: resolveSpotifyConcurrency(
        req.body?.spotifyConcurrency,
        req.body?.youtubeConcurrency,
        req.body?.concurrency
      ),
      refreshUnmatched: true
    });

    return sendOk(res, {
      ...updatedState,
      sync: {
        source,
        title: sourceTitle,
        added: Math.max(0, afterCount - beforeCount),
        total: afterCount,
        sourceTotal: items.length,
        matched: cacheResult.matchedCount,
        cacheHits: cacheResult.cacheHits,
        newlyMapped: cacheResult.newlyMapped,
        sourceKey: cacheResult.sourceKey,
        jsonFile: cacheResult.jsonFile,
        urlListFile: cacheResult.urlListFile
      }
    });
  } catch (error) {
    console.error("[ytlive-download-lists] sync failed:", error);
    return sendError(res, "LIST_SYNC_FAILED", error.message || "List could not be synchronized", 500);
  }
});

router.delete("/api/ytlive/download-lists/:id", (req, res) => {
  try {
    const state = deleteDownloadList(req.params.id);
    if (!state) {
      return sendError(res, "LIST_NOT_FOUND", "Download list not found", 404);
    }
    return sendOk(res, state);
  } catch (error) {
    console.error("[ytlive-download-lists] delete failed:", error);
    return sendError(res, "LIST_DELETE_FAILED", error.message || "List could not be deleted", 500);
  }
});

router.delete("/api/ytlive/download-lists/:id/items/:itemKey", (req, res) => {
  try {
    const state = removeDownloadListItem(req.params.id, req.params.itemKey);
    if (!state) {
      return sendError(res, "LIST_ITEM_NOT_FOUND", "Download list item not found", 404);
    }
    return sendOk(res, state);
  } catch (error) {
    console.error("[ytlive-download-lists] remove item failed:", error);
    return sendError(res, "LIST_ITEM_DELETE_FAILED", error.message || "Item could not be removed", 500);
  }
});

export default router;
