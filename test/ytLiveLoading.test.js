import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the actual UI methods with a small DOM/timer fixture, without initializing
// playback, authentication or the page's DOMContentLoaded callback.
const source = fs.readFileSync(new URL('../public/ui/YTLiveMusicApp.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');

function fixture(fetchImpl = () => { throw new Error('Unexpected fetch'); }) {
  const timers = new Map();
  const timerDelays = new Map();
  let timerId = 0;
  const status = { textContent: '', title: '' };
  const section = { hidden: false };
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, TextDecoder, Uint8Array,
    accessManager: { async ensureAccess() {} },
    settingsManager: { async initialize() {} },
    accessInboxManager: { initialize() {} },
    fetch: fetchImpl,
    console: { warn() {} },
    window: {
      setTimeout: (callback, delayMs) => { timers.set(++timerId, callback); timerDelays.set(timerId, delayMs); return timerId; },
      clearTimeout: (id) => { timers.delete(id); timerDelays.delete(id); }
    },
    document: {
      addEventListener() {},
      getElementById: (id) => ({ musicHomeSection: section, musicHomeStatus: status })[id]
    }
  });
  vm.runInContext(`${source}\nglobalThis.App = YTLiveMusicApp;`, context);
  const app = Object.create(context.App.prototype);
  const notifications = [];
  Object.assign(app, {
    musicHomeShelves: [], musicHomeController: null, musicHomeRetryTimer: null,
    musicHomeShelfCount: 30, discoverResultCache: new Map(), resultLoadLimit: 18,
    searchSerial: 0, searchController: null, results: [], activePreset: 'energizing',
    discoverPresets: ['energizing', 'workout', 'relax', 'sleep'],
    getCurrentLang: () => 'tr', getCurrentRegion: () => 'TR',
    normalizeItem: (item) => item,
    tt: (_key, fallback, variables = {}) => fallback.replace(/\{(\w+)\}/g, (_, key) => variables[key] ?? ''),
    renderMusicHomeShelves() {}, renderResults() {}, renderSkeletonResults() {},
    updateLoadMoreState() {}, playRandomPlayerContent() {},
    setResultsStatus(value) { this.resultsStatus = value; },
    notify: (...args) => notifications.push(args),
    hasActivePlayback: () => true,
    setActivePreset(preset) { this.activePreset = preset; },
    getPresetDisplayLabel: (preset) => preset,
    mergeUniqueResults: (items) => items,
    resetInfiniteResults(preset) { this.presetPaging = { mode: 'discover', page: 1, failedLoads: 0, preset }; }
  });
  return { app, status, section, timers, timerDelays, notifications };
}
const shelves = (count) => Array.from({ length: count }, (_, index) => ({
  title: `Shelf ${index}`, items: [{ title: `Track ${index}`, webpage_url: `https://music.youtube.com/watch?v=video${String(index).padStart(6, '0')}` }]
}));
const personal = (count, partial = false) => ({
  source: 'innertube', personalized: true, shelves: shelves(count),
  partial, hasMore: partial, authUser: '0', continuationPages: count - 1,
  warning: partial ? 'YouTube Music request timeout (7000ms)' : ''
});
async function runNextTimer(timers) {
  const [id, callback] = timers.entries().next().value;
  timers.delete(id);
  await callback();
}

test('recommendations start without waiting for download-list and queue initialization', async () => {
  const { app } = fixture();
  const lists = Promise.withResolvers();
  const started = [];
  Object.assign(app, {
    bindEvents() {}, applyLocalizedUi() {}, renderFormatOptions() {}, scheduleQueuePoll() {},
    loadMusicHomeShelves() { started.push('home'); },
    async search() { started.push('discover'); },
    refreshDownloadLists: () => lists.promise,
    async loadUiConfig() {}, async loadFormats() {}, async refreshQueueStatus() {}
  });
  const initializing = app.initialize();
  await new Promise(setImmediate);
  assert.deepEqual(started, ['home', 'discover']);
  lists.resolve();
  await initializing;
});

test('partial Home stays visible, automatically resumes without forcing fresh Home or timeout toast', async () => {
  const { app, status, timers, notifications } = fixture();
  const refreshes = [];
  app.readMusicHomeShelfStream = async (params, { onProgress }) => {
    refreshes.push(params.get('refresh'));
    if (refreshes.length === 1) {
      onProgress({ ...personal(15, true), cached: true });
      return personal(15, true);
    }
    assert.equal(app.musicHomeShelves.length, 15);
    return personal(23);
  };
  await app.loadMusicHomeShelves({ showToast: true, forceRefresh: true });
  assert.equal(app.musicHomeShelves.length, 15);
  assert.match(status.textContent, /devamı yeniden deneniyor/);
  assert.equal(notifications.length, 0);
  assert.equal(timers.size, 1);
  await runNextTimer(timers);
  assert.deepEqual(refreshes, ['1', '0']);
  assert.equal(app.musicHomeShelves.length, 23);
  assert.doesNotMatch(status.textContent, /tamamlanamadı|yeniden deneniyor/);
  assert.equal(status.title, '');
  assert.equal(timers.size, 0);
});

test('automatic Home retries are bounded and keep all loaded shelves', async () => {
  const { app, status, timers } = fixture();
  let calls = 0;
  app.readMusicHomeShelfStream = async () => { calls += 1; return personal(15, true); };
  await app.loadMusicHomeShelves();
  for (let i = 0; i < 3; i += 1) await runNextTimer(timers);
  assert.equal(calls, 4);
  assert.equal(timers.size, 0);
  assert.equal(app.musicHomeShelves.length, 15);
  assert.match(status.textContent, /devamı tamamlanamadı/);
});

test('browser honors the shared server retry delay instead of polling through a rate limit', async () => {
  const { app, status, timers, timerDelays } = fixture();
  app.readMusicHomeShelfStream = async () => ({ ...personal(15, true), retryAfterMs: 120000 });
  await app.loadMusicHomeShelves();
  assert.equal(timers.size, 1);
  assert.equal(timerDelays.get([...timers.keys()][0]), 120000);
  assert.match(status.textContent, /YouTube için bekleme süresi/);
  assert.equal(app.musicHomeShelves.length, 15);
});

test('new Home load cancels pending retry and ignores old stream progress and completion', async () => {
  const { app, status, timers } = fixture();
  const old = Promise.withResolvers();
  let oldProgress;
  app.readMusicHomeShelfStream = (_params, { onProgress }) => {
    oldProgress = onProgress;
    return old.promise;
  };
  const first = app.loadMusicHomeShelves();
  app.readMusicHomeShelfStream = async () => personal(23);
  await app.loadMusicHomeShelves();
  const completedStatus = status.textContent;
  oldProgress(personal(6, true));
  old.resolve(personal(6, true));
  await first;
  assert.equal(app.musicHomeShelves.length, 23);
  assert.equal(status.textContent, completedStatus);
  assert.equal(timers.size, 0);

  app.readMusicHomeShelfStream = async () => personal(23, true);
  await app.loadMusicHomeShelves();
  const previousRetry = [...timers.values()][0];
  app.readMusicHomeShelfStream = async () => personal(24);
  await app.loadMusicHomeShelves({ showToast: true });
  assert.equal(timers.size, 0);
  await previousRetry();
  assert.equal(app.musicHomeShelves.length, 24);
});

test('late failure of a previous mood search cannot clear the current category or show a toast', async () => {
  const { app, notifications } = fixture();
  const old = Promise.withResolvers();
  app.fetchDiscoverItems = () => old.promise;
  const first = app.search('', { preset: 'energizing' });
  app.fetchDiscoverItems = async () => ({ items: [{ title: 'Relax track' }], hasMore: true });
  await app.search('', { preset: 'relax' });
  old.reject(new Error('YouTube Music API timeout'));
  await first;
  assert.equal(app.results[0].title, 'Relax track');
  assert.equal(app.activePreset, 'relax');
  assert.equal(notifications.length, 0);
});

for (const failed of [false, true]) {
  test(`stale load-more ${failed ? 'error' : 'response'} does not alter a new category`, async () => {
    const { app, notifications } = fixture();
    const old = Promise.withResolvers();
    app.presetPaging = { mode: 'discover', page: 1, failedLoads: 0 };
    app.searchController = new AbortController();
    app.hasMoreResults = true;
    app.fetchDiscoverItems = ({ signal }) => {
      assert.equal(signal, app.searchController.signal);
      return old.promise;
    };
    const first = app.loadMorePresetResults();
    app.searchSerial += 1;
    const newPaging = { mode: 'discover', page: 1, failedLoads: 0 };
    app.presetPaging = newPaging;
    app.results = [{ title: 'Current mood' }];
    app.isLoadingMore = true;
    if (failed) old.reject(new Error('YouTube Music API timeout'));
    else old.resolve({ items: [{ title: 'Stale track' }], hasMore: false });
    await first;
    assert.equal(app.results.length, 1);
    assert.equal(app.results[0].title, 'Current mood');
    assert.equal(newPaging.failedLoads, 0);
    assert.equal(newPaging.page, 1);
    assert.equal(app.isLoadingMore, true);
    assert.equal(app.hasMoreResults, true);
    assert.equal(notifications.length, 0);
  });
}

test('truncated Home stream is retryable and its reader lock is released', async () => {
  const response = new Response(JSON.stringify({ type: 'progress', ...personal(15, true) }) + '\n');
  const { app } = fixture(async () => response);
  const progress = [];
  await assert.rejects(app.readMusicHomeShelfStream(new URLSearchParams(), { onProgress: (frame) => progress.push(frame) }));
  assert.equal(progress[0].shelves.length, 15);
  assert.equal(response.body.locked, false);
});

test('switching back to a loaded mood reuses client cache; locale and empty results stay distinct', async () => {
  let calls = 0, empty = false;
  const { app } = fixture(async () => {
    calls += 1;
    return Response.json({ items: empty ? [] : [{ title: 'Track' }], hasMore: false });
  });
  app.resultLoadLimit = 1;
  await app.fetchDiscoverItems({ preset: 'relax' });
  await app.fetchDiscoverItems({ preset: 'energizing' });
  await app.fetchDiscoverItems({ preset: 'relax' });
  assert.equal(calls, 2);
  app.getCurrentLang = () => 'en';
  await app.fetchDiscoverItems({ preset: 'relax' });
  assert.equal(calls, 3);
  empty = true;
  await app.fetchDiscoverItems({ preset: 'sleep' });
  empty = false;
  assert.equal((await app.fetchDiscoverItems({ preset: 'sleep' })).items.length, 1);
  assert.equal(calls, 5);
});

test('short discovery page is not frozen in the client cache', async () => {
  let calls = 0;
  const { app } = fixture(async () => {
    const count = ++calls === 1 ? 10 : 18;
    return Response.json({ items: Array.from({ length: count }, (_, index) => ({ title: `Track ${index}` })), hasMore: true });
  });
  assert.equal((await app.fetchDiscoverItems()).items.length, 10);
  assert.equal((await app.fetchDiscoverItems()).items.length, 18);
  assert.equal(calls, 2);
});
