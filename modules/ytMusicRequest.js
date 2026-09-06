// Each page gets its own deadline, including reading the response body. A Home
// crawl may have a separate overall budget without sharing an aborted signal.
export async function requestYtMusicJson(fetchPage, { timeoutMs = 7000, deadline = Infinity, retries = 1 } = {}) {
  timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 7000;
  for (let attempt = 0; ; attempt += 1) {
    const remaining = Math.min(timeoutMs, deadline - Date.now());
    if (remaining <= 0) throw Object.assign(new Error('YouTube Music loading budget exhausted'), { code: 'YTM_TIMEOUT' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetchPage(controller.signal);
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch {
        throw Object.assign(new Error(`YouTube Music returned non-JSON (${response.status})`), { status: response.status });
      }
      if (!response.ok) {
        throw Object.assign(new Error(data?.error?.message || `YouTube Music request failed (${response.status})`), { status: response.status });
      }
      return data;
    } catch (error) {
      const timedOut = controller.signal.aborted || error?.name === 'AbortError';
      const transient = timedOut || error instanceof TypeError || error?.status >= 500;
      if (!transient || attempt >= retries || Date.now() >= deadline) {
        if (timedOut) throw Object.assign(new Error(`YouTube Music request timeout (${timeoutMs}ms)`), { code: 'YTM_TIMEOUT' });
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(250 * (attempt + 1), Math.max(0, deadline - Date.now()))));
  }
}

// Shared by all Home/discovery consumers on one server, not by browser tab.
export function createYtMusicRequestGate({ maxConcurrent = 2, minIntervalMs = 500, cooldownMs = 300000, state = new Map(), now = Date.now } = {}) {
  let active = 0, nextStart = 0, timer = null;
  const queue = [];
  const retryAfterMs = () => Math.max(0, Number(state.get('cooldown')?.expiresAt || 0) - now());
  const blockedError = () => Object.assign(new Error('YouTube Music is rate limited; waiting before sending more requests.'), {
    code: 'YTM_RATE_LIMITED', status: 429, retryAfterMs: retryAfterMs()
  });
  const drain = () => {
    clearTimeout(timer);
    timer = null;
    if (retryAfterMs()) {
      while (queue.length) queue.shift().reject(blockedError());
      return;
    }
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].deadline <= now()) queue.splice(index, 1)[0].reject(Object.assign(
        new Error('YouTube Music request queue budget exhausted'), { code: 'YTM_TIMEOUT' }
      ));
    }
    while (active < maxConcurrent && queue.length && nextStart <= now()) {
      const job = queue.shift();
      active += 1;
      nextStart = now() + minIntervalMs;
      Promise.resolve().then(job.operation).then(job.resolve, job.reject).finally(() => { active -= 1; drain(); });
    }
    if (queue.length) {
      const nextDeadline = Math.min(...queue.map((job) => job.deadline));
      const wakeAt = active < maxConcurrent ? Math.min(nextStart, nextDeadline) : nextDeadline;
      if (Number.isFinite(wakeAt)) timer = setTimeout(drain, Math.max(1, wakeAt - now()));
    }
  };
  return {
    retryAfterMs,
    rateLimited(retryAfter) {
      const seconds = Number(retryAfter);
      const requested = retryAfter && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now();
      const waitMs = Number.isFinite(requested) && requested > 0 ? Math.max(30000, requested) : cooldownMs;
      state.set('cooldown', { expiresAt: Math.max(now() + waitMs, Number(state.get('cooldown')?.expiresAt || 0)) });
      drain();
      return blockedError();
    },
    run(operation, { deadline = Infinity } = {}) {
      if (retryAfterMs()) return Promise.reject(blockedError());
      if (queue.length >= 64) return Promise.reject(Object.assign(new Error('YouTube Music request queue is busy'), { code: 'YTM_BUSY' }));
      return new Promise((resolve, reject) => { queue.push({ operation, deadline, resolve, reject }); drain(); });
    }
  };
}
