import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCatalogMusicSearchQueries,
  isCatalogMusicProvider,
  isCatalogTextDurationMatch,
  isMappedMusicDurationCompatible,
  scoreCatalogMusicCandidateText
} from '../modules/mappedMusicMatcher.js';

test('catalog providers share artist+title then title-only search queries', () => {
  for (const provider of ['spotify', 'apple', 'apple_music', 'deezer', 'tidal']) {
    assert.equal(isCatalogMusicProvider(provider), true, provider);
  }
  assert.equal(isCatalogMusicProvider('soundcloud'), false);
  assert.deepEqual(
    buildCatalogMusicSearchQueries('Ahmet Kaya', 'Hep Sonradan'),
    ['Ahmet Kaya Hep Sonradan', 'Hep Sonradan']
  );
});

test('catalog duration guard accepts release variation but rejects long false matches', () => {
  assert.equal(isMappedMusicDurationCompatible(217733, 218), true);
  assert.equal(isMappedMusicDurationCompatible(316813, 317), true);
  assert.equal(isMappedMusicDurationCompatible(325683, 276), true);
  assert.equal(isMappedMusicDurationCompatible(321364, 295), true);
  assert.equal(isMappedMusicDurationCompatible(187546, 47 * 60), false);
  assert.equal(isMappedMusicDurationCompatible(171207, 60 * 60), false);
});

test('catalog weak text matches require very close duration and zero-score never passes', () => {
  assert.equal(isCatalogTextDurationMatch(6, 217733, 240), true);
  assert.equal(isCatalogTextDurationMatch(4, 217733, 218), true);
  assert.equal(isCatalogTextDurationMatch(4, 217733, 260), false);
  assert.equal(isCatalogTextDurationMatch(0, 217733, 218), false);
});


test('catalog scoring tolerates spacing variants and prefers concise YouTube titles', () => {
  const clean = scoreCatalogMusicCandidateText(
    'Ahmet Kaya',
    'Öyle Bir Yerdeyimki',
    'Öyle Bir Yerdeyim ki (Ahmet Kaya)',
    'Ahmet Kaya - Topic'
  );
  const noisy = scoreCatalogMusicCandidateText(
    'Ahmet Kaya',
    'Öyle Bir Yerdeyimki',
    'Ahmet Kaya Selda Bağcan öyle bir yerdeyimki KARADAYI dizi',
    'Karadayı Dizi'
  );

  assert.ok(clean > noisy, `clean=${clean} noisy=${noisy}`);
});
