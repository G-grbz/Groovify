import 'dotenv/config';
import SpotifyWebApi from "spotify-web-api-node";
import { resolveMarket, withMarketFallback } from "./market.js";
import assert from "node:assert";

export function isSpotifyUrl(url) {
  return /^(https?:\/\/open\.spotify\.com|spotify:)/i.test(String(url || ""));
}

export function parseSpotifyUrl(url) {
  const s = String(url || "").trim();
  let m = s.match(/^spotify:(track|playlist|album):([A-Za-z0-9]+)$/i);
  if (m) return { type: m[1].toLowerCase(), id: m[2] };

  m = s.match(
    /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(track|playlist|album)\/([A-Za-z0-9]+)(?:[/?].*)?$/i
  );
  if (m) return { type: m[1].toLowerCase(), id: m[2] };

  return { type: "unknown", id: null };
}

export function isPersonalizedMixId(id="") {
  const s = String(id || "");
  return /^37i9dQZF1E/i.test(s);
}

export async function makeSpotify() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET gerekli");
  }
  const api = new SpotifyWebApi({ clientId, clientSecret });
  const grant = await api.clientCredentialsGrant();
  api.setAccessToken(grant.body.access_token);
  return api;
}

export function pickBestImage(images=[]) {
  if (!Array.isArray(images) || !images.length) return null;
  return images.slice().sort((a,b)=> (b.width||0) - (a.width||0))[0]?.url || null;
}

export async function searchSpotifyBestTrack(artist, title, market) {
  return searchSpotifyBestTrackStrict(artist, title, market, {});
}

function _norm(s=""){
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g,"")
    .replace(/[\[\](){}"'“”‘’·•.,!?]/g," ")
    .replace(/\b(feat|ft|with)\b.*$/i,"")
    .replace(/\s+/g," ")
    .trim();
}

export async function searchSpotifyBestTrackStrict(
  artist, title, market,
  {
    targetDurationSec=null,
    minScore=7,
    titleRaw=null
  } = {}
){
  const api = await makeSpotify();
  const q = [artist, title].filter(Boolean).join(" ").trim();
  const items = await withMarketFallback(async (mkt) => {
    const resp = await api.searchTracks(q, { limit: 10, ...(mkt ? { market: mkt } : {}) });
    const arr = resp?.body?.tracks?.items || [];
    return arr.length ? arr : null;
  }, resolveMarket(market));
  if (!items.length) return null;

  const aN = _norm(artist||"");
  const tN = _norm(title||"");
  const tRawN = _norm(titleRaw||title||"");

  const score = (it)=>{
    const spTitle = _norm(it?.name||"");
    const spArtist = _norm(it?.artists?.[0]?.name||"");
    let s = 0;
    if (spTitle === tN || spTitle === tRawN) s += 4;
    else if (spTitle.includes(tN) || tN.includes(spTitle)) s += 2;
    if (aN){
      if (spArtist === aN) s += 3;
      else if (spArtist.includes(aN) || aN.includes(spArtist)) s += 1;
    }

    if (Number.isFinite(targetDurationSec) && it?.duration_ms){
      const spSec = Math.round(it.duration_ms/1000);
      const tol = Math.max(2, Math.round(targetDurationSec*0.02));
      if (Math.abs(spSec - targetDurationSec) <= tol) s += 2;
    }
    return s;
  };

  let best = null, bestScore = -1;
  for (const it of items){
    const s = score(it);
    if (s > bestScore){ best = it; bestScore = s; }
  }
  return (bestScore >= minScore) ? best : null;
}

export function trackToId3Meta(track) {
  if (!track) return null;
  const releaseDate = track.album?.release_date || "";
  const year = releaseDate.slice(0,4);
  const artist = (track.artists||[]).map(a=>a?.name).filter(Boolean).join(", ");
  return {
    track: track.name || "",
    title: track.name || "",
    artist,
    uploader: artist,
    album: track.album?.name || "",
    release_year: year || "",
    release_date: releaseDate || "",
    track_number: track.track_number || null,
    disc_number: track.disc_number || null,
    track_total: track.album?.total_tracks || null,
    disc_total: (track.album?.tracks?.items
                 ? Math.max(...track.album.tracks.items.map(t=>t.disc_number||1))
                 : null),
    isrc: track.external_ids?.isrc || "",
    coverUrl: pickBestImage(track.album?.images || []),
    spotifyUrl: track.external_urls?.spotify || ""
  };
}

async function fetchTrack(api, id, market) {
  const t = await withMarketFallback(async (mkt) => {
    const r = await api.getTrack(id, { ...(mkt ? { market: mkt } : {}) });
    return r?.body || null;
  }, resolveMarket(market));
  if (!t) throw new Error("Track getirilemedi");
  const meta = trackToId3Meta(t);
  return {
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    year: meta.release_year,
    date: meta.release_date,
    track_number: meta.track_number,
    disc_number: meta.disc_number,
    track_total: meta.track_total,
    disc_total: meta.disc_total,
    isrc: meta.isrc,
    spUrl: meta.spotifyUrl,
    coverUrl: meta.coverUrl
  };
}

async function fetchPlaylistItems(api, id, market) {
  const out = [];
  let page = await withMarketFallback(async (mkt) => {
    const r = await api.getPlaylistTracks(id, { limit: 100, ...(mkt ? { market: mkt } : {}) });
    return r || null;
  }, resolveMarket(market));
  if (!page) return out;
  while (true) {
    for (const it of page.body.items || []) {
      const t = it.track;
      if (!t) continue;
      const meta = trackToId3Meta(t);
      if (meta?.title && meta?.artist) {
        out.push({
          title: meta.title,
          artist: meta.artist,
          album: meta.album,
          year: meta.release_year,
          date: meta.release_date,
          track_number: meta.track_number,
          disc_number: meta.disc_number,
          track_total: meta.track_total,
          disc_total: meta.disc_total,
          isrc: meta.isrc,
          coverUrl: meta.coverUrl,
          spUrl: meta.spotifyUrl
        });
      }
    }
    if (page.body.next) {
      const url = new URL(page.body.next);
      const offset = Number(url.searchParams.get("offset") || 0);
      page = await withMarketFallback(async (mkt) => {
        const r = await api.getPlaylistTracks(id, { limit: 100, offset, ...(mkt ? { market: mkt } : {}) });
        return r || null;
      }, resolveMarket(market));
      if (!page) break;
    } else break;
  }
  return out;
}

async function fetchAlbumItems(api, id, market) {
  const out = [];
  let page = await withMarketFallback(async (mkt) => {
    const r = await api.getAlbumTracks(id, { limit: 50, ...(mkt ? { market: mkt } : {}) });
    return r || null;
  }, resolveMarket(market));
  if (!page) return out;

  let albumInfo = null;
  try {
    const albumData = await withMarketFallback(async (mkt) => {
      const r = await api.getAlbum(id, { ...(mkt ? { market: mkt } : {}) });
      return r?.body || null;
    }, resolveMarket(market));

    if (albumData) {
      albumInfo = {
        name: albumData.name,
        artist: albumData.artists?.[0]?.name || "",
        release_date: albumData.release_date || "",
        total_tracks: albumData.total_tracks,
        coverUrl: pickBestImage(albumData.images || [])
      };
    }
  } catch (e) {
    console.warn("Album info alınamadı:", e);
  }

  while (true) {
    for (const track of page.body.items || []) {
      const meta = trackToId3Meta({
        ...track,
        album: {
          name: albumInfo?.name || "",
          release_date: albumInfo?.release_date || "",
          total_tracks: albumInfo?.total_tracks || null,
          images: albumInfo?.coverUrl ? [{ url: albumInfo.coverUrl }] : []
        }
      });

      if (meta?.title && meta?.artist) {
        out.push({
          title: meta.title,
          artist: meta.artist,
          album: albumInfo?.name || "",
          year: meta.release_year,
          date: meta.release_date,
          track_number: meta.track_number,
          disc_number: meta.disc_number,
          track_total: albumInfo?.total_tracks || null,
          disc_total: meta.disc_total,
          isrc: meta.isrc,
          coverUrl: albumInfo?.coverUrl,
          spUrl: `https://open.spotify.com/track/${track.id}`
        });
      }
    }

    if (page.body.next) {
      const url = new URL(page.body.next);
      const offset = Number(url.searchParams.get("offset") || 0);
      page = await withMarketFallback(async (mkt) => {
        const r = await api.getAlbumTracks(id, { limit: 50, offset, ...(mkt ? { market: mkt } : {}) });
        return r || null;
      }, resolveMarket(market));
      if (!page) break;
    } else {
      break;
    }
  }
  return out;
}

export async function resolveSpotifyUrl(url, { market } = {}) {
  const { type, id } = parseSpotifyUrl(url);
  if (!id || type === "unknown") throw new Error("Desteklenmeyen Spotify URL");

  const api = await makeSpotify();

  if (type === "track") {
    const t = await fetchTrack(api, id, market);
    const title = `${t.artist} - ${t.title}`;
    return { kind: "track", title, items: [t] };
  }

  if (type === "playlist") {
    if (isPersonalizedMixId(id)) {
      throw new Error("SPOTIFY_MIX_UNSUPPORTED: Bu URL Spotify’ın kişiselleştirilmiş Mix formatında. Spotify Web API bu içerikleri sağlamaz (404). Lütfen mix’teki parçaları Spotify uygulamasında yeni bir oynatma listesine kopyalayın ve o listenin URL’sini kullanın.");
    }
    let plTitle = "Spotify Playlist";
    try {
      const pl = (await api.getPlaylist(id, { fields: "name" })).body;
      plTitle = pl?.name || plTitle;
    } catch {}
    let items;
    try {
      items = await fetchPlaylistItems(api, id, market);
    } catch (e) {
      const msg = String(e?.message || "");
      const notFound = /Resource not found|status\s*:\s*404/i.test(msg);
      if (notFound || isPersonalizedMixId(id)) {
        throw new Error("SPOTIFY_MIX_UNSUPPORTED: Bu URL kişiselleştirilmiş/erişilemeyen bir Mix olabilir. Spotify Web API bu içerikleri sağlamaz (404). Lütfen mix’teki parçaları Spotify uygulamasında yeni bir oynatma listesine kopyalayın ve o listenin URL’sini kullanın.");
      }
      throw e;
    }
    return { kind: "playlist", title: plTitle, items };
  }

  if (type === "album") {
    let albumTitle = "Spotify Album";
    let albumArtist = "";

    try {
      const albumData = await withMarketFallback(async (mkt) => {
        const r = await api.getAlbum(id, { ...(mkt ? { market: mkt } : {}) });
        return r?.body || null;
      }, resolveMarket(market));

      if (albumData) {
        albumTitle = albumData.name;
        albumArtist = albumData.artists?.[0]?.name || "";
      }
    } catch (e) {
      console.warn("Album başlık alınamadı:", e);
    }

    const items = await fetchAlbumItems(api, id, market);
    const title = albumArtist ? `${albumArtist} - ${albumTitle}` : albumTitle;

    return { kind: "playlist", title, items };
  }

  throw new Error("Bu Spotify URL tipi henüz destekli değil");
}
