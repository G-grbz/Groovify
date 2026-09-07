import test from 'node:test';
import assert from 'node:assert/strict';
import { MusicUrlQueueManager } from '../public/ui/MusicUrlQueueManager.js';

function createHarness() {
  const startButton = {
    disabled: false,
    classList: {
      add() {},
      remove() {}
    }
  };
  const urlInput = { value: '' };

  globalThis.document = {
    getElementById(id) {
      if (id === 'startIntegratedBtn') return startButton;
      if (id === 'urlInput') return urlInput;
      return null;
    }
  };

  const app = {
    isSpotifyUrl: (url) => /^https:\/\/open\.spotify\.com\//.test(String(url || '')),
    isRetagMode: () => false,
    onUrlInputChange() {},
    showNotification() {},
    t(key, vars = {}) {
      return Object.entries(vars).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
        key
      );
    }
  };

  return { manager: new MusicUrlQueueManager(app), startButton, app };
}

test('music URL queue removes only successful URLs when auto-remove is enabled', async () => {
  const { manager } = createHarness();
  manager.autoRemoveSuccessful = true;

  for (let i = 1; i <= 10; i += 1) {
    manager.add(`https://open.spotify.com/playlist/list${i}`);
  }

  await manager.processQueue(async (item) => {
    if (item.url.endsWith('list7')) {
      return { status: 'error', error: 'broken URL' };
    }
    return { status: 'completed' };
  });

  assert.equal(manager.items.length, 1);
  assert.equal(manager.items[0].url, 'https://open.spotify.com/playlist/list7');
  assert.equal(manager.items[0].status, 'error');
  assert.equal(manager.items[0].error, 'broken URL');
});

test('music URL queue processes list URLs strictly one at a time', async () => {
  const { manager } = createHarness();
  for (let i = 1; i <= 4; i += 1) {
    manager.add(`https://open.spotify.com/playlist/serial${i}`);
  }

  let active = 0;
  let maxActive = 0;
  const started = [];
  const finished = [];

  await manager.processQueue(async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    started.push(item.url);
    await new Promise((resolve) => setTimeout(resolve, 5));
    finished.push(item.url);
    active -= 1;
    return { status: 'completed' };
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(started, finished);
  assert.deepEqual(started, [
    'https://open.spotify.com/playlist/serial1',
    'https://open.spotify.com/playlist/serial2',
    'https://open.spotify.com/playlist/serial3',
    'https://open.spotify.com/playlist/serial4'
  ]);
});


test('music URL queue provider detection parses hostnames instead of trusting URL substrings', () => {
  const { manager } = createHarness();

  assert.equal(manager.getProvider('https://open.spotify.com/album/123ABC'), 'Spotify');
  assert.equal(manager.getProvider('https://music.apple.com/tr/album/example/123456789'), 'Apple Music');
  assert.equal(manager.getProvider('https://www.deezer.com/tr/album/123456'), 'Deezer');
  assert.equal(manager.getProvider('https://soundcloud.com/buzzing-playlists/sets/buzzing-mexico'), 'SoundCloud');

  assert.equal(manager.getProvider('https://evil.example/?next=https://music.apple.com/tr/album/1'), 'musicQueue.unknownProvider');
  assert.equal(manager.getProvider('https://music.apple.com.evil.example/album/1'), 'musicQueue.unknownProvider');
  assert.equal(manager.getProvider('https://evil-spotify.example/path/open.spotify.com/track/1'), 'musicQueue.unknownProvider');
  assert.equal(manager.getProvider('https://deezer.com.evil.example/album/1'), 'musicQueue.unknownProvider');
});

test('music URL queue support indicator mirrors supported mapped-music URL shapes', () => {
  const { manager } = createHarness();

  assert.equal(manager.isSupportedUrl('https://open.spotify.com/track/123ABC'), true);
  assert.equal(manager.isSupportedUrl('https://open.spotify.com/intl-tr/album/123ABC?si=1'), true);
  assert.equal(manager.isSupportedUrl('spotify:playlist:123ABC'), true);
  assert.equal(manager.isSupportedUrl('https://open.spotify.com/show/123ABC'), false);

  assert.equal(manager.isSupportedUrl('https://music.apple.com/tr/album/example/123456789?i=987654321'), true);
  assert.equal(manager.isSupportedUrl('https://music.apple.com/tr/playlist/example/pl.123abc'), true);
  assert.equal(manager.isSupportedUrl('https://music.apple.com/tr/artist/example/123456789'), false);

  assert.equal(manager.isSupportedUrl('https://www.deezer.com/tr/playlist/123456'), true);
  assert.equal(manager.isSupportedUrl('https://www.deezer.com/search/Ahmet%20Kaya/track'), true);
  assert.equal(manager.isSupportedUrl('https://www.deezer.com/tr/smarttracklist/inspired-by-1234'), true);
  assert.equal(manager.isSupportedUrl('https://abc.deezer.page.link/xyz'), true);

  assert.equal(manager.isSupportedUrl('https://soundcloud.com/example-user/example-track'), true);
  assert.equal(manager.isSupportedUrl('https://soundcloud.com/example-user/sets/example-set'), true);
  assert.equal(manager.isSupportedUrl('https://soundcloud.com/example-user/likes'), true);
  assert.equal(manager.isSupportedUrl('https://soundcloud.com/example-user/reposts'), true);
  assert.equal(manager.isSupportedUrl('https://soundcloud.com/buzzing-playlists/sets/buzzing-mexico'), true);
  assert.equal(manager.isSupportedUrl('https://soundcloud.com/discover/sets/charts-top:all-music:de'), true);
  assert.equal(manager.isSupportedUrl('https://soundcloud.com/stations/track/example-user/example-track'), true);
  assert.equal(manager.isSupportedUrl('https://soundcloud.com/charts/top'), false);
  assert.equal(manager.isSupportedUrl('https://soundcloud.com/buzzing-playlists'), false);

  assert.equal(manager.isSupportedUrl('https://www.youtube.com/watch?v=abc'), false);
});

test('unsupported URL stays in queue as an error and does not block following supported URL', async () => {
  const { manager } = createHarness();
  manager.autoRemoveSuccessful = true;

  manager.add('https://example.com/not-supported');
  manager.add('https://open.spotify.com/playlist/serialOK');

  let processed = 0;
  const result = await manager.processQueue(async () => {
    processed += 1;
    return { status: 'completed' };
  });

  assert.equal(processed, 1);
  assert.deepEqual(result, { completed: 1, failed: 1 });
  assert.equal(manager.items.length, 1);
  assert.equal(manager.items[0].url, 'https://example.com/not-supported');
  assert.equal(manager.items[0].status, 'error');
  assert.equal(manager.items[0].error, 'musicQueue.unsupportedError');
});


test('music URL queue persists rows, titles and auto-remove across page reloads', () => {
  const originalStorage = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); }
  };

  try {
    const { manager } = createHarness();
    manager.autoRemoveSuccessful = true;
    manager.items = [
      {
        id: 4,
        url: 'https://www.deezer.com/tr/album/9843866',
        status: 'completed',
        error: null,
        jobId: null,
        title: 'Artist - Album',
        titleStatus: 'resolved'
      },
      {
        id: 5,
        url: 'https://open.spotify.com/playlist/running123',
        status: 'running',
        error: null,
        jobId: 'job-1',
        title: 'Playlist',
        titleStatus: 'resolved'
      },
      {
        id: 6,
        url: 'https://example.com/broken',
        status: 'error',
        error: 'broken URL',
        jobId: null,
        title: '',
        titleStatus: 'error'
      }
    ];
    manager.persistState();

    const { manager: restored } = createHarness();
    restored.restoreState();

    assert.equal(restored.autoRemoveSuccessful, true);
    assert.equal(restored.items.length, 3);
    assert.equal(restored.items[0].status, 'completed');
    assert.equal(restored.items[0].title, 'Artist - Album');
    assert.equal(restored.items[1].status, 'pending');
    assert.equal(restored.items[1].jobId, null);
    assert.equal(restored.items[2].status, 'error');
    assert.equal(restored.items[2].error, 'broken URL');
    assert.equal(restored.nextId, 7);
  } finally {
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  }
});

test('music URL queue stores a resolved display title without changing processing status', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { ok: true, title: 'Sanatçı - Albüm' };
    }
  });

  try {
    const { manager } = createHarness();
    manager.items.push({
      id: 1,
      url: 'https://www.deezer.com/tr/album/9843866',
      status: 'pending',
      error: null,
      jobId: null,
      title: '',
      titleStatus: 'idle'
    });

    const title = await manager.resolveItemTitle(1);
    assert.equal(title, 'Sanatçı - Albüm');
    assert.equal(manager.items[0].title, 'Sanatçı - Albüm');
    assert.equal(manager.items[0].titleStatus, 'resolved');
    assert.equal(manager.items[0].status, 'pending');
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('main Match & Download button is controlled only by #urlInput, not saved queue rows', () => {
  const { manager, startButton } = createHarness();
  manager.addBtn = {
    style: {},
    disabled: false,
    title: '',
    setAttribute() {}
  };
  manager.items = [{
    id: 1,
    url: 'https://open.spotify.com/playlist/savedQueueOnly',
    status: 'pending',
    error: null,
    jobId: null,
    title: '',
    titleStatus: 'idle'
  }];

  manager.updateButton();
  assert.equal(startButton.disabled, true);

  globalThis.document.getElementById('urlInput').value = 'https://open.spotify.com/album/directInput';
  manager.updateButton();
  assert.equal(startButton.disabled, false);
});

test('queue start action sends queue URLs through the dedicated managed path', async () => {
  const { manager, app } = createHarness();
  manager.items = [{
    id: 1,
    url: 'https://open.spotify.com/playlist/queueOne',
    status: 'pending',
    error: null,
    jobId: null,
    title: '',
    titleStatus: 'idle'
  }];

  const calls = [];
  app.spotifyManager = {
    async startIntegratedSpotifyProcess(options) {
      calls.push(options);
      return { status: 'completed', jobId: 'job-1' };
    }
  };

  const result = await manager.startQueue();
  assert.deepEqual(result, { completed: 1, failed: 0 });
  assert.deepEqual(calls, [{
    url: 'https://open.spotify.com/playlist/queueOne',
    queueManaged: true,
    awaitCompletion: true
  }]);
});
