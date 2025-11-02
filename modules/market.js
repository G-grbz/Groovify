export function resolveMarket(preferred) {
  const fromEnv = process.env.SPOTIFY_MARKET && process.env.SPOTIFY_MARKET.trim();
  return (preferred && String(preferred).trim()) || fromEnv || undefined;
}

export function getFallbackMarkets() {
  const raw = process.env.SPOTIFY_FALLBACK_MARKETS || "";
  const list = raw.split(",").map(s => s.trim()).filter(Boolean);
  return list.length ? list : ["US", "GB", "DE", "FR"];
}

export async function withMarketFallback(callFn, preferred) {
  const tried = new Set();
  const seq = [];
  const m = resolveMarket(preferred);
  if (m) seq.push(m);
  seq.push(undefined);
  for (const f of getFallbackMarkets()) if (!seq.includes(f)) seq.push(f);
  for (const market of seq) {
    if (tried.has(market)) continue;
    tried.add(market);
    const res = await callFn(market);
    if (res) return res;
  }
  return null;
}
