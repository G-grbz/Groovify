import { searchSpotifyBestTrackStrict, trackToId3Meta } from "./spotify.js";
import { resolveMarket } from "./market.js";

function stripTailAfterDelims(s=""){
   return String(s).split(/\s*[|｜／/•·]\s*/)[0].trim();
 }

 function normalizeTitleNoise(s=""){
   return String(s)
     .replace(/[–—]/g, "-")
     .replace(/\s*[\[\(（【〔﹝〖].*?[\]\)）】〕﹞〗]\s*/g, " ")
     .replace(/\s+(feat\.?|ft\.?|with)\s+.+$/i, " ")
     .replace(/\b(official\s*video|audio|mv|hd|4k|lyrics|lyric|visualizer|remastered|remaster)\b/ig, " ")
     .replace(/\s*[|｜／/•·]\s*.*$/, " ")
     .replace(/\s+/g," ")
     .trim();
 }

function compactSpacedLetters(s = "") {
  const tokens = String(s).trim().split(/\s+/);
  if (tokens.length >= 2 && tokens.every(t => t.length === 1)) {
    return tokens.join("").toUpperCase();
  }
  return s;
}

function splitArtistTitle(title, uploader) {
  const t0 = stripTailAfterDelims(String(title||""));
  const t  = normalizeTitleNoise(t0);
  let u = compactSpacedLetters(String(uploader||"").replace(/\s+/g," ").trim());
  const m = t.match(/^\s*([^|-]+?)\s*-\s*(.+)$/);
  if (m) {
    const artist = m[1].trim();
    const titleOnly = stripTailAfterDelims(m[2].trim());
    return { artist, title: titleOnly };
  }
  if (u && t) return { artist: u, title: stripTailAfterDelims(t) };
  return { artist: "", title: stripTailAfterDelims(t) };
}

function sanitizeYouTubeArtist(a=""){
  return /^(youtube|youtube\s+mix)$/i.test(a.trim()) ? "" : a;
}

function buildId3FromYouTube(ytLikeMeta){
  const spl = splitArtistTitle(ytLikeMeta?.title, ytLikeMeta?.uploader);
  const artist = sanitizeYouTubeArtist(spl.artist);
  const title  = stripTailAfterDelims(spl.title);
  return {
    track: title || "",
    title: title || "",
    artist: artist || "",
    uploader: artist || "",
    album: "",
    release_year: "",
    release_date: "",
    track_number: null,
    disc_number: null,
    track_total: null,
    disc_total: null,
    isrc: "",
    coverUrl: ytLikeMeta?.thumbnail || null,
    spotifyUrl: "",
    webpage_url: ytLikeMeta?.webpage_url || ""
  };
}

export async function resolveId3FromSpotifyFallback(ytLikeMeta) {
  try {
    const { artist, title } = splitArtistTitle(ytLikeMeta?.title, ytLikeMeta?.uploader);
    if (!title) return null;

    const durationSec = Number.isFinite(ytLikeMeta?.duration) ? Number(ytLikeMeta.duration) : null;
    const found = await searchSpotifyBestTrackStrict(artist, title, resolveMarket(), { targetDurationSec: durationSec, titleRaw: ytLikeMeta?.title, minScore: 7 });
    if (!found) return null;

    const meta = trackToId3Meta(found);
    return meta;
  } catch {
    return null;
  }
}

export async function resolveId3StrictForYouTube(ytLikeMeta, { market="TR", isPlaylist=false } = {}) {
  try{
    const { artist, title } = splitArtistTitle(ytLikeMeta?.title, ytLikeMeta?.uploader);
    if (!title) return null;
    if (!isPlaylist){
      return await resolveId3FromSpotifyFallback(ytLikeMeta);
    }
    const durationSec = Number.isFinite(ytLikeMeta?.duration) ? Number(ytLikeMeta.duration) : null;
    const found = await searchSpotifyBestTrackStrict(artist, title, resolveMarket(market), {
      targetDurationSec: durationSec,
      titleRaw: ytLikeMeta?.title,
      minScore: 7
    });
    if (found){
      return trackToId3Meta(found);
    }
    return buildId3FromYouTube(ytLikeMeta);
  } catch {
    return buildId3FromYouTube(ytLikeMeta);
  }
}
