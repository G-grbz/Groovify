import os from "os";

const bool = (v, def=false) => {
  if (v == null) return def;
  const s = String(v).toLowerCase();
  return !["0","false","no","off"].includes(s);
};

const DEFAULT_REGION = (process.env.YT_DEFAULT_REGION || "").trim();
const DEFAULT_LANG   = (process.env.YT_LANG || "en-US").trim();
const DEFAULT_AL     = (process.env.YT_ACCEPT_LANGUAGE || `${DEFAULT_LANG},en;q=0.8`).trim();
const DEFAULT_UA     = process.env.YTDLP_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

export const FLAGS = {
  USE_MUSIC: bool(process.env.YT_USE_MUSIC, false),
  FORCE_IPV4: bool(process.env.YT_FORCE_IPV4, true),
  APPLY_403_WORKAROUNDS: bool(process.env.YT_403_WORKAROUNDS, true),
  STRIP_COOKIES: bool(process.env.YT_STRIP_COOKIES, false),
};

export function getYouTubeHeaders(lang = DEFAULT_LANG, acceptLanguage = DEFAULT_AL) {
  return {
    "Referer": "https://www.youtube.com/",
    "Origin": "https://www.youtube.com",
    "Accept-Language": acceptLanguage || DEFAULT_AL,
  };
}

export function getUserAgent() {
  return DEFAULT_UA;
}

export function addGeoArgs(args, { region = DEFAULT_REGION, forceIPv4 = FLAGS.FORCE_IPV4 } = {}) {
  const out = [...args];
  if (forceIPv4 && !out.includes("--force-ipv4")) out.push("--force-ipv4");
  if (region) out.push("--geo-bypass-country", region.toUpperCase());
  return out;
}

export function getExtraArgs() {
  const raw = process.env.YTDLP_ARGS_EXTRA || process.env.YTDLP_EXTRA;
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

export function getLocaleConfig() {
  return {
    region: DEFAULT_REGION,
    lang: DEFAULT_LANG,
    acceptLanguage: DEFAULT_AL,
    userAgent: DEFAULT_UA,
    flags: { ...FLAGS },
    hostnameForWatch: (useMusic = FLAGS.USE_MUSIC) => useMusic ? "music.youtube.com" : "www.youtube.com",
  };
}
