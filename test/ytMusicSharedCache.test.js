import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createYtMusicSharedCache } from '../modules/ytMusicSharedCache.js';
import { createYtMusicRequestGate, requestYtMusicJson } from '../modules/ytMusicRequest.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-shared-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'cache.json') };
}

test('central cache survives restart with private file permissions and discards expired entries', (t) => {
  const { file } = fixture(t);
  let clock = 1000;
  const first = createYtMusicSharedCache({ file, now: () => clock });
  first.map('home').set('session-hash', { expiresAt: 5000, result: { shelves: [{ title: 'Shelf', items: [] }] }, resumeState: { continuation: { token: 'next' } } });
  first.map('mood-pools').set('tr-focus', { expiresAt: 2000, value: { items: [], completedQueries: ['query'] } });
  first.close();
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  clock = 3000;
  const restarted = createYtMusicSharedCache({ file, now: () => clock });
  assert.equal(restarted.map('home').get('session-hash').resumeState.continuation.token, 'next');
  assert.equal(restarted.map('mood-pools').size, 0);
  restarted.close();
});

test('cache tolerates corrupt files and persistence failures without breaking memory reuse', (t) => {
  const { directory, file } = fixture(t);
  fs.writeFileSync(file, '{not-json');
  const corrupt = createYtMusicSharedCache({ file });
  assert.equal(corrupt.map('home').size, 0);
  corrupt.map('home').set('one', { expiresAt: Date.now() + 10000 });
  corrupt.close();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
  const unwritable = createYtMusicSharedCache({ file: path.join(file, 'impossible.json') });
  unwritable.map('home').set('one', { expiresAt: Date.now() + 10000, value: 'kept' });
  assert.doesNotThrow(() => unwritable.flush());
  assert.equal(unwritable.map('home').get('one').value, 'kept');
  unwritable.close();
  assert.deepEqual(fs.readdirSync(directory), ['cache.json'], 'atomic temp files are cleaned up');
});

test('oversized query data cannot prevent cooldowns and smaller feed checkpoints from persisting', (t) => {
  const { file } = fixture(t);
  const cache = createYtMusicSharedCache({ file, maxBytes: 1024 });
  const expiresAt = Date.now() + 10000;
  cache.map('queries').set('oversized', { expiresAt, value: 'x'.repeat(2000) });
  cache.map('home').set('session', { expiresAt, result: { shelves: [] } });
  cache.map('request-state').set('cooldown', { expiresAt });
  cache.close();
  assert.ok(fs.statSync(file).size <= 1024);
  const restored = createYtMusicSharedCache({ file, maxBytes: 1024 });
  assert.equal(restored.map('request-state').get('cooldown').expiresAt, expiresAt);
  assert.ok(restored.map('home').has('session'));
  assert.equal(restored.map('queries').size, 0);
  restored.close();
});

test('server gate bounds concurrency and spaces starts across different consumers', async () => {
  const gate = createYtMusicRequestGate({ maxConcurrent: 2, minIntervalMs: 20 });
  let active = 0, peak = 0;
  const started = [];
  await Promise.all(Array.from({ length: 5 }, () => gate.run(async () => {
    started.push(Date.now());
    peak = Math.max(peak, ++active);
    await delay(55);
    active -= 1;
  })));
  assert.equal(peak, 2);
  for (let i = 1; i < started.length; i += 1) assert.ok(started[i] - started[i - 1] >= 18);
});

test('rate limit cancels queued work, survives restart and honors Retry-After', async (t) => {
  const { file } = fixture(t);
  let clock = 1000, calls = 0;
  const cache = createYtMusicSharedCache({ file, now: () => clock });
  const gate = createYtMusicRequestGate({ maxConcurrent: 1, minIntervalMs: 0, state: cache.map('request-state'), now: () => clock });
  const first = gate.run(async () => { calls += 1; throw gate.rateLimited('120'); });
  const second = gate.run(async () => { calls += 1; });
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason.code === 'YTM_RATE_LIMITED'));
  assert.equal(calls, 1);
  assert.equal(gate.retryAfterMs(), 120000);
  cache.close();
  const restoredCache = createYtMusicSharedCache({ file, now: () => clock });
  const restoredGate = createYtMusicRequestGate({ minIntervalMs: 0, state: restoredCache.map('request-state'), now: () => clock });
  await assert.rejects(restoredGate.run(() => { calls += 1; }), { code: 'YTM_RATE_LIMITED' });
  clock += 120001;
  await restoredGate.run(() => { calls += 1; });
  assert.equal(calls, 2);
  restoredCache.close();
});

test('expired queued requests do not wait for a busy upstream slot', async () => {
  const gate = createYtMusicRequestGate({ maxConcurrent: 1, minIntervalMs: 0 });
  const hold = Promise.withResolvers();
  const first = gate.run(() => hold.promise);
  let ran = false;
  await assert.rejects(gate.run(() => { ran = true; }, { deadline: Date.now() + 20 }), { code: 'YTM_TIMEOUT' });
  assert.equal(ran, false);
  hold.resolve();
  await first;
});

test('HTTP 429 is never immediately retried by the JSON client', async () => {
  let calls = 0;
  await assert.rejects(requestYtMusicJson(async () => {
    calls += 1;
    return Response.json({ error: { message: 'Too many requests' } }, { status: 429 });
  }), { status: 429 });
  assert.equal(calls, 1);
});
