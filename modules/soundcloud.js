const SOUNDCLOUD_HOST_RE = /(^|\.)soundcloud\.com$/i;
const SOUNDCLOUD_API_HOST = "https://api-v2.soundcloud.com";
const SOUNDCLOUD_MAX_ITEMS = 1000;
const SOUNDCLOUD_PAGE_HEADERS = Object.freeze({
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.8"
});

function clean(value = "") {
  return String(value || "").trim();
}


function normalizeMatchText(value = "") {
  return clean(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSoundCloudDurationCompatible(
  sourceMs,
  candidateSeconds,
  {
    baseToleranceSec = 30,
    ratioTolerance = 0.20,
    minRatio = 0.65,
    maxRatio = 1.5
  } = {}
) {
  const sourceSeconds = Number(sourceMs) / 1000;
  const candidate = Number(candidateSeconds);
  if (!Number.isFinite(sourceSeconds) || sourceSeconds <= 0) return true;
  if (!Number.isFinite(candidate) || candidate <= 0) return true;

  const safeBase = Math.max(5, Number(baseToleranceSec) || 30);
  const safeRatioTolerance = Math.max(0.05, Math.min(1, Number(ratioTolerance) || 0.20));
  const safeMinRatio = Math.max(0.1, Math.min(1, Number(minRatio) || 0.65));
  const safeMaxRatio = Math.max(1, Number(maxRatio) || 1.5);
  const ratio = candidate / sourceSeconds;
  const maxDiff = Math.max(safeBase, sourceSeconds * safeRatioTolerance);
  const diff = Math.abs(candidate - sourceSeconds);

  return diff <= maxDiff && ratio >= safeMinRatio && ratio <= safeMaxRatio;
}

export function isSoundCloudTextDurationMatch(
  score,
  sourceMs,
  candidateSeconds,
  sourceTitle = "",
  {
    strictScore = 6,
    relaxedScore = 4,
    tightBaseSec = 8,
    tightRatio = 0.05
  } = {}
) {
  const numericScore = Number(score) || 0;
  if (numericScore >= Number(strictScore || 6)) return true;
  if (numericScore < Number(relaxedScore || 4)) return false;

  const sourceSeconds = Number(sourceMs) / 1000;
  const candidate = Number(candidateSeconds);
  if (!Number.isFinite(sourceSeconds) || sourceSeconds <= 0) return false;
  if (!Number.isFinite(candidate) || candidate <= 0) return false;

  const maxDiff = Math.max(
    Math.max(3, Number(tightBaseSec) || 8),
    sourceSeconds * Math.max(0.01, Math.min(0.20, Number(tightRatio) || 0.05))
  );
  if (Math.abs(candidate - sourceSeconds) > maxDiff) return false;

  const titleNorm = normalizeMatchText(sourceTitle || "");
  return titleNorm.length >= 6;
}


function splitSoundCloudArtistTitle(value = "") {
  const text = clean(value);
  const match = text.match(/^(.{1,120}?)\s+[\-–—]\s+(.{1,320})$/u);
  if (!match) return null;
  const artist = clean(match[1]);
  const title = clean(match[2]);
  return artist && title ? { artist, title } : null;
}

function stripLeadingSoundCloudUploaderPrefix(title = "", uploader = "") {
  const rawTitle = clean(title);
  const rawUploader = clean(uploader);
  if (!rawTitle || !rawUploader) return rawTitle;

  const first = splitSoundCloudArtistTitle(rawTitle);
  if (!first) return rawTitle;
  if (normalizeMatchText(first.artist) !== normalizeMatchText(rawUploader)) return rawTitle;

  // Only remove the account prefix when the remainder still has its own
  // canonical "Artist - Track" shape. This avoids stripping a real artist
  // from ordinary titles such as "Cem Karaca - Raptiye Rap Rap".
  return splitSoundCloudArtistTitle(first.title) ? first.title : rawTitle;
}

function stripSoundCloudPromoNoise(value = "") {
  let text = clean(value);
  if (!text) return "";

  const promoToken = /(?:free\s*(?:download|dl)|download\s*free|premiere|out\s*now|stream\s*now)/i;
  text = text
    .replace(/\(([^)]*)\)/g, (full, inner) => promoToken.test(inner) ? " " : full)
    .replace(/\[([^\]]*)\]/g, (full, inner) => promoToken.test(inner) ? " " : full)
    .replace(/\{([^}]*)\}/g, (full, inner) => promoToken.test(inner) ? " " : full)
    .replace(/\bFREE\s+(?:DOWNLOAD|DL)\b/gi, " ")
    .replace(/\b(?:DOWNLOAD|STREAM)\s+NOW\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text.replace(/[|•·\-–—:]+\s*$/g, "").trim();
}

export function deriveSoundCloudMatchIdentity({ artist = "", title = "" } = {}) {
  const rawArtist = clean(artist);
  const rawTitle = clean(title);
  let matchArtist = rawArtist;
  let matchTitle = stripSoundCloudPromoNoise(rawTitle);

  // SoundCloud upload titles very commonly include the canonical artist in the
  // title itself ("Artist - Track") while uploader is only an account name.
  // Use that pair for matching without changing the source metadata/tags.
  const separator = rawTitle.match(/^(.{1,100}?)\s+[\-–—]\s+(.{1,240})$/u);
  if (separator) {
    const left = stripSoundCloudPromoNoise(separator[1]);
    const right = stripSoundCloudPromoNoise(separator[2]);
    if (left && right) {
      matchArtist = left;
      matchTitle = right;
    }
  } else if (rawArtist && matchTitle) {
    const artistNorm = normalizeMatchText(rawArtist);
    const titleNorm = normalizeMatchText(matchTitle);
    if (artistNorm && titleNorm.startsWith(`${artistNorm} `)) {
      const escaped = rawArtist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      matchTitle = matchTitle.replace(new RegExp(`^${escaped}\\s*[:\-–—]\\s*`, "i"), "").trim() || matchTitle;
    }
  }

  return {
    artist: matchArtist || rawArtist,
    title: matchTitle || rawTitle
  };
}

function unknownParsed() {
  return { type: "unknown", id: "", special: false, collectionKind: "" };
}

export function parseSoundCloudUrl(rawUrl = "") {
  const value = clean(rawUrl);
  try {
    const parsed = new URL(value);
    if (!SOUNDCLOUD_HOST_RE.test(parsed.hostname)) return unknownParsed();

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (!parts.length) return unknownParsed();

    const first = clean(parts[0]).toLowerCase();
    const second = clean(parts[1]).toLowerCase();

    // SoundCloud exposes editorial/discovery lists as ordinary set URLs.
    // Examples supported by yt-dlp include /discover/sets/... and
    // /buzzing-playlists/sets/.... Keep their special origin in collectionKind.
    if (second === "sets" && parts[2]) {
      const special = first === "discover" || first === "buzzing-playlists";
      return {
        type: "playlist",
        id: `${parts[0]}/sets/${parts[2]}`,
        special,
        collectionKind: first === "buzzing-playlists"
          ? "buzzing_playlist"
          : first === "discover"
          ? "discovery_set"
          : "set"
      };
    }

    // Track stations are collection-like and have their own yt-dlp extractor.
    if (first === "stations" && second === "track" && parts[2]) {
      return {
        type: "special",
        id: parts.join("/"),
        special: true,
        collectionKind: "track_station"
      };
    }

    // Bare discovery pages are intentionally not accepted: the working public
    // URLs are their concrete /sets/... children, not /discover or /charts/top.
    if (first === "discover" || first === "charts" || first === "buzzing-playlists" || first === "stations") {
      return unknownParsed();
    }

    const userCollection = new Set([
      "tracks",
      "likes",
      "reposts",
      "sets",
      "albums",
      "popular-tracks",
      "spotlight"
    ]);
    if (userCollection.has(second)) {
      return {
        type: "user_playlist",
        id: `${parts[0]}/${parts[1]}`,
        special: true,
        collectionKind: second.replace(/-/g, "_")
      };
    }

    if (parts.length === 1) {
      return {
        type: "user_playlist",
        id: parts[0],
        special: true,
        collectionKind: "profile"
      };
    }

    if (parts.length >= 2) {
      return {
        type: "track",
        id: `${parts[0]}/${parts[1]}`,
        special: false,
        collectionKind: "track"
      };
    }
  } catch {}
  return unknownParsed();
}

export function isSoundCloudUrl(rawUrl = "") {
  return parseSoundCloudUrl(rawUrl).type !== "unknown";
}

function pickThumbnail(entry = {}) {
  return entry.thumbnail || entry.artwork_url || entry.thumbnails?.at?.(-1)?.url || null;
}

function durationMs(entry = {}) {
  const direct = Number(entry.duration_ms ?? entry.durationMs ?? 0);
  if (Number.isFinite(direct) && direct > 0) return Math.round(direct);
  const seconds = Number(entry.duration || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isNumericOnly(value = "") {
  return /^\d+$/.test(clean(value));
}

export function soundCloudTrackToMeta(entry = {}, parentUrl = "") {
  const rawUrl = clean(entry.permalink_url || entry.webpage_url || entry.original_url || entry.url || "");
  const webpageUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : parentUrl;
  const sourceId = clean(entry.soundcloud_track_id || entry.id || entry.display_id || "");
  const sourceUrn = clean(entry.soundcloud_urn || entry.urn || entry.track_urn || (/^soundcloud:tracks:/i.test(sourceId) ? sourceId : ""));
  const id = /^soundcloud:tracks:(\d+)$/i.test(sourceId)
    ? sourceId.match(/^soundcloud:tracks:(\d+)$/i)[1]
    : sourceId;
  const sourceUploader = clean(
    entry.uploader ||
    entry.creator ||
    entry.channel ||
    entry.user?.username ||
    ""
  );
  const rawArtist = clean(
    entry.artist ||
    entry.publisher_metadata?.artist ||
    sourceUploader ||
    ""
  );
  let rawTitle = clean(entry.track || entry.title || entry.fulltitle || entry.name || "");
  if (rawTitle && id && rawTitle === id) rawTitle = "";
  if (isNumericOnly(rawTitle) && (!id || rawTitle === id)) rawTitle = "";

  // Some SoundCloud sets expose rows as:
  //   "Uploader - Real Artist - Track"
  // Remove only that duplicated account prefix, then keep the remaining title
  // intact for identity parsing. Remix/Edit/Rework text is intentionally kept.
  const identityTitle = stripLeadingSoundCloudUploaderPrefix(rawTitle, sourceUploader);
  const uploaderPrefixRemoved = identityTitle !== rawTitle;
  const matchIdentity = deriveSoundCloudMatchIdentity({
    artist: uploaderPrefixRemoved ? "" : rawArtist,
    title: identityTitle
  });

  // When the title itself exposes a canonical artist/title pair, use it for
  // output metadata too. The original SoundCloud fields stay available below
  // for exact-search fallbacks, so this does not weaken remix matching.
  const identityPair = splitSoundCloudArtistTitle(identityTitle);
  const artist = identityPair ? (matchIdentity.artist || rawArtist) : rawArtist;
  const title = identityPair ? (matchIdentity.title || identityTitle) : identityTitle;

  const coverUrl = pickThumbnail(entry);
  const releaseDate = clean(entry.release_date || entry.upload_date || entry.published_at || "");
  const genre = clean(entry.genre || (Array.isArray(entry.genres) ? entry.genres[0] : ""));
  const explicitAlbumArtist = clean(entry.album_artist || entry.album_artists?.[0] || "");
  const albumArtist = explicitAlbumArtist && normalizeMatchText(explicitAlbumArtist) !== normalizeMatchText(sourceUploader)
    ? explicitAlbumArtist
    : artist;

  return {
    title,
    track: title,
    artist,
    uploader: artist,
    soundcloud_uploader: sourceUploader || null,
    soundcloud_raw_artist: rawArtist || null,
    soundcloud_raw_title: rawTitle || null,
    match_artist: matchIdentity.artist,
    match_title: matchIdentity.title,
    album: clean(entry.album || ""),
    album_artist: albumArtist,
    release_year: releaseDate ? releaseDate.slice(0, 4) : "",
    release_date: releaseDate,
    track_number: numberOrNull(entry.track_number || entry.playlist_index),
    track_total: numberOrNull(entry.track_total || entry.n_entries || entry.playlist_count),
    genre,
    copyright: clean(entry.copyright || entry.license || ""),
    duration_ms: durationMs(entry),
    coverUrl,
    thumbnailUrl: coverUrl,
    imageUrl: coverUrl,
    soundcloud_track_id: id || null,
    soundcloud_urn: sourceUrn || null,
    soundcloudUrl: webpageUrl,
    scUrl: webpageUrl,
    webpage_url: webpageUrl,
    source_provider: "soundcloud",
    source_store: "soundcloud"
  };
}

function usableTrack(item = {}) {
  return !!clean(item.title) && !!clean(item.artist) && !isNumericOnly(item.title);
}

function collectionTitle(meta = {}, parsed = {}) {
  if (meta.title && !isNumericOnly(meta.title)) return meta.title;
  if (parsed.collectionKind === "buzzing_playlist") return "SoundCloud Buzzing Playlist";
  if (parsed.collectionKind === "discovery_set") return "SoundCloud Discovery";
  if (parsed.collectionKind === "popular_tracks") return "SoundCloud Popular Tracks";
  if (parsed.collectionKind === "set") return "SoundCloud Playlist";
  if (parsed.type === "user_playlist") return "SoundCloud User Collection";
  if (parsed.type === "special") return "SoundCloud Station";
  if (parsed.type === "playlist") return "SoundCloud Playlist";
  return "SoundCloud Track";
}

async function fetchText(url, headers = SOUNDCLOUD_PAGE_HEADERS, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`SoundCloud metadata request failed (${response.status})`);
    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export function extractSoundCloudClientId(html = "") {
  const source = String(html || "");
  const patterns = [
    /["']hydratable["']\s*:\s*["']apiClient["'][\s\S]{0,1600}?["']id["']\s*:\s*["']([A-Za-z0-9_-]{16,})["']/i,
    /["']apiClient["'][\s\S]{0,1600}?["']id["']\s*:\s*["']([A-Za-z0-9_-]{16,})["']/i,
    /client_id[=:]([A-Za-z0-9_-]{16,})/i
  ];
  for (const re of patterns) {
    const match = source.match(re);
    if (match?.[1]) return match[1];
  }
  return "";
}

async function getSoundCloudClientId(pageUrl) {
  const envId = clean(process.env.SOUNDCLOUD_CLIENT_ID);
  if (envId) return envId;

  for (const candidate of [pageUrl, "https://soundcloud.com/"]) {
    try {
      const clientId = extractSoundCloudClientId(await fetchText(candidate));
      if (clientId) return clientId;
    } catch {}
  }
  return "";
}


async function fetchSoundCloudJson(rawUrl, clientId, timeoutMs = 20000) {
  const url = new URL(rawUrl);
  if (clientId && !url.searchParams.has("client_id")) url.searchParams.set("client_id", clientId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        referer: "https://soundcloud.com/",
        "user-agent": SOUNDCLOUD_PAGE_HEADERS["user-agent"]
      },
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`SoundCloud API request failed (${response.status})`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function rankSoundCloudPopularTracks(entries = []) {
  return [...entries].filter(Boolean).sort((a, b) => {
    const playsA = Number(a?.playback_count ?? a?.playbackCount ?? 0) || 0;
    const playsB = Number(b?.playback_count ?? b?.playbackCount ?? 0) || 0;
    if (playsB !== playsA) return playsB - playsA;
    const likesA = Number(a?.likes_count ?? a?.favoritings_count ?? 0) || 0;
    const likesB = Number(b?.likes_count ?? b?.favoritings_count ?? 0) || 0;
    return likesB - likesA;
  });
}

async function resolveSoundCloudPopularTracks(url, parsed, limit) {
  const clientId = await getSoundCloudClientId(url);
  if (!clientId) throw new Error("SoundCloud public client id could not be resolved");

  const profileSlug = clean(parsed.id).split("/")[0];
  if (!profileSlug) throw new Error("SoundCloud profile could not be resolved");

  const resolveUrl = new URL(`${SOUNDCLOUD_API_HOST}/resolve`);
  resolveUrl.searchParams.set("url", `https://soundcloud.com/${profileSlug}`);
  const user = await fetchSoundCloudJson(resolveUrl, clientId);
  const userId = clean(user?.id || String(user?.urn || "").match(/soundcloud:users:(\d+)/i)?.[1] || "");
  if (!userId) throw new Error("SoundCloud profile id could not be resolved");

  const collected = [];
  let nextUrl = new URL(`${SOUNDCLOUD_API_HOST}/users/${userId}/tracks`);
  nextUrl.searchParams.set("limit", "200");
  nextUrl.searchParams.set("linked_partitioning", "1");
  nextUrl.searchParams.set("offset", "0");

  // Popular Tracks is a SoundCloud web profile section that yt-dlp's current
  // SoundcloudUserIE does not accept. Recreate it from the user's public track
  // catalog and rank by public playback count. Fetch at most our global cap.
  while (nextUrl && collected.length < SOUNDCLOUD_MAX_ITEMS) {
    const payload = await fetchSoundCloudJson(nextUrl, clientId);
    const page = Array.isArray(payload) ? payload : (Array.isArray(payload?.collection) ? payload.collection : []);
    collected.push(...page.filter(Boolean));

    const nextHref = clean(payload?.next_href);
    if (!nextHref || Array.isArray(payload)) break;
    nextUrl = new URL(nextHref);
  }

  const ranked = rankSoundCloudPopularTracks(collected)
    .map((entry) => soundCloudApiEntryToMeta(entry, url))
    .filter(usableTrack)
    .slice(0, limit);
  if (!ranked.length) throw new Error("SoundCloud popular tracks could not be resolved");

  return {
    kind: "playlist",
    collectionKind: "popular_tracks",
    provider: "soundcloud",
    id: `${profileSlug}/popular-tracks`,
    title: `${clean(user?.username || profileSlug)} — Popular Tracks`,
    coverUrl: clean(user?.avatar_url) || null,
    items: ranked
  };
}

function soundCloudApiEntryToMeta(entry = {}, parentUrl = "") {
  return soundCloudTrackToMeta({
    ...entry,
    // api-v2 uses milliseconds while yt-dlp's generic duration uses seconds.
    duration_ms: Number(entry.duration || 0) || null,
    webpage_url: entry.permalink_url || entry.webpage_url || entry.url || parentUrl,
    uploader: entry.user?.username || entry.publisher_metadata?.artist || entry.uploader || "",
    artist: entry.publisher_metadata?.artist || entry.user?.username || entry.artist || "",
    title: entry.title || entry.name || ""
  }, parentUrl);
}

async function fetchSoundCloudTracksByIds(ids = [], clientId, parentUrl = "") {
  const unique = [...new Set(ids.map(clean).filter((id) => /^\d+$/.test(id)))];
  if (!unique.length || !clientId) return new Map();

  const out = new Map();
  const chunkSize = 50;
  for (let index = 0; index < unique.length; index += chunkSize) {
    const chunk = unique.slice(index, index + chunkSize);
    const url = new URL(`${SOUNDCLOUD_API_HOST}/tracks`);
    url.searchParams.set("ids", chunk.join(","));
    url.searchParams.set("client_id", clientId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          referer: "https://soundcloud.com/",
          "user-agent": SOUNDCLOUD_PAGE_HEADERS["user-agent"]
        },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`SoundCloud API metadata request failed (${response.status})`);
      const payload = await response.json();
      const entries = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.collection) ? payload.collection : []);
      for (const entry of entries) {
        const id = clean(entry?.id);
        if (!id) continue;
        const meta = soundCloudApiEntryToMeta(entry, parentUrl);
        if (usableTrack(meta)) out.set(id, meta);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  return out;
}

async function hydrateFlatEntriesWithApi(entries, url) {
  const incomplete = entries.filter((entry) => {
    const meta = soundCloudTrackToMeta(entry, url);
    return !usableTrack(meta) && /^\d+$/.test(clean(entry?.id));
  });
  if (!incomplete.length) return new Map();

  try {
    const clientId = await getSoundCloudClientId(url);
    if (!clientId) return new Map();
    return await fetchSoundCloudTracksByIds(incomplete.map((entry) => entry.id), clientId, url);
  } catch {
    return new Map();
  }
}

async function resolveWithFullYtDlp(runYtJson, url, limit) {
  const full = await runYtJson(
    ["--no-flat-playlist", "--playlist-end", String(limit), url],
    "soundcloud-metadata-full",
    180000
  );
  const entries = Array.isArray(full?.entries) && full.entries.length
    ? full.entries.filter(Boolean)
    : [full];
  return { meta: full, entries };
}

export async function resolveSoundCloudUrlLite(rawUrl, { maxItems = SOUNDCLOUD_MAX_ITEMS } = {}) {
  const url = clean(rawUrl);
  const parsed = parseSoundCloudUrl(url);
  if (parsed.type === "unknown") throw new Error("Unsupported SoundCloud URL");

  const limit = Math.max(1, Math.min(SOUNDCLOUD_MAX_ITEMS, Number(maxItems) || SOUNDCLOUD_MAX_ITEMS));

  // yt-dlp currently supports generic user collections such as /tracks and
  // /sets, but not the SoundCloud web-only /popular-tracks profile section.
  // Resolve that section directly through SoundCloud's public API instead.
  if (parsed.collectionKind === "popular_tracks") {
    return resolveSoundCloudPopularTracks(url, parsed, limit);
  }

  const { runYtJson } = await import("./yt.js");

  let meta = await runYtJson(
    ["--flat-playlist", "--playlist-end", String(limit), url],
    "soundcloud-metadata",
    90000
  );
  const rawEntries = Array.isArray(meta?.entries) ? meta.entries.filter(Boolean) : [];
  const isCollection = rawEntries.length > 0 || ["playlist", "user_playlist", "special"].includes(parsed.type);
  let entries = rawEntries.length ? rawEntries : [meta];

  // Flat playlists are intentionally fast, but SoundCloud sometimes emits only
  // numeric ids for part of a list. Fill those rows from api-v2 in batches so a
  // numeric id can never leak into the YouTube Music search query as the title.
  const hydratedById = await hydrateFlatEntriesWithApi(entries, url);
  let items = entries.map((entry) => {
    const id = clean(entry?.id);
    const basic = soundCloudTrackToMeta(entry, url);
    return usableTrack(basic) ? basic : (hydratedById.get(id) || basic);
  });

  if (items.some((item) => !usableTrack(item))) {
    try {
      const full = await resolveWithFullYtDlp(runYtJson, url, limit);
      meta = full.meta || meta;
      entries = full.entries;
      items = entries.map((entry) => soundCloudTrackToMeta(entry, url));
    } catch {
      items = items.filter(usableTrack);
    }
  }

  items = items.filter(usableTrack).slice(0, limit);
  if (!items.length) {
    throw new Error("SoundCloud content could not be resolved with title/artist metadata");
  }

  const albumType = clean(meta?.album_type || meta?.set_type).toLowerCase();
  const kind = parsed.type === "track"
    ? "track"
    : (albumType === "album" || albumType === "ep" ? "album" : "playlist");

  return {
    kind,
    collectionKind: isCollection ? (albumType || parsed.collectionKind || parsed.type) : "track",
    provider: "soundcloud",
    id: clean(meta?.id || parsed.id),
    title: collectionTitle(meta, parsed),
    coverUrl: pickThumbnail(meta),
    items
  };
}

export async function resolveSoundCloudUrl(rawUrl, options = {}) {
  return resolveSoundCloudUrlLite(rawUrl, options);
}

export async function resolveSoundCloudUrlTitle(rawUrl, options = {}) {
  const result = await resolveSoundCloudUrlLite(rawUrl, { ...options, maxItems: 1 });
  return result?.title || "";
}

export async function findSoundCloudTrackMetaById(_id, { item = null } = {}) {
  return item
    ? soundCloudTrackToMeta(item, item.soundcloudUrl || item.scUrl || item.webpage_url || "")
    : null;
}

export async function findSoundCloudTrackMetaByQuery(_artist, _title, { item = null } = {}) {
  return item
    ? soundCloudTrackToMeta(item, item.soundcloudUrl || item.scUrl || item.webpage_url || "")
    : null;
}
