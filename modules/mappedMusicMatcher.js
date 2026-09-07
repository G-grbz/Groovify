const CATALOG_MUSIC_PROVIDERS = new Set([
  'spotify',
  'apple',
  'apple_music',
  'deezer',
  'tidal'
]);

export const MAPPED_MUSIC_YT_SEARCH_RESULTS = Math.max(
  3,
  Math.min(10, Number(process.env.MAPPED_MUSIC_YT_SEARCH_RESULTS || 5))
);
export const MAPPED_MUSIC_YT_MIN_MATCH_SCORE = Math.max(
  1,
  Number(process.env.MAPPED_MUSIC_YT_MIN_MATCH_SCORE || 4)
);
export const MAPPED_MUSIC_YT_STRICT_MATCH_SCORE = Math.max(
  MAPPED_MUSIC_YT_MIN_MATCH_SCORE,
  Number(process.env.MAPPED_MUSIC_YT_STRICT_MATCH_SCORE || 6)
);
export const MAPPED_MUSIC_YT_SEARCH_RETRIES = Math.max(
  0,
  Math.min(1, Number(process.env.MAPPED_MUSIC_YT_SEARCH_RETRIES ?? 1))
);
export const MAPPED_MUSIC_YT_SEARCH_RETRY_BACKOFF_MS = Math.max(
  0,
  Number(process.env.MAPPED_MUSIC_YT_SEARCH_RETRY_BACKOFF_MS || 600)
);
export const MAPPED_MUSIC_YT_RATE_LIMIT_BACKOFF_MS = Math.max(
  1000,
  Number(process.env.MAPPED_MUSIC_YT_RATE_LIMIT_BACKOFF_MS || 15000)
);
export const MAPPED_MUSIC_YT_SEARCH_STAGGER_MS = Math.max(
  0,
  Number(process.env.MAPPED_MUSIC_YT_SEARCH_STAGGER_MS || 220)
);
export const MAPPED_MUSIC_YT_DURATION_BASE_TOLERANCE_SEC = Math.max(
  10,
  Number(process.env.MAPPED_MUSIC_YT_DURATION_BASE_TOLERANCE_SEC || 35)
);
export const MAPPED_MUSIC_YT_DURATION_RATIO_TOLERANCE = Math.max(
  0.05,
  Math.min(0.50, Number(process.env.MAPPED_MUSIC_YT_DURATION_RATIO_TOLERANCE || 0.18))
);
export const MAPPED_MUSIC_YT_DURATION_MIN_RATIO = Math.max(
  0.1,
  Math.min(1, Number(process.env.MAPPED_MUSIC_YT_DURATION_MIN_RATIO || 0.70))
);
export const MAPPED_MUSIC_YT_DURATION_MAX_RATIO = Math.max(
  1,
  Number(process.env.MAPPED_MUSIC_YT_DURATION_MAX_RATIO || 1.35)
);
export const MAPPED_MUSIC_YT_TIGHT_DURATION_BASE_SEC = Math.max(
  3,
  Number(process.env.MAPPED_MUSIC_YT_TIGHT_DURATION_BASE_SEC || 10)
);
export const MAPPED_MUSIC_YT_TIGHT_DURATION_RATIO = Math.max(
  0.01,
  Math.min(0.20, Number(process.env.MAPPED_MUSIC_YT_TIGHT_DURATION_RATIO || 0.05))
);

function norm(value = '') {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


function compactNorm(value = '') {
  return norm(value).replace(/\s+/g, '');
}

export function scoreCatalogMusicCandidateText(
  artist = '',
  title = '',
  candidateTitle = '',
  candidateChannel = ''
) {
  const aNorm = norm(artist);
  const tNorm = norm(title);
  const et = norm(candidateTitle);
  const ch = norm(candidateChannel);
  const tCompact = compactNorm(title);
  const etCompact = compactNorm(candidateTitle);

  let score = 0;
  let titleMatched = false;

  if (tNorm) {
    if (et === tNorm) {
      score += 6;
      titleMatched = true;
    } else {
      const directContains = et.includes(tNorm) || tNorm.includes(et);
      const compactContains = tCompact.length >= 5 && (
        etCompact.includes(tCompact) || tCompact.includes(etCompact)
      );

      if (directContains || compactContains) {
        score += 4;
        titleMatched = true;

        // Prefer concise titles that stay close to the source metadata. This
        // makes harmless spacing variants such as "yerdeyimki" / "yerdeyim ki"
        // equivalent without rewarding noisy TV/series/compilation titles.
        const minLen = Math.min(tCompact.length, etCompact.length);
        const maxLen = Math.max(tCompact.length, etCompact.length);
        const closeness = maxLen > 0 ? minLen / maxLen : 0;
        if (closeness >= 0.75) score += 3;
        else if (closeness >= 0.55) score += 2;
        else if (closeness >= 0.40) score += 1;

        if (tCompact && etCompact.includes(tCompact)) {
          const expansion = etCompact.length / tCompact.length;
          if (expansion >= 2.5) score -= 2;
          else if (expansion >= 1.9) score -= 1;
        }
      }
    }
  }

  let artistMatched = false;
  if (aNorm) {
    if (ch === aNorm) {
      score += 4;
      artistMatched = true;
    } else if (ch.includes(aNorm)) {
      score += 3;
      artistMatched = true;
    } else if (et.includes(aNorm)) {
      score += 2;
      artistMatched = true;
    }
  }

  if (titleMatched && artistMatched) score += 2;
  if (/\btopic\b/.test(ch)) score += 1;

  return Math.max(0, score);
}

function uniqueQueries(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const query = String(value || '').replace(/\s+/g, ' ').trim();
    const key = norm(query);
    if (!query || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(query);
  }
  return out;
}

export function isCatalogMusicProvider(provider = '') {
  return CATALOG_MUSIC_PROVIDERS.has(String(provider || '').trim().toLowerCase());
}

export function buildCatalogMusicSearchQueries(artist = '', title = '') {
  return uniqueQueries([
    `${artist || ''} ${title || ''}`,
    title
  ]);
}

export function isMappedMusicDurationCompatible(sourceMs, candidateSeconds, {
  baseToleranceSec = MAPPED_MUSIC_YT_DURATION_BASE_TOLERANCE_SEC,
  ratioTolerance = MAPPED_MUSIC_YT_DURATION_RATIO_TOLERANCE,
  minRatio = MAPPED_MUSIC_YT_DURATION_MIN_RATIO,
  maxRatio = MAPPED_MUSIC_YT_DURATION_MAX_RATIO
} = {}) {
  const sourceSeconds = Number(sourceMs) / 1000;
  const candidate = Number(candidateSeconds);
  if (!(sourceSeconds > 0) || !(candidate > 0)) return true;

  const ratio = candidate / sourceSeconds;
  if (ratio < minRatio || ratio > maxRatio) return false;

  const tolerance = Math.max(
    Number(baseToleranceSec) || 0,
    sourceSeconds * (Number(ratioTolerance) || 0)
  );
  return Math.abs(candidate - sourceSeconds) <= tolerance;
}

export function isMappedMusicDurationTight(sourceMs, candidateSeconds) {
  const sourceSeconds = Number(sourceMs) / 1000;
  const candidate = Number(candidateSeconds);
  if (!(sourceSeconds > 0) || !(candidate > 0)) return false;

  const tolerance = Math.max(
    MAPPED_MUSIC_YT_TIGHT_DURATION_BASE_SEC,
    sourceSeconds * MAPPED_MUSIC_YT_TIGHT_DURATION_RATIO
  );
  return Math.abs(candidate - sourceSeconds) <= tolerance;
}

export function isCatalogTextDurationMatch(score, sourceMs, candidateSeconds) {
  const value = Number(score) || 0;
  if (value >= MAPPED_MUSIC_YT_STRICT_MATCH_SCORE) return true;
  if (value < MAPPED_MUSIC_YT_MIN_MATCH_SCORE) return false;
  return isMappedMusicDurationTight(sourceMs, candidateSeconds);
}
