import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { requestYtMusicJson } from '../modules/ytMusicRequest.js';

let home, discover, root;
const originalEnv = { ...process.env };
const exitListeners = new Map(['exit', 'beforeExit'].map((event) => [event, process.listeners(event)]));

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-ytm-loading-'));
  process.env.DATA_DIR = root;
  process.env.JOBS_STATE_DIR = path.join(root, 'cache');
  process.env.YTDLP_COOKIES_FROM_BROWSER = '';
  process.env.YTM_HOME_YTDLP_FALLBACK = '0';
  process.env.YTM_HOME_CONTINUATION_PAGES = '12';
  process.env.YTM_HOME_FETCH_SHELVES = '10';
  process.env.YTM_HOME_TIMEOUT_MS = '2000';
  process.env.YTM_HOME_INNERTUBE_TIMEOUT_MS = '2000';
  process.env.YTM_HOME_TOTAL_TIMEOUT_MS = '5000';
  process.env.YTM_AUTH_USER = '0';
  process.env.YTM_API_MIN_INTERVAL_MS = '0';
  process.env.YTM_PARTIAL_RETRY_DELAY_MS = '0';
  // Importing yt also starts the unrelated job-store housekeeping intervals.
  const setIntervalOriginal = globalThis.setInterval;
  const intervals = [];
  globalThis.setInterval = (...args) => {
    const timer = setIntervalOriginal(...args);
    intervals.push(timer);
    return timer;
  };
  try {
    ({ getYouTubeMusicHomeShelves: home, discoverYouTubeContent: discover } = await import('../modules/yt.js'));
  } finally {
    globalThis.setInterval = setIntervalOriginal;
    intervals.forEach(clearInterval);
  }
});

after(() => {
  for (const [event, previous] of exitListeners) {
    for (const listener of process.listeners(event)) {
      if (!previous.includes(listener)) {
        if (event === 'exit') listener(0);
        process.removeListener(event, listener);
      }
    }
  }
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(root, { recursive: true, force: true });
});

function session(name) {
  const file = path.join(root, 'cookies.txt');
  fs.writeFileSync(file, '# Netscape HTTP Cookie File\n' + ['SAPISID', 'LOGIN_INFO']
    .map((key) => `.youtube.com\tTRUE\t/\tTRUE\t0\t${key}\tfixture-${name}\n`).join(''));
  process.env.YTDLP_COOKIES = file;
}

const track = (index) => ({ musicTwoRowItemRenderer: {
  title: { runs: [{ text: `Track ${index}` }] },
  subtitle: { runs: [{ text: 'Artist' }] },
  navigationEndpoint: { watchEndpoint: { videoId: `video${String(index).padStart(6, '0')}` } }
} });
const shelf = (index) => ({ musicCarouselShelfRenderer: {
  header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: `Shelf ${index}` }] } } },
  contents: [track(index)]
} });
function page(index, next = '', { first = false, inline = false } = {}) {
  const section = { contents: [shelf(index)] };
  if (next && inline) section.contents.push({ continuationItemRenderer: {
    continuationEndpoint: { continuationCommand: { token: next } }
  } });
  else if (next) section.continuations = [{ nextContinuationData: { continuation: next } }];
  return {
    responseContext: { serviceTrackingParams: [{ params: [{ key: 'logged_in', value: '1' }] }] },
    ...(first ? { contents: { singleColumnBrowseResultsRenderer: {
      tabs: [{ tabRenderer: { content: { sectionListRenderer: section } } }]
    } } } : inline ? { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: section.contents } }] }
      : { continuationContents: { sectionListContinuation: section } })
  };
}
function mockMusic(t, browse) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://music.youtube.com');
    if (url.pathname === '/') return Response.json({
      INNERTUBE_API_KEY: 'fixture-api-key', INNERTUBE_CLIENT_VERSION: '1.20260101.01.00', LOGGED_IN: true, SESSION_INDEX: '0'
    });
    const body = JSON.parse(options.body || '{}');
    const token = url.searchParams.get('continuation') || body.continuation || 'home';
    requests.push({ path: url.pathname, token, body, headers: options.headers });
    return browse({ url, body, token, signal: options.signal });
  });
  return requests;
}
const homeOptions = { shelves: 10, limit: 4, lang: 'tr', region: 'TR' };

test('partial cached Home resumes its failed continuation and complete Home is cached', async (t) => {
  session('resume');
  let recovered = false;
  const requests = mockMusic(t, ({ token }) => {
    if (token === 'home') return Response.json(page(1, 'private-next', { first: true }));
    if (!recovered) return Response.json({ error: { message: 'temporary outage' } }, { status: 503 });
    return Response.json(token === 'private-next' ? page(2, 'private-last') : page(3));
  });
  const partial = await home(homeOptions);
  assert.equal(partial.partial, true);
  assert.equal(partial.hasMore, true);
  assert.equal(partial.shelves.length, 1);
  assert.equal(partial.continuationPages, 0, 'failed pages are not counted as loaded');
  assert.equal(requests.length, 3, 'the failing page is retried once');

  recovered = true;
  const progress = [];
  const complete = await home({ ...homeOptions, onProgress: (value) => progress.push(value) });
  assert.equal(progress[0].cached, true);
  assert.deepEqual(progress.map((value) => value.shelves.length), [1, 1, 2, 3]);
  assert.equal(complete.partial, false);
  assert.equal(complete.shelves.length, 3);
  assert.equal(complete.continuationPages, 2);
  assert.equal(requests.filter((request) => request.token === 'home').length, 1);
  assert.doesNotMatch(JSON.stringify([partial, complete, progress]), /private-next|private-last|fixture-resume|sessionKey/);

  const cached = await home(homeOptions);
  assert.equal(cached.cached, true);
  assert.equal(cached.shelves.length, 3);
  assert.equal(requests.length, 5);
});

test('manual refreshes share one live Home request and both receive progress', async (t) => {
  session('concurrent');
  const firstPage = Promise.withResolvers();
  const release = Promise.withResolvers();
  const requests = mockMusic(t, async ({ token }) => {
    if (token === 'home') return Response.json(page(1, 'next', { first: true }));
    firstPage.resolve();
    await release.promise;
    return Response.json(page(2));
  });
  const firstProgress = [], secondProgress = [];
  const first = home({ ...homeOptions, onProgress: (value) => firstProgress.push(value.shelves.length) });
  await firstPage.promise;
  const second = home({ ...homeOptions, forceRefresh: true, onProgress: (value) => secondProgress.push(value.shelves.length) });
  await delay(0);
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(requests.length, 2);
  assert.deepEqual(firstProgress, [1, 2]);
  assert.deepEqual(secondProgress, [1, 2]);
  assert.ok(results.every((result) => result.shelves.length === 2));
});

test('a successful multi-page Home is not limited to one page timeout', async (t) => {
  session('page-budget');
  process.env.YTM_HOME_INNERTUBE_TIMEOUT_MS = '200';
  t.after(() => { process.env.YTM_HOME_INNERTUBE_TIMEOUT_MS = '2000'; });
  const requests = mockMusic(t, async ({ token, signal }) => {
    await delay(110, null, { signal });
    const index = token === 'home' ? 1 : Number(token);
    return Response.json(page(index, index < 4 ? String(index + 1) : '', { first: index === 1, inline: true }));
  });
  const result = await home(homeOptions);
  assert.equal(result.partial, false);
  assert.equal(result.shelves.length, 4);
  assert.equal(result.continuationPages, 3);
  assert.equal(requests.length, 4);
});

test('changing cookies in the same file never reuses another session cache', async (t) => {
  session('account-one');
  let index = 1;
  const requests = mockMusic(t, () => Response.json(page(index, '', { first: true })));
  const first = await home(homeOptions);
  session('account-two');
  index = 2;
  const second = await home(homeOptions);
  assert.equal(first.shelves[0].title, 'Shelf 1');
  assert.equal(second.shelves[0].title, 'Shelf 2');
  assert.equal(requests.length, 2);
});

test('expired continuation restarts Home instead of reusing a rejected checkpoint', async (t) => {
  session('expired');
  let recovered = false;
  const requests = mockMusic(t, ({ token }) => {
    if (token === 'home') return Response.json(page(1, recovered ? 'fresh-next' : 'expired', { first: true }));
    return recovered ? Response.json(page(2)) : Response.json({ error: { message: 'expired' } }, { status: 400 });
  });
  assert.equal((await home(homeOptions)).partial, true);
  recovered = true;
  assert.equal((await home(homeOptions)).shelves.length, 2);
  assert.deepEqual(requests.map((request) => request.token), ['home', 'expired', 'home', 'fresh-next']);
});

test('malformed successful response does not make an incomplete Home cache permanent', async (t) => {
  session('malformed');
  let recovered = false;
  const requests = mockMusic(t, ({ token }) => token === 'home'
    ? Response.json(page(1, 'retry-me', { first: true }))
    : Response.json(recovered ? page(2) : {}));
  assert.equal((await home(homeOptions)).partial, true);
  recovered = true;
  const result = await home(homeOptions);
  assert.equal(result.partial, false);
  assert.equal(result.shelves.length, 2);
  assert.deepEqual(requests.map((request) => request.token), ['home', 'retry-me', 'retry-me']);
});

test('per-batch page limit returns a resumable checkpoint, not a complete cache entry', async (t) => {
  session('batch');
  process.env.YTM_HOME_CONTINUATION_PAGES = '1';
  t.after(() => { process.env.YTM_HOME_CONTINUATION_PAGES = '12'; });
  const requests = mockMusic(t, ({ token }) => {
    const index = token === 'home' ? 1 : Number(token);
    return Response.json(page(index, index < 4 ? String(index + 1) : '', { first: index === 1 }));
  });
  assert.equal((await home(homeOptions)).shelves.length, 2);
  assert.equal((await home(homeOptions)).shelves.length, 3);
  const result = await home(homeOptions);
  assert.equal(result.shelves.length, 4);
  assert.equal(result.partial, false);
  assert.equal(requests.length, 4);
});

test('cold mood discovery uses bounded parallel anonymous searches, coalesces and caches', async (t) => {
  const requests = mockMusic(t, async ({ url, body }) => {
    assert.equal(url.pathname, '/youtubei/v1/search');
    assert.equal(body.context.client.hl, 'tr');
    assert.equal(body.context.client.gl, 'TR');
    await delay(10);
    return Response.json({ contents: Array.from({ length: 30 }, (_, index) => track(index)) });
  });
  const options = { preset: 'energizing', lang: 'tr', region: 'TR', limit: 18 };
  const [first, second] = await Promise.all([discover(options), discover(options)]);
  assert.equal(first.items.length, 18);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first, second);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.Cookie, undefined);
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.deepEqual(await discover(options), first);
  assert.equal(requests.length, 2);
});

test('empty discovery after an outage is not cached', async (t) => {
  let recovered = false;
  const requests = mockMusic(t, () => recovered
    ? Response.json({ contents: Array.from({ length: 20 }, (_, index) => track(index)) })
    : Response.json({ error: { message: 'temporary outage' } }, { status: 503 }));
  const options = { preset: 'sleep', lang: 'en', region: 'US', limit: 18 };
  assert.equal((await discover(options)).items.length, 0);
  const failedRequests = requests.length;
  recovered = true;
  assert.equal((await discover(options)).items.length, 18);
  assert.equal(requests.length, failedRequests + 2);
});

test('sparse mood query results are filled within the shared budget and retain pagination', async (t) => {
  let batch = 0;
  const requests = mockMusic(t, () => {
    const offset = batch++ * 10;
    return Response.json({ contents: Array.from({ length: 10 }, (_, index) => track(offset + index)) });
  });
  const result = await discover({ preset: 'workout', lang: 'tr', region: 'TR', limit: 18 });
  assert.equal(result.items.length, 18);
  assert.equal(result.hasMore, true);
  assert.equal(requests.length, 2);
});

test('short discovery pages remain retryable and recovered queries append without reordering prior tracks', async (t) => {
  let recovered = false;
  const queries = [];
  mockMusic(t, ({ body }) => {
    if (!queries.includes(body.query)) queries.push(body.query);
    if (body.query === queries[1]) {
      return Response.json({ contents: Array.from({ length: 10 }, (_, index) => track(index)) });
    }
    return recovered
      ? Response.json({ contents: Array.from({ length: 20 }, (_, index) => track(100 + index)) })
      : Response.json({ error: { message: 'temporary outage' } }, { status: 503 });
  });
  const options = { preset: 'focus', lang: 'de', region: 'DE', limit: 18 };
  const partial = await discover(options);
  assert.equal(partial.items.length, 10);
  recovered = true;
  const first = await discover(options);
  assert.equal(first.items.length, 18);
  assert.deepEqual(first.items.slice(0, 10), partial.items);
  const second = await discover({ ...options, page: 2 });
  assert.equal(second.items.length, 12);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 30);
});

test('request timeout covers body reading and retries with a fresh signal', async () => {
  const signals = [];
  const result = await requestYtMusicJson(async (signal) => {
    signals.push(signal);
    if (signals.length > 1) return Response.json({ recovered: true });
    return { ok: true, text: () => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) };
  }, { timeoutMs: 20 });
  assert.equal(result.recovered, true);
  assert.equal(signals.length, 2);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
});

test('total request deadline bounds repeated timeouts and auth failures are not retried', async () => {
  let calls = 0;
  await assert.rejects(requestYtMusicJson(async (signal) => {
    calls += 1;
    await delay(1000, null, { signal });
  }, { timeoutMs: 500, deadline: Date.now() + 30 }), { code: 'YTM_TIMEOUT' });
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(requestYtMusicJson(async () => {
    calls += 1;
    return Response.json({ error: { message: 'not authorized' } }, { status: 403 });
  }, { timeoutMs: 1000 }), { status: 403 });
  assert.equal(calls, 1);
});

test('different browser shelf counts share the full fetched page and resume only missing pages', async (t) => {
  session('shared-sizes');
  process.env.YTM_HOME_FETCH_SHELVES = '1';
  t.after(() => { process.env.YTM_HOME_FETCH_SHELVES = '10'; });
  const requests = mockMusic(t, ({ token }) => {
    if (token === 'home') {
      const first = page(1, 'more', { first: true });
      first.contents.singleColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents =
        Array.from({ length: 5 }, (_, index) => ({ musicCarouselShelfRenderer: {
          ...shelf(index + 1).musicCarouselShelfRenderer,
          contents: Array.from({ length: 15 }, (_, item) => track(index * 20 + item))
        } }));
      return Response.json(first);
    }
    const last = page(6);
    last.continuationContents.sectionListContinuation.contents.push(shelf(7));
    return Response.json(last);
  });
  const small = await home({ ...homeOptions, shelves: 2, limit: 4 });
  assert.equal(small.shelves.length, 2);
  assert.equal(small.partial, false);
  const medium = await home({ ...homeOptions, shelves: 5, limit: 12 });
  assert.equal(medium.shelves.length, 5);
  assert.equal(medium.shelves[0].items.length, 12);
  assert.equal(medium.cached, true);
  assert.equal(requests.length, 1);
  const large = await home({ ...homeOptions, shelves: 7, limit: 12 });
  assert.equal(large.shelves.length, 7);
  assert.equal(large.partial, false);
  assert.deepEqual(requests.map((request) => request.token), ['home', 'more']);
});

test('repeated manual refresh from other browsers cannot repeatedly bypass fresh server cache', async (t) => {
  session('shared-refresh');
  const requests = mockMusic(t, () => Response.json(page(1, '', { first: true })));
  await home(homeOptions);
  for (let i = 0; i < 3; i += 1) assert.equal((await home({ ...homeOptions, forceRefresh: true })).cached, true);
  assert.equal(requests.length, 1);
});

test('different discovery page sizes share one pool fill', async (t) => {
  const requests = mockMusic(t, async () => {
    await delay(10);
    return Response.json({ contents: Array.from({ length: 30 }, (_, index) => track(index)) });
  });
  const [small, large] = await Promise.all([
    discover({ preset: 'party', lang: 'fr', region: 'FR', limit: 10 }),
    discover({ preset: 'party', lang: 'fr', region: 'FR', limit: 18 })
  ]);
  assert.equal(small.items.length, 10);
  assert.equal(large.items.length, 18);
  assert.equal(requests.length, 2);
});

test('anonymous Home is also cached and coalesced on the server', async (t) => {
  const cookieFile = process.env.YTDLP_COOKIES;
  process.env.YTDLP_COOKIES = '';
  t.after(() => { process.env.YTDLP_COOKIES = cookieFile; });
  const requests = mockMusic(t, async () => {
    await delay(10);
    const first = page(1, '', { first: true });
    first.contents.singleColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents.push(shelf(2));
    return Response.json(first);
  });
  const options = { ...homeOptions, shelves: 2 };
  const [first, second] = await Promise.all([home(options), home(options)]);
  assert.equal(first.shelves.length, 2);
  assert.equal(second.personalized, false);
  assert.equal((await home(options)).cached, true);
  assert.equal(requests.length, 1);
});

test('a restarted server reuses actual Home cache without sending new YouTube requests', async (t) => {
  session('persistent-home');
  const requests = mockMusic(t, () => Response.json(page(1, '', { first: true })));
  await home(homeOptions);
  await delay(1100); // The server batches durable snapshot writes for one second.
  const snapshot = fs.readFileSync(path.join(root, 'cache', 'youtube-music-cache.json'), 'utf8');
  assert.doesNotMatch(snapshot, /fixture-persistent-home|SAPISID|LOGIN_INFO|Authorization/);
  const restarted = await import(`../modules/yt.js?shared-cache-restart=${Date.now()}`);
  const result = await restarted.getYouTubeMusicHomeShelves(homeOptions);
  assert.equal(result.cached, true);
  assert.equal(result.shelves.length, 1);
  assert.equal(requests.length, 1);
});

test('one Home rate limit stops new discovery/Home requests from every browser and retains loaded shelves', async (t) => {
  session('shared-rate-limit');
  const requests = mockMusic(t, ({ token }) => token === 'home'
    ? Response.json(page(1, 'blocked', { first: true }))
    : Response.json({ error: { message: 'Too many requests' } }, { status: 429, headers: { 'retry-after': '120' } }));
  const first = await home(homeOptions);
  assert.equal(first.shelves.length, 1);
  assert.equal(first.partial, true);
  assert.ok(first.retryAfterMs > 100000);
  const second = await home({ ...homeOptions, shelves: 20, forceRefresh: true });
  assert.equal(second.cached, true);
  assert.equal(second.shelves.length, 1);
  assert.ok(second.retryAfterMs > 100000);
  const mood = await discover({ preset: 'romance', lang: 'es', region: 'ES' });
  assert.ok(mood.retryAfterMs > 100000);
  session('another-account-during-cooldown');
  assert.equal((await home(homeOptions)).shelves.length, 0);
  assert.equal(requests.length, 2, 'no immediate retry, fallback crawl or second-browser upstream request');
});
