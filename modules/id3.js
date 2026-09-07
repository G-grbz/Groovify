import fs from "fs";
import path from "path";
import NodeID3 from "node-id3";

const TURKISH_SPECIFIC_RE = /[ĞğİıŞş]/;

// Parses track number for core application logic.
function parseTrackNumber(meta = {}) {
  const direct = Number(meta.track_number);
  if (Number.isFinite(direct) && direct >= 0) {
    return Math.max(0, Math.min(255, Math.floor(direct)));
  }
  const fromTrack = String(meta.track || "").match(/^\s*(\d{1,3})(?:\s*\/\s*\d{1,3})?\s*$/);
  if (fromTrack) {
    const n = Number(fromTrack[1]);
    if (Number.isFinite(n) && n >= 0) return Math.max(0, Math.min(255, Math.floor(n)));
  }
  return 0;
}

// Returns id3v1 encoding used for core application logic.
function getId3v1Encoding(values = []) {
  const env = String(process.env.ID3V1_ENCODING || "auto").trim().toLowerCase();
  if (["latin1", "iso-8859-1"].includes(env)) return "latin1";
  if (["latin5", "iso-8859-9", "windows-1254", "cp1254"].includes(env)) return "latin5";

  const joined = values.filter(Boolean).join(" ");
  return TURKISH_SPECIFIC_RE.test(joined) ? "latin5" : "latin1";
}

// Handles map latin5 byte in core application logic.
function mapLatin5Byte(ch) {
  switch (ch) {
    case "Ğ":
      return 0xd0;
    case "ğ":
      return 0xf0;
    case "İ":
      return 0xdd;
    case "ı":
      return 0xfd;
    case "Ş":
      return 0xde;
    case "ş":
      return 0xfe;
    default:
      return null;
  }
}

// Handles encode id3v1 field in core application logic.
function encodeId3v1Field(text, maxLen, encoding) {
  const out = Buffer.alloc(maxLen, 0x00);
  const s = String(text || "").normalize("NFC");
  let i = 0;

  for (const ch of s) {
    if (i >= maxLen) break;
    const latin5 = encoding === "latin5" ? mapLatin5Byte(ch) : null;
    if (latin5 !== null) {
      out[i++] = latin5;
      continue;
    }

    const code = ch.codePointAt(0);
    if (Number.isFinite(code) && code >= 0x20 && code <= 0xff) {
      out[i++] = code;
    } else {
      out[i++] = 0x3f;
    }
  }

  return out;
}

function trimMetaValue(value) {
  if (value == null) return "";
  return String(value).trim();
}

function toPositiveIntOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function formatCountPair(numberValue, totalValue) {
  const numberPart = toPositiveIntOrNull(numberValue);
  if (!numberPart) return "";
  const totalPart = toPositiveIntOrNull(totalValue);
  return totalPart ? `${numberPart}/${totalPart}` : String(numberPart);
}

function normalizeId3Language(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "und";
  if (/^[a-z]{3}$/.test(raw)) return raw;

  const shortCodeMap = {
    ar: "ara",
    de: "deu",
    en: "eng",
    es: "spa",
    fr: "fra",
    it: "ita",
    ja: "jpn",
    ko: "kor",
    pt: "por",
    ru: "rus",
    tr: "tur"
  };

  const nameMap = {
    arabic: "ara",
    english: "eng",
    french: "fra",
    german: "deu",
    italian: "ita",
    japanese: "jpn",
    korean: "kor",
    portuguese: "por",
    russian: "rus",
    spanish: "spa",
    turkish: "tur"
  };

  return shortCodeMap[raw] || nameMap[raw] || "und";
}

function pushUserDefinedText(items, description, value) {
  if (!description) return;
  const normalized =
    typeof value === "boolean"
      ? String(value)
      : trimMetaValue(value);
  if (!normalized) return;
  if (items.some((item) => item.description === description && item.value === normalized)) {
    return;
  }
  items.push({ description, value: normalized });
}

function pushUserDefinedUrl(items, description, value) {
  if (!description) return;
  const url = trimMetaValue(value);
  if (!/^https?:\/\//i.test(url)) return;
  if (items.some((item) => item.description === description && item.url === url)) {
    return;
  }
  items.push({ description, url });
}

function pickComposer(meta = {}) {
  return trimMetaValue(
    meta.composer ||
    meta.album_artist ||
    meta.artist ||
    meta.uploader
  );
}

function pickSourceUrl(meta = {}) {
  return trimMetaValue(
    meta.webpage_url ||
    meta.spotifyUrl ||
    meta.spUrl ||
    meta.deezerUrl ||
    meta.dzUrl ||
    meta.tidalUrl ||
    meta.soundcloudUrl ||
    meta.scUrl
  );
}

function pickReleaseDate(meta = {}) {
  return trimMetaValue(
    meta.release_date ||
    meta.release_year ||
    meta.upload_date ||
    meta.upload_year
  );
}

export function buildRichId3v2Tags(meta = {}) {
  const title = trimMetaValue(meta.track || meta.title);
  const artist = trimMetaValue(meta.artist || meta.uploader);
  const album = trimMetaValue(meta.album || meta.playlist_title);
  const albumArtist = trimMetaValue(meta.album_artist || artist);
  const publisher = trimMetaValue(meta.publisher || meta.label);
  const composer = pickComposer(meta);
  const genre = trimMetaValue(meta.genre);
  const copyright = trimMetaValue(meta.copyright);
  const isrc = trimMetaValue(meta.isrc);
  const sourceUrl = pickSourceUrl(meta);
  const releaseDate = pickReleaseDate(meta);
  const year = trimMetaValue(meta.release_year || meta.upload_year || releaseDate.slice(0, 4));
  const trackNumber = formatCountPair(meta.track_number, meta.track_total);
  const partOfSet = formatCountPair(meta.disc_number, meta.disc_total);
  const language = normalizeId3Language(meta.language || meta.lyrics_language || meta.comment_language);
  const commentText = trimMetaValue(meta.comment);
  const lyricsText = trimMetaValue(meta.lyrics || meta.unsynchronisedLyrics?.text);

  const tags = {};
  if (title) tags.title = title;
  if (artist) tags.artist = artist;
  if (album) tags.album = album;
  if (albumArtist) tags.performerInfo = albumArtist;
  if (composer) tags.composer = composer;
  if (genre) tags.genre = genre;
  if (publisher) tags.publisher = publisher;
  if (copyright) tags.copyright = copyright;
  if (isrc) tags.ISRC = isrc;
  if (trackNumber) tags.trackNumber = trackNumber;
  if (partOfSet) tags.partOfSet = partOfSet;
  if (year) tags.year = year;
  if (releaseDate) {
    tags.date = releaseDate;
    tags.originalReleaseTime = releaseDate;
    tags.recordingTime = releaseDate;
    tags.releaseTime = releaseDate;
  }
  if (commentText) {
    tags.comment = {
      language,
      text: commentText
    };
  }
  if (lyricsText) {
    tags.unsynchronisedLyrics = {
      language,
      text: lyricsText
    };
  }
  if (sourceUrl) tags.audioSourceUrl = sourceUrl;
  if (trimMetaValue(meta.apple_artist_url)) tags.artistUrl = trimMetaValue(meta.apple_artist_url);

  const userDefinedText = [];
  pushUserDefinedText(userDefinedText, "SOURCE_PROVIDER", meta.source_provider || meta.source);
  pushUserDefinedText(userDefinedText, "SOURCE_STORE", meta.source_store);
  pushUserDefinedText(userDefinedText, "ADVISORY_RATING", meta.advisory_rating);
  if (meta.explicit != null) pushUserDefinedText(userDefinedText, "EXPLICIT", Boolean(meta.explicit));
  pushUserDefinedText(userDefinedText, "DURATION_MS", meta.duration_ms);
  pushUserDefinedText(userDefinedText, "APPLE_TRACK_ID", meta.apple_track_id);
  pushUserDefinedText(userDefinedText, "APPLE_COLLECTION_ID", meta.apple_collection_id);
  pushUserDefinedText(userDefinedText, "APPLE_ARTIST_ID", meta.apple_artist_id);
  pushUserDefinedText(userDefinedText, "APPLE_COLLECTION_TYPE", meta.apple_collection_type);
  pushUserDefinedText(userDefinedText, "APPLE_COUNTRY", meta.apple_country);
  pushUserDefinedText(userDefinedText, "APPLE_CURRENCY", meta.apple_currency);
  pushUserDefinedText(userDefinedText, "APPLE_KIND", meta.apple_kind);
  pushUserDefinedText(userDefinedText, "DEEZER_TRACK_ID", meta.deezer_track_id);
  pushUserDefinedText(userDefinedText, "DEEZER_ALBUM_ID", meta.deezer_album_id);
  pushUserDefinedText(userDefinedText, "DEEZER_ARTIST_ID", meta.deezer_artist_id);
  pushUserDefinedText(userDefinedText, "TIDAL_TRACK_ID", meta.tidal_track_id);
  pushUserDefinedText(userDefinedText, "TIDAL_ALBUM_ID", meta.tidal_album_id);
  pushUserDefinedText(userDefinedText, "TIDAL_ARTIST_ID", meta.tidal_artist_id);
  pushUserDefinedText(userDefinedText, "SOUNDCLOUD_TRACK_ID", meta.soundcloud_track_id);
  pushUserDefinedText(userDefinedText, "SOUNDCLOUD_URN", meta.soundcloud_urn);
  pushUserDefinedText(userDefinedText, "ALBUM_ID", meta.album_id);
  pushUserDefinedText(userDefinedText, "PLAYLIST_INDEX", meta.playlist_index);
  pushUserDefinedText(userDefinedText, "PLAYLIST_TOTAL", meta.playlist_total);
  if (userDefinedText.length) tags.userDefinedText = userDefinedText;

  const userDefinedUrl = [];
  pushUserDefinedUrl(userDefinedUrl, "SOURCE_URL", sourceUrl);
  pushUserDefinedUrl(userDefinedUrl, "APPLE_TRACK_URL", meta.apple_track_url);
  pushUserDefinedUrl(userDefinedUrl, "APPLE_COLLECTION_URL", meta.apple_collection_url);
  pushUserDefinedUrl(userDefinedUrl, "APPLE_ARTIST_URL", meta.apple_artist_url);
  pushUserDefinedUrl(userDefinedUrl, "PREVIEW_URL", meta.preview_url);
  pushUserDefinedUrl(userDefinedUrl, "COVER_URL", meta.coverUrl);
  pushUserDefinedUrl(userDefinedUrl, "SPOTIFY_URL", meta.spotifyUrl || meta.spUrl);
  pushUserDefinedUrl(userDefinedUrl, "DEEZER_URL", meta.deezerUrl || meta.dzUrl);
  pushUserDefinedUrl(userDefinedUrl, "DEEZER_TRACK_URL", meta.deezer_track_url);
  pushUserDefinedUrl(userDefinedUrl, "DEEZER_ALBUM_URL", meta.deezer_album_url);
  pushUserDefinedUrl(userDefinedUrl, "DEEZER_ARTIST_URL", meta.deezer_artist_url);
  pushUserDefinedUrl(userDefinedUrl, "TIDAL_URL", meta.tidalUrl);
  pushUserDefinedUrl(userDefinedUrl, "SOUNDCLOUD_URL", meta.soundcloudUrl || meta.scUrl);
  if (userDefinedUrl.length) tags.userDefinedUrl = userDefinedUrl;

  return tags;
}

export function writeRichId3v2Tag(filePath, meta = {}) {
  try {
    if (String(path.extname(filePath) || "").toLowerCase() !== ".mp3") return false;

    const tags = buildRichId3v2Tags(meta);
    if (!Object.keys(tags).length) return false;

    const result = NodeID3.update(tags, filePath);
    if (result instanceof Error) return false;
    return Boolean(result);
  } catch {
    return false;
  }
}

// Handles rewrite id3v11 tag in core application logic.
export function rewriteId3v11Tag(filePath, meta = {}) {
  try {
    if (String(path.extname(filePath) || "").toLowerCase() !== ".mp3") return false;

    const title = meta.track || meta.title || "";
    const artist = meta.artist || meta.album_artist || meta.uploader || "";
    const album = meta.album || meta.playlist_title || "";
    const year = String(meta.release_year || meta.upload_year || "").slice(0, 4);
    const comment = meta.comment || "";

    const encoding = getId3v1Encoding([title, artist, album, comment]);
    const trackNo = parseTrackNumber(meta);
    const genre = 255;

    const tag = Buffer.alloc(128, 0x00);
    tag.write("TAG", 0, 3, "ascii");
    encodeId3v1Field(title, 30, encoding).copy(tag, 3);
    encodeId3v1Field(artist, 30, encoding).copy(tag, 33);
    encodeId3v1Field(album, 30, encoding).copy(tag, 63);
    encodeId3v1Field(year, 4, encoding).copy(tag, 93);
    encodeId3v1Field(comment, 28, encoding).copy(tag, 97);
    tag[125] = 0x00;
    tag[126] = trackNo;
    tag[127] = genre;

    const openFlags = fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(filePath, openFlags);
    try {
      const stat = fs.fstatSync(fd);
      let offset = stat.size;
      if (stat.size >= 128) {
        const tail = Buffer.alloc(128);
        fs.readSync(fd, tail, 0, 128, stat.size - 128);
        if (tail.slice(0, 3).toString("ascii") === "TAG") {
          offset = stat.size - 128;
        }
      }
      fs.writeSync(fd, tag, 0, tag.length, offset);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}
