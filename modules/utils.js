import fs from "fs";
import path from "path";

export const ERR = {
  INVALID_FORMAT: 'INVALID_FORMAT',
  URL_OR_FILE_REQUIRED: 'URL_OR_FILE_REQUIRED',
  UNSUPPORTED_URL_FORMAT: 'UNSUPPORTED_URL_FORMAT',
  PREVIEW_NEED_YT_URL: 'PREVIEW_NEED_YT_URL',
  PLAYLIST_REQUIRED: 'PLAYLIST_REQUIRED',
  PREVIEW_FAILED: 'PREVIEW_FAILED',
  PAGE_FETCH_FAILED: 'PAGE_FETCH_FAILED',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  YTDLP_NOT_FOUND: 'YTDLP_NOT_FOUND',
  INTERNAL: 'INTERNAL'
};

export function sendOk(res, payload = {}, status = 200) {
  return res.status(status).json({ ok: true, ...payload });
}

export function sendError(res, code, message, status = 400, extra = {}) {
  return res.status(status).json({ ok: false, error: { code, message, ...extra } });
}

export function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

export function findOnPATH(name) {
  const paths = (process.env.PATH || "").split(path.delimiter);
  for (const p of paths) {
    const candidate = path.join(p, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export const toNFC = (s) => (typeof s === "string" ? s.normalize("NFC") : s);

export function sanitizeFilename(name, replacement = "_") {
  const n = toNFC(name);
  const cleaned = n
    .replace(/[\/\\?%*:|"<>]/g, replacement)
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 200);
}

export const isDirectMediaUrl = (url) => /(\.(mp4|avi|mov|mkv|webm|mp3|wav|flac|aac|ogg|m4a))$/i.test(url);

export function makeT(req) {
  const fallback = (key, vars={}) => {
    let s = String(key);
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return s;
  };
  if (req && typeof req.t === 'function') return req.t;
  return fallback;
}
