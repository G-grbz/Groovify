import express from "express";
import { sendOk, sendError } from "../modules/utils.js";
import { getCache, setCache } from "../modules/cache.js";
import { isYouTubeUrl, isYouTubePlaylist, isYouTubeAutomix, normalizeYouTubeUrl, extractPlaylistAllFlat, extractPlaylistPage, getPlaylistMetaLite, extractAutomixAllFlat, extractAutomixPage, ensureAutomixUpto } from "../modules/yt.js";
import { isSpotifyUrl, resolveSpotifyUrl } from "../modules/spotify.js";
import { searchYtmBestId } from "../modules/sp.js";
import { resolveMarket } from "../modules/market.js";

const router = express.Router();

router.post("/api/playlist/preview", async (req, res) => {
  try {
    const { url, page = 1, pageSize = 25 } = req.body || {};

    if (url && isSpotifyUrl(url)) {
      try {
        const sp = await resolveSpotifyUrl(url, { market: resolveMarket(req.body?.market) });
        const ps = Math.max(1, Math.min(100, Number(pageSize) || 25));
        const p  = Math.max(1, Number(page) || 1);
        const start = (p - 1) * ps; const slice = (sp.items || []).slice(start, start + ps);
        const items = [];
        for (let i=0; i<slice.length; i++) {
          const it = slice[i]; let vid = null; try { vid = await searchYtmBestId(it.artist, it.title); } catch {}
          items.push({ index: start + i + 1, id: vid || null, title: it.title, uploader: it.artist, duration: null, duration_string: null, webpage_url: vid ? (process.env.YT_USE_MUSIC !== "0" ? `https://music.youtube.com/watch?v=${vid}` : `https://www.youtube.com/watch?v=${vid}`) : "", thumbnail: null });
        }
        return sendOk(res, { playlist: { title: sp.title || (sp.kind === "track" ? "Spotify Track" : "Spotify Playlist"), count: (sp.items || []).length, isAutomix: false, isSpotify: true }, page: p, pageSize: ps, items });
      } catch (e) { return sendError(res, 'PREVIEW_FAILED', e.message || "Spotify önizleme hatası", 400); }
    }

    if (!url || !isYouTubeUrl(url)) return sendError(res, 'PREVIEW_NEED_YT_URL', "A valid YouTube URL is required", 400);

    const keyUrl = normalizeYouTubeUrl(url);
    const isAutomix = isYouTubeAutomix(keyUrl);
    const ps = Math.max(1, Math.min(100, Number(pageSize) || (isAutomix ? 50 : 25)));
    const p  = Math.max(1, Number(page) || 1);

    if (isAutomix) {
      let cached = getCache(keyUrl);
      if (!cached) {
        try {
          const all = await extractAutomixAllFlat(keyUrl);
          cached = { title: all.title, count: all.count, isAutomix: true, entries: all.items };
          setCache(keyUrl, cached);
        } catch (e) {
          const meta = await getPlaylistMetaLite(keyUrl);
          const total = meta.count || 50; const start = (p - 1) * ps + 1; const end = Math.min(p * ps, total);
          const pageData = await extractAutomixPage(keyUrl, start, end);
          if (pageData) return sendOk(res, { playlist: { title: pageData.title || meta.title, count: total, isAutomix: true }, page: p, pageSize: ps, items: pageData.items });
          return sendOk(res, { playlist: { title: meta.title || "YouTube Automix", count: total, isAutomix: true }, page: p, pageSize: ps, items: [] });
        }
      }
      const upto = Math.min(p * ps, Math.max(cached.count || 0, cached.entries.length));
      await ensureAutomixUpto(keyUrl, upto);
      const fresh = getCache(keyUrl) || cached;
      const total = Math.max(fresh.count || 0, fresh.entries.length);
      const startIdx = (p - 1) * ps; const endIdx = Math.min(p * ps, fresh.entries.length);
      const slice = fresh.entries.slice(startIdx, endIdx);
      return sendOk(res, { playlist: { title: fresh.title, count: total, isAutomix: true }, page: p, pageSize: ps, items: slice });
    }

    if (!isYouTubePlaylist(keyUrl)) return sendError(res, 'PLAYLIST_REQUIRED', "This URL is not a playlist", 400);

    let cached = getCache(keyUrl);
    if (!cached) {
      try {
        const all = await extractPlaylistAllFlat(keyUrl);
        if (!all.count) return sendError(res, 'PREVIEW_FAILED', "Playlist boş ya da okunamadı", 404);
        cached = { title: all.title, count: all.count, isAutomix: false, entries: all.items };
        setCache(keyUrl, cached);
      } catch (e) {
        const meta = await getPlaylistMetaLite(keyUrl);
        if (!meta.count) return sendError(res, 'PREVIEW_FAILED', "Playlist boş ya da okunamadı", 404);
        const start = (p - 1) * ps + 1; const end = Math.min(p * ps, meta.count);
        const pageData = await extractPlaylistPage(keyUrl, start, end);
        return sendOk(res, { playlist: { title: pageData.title || meta.title, count: meta.count, isAutomix: false }, page: p, pageSize: ps, items: pageData.items });
      }
    }
    const startIdx = (p - 1) * ps; const endIdx = Math.min(p * ps, cached.entries.length);
    const slice = cached.entries.slice(startIdx, endIdx);
    sendOk(res, { playlist: { title: cached.title, count: cached.count, isAutomix: false }, page: p, pageSize: ps, items: slice });
  } catch (e) {
    console.error("Playlist preview error:", e);
    return sendError(res, 'PREVIEW_FAILED', String(e.message || e), 500);
  }
});

export default router;
