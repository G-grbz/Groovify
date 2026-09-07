import assert from "node:assert/strict";
import test from "node:test";
import {
  collectTidalPagedItems,
  isTidalUrl,
  parseTidalUrl,
  tidalTrackToMeta,
  TIDAL_METADATA_MAX_ITEMS,
  TIDAL_METADATA_PAGE_SIZE
} from "../modules/tidal.js";

test("parses supported TIDAL playlist, album and album-track URLs", () => {
  assert.deepEqual(
    parseTidalUrl("https://tidal.com/playlist/edf3b7d2-cb42-41d7-93c0-afa2a395521b"),
    {
      type: "playlist",
      id: "edf3b7d2-cb42-41d7-93c0-afa2a395521b",
      albumId: null,
      trackId: null
    }
  );

  assert.deepEqual(
    parseTidalUrl("https://tidal.com/album/549573349"),
    { type: "album", id: "549573349", albumId: "549573349", trackId: null }
  );

  assert.deepEqual(
    parseTidalUrl("https://tidal.com/album/549573349/track/550000001?u"),
    { type: "track", id: "550000001", albumId: "549573349", trackId: "550000001" }
  );

  assert.equal(isTidalUrl("https://tidal.com/album/549573349"), true);
  assert.equal(isTidalUrl("https://example.com/album/549573349"), false);
});

test("paginates TIDAL collections in pages of at most 50", async () => {
  const calls = [];
  const total = 143;
  const result = await collectTidalPagedItems(async ({ limit, offset }) => {
    calls.push({ limit, offset });
    const count = Math.max(0, Math.min(limit, total - offset));
    return {
      totalNumberOfItems: total,
      items: Array.from({ length: count }, (_, i) => offset + i + 1)
    };
  });

  assert.equal(TIDAL_METADATA_PAGE_SIZE, 50);
  assert.equal(result.items.length, 143);
  assert.deepEqual(calls, [
    { limit: 50, offset: 0 },
    { limit: 50, offset: 50 },
    { limit: 50, offset: 100 }
  ]);
  assert.ok(calls.every((call) => call.limit <= 50));
});

test("caps TIDAL collection enumeration at 1000 tracks", async () => {
  const calls = [];
  const total = 5000;
  const result = await collectTidalPagedItems(async ({ limit, offset }) => {
    calls.push({ limit, offset });
    return {
      totalNumberOfItems: total,
      items: Array.from({ length: limit }, (_, i) => offset + i + 1)
    };
  });

  assert.equal(TIDAL_METADATA_MAX_ITEMS, 1000);
  assert.equal(result.items.length, 1000);
  assert.equal(result.totalNumberOfItems, 1000);
  assert.equal(calls.length, 20);
  assert.deepEqual(calls[0], { limit: 50, offset: 0 });
  assert.deepEqual(calls.at(-1), { limit: 50, offset: 950 });
  assert.ok(calls.every((call) => call.limit <= 50));
});

test("normalizes TIDAL track metadata and preserves album-track source URL", () => {
  const meta = tidalTrackToMeta({
    id: 550000001,
    title: "Track One",
    duration: 201,
    trackNumber: 2,
    volumeNumber: 1,
    isrc: "USABC2600001",
    explicit: true,
    artist: { id: 123, name: "Artist One" },
    artists: [{ id: 123, name: "Artist One" }],
    album: {
      id: 549573349,
      title: "Album One",
      cover: "605a71dc-5ba2-41af-a1a5-f96d1d3ef22c"
    }
  }, {
    id: 549573349,
    title: "Album One",
    artist: { id: 123, name: "Artist One" },
    releaseDate: "2026-08-20",
    numberOfTracks: 12,
    numberOfVolumes: 1,
    cover: "605a71dc-5ba2-41af-a1a5-f96d1d3ef22c"
  });

  assert.equal(meta.title, "Track One");
  assert.equal(meta.artist, "Artist One");
  assert.equal(meta.album, "Album One");
  assert.equal(meta.duration_ms, 201000);
  assert.equal(meta.track_number, 2);
  assert.equal(meta.track_total, 12);
  assert.equal(meta.tidal_track_id, 550000001);
  assert.equal(meta.tidal_album_id, 549573349);
  assert.equal(meta.webpage_url, "https://tidal.com/album/549573349/track/550000001");
  assert.match(meta.coverUrl, /resources\.tidal\.com\/images\/605a71dc\/5ba2\/41af\/a1a5\/f96d1d3ef22c\/1280x1280\.jpg$/);
});

test("playlist resolver requests 50-track pages and stops at reported total", async () => {
  const { resolveTidalUrlLite } = await import("../modules/tidal.js");
  const originalFetch = globalThis.fetch;
  const requested = [];
  const playlistId = "edf3b7d2-cb42-41d7-93c0-afa2a395521b";
  const total = 143;

  globalThis.fetch = async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl));
    requested.push({
      pathname: url.pathname,
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset"),
      token: options?.headers?.["x-tidal-token"] || ""
    });

    let payload;
    if (url.pathname === `/v1/playlists/${playlistId}`) {
      payload = { uuid: playlistId, title: "TIDAL Test Playlist", numberOfTracks: total };
    } else if (url.pathname === `/v1/playlists/${playlistId}/tracks`) {
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      const count = Math.max(0, Math.min(limit, total - offset));
      payload = {
        limit,
        offset,
        totalNumberOfItems: total,
        items: Array.from({ length: count }, (_, i) => {
          const id = 100000 + offset + i;
          return {
            id,
            title: `Track ${offset + i + 1}`,
            duration: 180,
            trackNumber: offset + i + 1,
            volumeNumber: 1,
            artist: { id: 7, name: "Artist" },
            artists: [{ id: 7, name: "Artist" }],
            album: { id: 99, title: "Album", cover: "605a71dc-5ba2-41af-a1a5-f96d1d3ef22c" }
          };
        })
      };
    } else {
      return new Response(JSON.stringify({ userMessage: `Unexpected ${url.pathname}` }), { status: 404 });
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const resolved = await resolveTidalUrlLite(`https://tidal.com/playlist/${playlistId}`, {
      market: "US",
      maxItems: 1000
    });
    assert.equal(resolved.kind, "playlist");
    assert.equal(resolved.provider, "tidal");
    assert.equal(resolved.title, "TIDAL Test Playlist");
    assert.equal(resolved.items.length, 143);

    const trackRequests = requested.filter((entry) => entry.pathname.endsWith("/tracks"));
    assert.deepEqual(trackRequests.map(({ limit, offset }) => ({ limit, offset })), [
      { limit: "50", offset: "0" },
      { limit: "50", offset: "50" },
      { limit: "50", offset: "100" }
    ]);
    assert.ok(trackRequests.every((entry) => Number(entry.limit) <= 50));
    assert.ok(requested.every((entry) => entry.token));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("album and album-track resolvers preserve the requested TIDAL entity", async () => {
  const { resolveTidalUrlLite } = await import("../modules/tidal.js");
  const originalFetch = globalThis.fetch;
  const albumId = "549573349";
  const trackId = "550000001";

  const album = {
    id: Number(albumId),
    title: "Album One",
    artist: { id: 123, name: "Artist One" },
    releaseDate: "2026-08-20",
    numberOfTracks: 1,
    numberOfVolumes: 1,
    cover: "605a71dc-5ba2-41af-a1a5-f96d1d3ef22c"
  };
  const track = {
    id: Number(trackId),
    title: "Track One",
    duration: 201,
    trackNumber: 1,
    volumeNumber: 1,
    artist: { id: 123, name: "Artist One" },
    artists: [{ id: 123, name: "Artist One" }],
    album: { id: Number(albumId), title: "Album One", cover: album.cover }
  };

  globalThis.fetch = async (rawUrl) => {
    const url = new URL(String(rawUrl));
    let payload;
    if (url.pathname === `/v1/albums/${albumId}`) payload = album;
    else if (url.pathname === `/v1/albums/${albumId}/tracks`) {
      payload = { limit: 50, offset: 0, totalNumberOfItems: 1, items: [track] };
    } else if (url.pathname === `/v1/tracks/${trackId}`) payload = track;
    else return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(payload), { status: 200 });
  };

  try {
    const albumResult = await resolveTidalUrlLite(`https://tidal.com/album/${albumId}`, { market: "US" });
    assert.equal(albumResult.kind, "album");
    assert.equal(albumResult.items.length, 1);
    assert.equal(albumResult.items[0].tidal_album_id, Number(albumId));

    const trackResult = await resolveTidalUrlLite(
      `https://tidal.com/album/${albumId}/track/${trackId}`,
      { market: "US" }
    );
    assert.equal(trackResult.kind, "track");
    assert.equal(trackResult.items.length, 1);
    assert.equal(trackResult.items[0].tidal_track_id, Number(trackId));
    assert.equal(trackResult.items[0].webpage_url, `https://tidal.com/album/${albumId}/track/${trackId}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
