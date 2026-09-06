import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// One server-owned snapshot, never a browser-local cache. Personal feed keys
// contain only session hashes; raw cookies/bootstrap credentials are not stored.
export function createYtMusicSharedCache({ file, now = Date.now, flushDelayMs = 1000, maxBytes = 8 * 1024 * 1024 } = {}) {
  const maps = new Map();
  let saved = {}, timer = null, dirty = false;
  if (file) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const info = fs.fstatSync(fd);
      if (info.isFile() && info.size <= maxBytes) {
        const snapshot = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (snapshot.version === 1 && snapshot.namespaces && typeof snapshot.namespaces === 'object') saved = snapshot.namespaces;
      }
    } catch { /* Missing/corrupt caches are disposable, not startup failures. */ }
    finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
  }
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!dirty || !file) return;
    let temporary = '';
    try {
      const namespaces = Object.create(null);
      let remaining = maxBytes - 64;
      // Retain cooldowns and personal checkpoints before disposable query data.
      const priority = (name) => name === 'request-state' ? 0 : name === 'home' ? 1 : 2;
      for (const [name, cache] of [...maps].sort(([a], [b]) => priority(a) - priority(b))) {
        const overhead = Buffer.byteLength(JSON.stringify(name)) + 4;
        if (remaining < overhead) continue;
        remaining -= overhead;
        const entries = [];
        for (const entry of [...cache].slice(-128).reverse()) {
          if (Number(entry[1]?.expiresAt) <= now()) continue;
          const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
          if (bytes > remaining) continue;
          entries.unshift(entry);
          remaining -= bytes;
        }
        namespaces[name] = entries;
      }
      const snapshot = JSON.stringify({ version: 1, namespaces });
      if (Buffer.byteLength(snapshot) > maxBytes) return;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      temporary = `${file}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, snapshot, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
      temporary = '';
      dirty = false;
    } catch { /* A read-only data volume must still allow in-memory caching. */ }
    finally { if (temporary) { try { fs.unlinkSync(temporary); } catch {} } }
  };
  const changed = () => {
    dirty = true;
    if (!file || timer) return;
    timer = setTimeout(flush, flushDelayMs);
    timer.unref?.();
  };
  class SharedMap extends Map {
    set(key, value) { super.set(key, value); changed(); return this; }
    delete(key) { const removed = super.delete(key); if (removed) changed(); return removed; }
    clear() { if (this.size) { super.clear(); changed(); } }
  }
  return {
    map(name) {
      if (maps.has(name)) return maps.get(name);
      const cache = new SharedMap();
      const entries = Object.hasOwn(saved, name) && Array.isArray(saved[name]) ? saved[name] : [];
      for (const entry of entries.slice(-128)) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && Number(entry[1]?.expiresAt) > now()) {
          Map.prototype.set.call(cache, entry[0], entry[1]);
        }
      }
      maps.set(name, cache);
      return cache;
    },
    flush,
    close() { flush(); clearTimeout(timer); timer = null; }
  };
}
