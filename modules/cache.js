const PREVIEW_CACHE_TTL_MS = Number(process.env.PREVIEW_CACHE_TTL_MS || 30 * 60 * 1000);
const PREVIEW_MAX_ENTRIES  = Number(process.env.PREVIEW_MAX_ENTRIES  || 1000);
const previewCache = new Map();

export function getCache(url) {
  const c = previewCache.get(url);
  if (!c) return null;
  if (Date.now() - c.ts > PREVIEW_CACHE_TTL_MS) {
    previewCache.delete(url);
    return null;
  }
  return c;
}

export function setCache(url, payload) {
  previewCache.set(url, { ...payload, ts: Date.now() });
  if (previewCache.size > 100) {
    const arr = [...previewCache.entries()].sort((a,b)=>a[1].ts - b[1].ts).slice(0,20);
    for (const [k] of arr) previewCache.delete(k);
  }
}

export function mergeCacheEntries(url, newItems = []) {
  const c = getCache(url);
  if (!c) return;
  const byIndex = new Map(c.entries.map(e => [e.index, e]));
  for (const it of newItems) {
    if (it && Number.isFinite(it.index) && !byIndex.has(it.index)) byIndex.set(it.index, it);
  }
  const PREVIEW_MAX_ENTRIES  = Number(process.env.PREVIEW_MAX_ENTRIES  || 1000);
  const merged = [...byIndex.values()].sort((a,b)=>a.index-b.index).slice(0, PREVIEW_MAX_ENTRIES);
  setCache(url, { ...c, entries: merged, count: Math.max(c.count || 0, merged.length) });
}

export { PREVIEW_CACHE_TTL_MS, PREVIEW_MAX_ENTRIES };
