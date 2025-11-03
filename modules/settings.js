import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const router = express.Router();
const ENV_PATH = path.resolve(process.cwd(), ".env");
const APP_SECRET = process.env.APP_SECRET || "dev-secret";
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ALLOWED_KEYS = [
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_MARKET",
  "SPOTIFY_FALLBACK_MARKETS",
  "YT_USE_MUSIC",
  "PREFER_SPOTIFY_TAGS",
  "TITLE_CLEAN_PIPE",
  "YTDLP_UA",
  "YTDLP_COOKIES",
  "YTDLP_COOKIES_FROM_BROWSER",
  "YTDLP_EXTRA",
  "YT_STRIP_COOKIES",
  "YT_DEFAULT_REGION",
  "YT_LANG",
  "YT_ACCEPT_LANGUAGE",
  "YT_FORCE_IPV4",
  "YT_403_WORKAROUNDS"
];

function sign(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const mac = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, mac] = token.split(".");
  const expected = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64url");
  const macBuf = Buffer.from(mac || "", "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (macBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(macBuf, expBuf)) return null;
  let obj = null;
  try { obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch {}
  if (!obj) return null;
  if (Date.now() > (obj.iat || 0) + 24 * 60 * 60 * 1000) return null;
  return obj;
}

function authMiddleware(req, res, next) {
  const h = req.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const ok = verify(token);
  if (!ok) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Yetkisiz" } });
  next();
}

function parseEnv() {
  const m = new Map();
  if (fs.existsSync(ENV_PATH)) {
    const txt = fs.readFileSync(ENV_PATH, "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m2 = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m2) {
        let val = m2[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        m.set(m2[1], val);
      }
    }
  }
  return m;
}

function writeEnv(updates, extraAllowed = []) {
  const envMap = parseEnv();
  for (const [k, v] of Object.entries(updates)) {
    if (!(ALLOWED_KEYS.includes(k) || extraAllowed.includes(k))) continue;
    if (v === "" || v === null || typeof v === "undefined") continue;
    envMap.set(k, String(v));
  }

  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : [];
  const seen = new Set();
  const out = existing.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) return line;
    const key = m[1];
    if (envMap.has(key)) {
      seen.add(key);
      const val = envMap.get(key);
      const needsQuote = /[\s#"'`]/.test(val);
      return `${key}=${needsQuote ? JSON.stringify(val) : val}`;
    }
    return line;
  });
  for (const [k, v] of envMap.entries()) {
    if (!seen.has(k)) {
      const needsQuote = /[\s#"'`]/.test(v);
      out.push(`${k}=${needsQuote ? JSON.stringify(v) : v}`);
    }
  }
  const clean = out.filter((line, idx, arr) =>
    idx === 0 || line.trim() !== "" || arr[idx - 1].trim() !== ""
  );
  fs.writeFileSync(ENV_PATH, clean.join("\n").trim() + "\n", "utf8");
}

router.post("/auth/login", express.json(), (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: { code: "NO_ADMIN_PASSWORD", message: "ADMIN_PASSWORD tanımlı değil" } });
  if (!password || password !== ADMIN_PASSWORD) return res.status(401).json({ error: { code: "BAD_PASSWORD", message: "Hatalı şifre" } });
  const token = sign({ iat: Date.now(), role: "admin" });
  res.json({ token });
});

router.get("/settings", authMiddleware, (req, res) => {
  const env = parseEnv();
  const data = {};
  for (const k of ALLOWED_KEYS) {
    let val = env.get(k) ?? "";
    if (k === "SPOTIFY_CLIENT_SECRET" && val) {
      val = "••••••••";
    }
    data[k] = val;
  }
  res.json({ settings: data });
});

router.post("/settings", authMiddleware, express.json(), (req, res) => {
  const incoming = (req.body && req.body.settings) || {};
  const env = parseEnv();
  const updates = {};
  for (const k of ALLOWED_KEYS) {
    if (!(k in incoming)) continue;
    const v = incoming[k];
    if (k === "SPOTIFY_CLIENT_SECRET") {
      if (!v || v === "••••••••") {
        updates[k] = env.get(k) || "";
      } else {
        updates[k] = String(v);
      }
    } else {
      if (typeof v !== "undefined" && v !== null) {
        updates[k] = String(v);
      }
    }
  }
  writeEnv(updates);
  for (const [k, v] of Object.entries(updates)) {
    process.env[k] = v;
  }
  res.json({ ok: true, appliedInMemory: true });
});

function verifyTokenRaw(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, mac] = token.split(".");
  const expected = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64url");
  const macBuf = Buffer.from(mac || "", "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (macBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(macBuf, expBuf)) return null;
  let obj = null;
  try { obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch {}
  if (!obj) return null;
  if (Date.now() > (obj.iat || 0) + 24*60*60*1000) return null;
  return obj;
}

function getTokenFromReq(req) {
  const h = req.get("authorization") || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  if (req.query?.token) return String(req.query.token);
  return null;
}

export function requireAuth(req, res, next) {
  const tok = getTokenFromReq(req);
  const ok = verifyTokenRaw(tok);
  if (!ok) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Yetkisiz" } });
  next();
}

router.post("/auth/change-password", authMiddleware, express.json(), (req, res) => {
  const { oldPassword, newPassword, newPassword2 } = req.body || {};
  const fail = (code, message) =>
    res.status(400).json({ error: { code, message } });

  if (!oldPassword || !newPassword || !newPassword2) {
    return fail("FIELDS_REQUIRED", "Tüm alanlar zorunludur.");
  }
  if (newPassword !== newPassword2) {
    return fail("PASSWORD_MISMATCH", "Yeni şifreler eşleşmiyor.");
  }
  if (String(newPassword).length < 6) {
    return fail("PASSWORD_TOO_SHORT", "Yeni şifre en az 6 karakter olmalıdır.");
  }

  const current = process.env.ADMIN_PASSWORD || ADMIN_PASSWORD || "";
  if (current && oldPassword !== current) {
    return res.status(401).json({ error: { code: "BAD_PASSWORD", message: "Eski şifre hatalı." } });
  }

  try {
    writeEnv({ ADMIN_PASSWORD: newPassword }, ["ADMIN_PASSWORD"]);
    process.env.ADMIN_PASSWORD = newPassword;
    ADMIN_PASSWORD = newPassword;
    return res.json({ ok: true, logout: true });
  } catch (e) {
    return res.status(500).json({ error: { code: "PASSWORD_SAVE_FAILED", message: e.message || "Kaydedilemedi." } });
  }
});

export default router;
