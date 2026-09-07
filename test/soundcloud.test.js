import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveSoundCloudMatchIdentity,
  extractSoundCloudClientId,
  isSoundCloudDurationCompatible,
  isSoundCloudTextDurationMatch,
  isSoundCloudUrl,
  parseSoundCloudUrl,
  rankSoundCloudPopularTracks,
  soundCloudTrackToMeta
} from '../modules/soundcloud.js';

test('SoundCloud parser supports tracks and sets', () => {
  assert.deepEqual(
    parseSoundCloudUrl('https://soundcloud.com/example-user/example-track'),
    { type: 'track', id: 'example-user/example-track', special: false, collectionKind: 'track' }
  );
  assert.deepEqual(
    parseSoundCloudUrl('https://soundcloud.com/example-user/sets/example-set'),
    { type: 'playlist', id: 'example-user/sets/example-set', special: false, collectionKind: 'set' }
  );
});

test('SoundCloud parser supports user collections', () => {
  for (const section of ['tracks', 'likes', 'reposts', 'sets', 'albums', 'popular-tracks', 'spotlight']) {
    const parsed = parseSoundCloudUrl(`https://soundcloud.com/example-user/${section}`);
    assert.equal(parsed.type, 'user_playlist');
    assert.equal(parsed.collectionKind, section.replace(/-/g, '_'));
  }
  const profile = parseSoundCloudUrl('https://soundcloud.com/example-user');
  assert.equal(profile.type, 'user_playlist');
  assert.equal(profile.collectionKind, 'profile');
});


test('SoundCloud parser supports real popular-tracks and member set URL shapes', () => {
  assert.deepEqual(
    parseSoundCloudUrl('https://soundcloud.com/ahmet-kaya-2/popular-tracks'),
    { type: 'user_playlist', id: 'ahmet-kaya-2/popular-tracks', special: true, collectionKind: 'popular_tracks' }
  );
  assert.deepEqual(
    parseSoundCloudUrl('https://soundcloud.com/dervis-ali-zt-rk/sets/ahmet-kaya-2'),
    { type: 'playlist', id: 'dervis-ali-zt-rk/sets/ahmet-kaya-2', special: false, collectionKind: 'set' }
  );
});

test('SoundCloud popular tracks are ranked by plays with likes as tie-breaker', () => {
  const ranked = rankSoundCloudPopularTracks([
    { id: 1, playback_count: 100, likes_count: 4 },
    { id: 2, playback_count: 300, likes_count: 1 },
    { id: 3, playback_count: 100, likes_count: 9 }
  ]);
  assert.deepEqual(ranked.map((entry) => entry.id), [2, 3, 1]);
});

test('SoundCloud parser preserves working discovery set kinds', () => {
  assert.deepEqual(
    parseSoundCloudUrl('https://soundcloud.com/buzzing-playlists/sets/buzzing-mexico'),
    {
      type: 'playlist',
      id: 'buzzing-playlists/sets/buzzing-mexico',
      special: true,
      collectionKind: 'buzzing_playlist'
    }
  );
  assert.deepEqual(
    parseSoundCloudUrl('https://soundcloud.com/discover/sets/charts-top:all-music:de'),
    {
      type: 'playlist',
      id: 'discover/sets/charts-top:all-music:de',
      special: true,
      collectionKind: 'discovery_set'
    }
  );
  assert.deepEqual(
    parseSoundCloudUrl('https://soundcloud.com/stations/track/example-user/example-track'),
    {
      type: 'special',
      id: 'stations/track/example-user/example-track',
      special: true,
      collectionKind: 'track_station'
    }
  );
});

test('SoundCloud parser rejects unsupported bare discovery pages and spoofed hosts', () => {
  for (const url of [
    'https://soundcloud.com/',
    'https://soundcloud.com/discover',
    'https://soundcloud.com/charts/top',
    'https://soundcloud.com/buzzing-playlists',
    'https://soundcloud.com.evil.example/example-user/example-track'
  ]) {
    assert.equal(isSoundCloudUrl(url), false, url);
  }
});

test('SoundCloud numeric flat-playlist ids are never treated as titles', () => {
  const meta = soundCloudTrackToMeta({
    id: '2381141178',
    title: '2381141178',
    webpage_url: 'https://api-v2.soundcloud.com/tracks/2381141178'
  });
  assert.equal(meta.title, '');
  assert.equal(meta.track, '');
  assert.equal(meta.soundcloud_track_id, '2381141178');
});

test('SoundCloud metadata preserves artist, album, URL, URN and duration', () => {
  const meta = soundCloudTrackToMeta({
    id: '2381141178',
    urn: 'soundcloud:tracks:2381141178',
    title: 'Nomawol - The Silence (FREE)',
    uploader: 'Nomawol',
    album: 'Buzzing Mexico',
    duration: 136.326,
    webpage_url: 'https://soundcloud.com/nomawoldub/nomawol-the-silence-1',
    thumbnail: 'https://i1.sndcdn.com/artworks-example-large.jpg'
  });
  assert.equal(meta.title, 'The Silence (FREE)');
  assert.equal(meta.artist, 'Nomawol');
  assert.equal(meta.soundcloud_raw_title, 'Nomawol - The Silence (FREE)');
  assert.equal(meta.album, 'Buzzing Mexico');
  assert.equal(meta.duration_ms, 136326);
  assert.equal(meta.soundcloud_urn, 'soundcloud:tracks:2381141178');
  assert.equal(meta.soundcloudUrl, 'https://soundcloud.com/nomawoldub/nomawol-the-silence-1');
});

test('SoundCloud api-v2 millisecond duration is not multiplied twice', () => {
  const meta = soundCloudTrackToMeta({
    id: '1',
    title: 'Track',
    artist: 'Artist',
    duration_ms: 136326,
    permalink_url: 'https://soundcloud.com/artist/track'
  });
  assert.equal(meta.duration_ms, 136326);
});

test('SoundCloud client id is extracted from public hydration payload', () => {
  const html = '<script>window.__sc_hydration = [{"hydratable":"apiClient","data":{"id":"Pb72ranhoyt6gw7hM7TkzUItXlMWSNSo"}}];</script>';
  assert.equal(extractSoundCloudClientId(html), 'Pb72ranhoyt6gw7hM7TkzUItXlMWSNSo');
});


test('SoundCloud matching identity removes duplicated artist and promo noise', () => {
  assert.deepEqual(
    deriveSoundCloudMatchIdentity({
      artist: 'Nomawol',
      title: 'Nomawol - The Silence (FREE DOWNLOAD)'
    }),
    { artist: 'Nomawol', title: 'The Silence' }
  );

  assert.deepEqual(
    deriveSoundCloudMatchIdentity({
      artist: 'Strooke',
      title: 'Franco Smith - Misil (Strooke Remix)'
    }),
    { artist: 'Franco Smith', title: 'Misil (Strooke Remix)' }
  );
});


test('SoundCloud YouTube duration guard rejects long or short false matches', () => {
  // DSD from the real Buzzing Mexico manifest is about 187.5 seconds.
  assert.equal(isSoundCloudDurationCompatible(187546, 190), true);
  assert.equal(isSoundCloudDurationCompatible(187546, 900), false);
  assert.equal(isSoundCloudDurationCompatible(187546, 60), false);

  // peonias.m4a is about 151 seconds; a normal mirror stays close.
  assert.equal(isSoundCloudDurationCompatible(151069, 151), true);
  assert.equal(isSoundCloudDurationCompatible(151069, 600), false);

  // Unknown candidate duration is left for the metadata probe.
  assert.equal(isSoundCloudDurationCompatible(270317, 0), true);
});


test('SoundCloud relaxed text matches require a tight duration', () => {
  // A title-only YouTube result can be accepted when the duration is nearly exact.
  assert.equal(isSoundCloudTextDurationMatch(4, 187546, 188, 'That Makes Sense'), true);
  // The same weak text score must not admit a long lecture/mix.
  assert.equal(isSoundCloudTextDurationMatch(4, 187546, 2820, 'That Makes Sense'), false);
  // Very short/generic titles stay on the strict path.
  assert.equal(isSoundCloudTextDurationMatch(4, 187546, 188, 'DSD'), false);
  // Exact-title score remains valid when the duration guard already passed.
  assert.equal(isSoundCloudTextDurationMatch(6, 187546, 188, 'DSD'), true);
});


test('SoundCloud drops only a leading uploader prefix before real artist metadata', () => {
  const meta = soundCloudTrackToMeta({
    id: '42',
    uploader: 'Samet Gür',
    title: 'Samet Gür - Ahmet Kaya - Korkarım',
    duration: 240,
    webpage_url: 'https://soundcloud.com/dervis-ali-zt-rk/example'
  });

  assert.equal(meta.artist, 'Ahmet Kaya');
  assert.equal(meta.title, 'Korkarım');
  assert.equal(meta.match_artist, 'Ahmet Kaya');
  assert.equal(meta.match_title, 'Korkarım');
  assert.equal(meta.soundcloud_uploader, 'Samet Gür');
  assert.equal(meta.soundcloud_raw_title, 'Samet Gür - Ahmet Kaya - Korkarım');
});

test('SoundCloud keeps remix/edit text while excluding an unrelated uploader from output metadata', () => {
  const meta = soundCloudTrackToMeta({
    id: '43',
    uploader: '❌ HSN SBBH ❌',
    title: 'Eypio - Ömrüm (Erhan Boraer Remix)',
    duration: 210,
    webpage_url: 'https://soundcloud.com/user/example'
  });

  assert.equal(meta.artist, 'Eypio');
  assert.equal(meta.title, 'Ömrüm (Erhan Boraer Remix)');
  assert.equal(meta.match_artist, 'Eypio');
  assert.equal(meta.match_title, 'Ömrüm (Erhan Boraer Remix)');
  assert.equal(meta.soundcloud_raw_title, 'Eypio - Ömrüm (Erhan Boraer Remix)');
});

test('SoundCloud does not strip a real artist when uploader and artist are the same', () => {
  const meta = soundCloudTrackToMeta({
    id: '44',
    uploader: 'Cem Karaca',
    title: 'Cem Karaca - Raptiye Rap Rap (Cantuğ Gökçel Edit)',
    duration: 200,
    webpage_url: 'https://soundcloud.com/example/example'
  });

  assert.equal(meta.artist, 'Cem Karaca');
  assert.equal(meta.title, 'Raptiye Rap Rap (Cantuğ Gökçel Edit)');
  assert.equal(meta.match_title, 'Raptiye Rap Rap (Cantuğ Gökçel Edit)');
});

test('SoundCloud leaves non artist-title uploads unchanged when no safer identity exists', () => {
  const meta = soundCloudTrackToMeta({
    id: '45',
    uploader: 'SWEETLOST',
    title: 'RIDDIM GIRL (VIP)',
    duration: 141,
    webpage_url: 'https://soundcloud.com/sweetlostmusic/riddim-girl-vip'
  });

  assert.equal(meta.artist, 'SWEETLOST');
  assert.equal(meta.title, 'RIDDIM GIRL (VIP)');
});
