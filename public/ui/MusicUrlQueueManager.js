export class MusicUrlQueueManager {
    constructor(app) {
        this.app = app;
        this.items = [];
        this.running = false;
        this.autoRemoveSuccessful = false;
        this.nextId = 1;
        this.modalEl = null;
        this.listEl = null;
        this.countEl = null;
        this.addBtn = null;
        this.modalInput = null;
        this.modalAddBtn = null;
        this.modalSupportEl = null;
        this.autoRemoveCheckbox = null;
        this.queueStartBtn = null;
        this.storageKey = 'gharmonize_music_url_queue_v1';
    }

    initialize() {
        this.addBtn = document.getElementById('musicUrlQueueAddBtn');
        this.countEl = document.getElementById('musicUrlQueueCount');
        if (!this.addBtn) return;

        this.restoreState();
        this.createModal();
        this.addBtn.addEventListener('click', () => this.addCurrentUrlAndOpen());
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.isOpen()) this.close();
        });
        document.addEventListener('i18n:applied', () => {
            this.updateButton();
            this.render();
        });
        this.updateButton();
        this.resolveMissingTitles();
    }

    restoreState() {
        try {
            if (typeof localStorage === 'undefined') return;
            const raw = localStorage.getItem(this.storageKey);
            if (!raw) return;
            const saved = JSON.parse(raw);
            const rows = Array.isArray(saved?.items) ? saved.items : [];
            const allowedStatuses = new Set(['pending', 'running', 'completed', 'error', 'canceled']);

            this.items = rows
                .map((entry, index) => {
                    const url = String(entry?.url || '').trim();
                    if (!url) return null;
                    const savedStatus = allowedStatuses.has(entry?.status) ? entry.status : 'pending';
                    const status = savedStatus === 'running' ? 'pending' : savedStatus;
                    const title = String(entry?.title || '').trim();
                    return {
                        id: Number.isFinite(Number(entry?.id)) ? Number(entry.id) : index + 1,
                        url,
                        status,
                        error: savedStatus === 'running' ? null : (entry?.error ? String(entry.error) : null),
                        jobId: null,
                        title,
                        titleStatus: title ? 'resolved' : 'idle'
                    };
                })
                .filter(Boolean);

            const maxId = this.items.reduce((max, item) => Math.max(max, item.id), 0);
            this.nextId = Math.max(maxId + 1, 1);
            this.autoRemoveSuccessful = saved?.autoRemoveSuccessful === true;
            this.persistState();
        } catch (error) {
            console.warn('Music URL queue state could not be restored:', error);
        }
    }

    persistState() {
        try {
            if (typeof localStorage === 'undefined') return;
            localStorage.setItem(this.storageKey, JSON.stringify({
                version: 1,
                autoRemoveSuccessful: this.autoRemoveSuccessful,
                items: this.items.map((item) => ({
                    id: item.id,
                    url: item.url,
                    status: item.status,
                    error: item.error || null,
                    title: item.title || ''
                }))
            }));
        } catch (error) {
            console.warn('Music URL queue state could not be saved:', error);
        }
    }

    createModal() {
        if (document.getElementById('musicUrlQueueModal')) {
            this.modalEl = document.getElementById('musicUrlQueueModal');
            this.listEl = this.modalEl.querySelector('#musicUrlQueueList');
            this.modalInput = this.modalEl.querySelector('#musicUrlQueueInput');
            this.modalAddBtn = this.modalEl.querySelector('#musicUrlQueueModalAdd');
            this.modalSupportEl = this.modalEl.querySelector('#musicUrlQueueInputSupport');
            this.autoRemoveCheckbox = this.modalEl.querySelector('#musicUrlQueueAutoRemove');
            this.queueStartBtn = this.modalEl.querySelector('#musicUrlQueueStart');
            return;
        }

        const backdrop = document.createElement('div');
        backdrop.id = 'musicUrlQueueModal';
        backdrop.className = 'music-url-queue-backdrop';
        backdrop.setAttribute('aria-hidden', 'true');
        backdrop.innerHTML = `
            <section class="music-url-queue-dialog" role="dialog" aria-modal="true" aria-labelledby="musicUrlQueueTitle">
                <header class="music-url-queue-header">
                    <div>
                        <h3 id="musicUrlQueueTitle"></h3>
                        <p id="musicUrlQueueHint" class="muted"></p>
                    </div>
                    <button type="button" id="musicUrlQueueClose" class="music-url-queue-close" aria-label="Close">×</button>
                </header>
                <div class="music-url-queue-entry">
                    <div class="music-url-queue-entry-field">
                        <input
                            type="url"
                            id="musicUrlQueueInput"
                            class="form-control music-url-queue-entry-input"
                            autocomplete="off"
                            spellcheck="false"
                        />
                        <span id="musicUrlQueueInputSupport" class="music-url-queue-support is-empty" aria-live="polite"></span>
                    </div>
                    <button type="button" id="musicUrlQueueModalAdd" class="btn-secondary music-url-queue-entry-add"></button>
                </div>
                <div class="music-url-queue-summary">
                    <span id="musicUrlQueueSummary"></span>
                </div>
                <div id="musicUrlQueueList" class="music-url-queue-list"></div>
                <footer class="music-url-queue-footer">
                    <label class="music-url-queue-auto-remove" for="musicUrlQueueAutoRemove">
                        <input type="checkbox" id="musicUrlQueueAutoRemove" />
                        <span id="musicUrlQueueAutoRemoveLabel"></span>
                    </label>
                    <div class="music-url-queue-footer-actions">
                        <button type="button" id="musicUrlQueueDone" class="btn-secondary"></button>
                        <button type="button" id="musicUrlQueueStart" class="btn-primary"></button>
                    </div>
                </footer>
            </section>
        `;

        document.body.appendChild(backdrop);
        this.modalEl = backdrop;
        this.listEl = backdrop.querySelector('#musicUrlQueueList');
        this.modalInput = backdrop.querySelector('#musicUrlQueueInput');
        this.modalAddBtn = backdrop.querySelector('#musicUrlQueueModalAdd');
        this.modalSupportEl = backdrop.querySelector('#musicUrlQueueInputSupport');
        this.autoRemoveCheckbox = backdrop.querySelector('#musicUrlQueueAutoRemove');
        this.queueStartBtn = backdrop.querySelector('#musicUrlQueueStart');

        backdrop.querySelector('#musicUrlQueueClose')?.addEventListener('click', () => this.close());
        backdrop.querySelector('#musicUrlQueueDone')?.addEventListener('click', () => this.close());
        this.queueStartBtn?.addEventListener('click', () => this.startQueue());
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) this.close();
        });
        this.autoRemoveCheckbox?.addEventListener('change', (event) => {
            this.autoRemoveSuccessful = !!event.target.checked;
            this.persistState();
        });
        this.modalInput?.addEventListener('input', () => this.updateModalInputSupport());
        this.modalInput?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            this.addModalUrl();
        });
        this.modalAddBtn?.addEventListener('click', () => this.addModalUrl());
        this.listEl?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-queue-remove-id]');
            if (!button) return;
            const id = Number(button.dataset.queueRemoveId);
            this.remove(id);
        });

        this.render();
    }

    isOpen() {
        return this.modalEl?.classList.contains('is-open') || false;
    }

    open() {
        if (!this.modalEl) return;
        this.render();
        this.modalEl.classList.add('is-open');
        this.modalEl.setAttribute('aria-hidden', 'false');
        this.modalInput?.focus();
    }

    close() {
        if (!this.modalEl) return;
        this.modalEl.classList.remove('is-open');
        this.modalEl.setAttribute('aria-hidden', 'true');
        this.addBtn?.focus();
    }

    addCurrentUrlAndOpen() {
        const input = document.getElementById('urlInput');
        const url = input?.value.trim() || '';

        if (url && this.app.isSpotifyUrl(url)) {
            const added = this.add(url);
            if (added && input) {
                input.value = '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }

        this.open();
    }

    addModalUrl() {
        const url = this.modalInput?.value.trim() || '';
        if (!url) {
            this.updateModalInputSupport();
            return false;
        }

        const added = this.add(url);
        if (added && this.modalInput) {
            this.modalInput.value = '';
            this.updateModalInputSupport();
            this.modalInput.focus();
        }
        return added;
    }

    add(url) {
        const normalized = String(url || '').trim();
        if (!normalized) return false;

        if (this.items.some((item) => item.url === normalized)) {
            this.app.showNotification(
                this.app.t('musicQueue.duplicate') || 'This URL is already in the list.',
                'info',
                'default'
            );
            this.updateButton();
            return false;
        }

        const item = {
            id: this.nextId++,
            url: normalized,
            status: 'pending',
            error: null,
            jobId: null,
            title: '',
            titleStatus: 'idle'
        };
        this.items.push(item);
        this.updateAfterMutation();
        this.resolveItemTitle(item.id);
        return true;
    }

    remove(id) {
        const item = this.items.find((entry) => entry.id === id);
        if (!item || item.status === 'running') return false;
        this.items = this.items.filter((entry) => entry.id !== id);
        this.updateAfterMutation();
        return true;
    }

    hasItems() {
        return this.items.length > 0;
    }

    hasRunnableItems() {
        return this.items.some((item) => ['pending', 'error', 'canceled'].includes(item.status));
    }

    getRepresentativeUrl() {
        return this.items.find((item) => ['pending', 'error', 'canceled'].includes(item.status))?.url
            || this.items[0]?.url
            || '';
    }

    resolveMissingTitles() {
        for (const item of this.items) {
            if (!item.title && this.isSupportedUrl(item.url)) {
                this.resolveItemTitle(item.id);
            }
        }
    }

    async resolveItemTitle(id) {
        const item = this.items.find((entry) => entry.id === id);
        if (!item || item.title || !this.isSupportedUrl(item.url)) return null;
        if (item.titleStatus === 'loading') return null;

        item.titleStatus = 'loading';
        this.render();

        try {
            const response = await fetch('/api/spotify/url-title', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: item.url })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data?.ok === false) {
                throw new Error(data?.error?.message || `HTTP ${response.status}`);
            }

            const liveItem = this.items.find((entry) => entry.id === id);
            if (!liveItem) return null;
            liveItem.title = String(data?.title || '').trim();
            liveItem.titleStatus = liveItem.title ? 'resolved' : 'error';
            this.persistState();
            this.render();
            return liveItem.title || null;
        } catch {
            const liveItem = this.items.find((entry) => entry.id === id);
            if (!liveItem) return null;
            liveItem.titleStatus = 'error';
            this.persistState();
            this.render();
            return null;
        }
    }

    getProvider(url) {
        const raw = String(url || '').trim();
        const value = raw.toLowerCase();

        if (value.startsWith('spotify:')) return 'Spotify';
        if (value.startsWith('deezer:')) return 'Deezer';

        let parsed;
        try {
            parsed = new URL(raw);
        } catch {
            return this.app.t('musicQueue.unknownProvider');
        }

        if (!/^https?:$/i.test(parsed.protocol)) {
            return this.app.t('musicQueue.unknownProvider');
        }

        const host = parsed.hostname.toLowerCase();
        if (host === 'open.spotify.com') return 'Spotify';
        if (host === 'music.apple.com' || host === 'embed.music.apple.com') return 'Apple Music';
        if (host === 'tidal.com' || host === 'www.tidal.com' || host === 'listen.tidal.com') return 'TIDAL';
        if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) return 'SoundCloud';
        if (
            host === 'deezer.com'
            || host.endsWith('.deezer.com')
            || host === 'deezer.page.link'
            || host.endsWith('.deezer.page.link')
        ) {
            return 'Deezer';
        }

        return this.app.t('musicQueue.unknownProvider');
    }

    getStatusLabel(status) {
        const key = {
            pending: 'musicQueue.status.pending',
            running: 'musicQueue.status.running',
            completed: 'musicQueue.status.completed',
            error: 'musicQueue.status.error',
            canceled: 'musicQueue.status.canceled'
        }[status] || 'musicQueue.status.pending';
        return this.app.t(key);
    }

    isSupportedUrl(url) {
        const raw = String(url || '').trim();
        if (!raw) return false;

        if (/^spotify:(track|playlist|album):[A-Za-z0-9]+$/i.test(raw)) return true;
        if (/^deezer:(track|album|playlist|artist):\d+$/i.test(raw)) return true;

        let parsed;
        try {
            parsed = new URL(raw);
        } catch {
            return false;
        }

        if (!/^https?:$/i.test(parsed.protocol)) return false;
        const host = parsed.hostname.toLowerCase();
        const parts = parsed.pathname.split('/').filter(Boolean);

        if (host === 'open.spotify.com') {
            const spotifyParts = /^intl-[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[0] || '')
                ? parts.slice(1)
                : parts;
            return ['track', 'playlist', 'album'].includes(String(spotifyParts[0] || '').toLowerCase())
                && /^[A-Za-z0-9]+$/.test(String(spotifyParts[1] || ''));
        }

        if (host === 'music.apple.com' || host === 'embed.music.apple.com') {
            const type = String(parts[1] || '').toLowerCase();
            const lastPart = String(parts[parts.length - 1] || '');
            const queryTrackId = String(parsed.searchParams.get('i') || '');
            if (type === 'song' || /^\d+$/.test(queryTrackId)) {
                return /^\d+$/.test(queryTrackId) || /^\d+$/.test(lastPart);
            }
            if (type === 'album') return /^\d+$/.test(lastPart);
            if (type === 'playlist') return !!lastPart;
            return false;
        }

        if (host === 'tidal.com' || host === 'www.tidal.com' || host === 'listen.tidal.com') {
            const type = String(parts[0] || '').toLowerCase();
            if (type === 'playlist') return /^[0-9a-f-]{16,64}$/i.test(String(parts[1] || ''));
            if (type === 'album') {
                if (!/^\d+$/.test(String(parts[1] || ''))) return false;
                if (String(parts[2] || '').toLowerCase() === 'track') return /^\d+$/.test(String(parts[3] || ''));
                return parts.length >= 2;
            }
            return false;
        }

        if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) {
            const first = String(parts[0] || '').toLowerCase();
            const second = String(parts[1] || '').toLowerCase();
            if (!first) return false;
            if (first === 'discover') return second === 'sets' && !!parts[2];
            if (first === 'buzzing-playlists') return second === 'sets' && !!parts[2];
            if (first === 'stations') return second === 'track' && !!parts[2];
            if (['discover', 'charts', 'buzzing-playlists', 'stations'].includes(first)) return false;
            if (second === 'sets') return !!parts[2] || parts.length === 2;
            if (['tracks', 'likes', 'reposts', 'sets', 'albums', 'popular-tracks', 'spotlight'].includes(second)) return true;
            return parts.length >= 1;
        }

        if (host === 'link.deezer.com' || host === 'deezer.page.link' || host.endsWith('.deezer.page.link')) {
            return true;
        }

        if (host === 'deezer.com' || host.endsWith('.deezer.com')) {
            const first = String(parts[0] || '').toLowerCase();
            const second = String(parts[1] || '').toLowerCase();
            const localePattern = /^[a-z]{2}(?:-[a-z]{2})?$/i;
            const offset = localePattern.test(first) ? 1 : 0;
            const type = String(parts[offset] || '').toLowerCase();

            if (type === 'search') {
                return !!parts[offset + 1]
                    && String(parts[offset + 2] || '').toLowerCase() === 'track'
                    && parts.length === offset + 3;
            }
            if (type === 'smarttracklist') {
                return /^inspired-by-\d+$/i.test(String(parts[offset + 1] || ''))
                    && parts.length === offset + 2;
            }
            return ['track', 'album', 'playlist', 'artist'].includes(type)
                && /^\d+$/.test(String(parts[offset + 1] || ''));
        }

        return false;
    }

    getSupportLabel(supported) {
        return this.app.t(supported ? 'musicQueue.supported' : 'musicQueue.unsupported');
    }

    renderSupportIndicator(supported, { compact = false } = {}) {
        const label = this.getSupportLabel(supported);
        const className = supported ? 'is-supported' : 'is-unsupported';
        const icon = supported ? '✓' : '×';
        return `<span class="music-url-queue-support ${className}${compact ? ' is-compact' : ''}" title="${this.app.escapeHtml(label)}" aria-label="${this.app.escapeHtml(label)}"><span aria-hidden="true">${icon}</span>${compact ? '' : `<span>${this.app.escapeHtml(label)}</span>`}</span>`;
    }

    updateModalInputSupport() {
        if (!this.modalSupportEl) return;
        const value = this.modalInput?.value.trim() || '';
        if (!value) {
            this.modalSupportEl.className = 'music-url-queue-support is-empty';
            this.modalSupportEl.textContent = '';
            this.modalSupportEl.removeAttribute('title');
            this.modalSupportEl.removeAttribute('aria-label');
            if (this.modalAddBtn) this.modalAddBtn.disabled = true;
            return;
        }

        const supported = this.isSupportedUrl(value);
        const label = this.getSupportLabel(supported);
        this.modalSupportEl.className = `music-url-queue-support ${supported ? 'is-supported' : 'is-unsupported'} is-compact`;
        this.modalSupportEl.innerHTML = `<span aria-hidden="true">${supported ? '✓' : '×'}</span>`;
        this.modalSupportEl.title = label;
        this.modalSupportEl.setAttribute('aria-label', label);
        if (this.modalAddBtn) this.modalAddBtn.disabled = false;
    }

    updateButton() {
        if (!this.addBtn) return;
        const input = document.getElementById('urlInput');
        const value = input?.value.trim() || '';
        const canAddCurrent = !!value && this.app.isSpotifyUrl(value);
        const shouldShow = !this.app.isRetagMode?.() && (canAddCurrent || this.items.length > 0);

        this.addBtn.style.display = shouldShow ? 'inline-flex' : 'none';
        this.addBtn.disabled = this.running && !this.items.length;
        this.addBtn.title = this.app.t('musicQueue.addButtonTitle');
        this.addBtn.setAttribute('aria-label', this.app.t('musicQueue.addButtonTitle'));
        if (this.countEl) {
            this.countEl.textContent = String(this.items.length);
            this.countEl.style.display = this.items.length ? 'inline-flex' : 'none';
        }

        const startButton = document.getElementById('startIntegratedBtn');
        if (startButton && !this.running) {
            // The main Match & Download button is direct-input only. Queue state must
            // never make it runnable or cause it to consume saved queue entries.
            startButton.disabled = !(!!value && this.app.isSpotifyUrl(value));
        }
    }

    render() {
        if (!this.modalEl || !this.listEl) return;
        const title = this.modalEl.querySelector('#musicUrlQueueTitle');
        const hint = this.modalEl.querySelector('#musicUrlQueueHint');
        const summary = this.modalEl.querySelector('#musicUrlQueueSummary');
        const autoLabel = this.modalEl.querySelector('#musicUrlQueueAutoRemoveLabel');
        const done = this.modalEl.querySelector('#musicUrlQueueDone');
        const queueStart = this.modalEl.querySelector('#musicUrlQueueStart');
        const close = this.modalEl.querySelector('#musicUrlQueueClose');

        if (title) title.textContent = this.app.t('musicQueue.title');
        if (hint) hint.textContent = this.app.t('musicQueue.hint');
        if (summary) summary.textContent = this.app.t('musicQueue.summary', { count: this.items.length });
        if (autoLabel) autoLabel.textContent = this.app.t('musicQueue.autoRemove');
        if (done) done.textContent = this.app.t('musicQueue.done');
        if (queueStart) {
            queueStart.textContent = this.app.t('btn.spotifyIntegrated');
            queueStart.disabled = this.running || !this.hasRunnableItems();
        }
        if (close) close.setAttribute('aria-label', this.app.t('musicQueue.close'));
        if (this.modalInput) this.modalInput.placeholder = this.app.t('musicQueue.urlPlaceholder');
        if (this.modalAddBtn) this.modalAddBtn.textContent = this.app.t('musicQueue.addUrl');
        if (this.autoRemoveCheckbox) this.autoRemoveCheckbox.checked = this.autoRemoveSuccessful;
        this.updateModalInputSupport();

        if (!this.items.length) {
            this.listEl.innerHTML = `<div class="music-url-queue-empty">${this.app.escapeHtml(this.app.t('musicQueue.empty'))}</div>`;
            return;
        }

        this.listEl.innerHTML = this.items.map((item, index) => {
            const removable = item.status !== 'running';
            const supported = this.isSupportedUrl(item.url);
            const errorHtml = item.error
                ? `<div class="music-url-queue-error">${this.app.escapeHtml(item.error)}</div>`
                : '';
            return `
                <article class="music-url-queue-item is-${this.app.escapeHtml(item.status)}${supported ? '' : ' is-unsupported-url'}">
                    <div class="music-url-queue-index">${index + 1}</div>
                    <div class="music-url-queue-main">
                        <div class="music-url-queue-meta">
                            <strong>${this.app.escapeHtml(this.getProvider(item.url))}</strong>
                            ${this.renderSupportIndicator(supported, { compact: true })}
                            <span class="music-url-queue-status is-${this.app.escapeHtml(item.status)}">${this.app.escapeHtml(this.getStatusLabel(item.status))}</span>
                        </div>
                        ${item.title
                            ? `<div class="music-url-queue-resolved-title" title="${this.app.escapeHtml(item.title)}">${this.app.escapeHtml(item.title)}</div>`
                            : item.titleStatus === 'loading'
                                ? `<div class="music-url-queue-resolved-title is-loading">${this.app.escapeHtml(this.app.t('musicQueue.titleLoading'))}</div>`
                                : item.titleStatus === 'error'
                                    ? `<div class="music-url-queue-resolved-title is-unavailable">${this.app.escapeHtml(this.app.t('musicQueue.titleUnavailable'))}</div>`
                                    : ''}
                        <div class="music-url-queue-url" title="${this.app.escapeHtml(item.url)}">${this.app.escapeHtml(item.url)}</div>
                        ${errorHtml}
                    </div>
                    <button
                        type="button"
                        class="music-url-queue-remove"
                        data-queue-remove-id="${item.id}"
                        ${removable ? '' : 'disabled'}
                        aria-label="${this.app.escapeHtml(this.app.t('musicQueue.remove'))}"
                        title="${this.app.escapeHtml(this.app.t('musicQueue.remove'))}"
                    >×</button>
                </article>
            `;
        }).join('');
    }

    updateAfterMutation() {
        this.persistState();
        this.updateButton();
        this.render();
        const input = document.getElementById('urlInput');
        this.app.onUrlInputChange?.(input?.value || '');
    }

    async startQueue() {
        if (this.running || !this.hasRunnableItems()) return null;
        if (!this.app.spotifyManager?.startIntegratedSpotifyProcess) return null;

        return this.processQueue((item) => this.app.spotifyManager.startIntegratedSpotifyProcess({
            url: item.url,
            queueManaged: true,
            awaitCompletion: true
        }));
    }

    async processQueue(processItem) {
        if (this.running || !this.hasRunnableItems()) return null;
        this.running = true;

        const queueStartButton = this.queueStartBtn || this.modalEl?.querySelector?.('#musicUrlQueueStart') || null;
        const directStartButton = document.getElementById('startIntegratedBtn');
        queueStartButton?.classList.add('btn-loading');
        if (queueStartButton) queueStartButton.disabled = true;
        // SpotifyManager has a single live integrated-job UI/SSE state, so prevent a
        // direct job from being started while a queue item is active.
        if (directStartButton) directStartButton.disabled = true;

        const runIds = this.items
            .filter((item) => ['pending', 'error', 'canceled'].includes(item.status))
            .map((item) => item.id);

        let completed = 0;
        let failed = 0;

        try {
            for (const id of runIds) {
                const item = this.items.find((entry) => entry.id === id);
                if (!item) continue;

                if (!this.isSupportedUrl(item.url)) {
                    failed += 1;
                    item.status = 'error';
                    item.error = this.app.t('musicQueue.unsupportedError');
                    item.jobId = null;
                    this.updateAfterMutation();
                    continue;
                }

                item.status = 'running';
                item.error = null;
                item.jobId = null;
                this.updateAfterMutation();

                let result;
                try {
                    result = await processItem(item);
                } catch (error) {
                    result = { status: 'error', error: error?.message || String(error) };
                }

                const liveItem = this.items.find((entry) => entry.id === id);
                if (!liveItem) continue;

                liveItem.jobId = result?.jobId || liveItem.jobId;
                if (result?.status === 'completed') {
                    completed += 1;
                    if (this.autoRemoveSuccessful) {
                        this.items = this.items.filter((entry) => entry.id !== id);
                    } else {
                        liveItem.status = 'completed';
                    }
                } else {
                    failed += 1;
                    liveItem.status = result?.status === 'canceled' ? 'canceled' : 'error';
                    liveItem.error = result?.error
                        || result?.job?.error
                        || this.app.t('musicQueue.unknownError');
                }

                this.updateAfterMutation();
            }

            this.app.showNotification(
                failed > 0
                    ? this.app.t('musicQueue.finishedWithErrors', { completed, failed })
                    : this.app.t('musicQueue.finished', { completed }),
                failed > 0 ? 'warning' : 'success',
                failed > 0 ? 'default' : 'queue'
            );

            return { completed, failed };
        } finally {
            this.running = false;
            queueStartButton?.classList.remove('btn-loading');
            this.updateAfterMutation();
        }
    }
}
