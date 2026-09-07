const TIDAL_API_BASE = "https://api.tidal.com/v1";
const TIDAL_PAGE_SIZE = 50;
const TIDAL_MAX_ITEMS = 1000;
// Public client token used by TIDAL's anonymous web player for catalog metadata.
// TIDAL_PUBLIC_TOKEN can override this value if TIDAL rotates the web client token.
const TIDAL_PUBLIC_WEB_TOKEN = "txNoH4kkV41MfH25";
const TIDAL_HEADERS = Object.freeze({
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  accept: "application/json",
  "accept-language": "en-US,en;q=0.8"
});

const TRACK_CACHE = new Map();
const ALBUM_CACHE = new Map();
const PLAYLIST_CACHE = new Map();
const SEARCH_CACHE = new Map();

function cacheGet(cache, key) {
  return cache.has(key) ? cache.get(key) : undefined;
}

function cacheSet(cache, key, value, max = 500) {
  cache.set(key, value);
  if (cache.size > max) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeCountryCode(value = "") {
  const raw = String(value || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(raw) ? raw : "US";
}

function resolveCountryCode(market = "") {
  return normalizeCountryCode(process.env.TIDAL_COUNTRY_CODE || market || "US");
}

function tidalToken() {
  return String(process.env.TIDAL_PUBLIC_TOKEN || TIDAL_PUBLIC_WEB_TOKEN).trim();
}

function buildApiUrl(pathname = "", query = {}) {
  const path = String(pathname || "").replace(/^\/+/, "");
  const url = new URL(`${TIDAL_API_BASE}/${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function tidalGet(pathname, query = {}, { market = "", retryUs = true } = {}) {
  const requestedCountry = resolveCountryCode(market);
  const countries = retryUs && requestedCountry !== "US"
    ? [requestedCountry, "US"]
    : [requestedCountry];

  let lastError = null;
  for (const countryCode of countries) {
    const url = buildApiUrl(pathname, { ...query, countryCode });
    let res;
    try {
      res = await fetch(url, {
        headers: {
          ...TIDAL_HEADERS,
          "x-tidal-token": tidalToken()
        },
        redirect: "error"
      });
    } catch (error) {
      lastError = new Error(`TIDAL metadata request failed: ${error?.message || error}`);
      continue;
    }

    const text = await res.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}

    if (res.ok) return payload;

    const detail = payload?.userMessage || payload?.message || text || `HTTP ${res.status}`;
    lastError = new Error(`TIDAL metadata request failed (${res.status}): ${String(detail).slice(0, 500)}`);

    // A market may be unsupported even though the catalog item exists. Retry against US once.
    if (!(retryUs && countryCode !== "US" && [400, 403, 404].includes(res.status))) {
      break;
    }
  }

  throw lastError || new Error("TIDAL metadata request failed");
}

function buildTidalCoverUrl(cover = "", size = 1280) {
  const id = String(cover || "").trim();
  if (!id) return "";
  const safeSize = Math.max(80, Math.min(1280, Number(size) || 1280));
  const path = id.replace(/-/g, "/");
  return `https://resources.tidal.com/images/${path}/${safeSize}x${safeSize}.jpg`;
}

function artistNames(track = {}) {
  const artists = Array.isArray(track?.artists) ? track.artists : [];
  const names = artists
    .map((artist) => String(artist?.name || "").trim())
    .filter(Boolean);
  if (names.length) return names.join(", ");
  return String(track?.artist?.name || "").trim();
}

function albumArtistName(track = {}, album = null) {
  const albumArtist = String(album?.artist?.name || track?.album?.artist?.name || "").trim();
  return albumArtist || artistNames(track);
}

function buildTidalTrackUrl(trackId, albumId = null) {
  const tid = String(trackId || "").trim();
  const aid = String(albumId || "").trim();
  if (!tid) return "";
  if (aid) return `https://tidal.com/album/${encodeURIComponent(aid)}/track/${encodeURIComponent(tid)}`;
  return `https://tidal.com/track/${encodeURIComponent(tid)}`;
}

function unwrapTrackRow(row = {}) {
  if (row?.item && typeof row.item === "object") return row.item;
  if (row?.track && typeof row.track === "object") return row.track;
  return row;
}

export function tidalTrackToMeta(rawTrack, albumResult = null) {
  const track = unwrapTrackRow(rawTrack || {});
  if (!track || typeof track !== "object") return null;

  const album = albumResult || track.album || {};
  const trackId = numberOrNull(track.id);
  const albumId = numberOrNull(album?.id || track?.album?.id);
  const artistId = numberOrNull(track?.artist?.id || track?.artists?.[0]?.id);
  const releaseDate = String(
    album?.releaseDate ||
    album?.streamStartDate ||
    track?.streamStartDate ||
    ""
  ).trim();
  const coverId = String(album?.cover || track?.album?.cover || "").trim();
  const artist = artistNames(track);
  const title = String(track?.title || "").trim();
  const version = String(track?.version || "").trim();
  const displayTitle = version && !title.toLowerCase().includes(version.toLowerCase())
    ? `${title} (${version})`
    : title;
  const webpageUrl = buildTidalTrackUrl(trackId, albumId);

  return {
    title: displayTitle,
    track: displayTitle,
    artist,
    uploader: artist,
    album: String(album?.title || track?.album?.title || "").trim(),
    album_artist: albumArtistName(track, albumResult),
    release_year: releaseDate ? releaseDate.slice(0, 4) : "",
    release_date: releaseDate,
    track_number: numberOrNull(track?.trackNumber),
    disc_number: numberOrNull(track?.volumeNumber),
    track_total: numberOrNull(album?.numberOfTracks || track?.album?.numberOfTracks),
    disc_total: numberOrNull(album?.numberOfVolumes || track?.album?.numberOfVolumes),
    isrc: String(track?.isrc || "").trim(),
    coverUrl: buildTidalCoverUrl(coverId, 1280),
    thumbnailUrl: buildTidalCoverUrl(coverId, 640),
    imageUrl: buildTidalCoverUrl(coverId, 1280),
    webpage_url: webpageUrl,
    tidalUrl: webpageUrl,
    genre: "",
    label: String(album?.label || "").trim(),
    publisher: String(album?.label || "").trim(),
    copyright: String(album?.copyright || track?.copyright || "").trim(),
    duration_ms: Number.isFinite(Number(track?.duration)) ? Math.round(Number(track.duration) * 1000) : null,
    explicit: track?.explicit === true,
    tidal_track_id: trackId,
    tidal_album_id: albumId,
    tidal_artist_id: artistId,
    source_provider: "tidal",
    source_store: "tidal"
  };
}

function buildResolvedItem(meta = {}) {
  const webpageUrl = meta.tidalUrl || meta.webpage_url || "";
  return {
    title: meta.track || meta.title || "",
    artist: meta.artist || meta.uploader || "",
    album: meta.album || "",
    album_artist: meta.album_artist || meta.artist || "",
    year: meta.release_year || "",
    date: meta.release_date || "",
    track_number: meta.track_number ?? null,
    disc_number: meta.disc_number ?? null,
    track_total: meta.track_total ?? null,
    disc_total: meta.disc_total ?? null,
    isrc: meta.isrc || "",
    coverUrl: meta.coverUrl || "",
    duration_ms: meta.duration_ms ?? null,
    tidalUrl: webpageUrl,
    webpage_url: webpageUrl,
    tidal_track_id: meta.tidal_track_id ?? null,
    tidal_album_id: meta.tidal_album_id ?? null,
    tidal_artist_id: meta.tidal_artist_id ?? null
  };
}

export function isTidalUrl(url) {
  return parseTidalUrl(url).type !== "unknown";
}

export function parseTidalUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return { type: "unknown", id: null, albumId: null, trackId: null };

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (host !== "tidal.com" && host !== "www.tidal.com" && host !== "listen.tidal.com") {
      return { type: "unknown", id: null, albumId: null, trackId: null };
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    const first = String(parts[0] || "").toLowerCase();

    if (first === "playlist") {
      const id = String(parts[1] || "").trim();
      if (/^[0-9a-f-]{16,64}$/i.test(id)) {
        return { type: "playlist", id, albumId: null, trackId: null };
      }
    }

    if (first === "album") {
      const albumId = String(parts[1] || "").trim();
      if (!/^\d+$/.test(albumId)) {
        return { type: "unknown", id: null, albumId: null, trackId: null };
      }
      if (String(parts[2] || "").toLowerCase() === "track" && /^\d+$/.test(String(parts[3] || ""))) {
        const trackId = String(parts[3]);
        return { type: "track", id: trackId, albumId, trackId };
      }
      return { type: "album", id: albumId, albumId, trackId: null };
    }
  } catch {}

  return { type: "unknown", id: null, albumId: null, trackId: null };
}

async function lookupTrack(trackId, { market = "" } = {}) {
  const id = String(trackId || "").trim();
  if (!/^\d+$/.test(id)) return null;
  const key = `${id}:${resolveCountryCode(market)}`;
  const cached = cacheGet(TRACK_CACHE, key);
  if (cached !== undefined) return cached;
  const track = await tidalGet(`tracks/${encodeURIComponent(id)}`, {}, { market });
  cacheSet(TRACK_CACHE, key, track || null, 1200);
  return track || null;
}

async function lookupAlbum(albumId, { market = "" } = {}) {
  const id = String(albumId || "").trim();
  if (!/^\d+$/.test(id)) return null;
  const key = `${id}:${resolveCountryCode(market)}`;
  const cached = cacheGet(ALBUM_CACHE, key);
  if (cached !== undefined) return cached;
  const album = await tidalGet(`albums/${encodeURIComponent(id)}`, {}, { market });
  cacheSet(ALBUM_CACHE, key, album || null, 500);
  return album || null;
}

async function lookupPlaylist(playlistId, { market = "" } = {}) {
  const id = String(playlistId || "").trim();
  if (!id) return null;
  const key = `${id}:${resolveCountryCode(market)}`;
  const cached = cacheGet(PLAYLIST_CACHE, key);
  if (cached !== undefined) return cached;
  const playlist = await tidalGet(`playlists/${encodeURIComponent(id)}`, {}, { market });
  cacheSet(PLAYLIST_CACHE, key, playlist || null, 300);
  return playlist || null;
}

export async function collectTidalPagedItems(fetchPage, {
  maxItems = TIDAL_MAX_ITEMS,
  pageSize = TIDAL_PAGE_SIZE
} = {}) {
  if (typeof fetchPage !== "function") throw new TypeError("fetchPage must be a function");
  const max = Math.max(1, Math.min(TIDAL_MAX_ITEMS, Number(maxItems) || TIDAL_MAX_ITEMS));
  const size = Math.max(1, Math.min(TIDAL_PAGE_SIZE, Number(pageSize) || TIDAL_PAGE_SIZE));
  const items = [];
  let totalNumberOfItems = null;

  for (let offset = 0; offset < max; offset += size) {
    const remaining = max - items.length;
    const limit = Math.min(size, remaining);
    if (limit <= 0) break;

    const page = await fetchPage({ limit, offset });
    const rows = Array.isArray(page?.items) ? page.items : [];
    const total = numberOrNull(page?.totalNumberOfItems);
    if (total != null && total >= 0) totalNumberOfItems = total;

    items.push(...rows.slice(0, remaining));

    if (!rows.length || rows.length < limit) break;
    if (totalNumberOfItems != null && items.length >= totalNumberOfItems) break;
  }

  return {
    items,
    totalNumberOfItems: totalNumberOfItems == null
      ? items.length
      : Math.min(totalNumberOfItems, max)
  };
}

async function getAllItems(pathname, {
  market = "",
  maxItems = TIDAL_MAX_ITEMS,
  pageSize = TIDAL_PAGE_SIZE
} = {}) {
  return collectTidalPagedItems(
    ({ limit, offset }) => tidalGet(pathname, { limit, offset }, { market }),
    { maxItems, pageSize }
  );
}

export async function findTidalTrackMetaById(trackId, { market = "", albumId = null } = {}) {
  const track = await lookupTrack(trackId, { market });
  if (!track) return null;

  const resolvedAlbumId = albumId || track?.album?.id || null;
  let album = null;
  if (resolvedAlbumId) {
    try { album = await lookupAlbum(resolvedAlbumId, { market }); } catch {}
  }
  return tidalTrackToMeta(track, album);
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

export async function findTidalTrackMetaByQuery(
  artist,
  title,
  { album = "", market = "", targetDurationMs = null, limit = 10 } = {}
) {
  const titleSafe = String(title || "").trim();
  const artistSafe = String(artist || "").trim();
  if (!titleSafe) return null;

  const cacheKey = JSON.stringify({
    artist: norm(artistSafe),
    title: norm(titleSafe),
    album: norm(album),
    market: resolveCountryCode(market),
    duration: Number.isFinite(Number(targetDurationMs)) ? Math.round(Number(targetDurationMs)) : null
  });
  const cached = cacheGet(SEARCH_CACHE, cacheKey);
  if (cached !== undefined) return cached;

  const query = [artistSafe, titleSafe].filter(Boolean).join(" ");
  let payload;
  try {
    payload = await tidalGet("search/tracks", {
      query,
      limit: Math.max(1, Math.min(20, Number(limit) || 10)),
      offset: 0
    }, { market });
  } catch {
    cacheSet(SEARCH_CACHE, cacheKey, null, 500);
    return null;
  }

  const rows = Array.isArray(payload?.items) ? payload.items : [];
  const targetTitle = norm(titleSafe);
  const targetArtist = norm(artistSafe);
  const targetAlbum = norm(album);
  let best = null;
  let bestScore = -1;

  for (const row of rows) {
    const track = unwrapTrackRow(row);
    const candidateTitle = norm(track?.title || "");
    const candidateArtist = norm(artistNames(track));
    const candidateAlbum = norm(track?.album?.title || "");
    if (!candidateTitle) continue;

    let score = 0;
    if (candidateTitle === targetTitle) score += 6;
    else if (candidateTitle.includes(targetTitle) || targetTitle.includes(candidateTitle)) score += 3;
    if (targetArtist && candidateArtist === targetArtist) score += 5;
    else if (targetArtist && (candidateArtist.includes(targetArtist) || targetArtist.includes(candidateArtist))) score += 2;
    if (targetAlbum && candidateAlbum === targetAlbum) score += 2;

    const durationMs = Number(track?.duration || 0) * 1000;
    if (Number.isFinite(Number(targetDurationMs)) && durationMs > 0) {
      const delta = Math.abs(durationMs - Number(targetDurationMs));
      if (delta <= 3000) score += 2;
      else if (delta <= 8000) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }

  if (!best || bestScore < 3) {
    cacheSet(SEARCH_CACHE, cacheKey, null, 500);
    return null;
  }

  let albumResult = null;
  try { albumResult = await lookupAlbum(best?.album?.id, { market }); } catch {}
  const meta = tidalTrackToMeta(best, albumResult);
  cacheSet(SEARCH_CACHE, cacheKey, meta, 500);
  return meta;
}

export async function resolveTidalUrlTitle(url, { market = "" } = {}) {
  const parsed = parseTidalUrl(url);
  if (!parsed?.id || parsed.type === "unknown") {
    throw new Error("Unsupported TIDAL URL");
  }

  if (parsed.type === "track") {
    const meta = await findTidalTrackMetaById(parsed.trackId || parsed.id, {
      market,
      albumId: parsed.albumId
    });
    if (!meta) throw new Error("TIDAL track title could not be resolved");
    return [meta.artist, meta.title].filter(Boolean).join(" - ");
  }

  if (parsed.type === "album") {
    const album = await lookupAlbum(parsed.id, { market });
    const title = [album?.artist?.name, album?.title]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" - ");
    if (!title) throw new Error("TIDAL album title could not be resolved");
    return title;
  }

  if (parsed.type === "playlist") {
    const playlist = await lookupPlaylist(parsed.id, { market });
    const title = String(playlist?.title || "").trim();
    if (!title) throw new Error("TIDAL playlist title could not be resolved");
    return title;
  }

  throw new Error("Unsupported TIDAL URL");
}

export async function resolveTidalUrlLite(url, { market = "", maxItems = TIDAL_MAX_ITEMS } = {}) {
  const parsed = parseTidalUrl(url);
  if (!parsed?.id || parsed.type === "unknown") {
    throw new Error("Unsupported TIDAL URL");
  }

  if (parsed.type === "track") {
    const meta = await findTidalTrackMetaById(parsed.trackId || parsed.id, {
      market,
      albumId: parsed.albumId
    });
    if (!meta) throw new Error("TIDAL track metadata not found");
    return {
      kind: "track",
      provider: "tidal",
      title: [meta.artist, meta.title].filter(Boolean).join(" - ") || "TIDAL Track",
      items: [buildResolvedItem(meta)],
      totalHint: 1
    };
  }

  if (parsed.type === "album") {
    const [album, tracksPage] = await Promise.all([
      lookupAlbum(parsed.id, { market }),
      getAllItems(`albums/${encodeURIComponent(parsed.id)}/tracks`, { market, maxItems })
    ]);
    const tracks = Array.isArray(tracksPage?.items) ? tracksPage.items : [];
    if (!album || !tracks.length) throw new Error("TIDAL album metadata not found");

    const items = tracks
      .map((track) => buildResolvedItem(tidalTrackToMeta(track, album)))
      .filter((item) => item.title);
    if (!items.length) throw new Error("TIDAL album metadata not found");

    return {
      kind: "album",
      provider: "tidal",
      title: [album?.artist?.name, album?.title]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join(" - ") || "TIDAL Album",
      items,
      totalHint: Math.min(Number(tracksPage?.totalNumberOfItems || items.length), Number(maxItems) || TIDAL_MAX_ITEMS)
    };
  }

  if (parsed.type === "playlist") {
    const [playlist, tracksPage] = await Promise.all([
      lookupPlaylist(parsed.id, { market }),
      getAllItems(`playlists/${encodeURIComponent(parsed.id)}/tracks`, { market, maxItems })
    ]);
    const tracks = Array.isArray(tracksPage?.items) ? tracksPage.items : [];
    if (!tracks.length) throw new Error("TIDAL playlist metadata not found");

    const items = tracks
      .map((track) => buildResolvedItem(tidalTrackToMeta(track, null)))
      .filter((item) => item.title);
    if (!items.length) throw new Error("TIDAL playlist metadata not found");

    return {
      kind: "playlist",
      provider: "tidal",
      title: String(playlist?.title || "").trim() || "TIDAL Playlist",
      items,
      totalHint: Math.min(Number(tracksPage?.totalNumberOfItems || items.length), Number(maxItems) || TIDAL_MAX_ITEMS)
    };
  }

  throw new Error("Unsupported TIDAL URL");
}

export async function resolveTidalUrl(url, options = {}) {
  return resolveTidalUrlLite(url, options);
}

export const TIDAL_METADATA_PAGE_SIZE = TIDAL_PAGE_SIZE;
export const TIDAL_METADATA_MAX_ITEMS = TIDAL_MAX_ITEMS;
