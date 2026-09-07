import { collectJobOutputPaths, outputExistenceClient } from './OutputExistenceClient.js';

export class JobsPanelManager {
    // Initializes class state and defaults for the browser UI layer.
    constructor() {
        this.tokenKey = "gharmonize_admin_token";
        this.panel = null;
        this.overlay = null;
        this.list = null;
        this.state = {
            items: [],
            hasUpdate: false,
            latestVersion: null,
            releaseUrl: null
        };
        this.filter = 'active';
        this.eventSource = null;
        this.isStarted = false;
        this.pollingInterval = null;
        this.tokenCheckInterval = null;
        this.accessRequestsInterval = null;
        this.accessRequestsInFlight = false;
        this.accessRequests = [];
        this.activeAccessGrants = [];
        this.temporaryAccessDuration = {};
        this.progressCache = new Map();
        this.completedAtCache = new Map();
        this.storageKey = 'gharmonize_jobs_panel_state';
    }

    // Initializes startup state for the browser UI layer.
    initialize() {
        if (this.isStarted) return;

        this.panel = document.getElementById('jobsPanel');
        this.overlay = document.getElementById('jobsOverlay');
        this.list = document.getElementById('jobsList');
        this.setupEventListeners();
        this.isStarted = true;
        this.startTokenCheck();
        this.restoreState().catch(e => {
            console.warn('[JobsPanel] restoreState error:', e);
        });

        try {
            const latestVersion = localStorage.getItem('gharmonize_latest_version');
            const storedReleaseUrl = localStorage.getItem('gharmonize_latest_release_url');
            const currentVersion =
                window.versionManager?.currentVersion ||
                (() => {
                    try {
                        return localStorage.getItem('gharmonize_current_version');
                    } catch {
                        return null;
                    }
                })() ||
                null;

            if (latestVersion && currentVersion) {
                let isNewer = false;

                if (window.versionManager && typeof window.versionManager.isNewerVersion === 'function') {
                    isNewer = window.versionManager.isNewerVersion(latestVersion, currentVersion);
                } else {
                    isNewer = this.isNewerVersionFallback(latestVersion, currentVersion);
                }

                if (isNewer) {
                    this.state.hasUpdate = true;
                    this.state.latestVersion = latestVersion;
                    this.state.releaseUrl =
                    storedReleaseUrl ||
                    (window.versionManager?.githubRepo
                    ? `https://github.com/${window.versionManager.githubRepo}/releases/tag/v${latestVersion}`
                  : null);
                }
            }
        } catch (e) {
            console.warn('[JobsPanel] update banner init error:', e);
        }

        if (this.state.hasUpdate) {
            this.render();
        }

        if (localStorage.getItem(this.tokenKey)) {
            this.goOnline();
        } else {
            this.goOffline();
        }
    }

    // Handles start access token check in the browser UI layer.
    startTokenCheck() {
        this.tokenCheckInterval = setInterval(() => {
            this.checkTokenValidity();
        }, 100000);
    }

    // Handles check access token validity in the browser UI layer.
    async checkTokenValidity() {
        const token = localStorage.getItem(this.tokenKey);
        if (!token) {
            this.handleTokenExpired();
            return;
        }

        try {
            const response = await fetch('/api/auth/verify', {
                headers: { 'Authorization': 'Bearer ' + token }
            });

            if (!response.ok) {
                this.handleTokenExpired();
            }
        } catch (error) {
            console.error('Token check error:', error);
            this.handleTokenExpired();
        }
    }

    // Handles handle access token expired in the browser UI layer.
    handleTokenExpired() {
        console.log('Token expired or invalid, going offline');
        localStorage.removeItem(this.tokenKey);
        this.goOffline();
        window.dispatchEvent(new CustomEvent('gharmonize:auth', {
            detail: { loggedIn: false }
        }));
    }

    // Updates event listeners used for the browser UI layer.
    setupEventListeners() {
        document.getElementById('jobsBell')?.addEventListener('click', () => this.open());
        this.overlay?.addEventListener('click', () => this.close());
        document.getElementById('jobsClose')?.addEventListener('click', () => this.close());
        document.getElementById('jobsFilterActive')?.addEventListener('click', () => this.setFilter('active'));
        document.getElementById('jobsFilterAll')?.addEventListener('click', () => this.setFilter('all'));
        document.getElementById('jobsFilterAccess')?.addEventListener('click', () => this.setFilter('access'));

        window.addEventListener('gharmonize:auth', (ev) => {
            if (ev?.detail?.loggedIn) this.goOnline();
            else this.goOffline();
        });

        window.addEventListener('storage', (ev) => {
            if (ev.key !== this.tokenKey) return;
            if (ev.newValue) this.goOnline();
            else this.goOffline();
        });
    }

    // Opens open in the browser UI layer.
    open() {
        const panel = this.panel;
        if (!panel) return;
        panel.setAttribute('aria-hidden', 'false');
        panel.removeAttribute('inert');
        this.overlay && (this.overlay.hidden = false);
        document.body.style.overflow = 'hidden';
        requestAnimationFrame(() => {
            const closeBtn = document.getElementById('jobsClose');
            closeBtn?.focus();
        });
    }

    // Closes close in the browser UI layer.
    close() {
        const panel = this.panel;
        if (!panel) return;
        panel.setAttribute('aria-hidden', 'true');
        panel.setAttribute('inert', '');
        this.overlay && (this.overlay.hidden = true);
        document.body.style.overflow = '';
        const jobsBell = document.getElementById('jobsBell');
        if (jobsBell && !jobsBell.hidden) {
            jobsBell.focus();
        }
    }

    // Updates filter used for the browser UI layer.
    setFilter(newFilter) {
        this.filter = newFilter;
        document.getElementById('jobsFilterActive')?.classList.toggle('chip--active', newFilter === 'active');
        document.getElementById('jobsFilterAll')?.classList.toggle('chip--active', newFilter === 'all');
        document.getElementById('jobsFilterAccess')?.classList.toggle('chip--active', newFilter === 'access');
        this.render();
    }

    // Handles go online in the browser UI layer.
    goOnline() {
        document.getElementById('jobsBell').hidden = false;
        this.startSSE();
        this.startAccessRequestsPolling();
    }

    // Handles go offline in the browser UI layer.
    goOffline() {
    const jobsBell = document.getElementById('jobsBell');
    if (jobsBell) {
        jobsBell.hidden = true;
    }

    this.close();
    this.eventSource?.close();
    this.eventSource = null;

    if (this.pollingInterval) {
        clearInterval(this.pollingInterval);
        this.pollingInterval = null;
        }
    if (this.accessRequestsInterval) {
        clearInterval(this.accessRequestsInterval);
        this.accessRequestsInterval = null;
    }
    this.accessRequests = [];
    this.activeAccessGrants = [];
    this.temporaryAccessDuration = {};
    }

    // Handles destroy in the browser UI layer.
    destroy() {
        if (this.tokenCheckInterval) {
            clearInterval(this.tokenCheckInterval);
            this.tokenCheckInterval = null;
        }
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        if (this.accessRequestsInterval) {
            clearInterval(this.accessRequestsInterval);
            this.accessRequestsInterval = null;
        }
        this.eventSource?.close();
        this.isStarted = false;
    }

    startAccessRequestsPolling() {
        if (this.accessRequestsInterval) return;
        this.refreshAccessRequests().catch(() => {});
        this.accessRequestsInterval = setInterval(() => {
            this.refreshAccessRequests().catch(() => {});
        }, 2500);
    }

    async refreshAccessRequests() {
        if (this.accessRequestsInFlight || !localStorage.getItem(this.tokenKey)) return;
        this.accessRequestsInFlight = true;
        try {
            const response = await fetch('/api/access/requests', { cache: 'no-store' });
            if (response.status === 401) {
                this.handleTokenExpired();
                return;
            }
            if (!response.ok) throw new Error(`Access requests HTTP ${response.status}`);
            const body = await response.json();
            this.accessRequests = Array.isArray(body?.requests) ? body.requests : [];
            this.activeAccessGrants = Array.isArray(body?.active) ? body.active : [];
            this.temporaryAccessDuration = body?.temporaryDuration || {};
            this.updateJobsBell();
            if (this.filter === 'access') this.render();
        } finally {
            this.accessRequestsInFlight = false;
        }
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    formatAccessDuration(duration = {}) {
        const parts = [];
        const values = [
            [duration.years, this.t('access.unitYear')],
            [duration.months, this.t('access.unitMonth')],
            [duration.days, this.t('access.unitDay')],
            [duration.hours, this.t('access.unitHour')]
        ];
        for (const [value, label] of values) {
            if (Number(value) > 0) parts.push(`${Number(value)} ${label}`);
        }
        return parts.join(' ') || `1 ${this.t('access.unitHour')}`;
    }

    async decideAccessRequest(id, decision, buttons = []) {
        buttons.forEach((button) => { button.disabled = true; });
        try {
            const response = await fetch(`/api/access/requests/${encodeURIComponent(id)}/decision`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decision })
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
            window.app?.showNotification?.(
                decision === 'approve'
                    ? this.t('access.approvedToast')
                    : this.t('access.rejectedToast'),
                decision === 'approve' ? 'success' : 'info'
            );
            await this.refreshAccessRequests();
        } catch (error) {
            console.warn('[JobsPanel] access decision failed:', error);
            window.app?.showNotification?.(
                error?.message || this.t('access.requestFailed'),
                'error'
            );
            buttons.forEach((button) => { button.disabled = false; });
        }
    }

    async revokeAccessGrant(id, buttons = []) {
        buttons.forEach((button) => { button.disabled = true; });
        try {
            const response = await fetch(`/api/access/grants/${encodeURIComponent(id)}/revoke`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
            window.app?.showNotification?.(this.t('access.revokedToast'), 'info');
            await this.refreshAccessRequests();
        } catch (error) {
            console.warn('[JobsPanel] access revoke failed:', error);
            window.app?.showNotification?.(error?.message || this.t('access.revokeFailed'), 'error');
            buttons.forEach((button) => { button.disabled = false; });
        }
    }

    renderAccessRequests(prevScrollTop = 0) {
        if (!this.list) return;
        const requests = Array.isArray(this.accessRequests) ? this.accessRequests : [];
        const active = Array.isArray(this.activeAccessGrants) ? this.activeAccessGrants : [];
        const duration = this.escapeHtml(this.formatAccessDuration(this.temporaryAccessDuration));

        if (!requests.length && !active.length) {
            this.list.innerHTML = `
                <div class="jobs-panel__empty jobs-access-empty">
                    <div class="jobs-panel__empty-icon">🔐</div>
                    <div class="jobs-panel__empty-title">${this.escapeHtml(this.t('access.requestsEmpty'))}</div>
                    <div class="jobs-panel__empty-subtitle">${this.escapeHtml(this.t('access.requestsEmptyHint'))}</div>
                </div>
            `;
            this.list.scrollTop = prevScrollTop;
            return;
        }

        const pendingHtml = requests.length ? `
            <section class="jobs-access-section">
                <div class="jobs-access-section__title">
                    <span>${this.escapeHtml(this.t('access.pendingRequestsTitle'))}</span>
                    <span class="jobs-access-section__count">${requests.length}</span>
                </div>
                <div class="jobs-access-list">
                    ${requests.map((request) => {
                        const requestedAt = new Date(Number(request.createdAt || 0)).toLocaleString();
                        const ip = this.escapeHtml(request.ip || '-');
                        const ua = this.escapeHtml(request.userAgent || '-');
                        const id = this.escapeHtml(request.id || '');
                        return `
                            <article class="jobs-access-card" data-access-request-id="${id}">
                                <div class="jobs-access-card__header">
                                    <div>
                                        <div class="jobs-access-card__title">🔐 ${this.escapeHtml(this.t('access.adminRequestTitle'))}</div>
                                        <div class="jobs-access-card__time">${this.escapeHtml(requestedAt)}</div>
                                    </div>
                                    <span class="chip chip--active">${this.escapeHtml(this.t('access.pending'))}</span>
                                </div>
                                <dl class="jobs-access-card__details">
                                    <div><dt>${this.escapeHtml(this.t('access.ipLabel'))}</dt><dd>${ip}</dd></div>
                                    <div><dt>${this.escapeHtml(this.t('access.durationLabel'))}</dt><dd>${duration}</dd></div>
                                    <div class="jobs-access-card__client"><dt>${this.escapeHtml(this.t('access.browserLabel'))}</dt><dd>${ua}</dd></div>
                                </dl>
                                <div class="jobs-access-card__actions">
                                    <button class="btn-secondary jobs-access-reject" type="button" data-access-decision="reject" data-access-id="${id}">
                                        ${this.escapeHtml(this.t('access.reject'))}
                                    </button>
                                    <button class="btn-primary jobs-access-approve" type="button" data-access-decision="approve" data-access-id="${id}">
                                        ${this.escapeHtml(this.t('access.approve'))}
                                    </button>
                                </div>
                            </article>
                        `;
                    }).join('')}
                </div>
            </section>
        ` : '';

        const activeHtml = active.length ? `
            <section class="jobs-access-section">
                <div class="jobs-access-section__title">
                    <span>${this.escapeHtml(this.t('access.activeGrantsTitle'))}</span>
                    <span class="jobs-access-section__count">${active.length}</span>
                </div>
                <div class="jobs-access-list">
                    ${active.map((grant) => {
                        const approvedAt = new Date(Number(grant.approvedAt || grant.createdAt || 0)).toLocaleString();
                        const expiresAt = new Date(Number(grant.expiresAt || 0)).toLocaleString();
                        const ip = this.escapeHtml(grant.ip || '-');
                        const ua = this.escapeHtml(grant.userAgent || '-');
                        const id = this.escapeHtml(grant.id || '');
                        return `
                            <article class="jobs-access-card jobs-access-card--approved" data-access-grant-id="${id}">
                                <div class="jobs-access-card__header">
                                    <div>
                                        <div class="jobs-access-card__title">✅ ${this.escapeHtml(this.t('access.activeGrantTitle'))}</div>
                                        <div class="jobs-access-card__time">${this.escapeHtml(approvedAt)}</div>
                                    </div>
                                    <span class="chip chip--active">${this.escapeHtml(this.t('access.active'))}</span>
                                </div>
                                <dl class="jobs-access-card__details">
                                    <div><dt>${this.escapeHtml(this.t('access.ipLabel'))}</dt><dd>${ip}</dd></div>
                                    <div><dt>${this.escapeHtml(this.t('access.expiresLabel'))}</dt><dd>${this.escapeHtml(expiresAt)}</dd></div>
                                    <div class="jobs-access-card__client"><dt>${this.escapeHtml(this.t('access.browserLabel'))}</dt><dd>${ua}</dd></div>
                                </dl>
                                <div class="jobs-access-card__actions">
                                    <button class="btn-secondary jobs-access-revoke" type="button" data-access-revoke-id="${id}">
                                        ${this.escapeHtml(this.t('access.revoke'))}
                                    </button>
                                </div>
                            </article>
                        `;
                    }).join('')}
                </div>
            </section>
        ` : '';

        this.list.innerHTML = pendingHtml + activeHtml;

        this.list.querySelectorAll('[data-access-decision]').forEach((button) => {
            button.addEventListener('click', () => {
                const id = button.getAttribute('data-access-id') || '';
                const decision = button.getAttribute('data-access-decision') || '';
                if (!id || !['approve', 'reject'].includes(decision)) return;
                const card = button.closest('[data-access-request-id]');
                const buttons = [...(card?.querySelectorAll('[data-access-decision]') || [])];
                this.decideAccessRequest(id, decision, buttons).catch(() => {});
            });
        });

        this.list.querySelectorAll('[data-access-revoke-id]').forEach((button) => {
            button.addEventListener('click', () => {
                const id = button.getAttribute('data-access-revoke-id') || '';
                if (!id) return;
                const card = button.closest('[data-access-grant-id]');
                const buttons = [...(card?.querySelectorAll('[data-access-revoke-id]') || [])];
                this.revokeAccessGrant(id, buttons).catch(() => {});
            });
        });

        this.list.scrollTop = prevScrollTop;
    }

    // Handles start sse in the browser UI layer.
    startSSE() {
    try {
            const token = localStorage.getItem(this.tokenKey) || "";
            this.eventSource = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);

            this.eventSource.onmessage = async (ev) => {
    try {
        const incoming = JSON.parse(ev.data) || { items: [] };
        const { hasUpdate, latestVersion, releaseUrl } = this.state;
        const serverItems = Array.isArray(incoming.items) ? incoming.items : [];
        const cleanedItems = await this.cleanupServerItems(serverItems);
        const existingAfterReconcile = await this.reconcileLostJobs(
            this.state.items || [],
            cleanedItems
        );
        const mergedItems = this.mergeItems(existingAfterReconcile, cleanedItems);
        const limitedItems = this.limitCompleted(mergedItems, 15);

        this.state = {
            items: limitedItems,
            hasUpdate,
            latestVersion,
            releaseUrl
        };

        this.saveState();
        this.render();
            } catch (e) {
                console.error('SSE parse error:', e);
            }
        };

            this.eventSource.onerror = () => {
                this.eventSource?.close();
                this.startPolling();
            };
        } catch (e) {
            console.error('SSE connection error:', e);
            this.startPolling();
        }
    }

    // Handles start polling in the browser UI layer.
    startPolling() {
        // Handles poll in the browser UI layer.
        const poll = () => {
            const token = localStorage.getItem(this.tokenKey) || "";
            if (!token) {
                if (this.pollingInterval) {
                    clearInterval(this.pollingInterval);
                    this.pollingInterval = null;
                }
                return;
            }

            fetch(`/api/jobs?status=all`, {
                headers: { 'Authorization': 'Bearer ' + token }
            })
            .then(r => {
                if (r.status === 401) {
                    if (this.pollingInterval) {
                        clearInterval(this.pollingInterval);
                        this.pollingInterval = null;
                    }
                    return;
                }
                if (!r.ok) throw new Error('Failed to fetch jobs');
                return r.json();
            })
            .then(async d => {
            if (d) {
            const { hasUpdate, latestVersion, releaseUrl } = this.state;
            const serverItems = Array.isArray(d.items) ? d.items : [];
            const cleanedItems = await this.cleanupServerItems(serverItems);

            const existingAfterReconcile = await this.reconcileLostJobs(
                this.state.items || [],
                cleanedItems
            );

            const mergedItems = this.mergeItems(existingAfterReconcile, cleanedItems);
            const limitedItems = this.limitCompleted(mergedItems, 15);

            this.state = {
                items: limitedItems,
                hasUpdate,
                latestVersion,
                releaseUrl
            };

            this.saveState();
            this.render();
                }
            })
            .catch(e => {
                console.error('Polling error:', e);
            });
        };

    poll();
        this.pollingInterval = setInterval(poll, 1500);
    }

    // Handles norm in the browser UI layer.
    norm(s) {
        const v = String(s || '').toLowerCase();
        return v === 'cancelled' ? 'canceled' : v;
    }

    // Checks whether output exists without triggering /download 404 noise.
    async checkOutputExistsPanel(rawUrl) {
        const url = String(rawUrl || '').trim();
        if (!url) return false;
        return outputExistenceClient.check(url);
    }

    // Checks whether newer version metadata fallback is valid for the browser UI layer.
    isNewerVersionFallback(latest, current) {
        if (!latest) return false;

        const latestParts  = String(latest).split('.').map(Number);
        const currentParts = String(current).split('.').map(Number);

        for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
            const lp = latestParts[i] || 0;
            const cp = currentParts[i] || 0;
            if (lp > cp) return true;
            if (lp < cp) return false;
        }
        return false;
    }

    // Handles title of in the browser UI layer.
    titleOf(j) {
        const m = j.metadata || {};
        const ex = m.extracted || {};
        return m.frozenTitle || m.spotifyTitle || ex.title || m.originalName ||
               (m.isAutomix ? this.t('jobsPanel.automix') : (m.isPlaylist ? this.t('jobsPanel.playlist') : this.t('jobsPanel.job')));
    }

    // Returns hwaccel icon used for the browser UI layer.
    getHwaccelIcon(hwaccel) {
        const icons = {
            nvenc: '🔵',
            qsv: '🔶',
            vaapi: '🟣',
            off: '⚪'
        };
        return icons[hwaccel] || '⚪';
    }

    // Returns channels text used for the browser UI layer.
    getChannelsText(channels) {
        const texts = {
            stereo: this.t('option.forceStereo') || '2.0',
            mono: this.t('option.forceMono') || '1.0',
            original: this.t('option.auto') || 'Orig'
        };
        return texts[channels] || channels;
    }

    // Formats fps text used for the browser UI layer.
    formatFpsValue(fps) {
        const n = Number(fps);
        return Number.isFinite(n) && n > 0
            ? n.toFixed(3).replace(/\.00$/, '').replace(/(\.\d*[1-9])0+$/, '$1').replace(/\.$/, '')
            : '';
    }

    // Returns selected or source fps for the browser UI layer.
    getDisplayedVideoFps(job) {
        const selectedFps = String(job?.videoSettings?.fps || '').trim();
        if (selectedFps && selectedFps !== 'source') {
            return this.formatFpsValue(selectedFps);
        }
        return this.formatFpsValue(job?.metadata?.selectedStreams?.sourceVideoFps);
    }

    // Handles source pill in the browser UI layer.
    sourcePill(j) {
        const s = j.metadata?.source || 'file';
        const mediaPlatform = String(j.metadata?.mediaPlatform || '').toLowerCase();
        const sourceKey = mediaPlatform || s;
        const sources = {
           youtube: `▶️ ${this.t('jobsPanel.sourceYouTube')}`,
            dailymotion: `🎬 ${this.t('jobsPanel.sourceDailymotion')}`,
            spotify: `🎵 ${this.t('jobsPanel.sourceSpotify')}`,
            apple_music: `🎵 ${this.t('jobsPanel.sourceAppleMusic')}`,
            deezer: `🎵 ${this.t('jobsPanel.sourceDeezer')}`,
            tidal: `🎵 ${this.t('jobsPanel.sourceTidal')}`,
            soundcloud: `🎵 ${this.t('jobsPanel.sourceSoundCloud')}`,
            direct_url: `🌐 ${this.t('jobsPanel.sourceURL')}`,
            file: `💾 ${this.t('jobsPanel.sourceFile')}`,
            local: `💻 ${this.t('jobsPanel.sourceLocal')}`
        };
        return sources[sourceKey] || sources[s] || sourceKey;
    }

    // Handles phase pill in the browser UI layer.
    phasePill(j) {
        const p = this.norm(j.currentPhase || j.status);
        const map = {
            preparing: this.t('phase.preparing'),
            downloading: this.t('phase.downloading'),
            converting: this.t('phase.converting'),
            completed: this.t('phase.completed'),
            error: this.t('phase.error'),
            canceled: this.t('status.canceled'),
            cancelled: this.t('status.canceled')
        };
        return map[p] || (j.currentPhase || j.status);
    }

    // Handles status dot in the browser UI layer.
    statusDot(j) {
        const s = this.norm(j.status);
        if (s === 'error') return '<span class="dot status-err">●</span>';
        if (s === 'completed') return '<span class="dot status-ok">●</span>';
        if (s === 'canceled') return '<span class="dot status-warn">●</span>';
        return '<span class="dot status-warn">●</span>';
    }

    // Handles raw prog in the browser UI layer.
    rawProg(j) {
        const source = j.metadata?.source || 'file';
        const isLocalSource = source === 'local' || source === 'file';
        if (isLocalSource) {
            const convertProgress = Number(j.convertProgress) || 0;
            if (convertProgress > 0) return convertProgress;
            if (this.norm(j.status) === 'completed') return 100;
            return 0;
        }

        const isMultiAudio =
            !j.metadata?.isPlaylist &&
            j.metadata?.selectedStreams &&
            Array.isArray(j.metadata.selectedStreams.audio) &&
            j.metadata.selectedStreams.audio.length > 1;

        const isVideoTranscode = j.format?.toLowerCase() === 'mp4' ||
                            j.format?.toLowerCase() === 'mkv' ||
                            j.format?.toLowerCase() === 'webm' ||
                            (j.videoSettings && j.videoSettings.transcodeEnabled);

        if (j.metadata?.isPlaylist) {
            const status = this.norm(j.status);
            if (status === 'completed') return 100;

            const counters = j.counters || {};
            const playlistTotal = Math.max(
                0,
                Number(j.playlist?.total || 0),
                Number(counters.dlTotal || 0),
                Number(counters.cvTotal || 0),
                Array.isArray(j.metadata?.frozenEntries) ? j.metadata.frozenEntries.filter(Boolean).length : 0
            );

            if (playlistTotal > 0) {
                const dlTotal = Number(counters.dlTotal) > 0 ? Number(counters.dlTotal) : playlistTotal;
                const cvTotal = Number(counters.cvTotal) > 0 ? Number(counters.cvTotal) : playlistTotal;
                const dlDone = Math.max(0, Math.min(dlTotal, Number(counters.dlDone || j.playlist?.downloaded || 0)));
                const cvDone = Math.max(0, Math.min(cvTotal, Number(counters.cvDone || j.playlist?.converted || j.playlist?.done || 0)));
                const dlPct = (dlDone / dlTotal) * 100;
                const cvPct = (cvDone / cvTotal) * 100;
                return Math.floor((dlPct + cvPct) / 2);
            }
        }

        if (typeof j.progress === 'number' && Number.isFinite(j.progress)) {
            return j.progress;
        }

        if (isMultiAudio) {
            const total = Number(j.counters?.cvTotal || j.counters?.dlTotal || 0);
            const done  = Number(j.counters?.cvDone || j.counters?.dlDone || 0);

            if (total > 0) {
                const ratio = Math.max(0, Math.min(1, done / total));
                const pct = Math.floor(ratio * 100);
                if (pct > 0) return pct;
            }
        }

        const phase = this.norm(j.currentPhase || j.phase);

        let d = Number(j.downloadProgress || 0);
        let c = 0;

        if (isVideoTranscode) {
            d = Number(j.downloadProgress || 0);
            c = Number(j.convertProgress || 0);
        } else if (phase === 'converting' || phase === 'completed') {
            c = Number(j.convertProgress || 0);
        }

        if (d || c) {
            return Math.floor((d + c) / 2);
        }
        return 0;
    }

    // Handles prog in the browser UI layer.
    prog(j) {
        const id = j.id ?? j._id ?? null;
        const source = j.metadata?.source || 'file';
        const isLocalSource = source === 'local' || source === 'file';

        if (isLocalSource) {
            const baseRaw = this.rawProg(j);

            if (!Number.isFinite(baseRaw)) return 0;

            const status = this.norm(j.status);
            const prev = (id && this.progressCache.has(id))
                ? this.progressCache.get(id)
                : 0;

            let next = baseRaw;

            if (status !== 'completed') {
                if (next > 95) next = 95;
            } else {
                next = 100;
            }
            if (next < prev) next = prev;

            if (id) {
                this.progressCache.set(id, next);
            }
            return next;
        }

        const baseRaw = this.rawProg(j);

        if (!Number.isFinite(baseRaw)) return 0;

        const status = this.norm(j.status);
        const prev = (id && this.progressCache.has(id))
            ? this.progressCache.get(id)
            : 0;

        let next = baseRaw;

        const isVideoTranscode = j.format?.toLowerCase() === 'mp4' ||
                            (j.videoSettings && j.videoSettings.transcodeEnabled);

        if (isVideoTranscode && !j.metadata?.isPlaylist) {
            next = Math.floor((Number(j.downloadProgress || 0) + Number(j.convertProgress || 0)) / 2);
        }

        if (status !== 'completed') {
            if (next > 95) next = 95;
        } else {
            next = 100;
        }
        if (next < prev) next = prev;

        if (id) {
            this.progressCache.set(id, next);
        }
        return next;
    }

    // Handles current index in the browser UI layer.
    currentIndex(j) {
        const total = j.playlist?.total;
        const done = j.playlist?.done;
        if (Number.isFinite(total) && Number.isFinite(done) && total > 0) {
            const idx0 = Math.min(Math.max(0, done || 0), Math.max(0, total - 1));
            return idx0;
        }
        return null;
    }

    // Handles now title in the browser UI layer.
    nowTitle(j) {
        if (j.metadata?.isPlaylist && Array.isArray(j.metadata?.frozenEntries) && j.metadata.frozenEntries.length) {
            const i0 = this.currentIndex(j);
            if (i0 !== null && j.metadata.frozenEntries[i0]) {
                return `${j.metadata.frozenEntries[i0].index}. ${j.metadata.frozenEntries[i0].title}`;
            }
        }
        const ex = j.metadata?.extracted || {};
        return ex.track || ex.title || j.metadata?.originalName || null;
    }

    // Computes skipped panel for the browser UI layer.
    computeSkippedPanel(j) {
        const direct = Number(j?.skippedCount ?? j?.metadata?.skippedCount ?? 0);
        if (direct > 0) return direct;

        if (Number.isFinite(j?.playlist?.skipped))
            return Number(j.playlist.skipped);

        if (j?.metadata?.isPlaylist && Array.isArray(j?.resultPath)) {
            const successful = j.resultPath.filter(r => r && r.outputPath && !r.error).length;
            const total = Number(j?.playlist?.total ?? j?.metadata?.frozenEntries?.length ?? successful);
            return Math.max(0, total - successful);
        }
        return 0;
    }

        // Handles job state has existing output panel in the browser UI layer.
        async jobHasExistingOutputPanel(job) {
            const s = this.norm(job.status);
            if (s !== 'completed') return true;

            const candidates = [];
            if (typeof job.resultPath === 'string' && job.resultPath) {
                candidates.push(job.resultPath);
            }
            else if (Array.isArray(job.resultPath)) {
                const firstOk = job.resultPath.find(r => r && r.outputPath && !r.error);
                if (firstOk && firstOk.outputPath) {
                    candidates.push(firstOk.outputPath);
                }
                if (!candidates.length && job.zipPath) {
                    candidates.push(job.zipPath);
                }
            }
            else if (job.resultPath && typeof job.resultPath === 'object') {
                if (job.resultPath.outputPath) {
                    candidates.push(job.resultPath.outputPath);
                }
            }
            else if (job.zipPath) {
                candidates.push(job.zipPath);
            }

            if (!candidates.length) return false;

            const url = candidates[0];
            return this.checkOutputExistsPanel(url);
        }

        // Handles prune playlist data outputs panel in the browser UI layer.
        async prunePlaylistOutputsPanel(job) {
            const s = this.norm(job.status);
            if (s !== 'completed') return true;

            if (!Array.isArray(job.resultPath)) return true;

            const candidates = job.resultPath
                .filter((result) => result && !result.error)
                .map((result) => ({ result, path: result.outputPath || result.path }))
                .filter((candidate) => candidate.path);
            const paths = candidates.map((candidate) => candidate.path);
            if (job.zipPath) paths.push(job.zipPath);
            const existence = await outputExistenceClient.checkMany(paths);

            const keptResults = candidates
                .filter((candidate) => existence.get(String(candidate.path).trim()))
                .map((candidate) => candidate.result);

            if (job.zipPath) {
                const zipExists = existence.get(String(job.zipPath).trim());
                if (!zipExists) {
                    job.zipPath = null;
                }
            }

            if (keptResults.length === 0 && !job.zipPath) {
                return false;
            }

            job.resultPath = keptResults;
            return true;
        }

    // Cleans up server items for the browser UI layer.
    async cleanupServerItems(items) {
        const safeItems = Array.isArray(items) ? items : [];
        await outputExistenceClient.checkMany(
            safeItems
                .filter((job) => this.norm(job?.status) === 'completed')
                .flatMap((job) => collectJobOutputPaths(job))
        );
        const cleaned = [];

        for (const job of safeItems) {
            const status = this.norm(job.status);

            if (status === 'completed') {
                const knownTs = this.completedAtCache.get(job.id);
                const ts = job.completedAt || knownTs || null;
                if (ts) {
                    job.completedAt = ts;
                    this.completedAtCache.set(job.id, ts);
                }

                let keep = true;

                if (Array.isArray(job.resultPath)) {
                    keep = await this.prunePlaylistOutputsPanel(job);
                } else {
                    keep = await this.jobHasExistingOutputPanel(job);
                }

                if (!keep) {
                    continue;
                }
            } else {
                const knownTs = this.completedAtCache.get(job.id);
                if (knownTs && !job.completedAt) {
                    job.completedAt = knownTs;
                }
            }
            cleaned.push(job);
        }
        return cleaned;
    }

        // Handles reconcile lost job state in the browser UI layer.
        async reconcileLostJobs(existing, incoming) {
        const safeExisting = Array.isArray(existing) ? existing : [];
        const safeIncoming = Array.isArray(incoming) ? incoming : [];
        const incomingIds = new Set(
            safeIncoming
                .map(j => j?.id ?? j?._id)
                .filter(Boolean)
        );
        await outputExistenceClient.checkMany(
            safeExisting
                .filter((job) => {
                    const id = job?.id ?? job?._id;
                    return id && !incomingIds.has(id);
                })
                .flatMap((job) => collectJobOutputPaths(job))
        );

        const result = [];

        for (const job of safeExisting) {
            if (!job) continue;

            const id = job.id ?? job._id;
            if (!id) {
                result.push(job);
                continue;
            }

            if (incomingIds.has(id)) {
                result.push(job);
                continue;
            }

            const status = this.norm(job.status);
            if (status === 'completed') {
                let keep = true;

                if (Array.isArray(job.resultPath)) {
                    keep = await this.prunePlaylistOutputsPanel(job);
                } else {
                    keep = await this.jobHasExistingOutputPanel(job);
                }

                if (keep) {
                    result.push(job);
                }
                continue;
            }

            let keep = true;

            if (Array.isArray(job.resultPath)) {
                keep = await this.prunePlaylistOutputsPanel(job);
            } else if (job.resultPath || job.zipPath) {
                keep = await this.jobHasExistingOutputPanel(job);
            } else {
                keep = false;
            }

            if (!keep) {
                continue;
            }
            result.push(job);
        }
        return result;
    }

    // Handles merge items in the browser UI layer.
    mergeItems(existing, incoming) {
        const result = [];
        const byId = new Map();

        // Handles add in the browser UI layer.
        const add = (job, isExisting = false) => {
            if (!job) return;
            const id = job.id ?? job._id;
            if (!id) {
                result.push(job);
                return;
            }

            const prev = byId.get(id);
            if (!prev) {
                byId.set(id, job);
                result.push(job);
            } else {
                const merged = { ...prev, ...job };
                if (prev.completedAt && !merged.completedAt) {
                    merged.completedAt = prev.completedAt;
                }

                byId.set(id, merged);

                const idx = result.findIndex(x => (x.id ?? x._id) === id);
                if (idx >= 0) {
                    result[idx] = merged;
                }
            }
        };

        (existing || []).forEach(j => add(j, true));
        (incoming || []).forEach(j => add(j, false));

        return result;
    }

        // Handles limit completed in the browser UI layer.
        limitCompleted(items, maxCompleted = 15) {
        if (!Array.isArray(items)) return [];

        const active = [];
        const completed = [];

        for (const j of items) {
            const s = this.norm(j?.status);
            if (s === 'completed') {
                completed.push(j);
            } else {
                active.push(j);
            }
        }

        completed.sort((a, b) => {
            const ta = a.completedAt || 0;
            const tb = b.completedAt || 0;
            return tb - ta;
        });

        return [...active, ...completed.slice(0, maxCompleted)];
    }

        // Persists state for the browser UI layer.
        saveState() {
        try {
            const items = this.limitCompleted(this.state.items || [], 15);

            const payload = {
                items,
                savedAt: Date.now(),
                version: 1
            };

            localStorage.setItem(this.storageKey, JSON.stringify(payload));
        } catch (e) {
            console.warn('[JobsPanel] saveState error:', e);
        }
    }

    // Handles restore state in the browser UI layer.
    async restoreState() {
        try {
            const raw = localStorage.getItem(this.storageKey);
            if (!raw) return;

            const data = JSON.parse(raw);
            if (!data || !Array.isArray(data.items)) return;

            const cleaned = await this.cleanupServerItems(data.items || []);
            const limited = this.limitCompleted(cleaned, 15);
            const { hasUpdate, latestVersion, releaseUrl } = this.state;
            this.state = {
                items: limited,
                hasUpdate,
                latestVersion,
                releaseUrl
            };
            this.render();
        } catch (e) {
            console.warn('[JobsPanel] restoreState parse error:', e);
            try { localStorage.removeItem(this.storageKey); } catch (_) {}
        }
    }

        // Updates job state bell for the browser UI layer.
        updateJobsBell() {
        const allItems = Array.isArray(this.state.items)
            ? this.state.items
            : [];

        const activeCount = allItems.filter(j =>
            !['completed', 'error', 'canceled'].includes(this.norm(j.status))
        ).length;

        const badge = document.getElementById('jobsBadge');
        const bell  = document.getElementById('jobsBell');
        if (!badge || !bell) return;

        const accessCount = Array.isArray(this.accessRequests) ? this.accessRequests.length : 0;
        const accessTabBadge = document.getElementById('accessRequestsTabBadge');
        if (accessTabBadge) {
            accessTabBadge.textContent = accessCount > 99 ? '99+' : String(accessCount);
            accessTabBadge.hidden = accessCount === 0;
        }

        const baseCount = activeCount + accessCount;
        const displayCount = this.state.hasUpdate
            ? baseCount + 1
            : baseCount;

        const prev = Number(badge.dataset.count || 0);
        badge.dataset.count = String(displayCount);
        if (displayCount > 0) {
            badge.textContent = String(displayCount);
            badge.title = this.t('version.badgeTitle', { count: displayCount });
            badge.hidden = false;
        } else {
            badge.textContent = '';
            badge.removeAttribute('title');
            badge.hidden = true;
        }

        const hasToken = !!localStorage.getItem(this.tokenKey);
        if (!hasToken) {
            bell.hidden = true;
            bell.classList.remove('jobs-bell--active', 'jobs-bell--ping');
            return;
        }

        bell.hidden = false;

        if (displayCount > 0) {
            bell.classList.add('jobs-bell--active');
        } else {
            bell.classList.remove('jobs-bell--active');
            bell.classList.remove('jobs-bell--ping');
        }

        if (displayCount > prev) {
            bell.classList.add('jobs-bell--ping');
            setTimeout(() => {
                bell.classList.remove('jobs-bell--ping');
            }, 900);
        }
    }

    // Renders render in the browser UI layer.
    render() {
    if (!this.list) return;
    const prevScrollTop = this.list.scrollTop;

    const allItems = Array.isArray(this.state.items)
        ? this.state.items.slice()
        : [];

    const items = (this.filter === 'active')
        ? allItems.filter(j => !['completed', 'error', 'canceled'].includes(this.norm(j.status)))
        : allItems;

        items.sort((a, b) => {
            const sa = this.norm(a.status);
            const sb = this.norm(b.status);
            const ta = a.completedAt || 0;
            const tb = b.completedAt || 0;

            if (sa === 'completed' && sb === 'completed') return tb - ta;
            if (sa === 'completed' && sb !== 'completed') return -1;
            if (sb === 'completed' && sa !== 'completed') return 1;
            return 0;
        });

      this.updateJobsBell();

    if (this.filter === 'access') {
        this.renderAccessRequests(prevScrollTop);
        return;
    }

    let updateNotification = '';
    if (this.state.hasUpdate) {
        updateNotification = `
            <div class="update-notification" style="
                background: linear-gradient(135deg, var(--success-light) 0%, var(--accent-light) 100%);
                border: 1px solid var(--success);
                border-radius: 12px;
                padding: 16px;
                margin: 0 16px 16px 16px;
                display: flex;
                align-items: center;
                gap: 12px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
            ">
                <div style="font-size: 24px; flex-shrink: 0;">🔄</div>
                <div style="flex: 1;">
                    <div style="font-weight: 700; color: var(--success); margin-bottom: 4px; font-size: 14px;">
                        ${this.t('version.updateAvailable')}
                    </div>
                    <div style="font-size: 13px; color: var(--text-muted);">
                        <strong>v${this.state.latestVersion}</strong> - ${this.t('version.viewDetails')}
                    </div>
                </div>
                <div style="display: flex; gap: 8px; flex-shrink: 0;">
                    <button
                        type="button"
                        class="btn-outline btn-sm jobs-update-view"
                        style="padding: 6px 12px; font-size: 12px; border-radius: 6px;"
                    >
                        ${this.t('btn.view')}
                    </button>
                    <button
                        type="button"
                        class="btn-primary btn-sm jobs-update-dismiss"
                        style="padding: 6px 12px; font-size: 12px; border-radius: 6px; background: var(--success); border-color: var(--success);"
                    >
                        ${this.t('btn.close')}
                    </button>
                </div>
            </div>
        `;
    }

    if (items.length === 0) {
        const isActive = (this.filter === 'active');
        this.list.innerHTML = `
            ${updateNotification}
            <div class="jobs-panel__empty">
                <div class="jobs-panel__empty-icon">🎵</div>
                <div class="jobs-panel__empty-title">
                    ${isActive ? this.t('jobsPanel.emptyActive') : this.t('jobs.empty')}
                </div>
                <div class="jobs-panel__empty-subtitle">
                    ${isActive ? this.t('jobsPanel.emptyDescriptionActive') : this.t('jobsPanel.emptyDescriptionAll')}
                </div>
                <div class="jobs-panel__empty-actions">
                    <button class="jobs-panel__empty-action" data-action="focus-url-close">
                        ${this.t('jobsPanel.addUrl')}
                    </button>
                    <button class="jobs-panel__empty-action jobs-panel__empty-action--outline" data-action="focus-file-close">
                        ${this.t('section.file')}
                    </button>
                </div>
            </div>
        `;

        if (window.i18n?.apply) window.i18n.apply(this.list);

        const viewBtnEmpty = this.list.querySelector('.jobs-update-view');
        if (viewBtnEmpty && window.versionManager?.viewRelease) {
            viewBtnEmpty.addEventListener('click', () => {
                window.versionManager.viewRelease();
            });
        }

        const dismissBtnEmpty = this.list.querySelector('.jobs-update-dismiss');
        if (dismissBtnEmpty && window.versionManager?.dismissUpdate) {
            dismissBtnEmpty.addEventListener('click', () => {
                window.versionManager.dismissUpdate();
            });
        }

        this.list.scrollTop = prevScrollTop;
        return;
    }

    const jobsHtml = items.map(j => {
        const p = this.prog(j);
        let downloadLinks = '';

        if (j.status === 'completed') {
            if (typeof j.resultPath === 'string' && j.resultPath) {
                downloadLinks = `<a class="link" href="${j.resultPath}" download>${this.t('jobsPanel.downloadFile')}</a>`;
            } else if (Array.isArray(j.resultPath)) {
                const successfulResults = j.resultPath.filter(r => r.outputPath && !r.error);
                if (successfulResults.length > 0) {
                    if (j.zipPath) {
                        downloadLinks = `<a class="link" href="${j.zipPath}" download>${this.t('jobsPanel.downloadZip')}</a>`;
                    } else {
                        downloadLinks = `<span class="link" style="opacity:.8" title="${this.t('jobsPanel.multipleOutputs')}">${this.t('jobsPanel.multiple')}</span>`;
                    }
                }
            } else if (typeof j.resultPath === 'object' && j.resultPath?.outputPath) {
                downloadLinks = `<a class="link" href="${j.resultPath.outputPath}" download>${this.t('jobsPanel.downloadFile')}</a>`;
            }
        }

        const baseTitle = this.titleOf(j);
        const nowT = this.nowTitle(j);
        const titleText = (j.metadata?.isPlaylist && nowT)
            ? `${baseTitle} — ${nowT}`
            : (nowT || baseTitle);

        const fmt = String(j.format || '').toLowerCase();
        const videoFormats = ['mp4', 'mkv', 'webm', 'avi', 'mov'];
        const audioFormats = ['mp3', 'aac', 'm4a', 'ogg', 'opus', 'flac', 'wav', 'alac', 'eac3', 'ac3'];

        let formatEmoji = '📁';
        if (videoFormats.includes(fmt)) {
            formatEmoji = '🎬';
        } else if (audioFormats.includes(fmt)) {
            formatEmoji = '🎧';
        }

        const fpsEmoji = '🎯';
        const sampleRateEmoji = '📡';
        const channelsEmoji = '🎚️';
        const bitrateEmoji = '📶';
        const videoFpsText = this.getDisplayedVideoFps(j);

        const skippedCount = this.computeSkippedPanel(j);
        const skippedKeywords = /(private|izin|skipp?ed|unavailable|atlan(?:d|an)|blocked|copyright|region|geo)/i;
        const showSkippedBadge =
            (skippedCount > 0) ||
            (j.lastLog && skippedKeywords.test(String(j.lastLog))) ||
            (j.lastLogKey && skippedKeywords.test(String(j.lastLogKey))) ||
            (j.error && skippedKeywords.test(String(j.error?.message || j.error)));

        const skippedBadge = showSkippedBadge
            ? `<span class="chip chip--warn" title="atlananlar">⚠️ ${this.t('jobs.skipped')}${skippedCount ? ` (${skippedCount})` : ''}</span>`
            : '';

        const cancelInfo = (j.canceledBy === 'user')
            ? `<div class="muted" style="font-size:12px;margin-top:4px;">
                    ${this.t('status.canceled')}
            </div>`
            : '';

        let completedAtInfo = '';
        if (this.norm(j.status) === 'completed' && j.completedAt) {
            const d = new Date(j.completedAt);
            const formatted = d.toLocaleString();
            completedAtInfo = `
                <div class="muted" style="font-size:12px;margin-top:4px;">
                    🕒 ${formatted}
                </div>
            `;
        }

        return `
            <div class="job-card" data-job-id="${j.id}">
                <div class="job-title">${this.statusDot(j)}<span>${titleText}</span></div>

                <div class="job-meta">
                    <span class="pill">${this.sourcePill(j)}</span>
                    <span class="pill">${formatEmoji} ${(j.format || '').toUpperCase()} ${j.bitrate ? `• ${bitrateEmoji} ${j.bitrate}` : ''}</span>
                    ${j.sampleRate ? `
                        <span class="pill">
                            ${sampleRateEmoji} ${Math.round(j.sampleRate / 1000)} ${this.t('ui.khz') || 'kHz'}
                        </span>
                    ` : ''}
                    ${j.videoSettings?.transcodeEnabled ? `
                        <span class="pill pill--video" title="${this.t('label.videoTranscodejob')}">🎬</span>
                    ` : ''}
                    ${j.videoSettings?.audioTranscodeEnabled ? `
                        <span class="pill pill--audio" title="${this.t('label.audioTranscode')}">🎵</span>
                    ` : ''}
                    ${j.videoSettings?.hwaccel && j.videoSettings.hwaccel !== 'off' ? `
                        <span
                            class="pill pill--hwaccel"
                            title="${this.t('label.hwaccel')}: ${this.t(`option.${j.videoSettings.hwaccel}`) || j.videoSettings.hwaccel}"
                        >
                            ${this.getHwaccelIcon(j.videoSettings.hwaccel)}
                        </span>
                    ` : ''}
                    ${videoFpsText ?
                        `<span class="pill" title="FPS">${fpsEmoji} ${videoFpsText} ${this.t('ui.fps') || 'FPS'}</span>` : ''}
                    ${j.videoSettings?.audioChannels && j.videoSettings.audioChannels !== 'original' ?
                        `<span class="pill" title="${this.t('label.stereoConvert')}">
                            ${channelsEmoji} ${this.getChannelsText(j.videoSettings.audioChannels)}
                        </span>` : ''}
                    ${j.videoSettings?.audioSampleRate && j.videoSettings.audioSampleRate !== '48000' ?
                        `<span class="pill" title="${this.t('label.sampleRate')}">
                            ${sampleRateEmoji} ${parseInt(j.videoSettings.audioSampleRate)/1000}k
                        </span>` : ''}
                    ${j.videoSettings?.audioCodec && j.videoSettings.audioCodec !== 'aac' ?
                        `<span class="pill" title="${this.t('label.format')}">${this.t(`option.${j.videoSettings.audioCodec}`) || j.videoSettings.audioCodec.toUpperCase()}</span>` : ''}
                    ${j.videoSettings?.audioBitrate && j.videoSettings.audioBitrate !== '192k' ?
                        `<span class="pill" title="${this.t('label.audioBitrate')}">
                            ${bitrateEmoji} ${j.videoSettings.audioBitrate}
                        </span>` : ''}
                    ${j.metadata?.includeLyrics ? `
                        <span class="pill pill--lyrics" title="${this.t('label.includeLyrics2')}">🎼</span>
                    ` : ''}
                    ${j.metadata?.volumeGain && j.metadata.volumeGain !== 1.0 ? `
                        <span class="pill pill--volume" title="${this.t('label.volumeGain')}">🔊 ${j.metadata.volumeGain}x</span>
                    ` : ''}
                    ${j.metadata?.loudnorm ? `
                        <span class="pill pill--volume" title="${this.t('label.loudnorm') || 'Loudness Normalize'}">🎚 ${
                            String(j.metadata?.loudnormMode || 'ebu_r128') === 'two_pass'
                                ? (this.t('option.loudnormMode.twoPass') || 'Two-Pass Processing')
                                : String(j.metadata?.loudnormMode || 'ebu_r128') === 'dynamic'
                                    ? (this.t('option.loudnormMode.dynamic') || 'Dynamic Range Control')
                                    : (this.t('option.loudnormMode.ebuR128') || 'EBU R128 Standard')
                        }</span>
                    ` : ''}
                    <span class="pill">${this.phasePill(j)}</span>
                    ${skippedBadge}
                </div>

                ${(() => {
                    const nt = nowT;
                    return nt ? `<div class="muted" style="font-size:12px">▶️ <strong>${nt}</strong></div>` : '';
                })()}

                ${cancelInfo}
                ${completedAtInfo}

                <div class="progress panel" role="progressbar"
                     aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}">
                    <span style="width:${p}%"></span>
                </div>

                <div class="row panel">
                    <span>${p}%</span>
                    <span style="display:flex; gap:8px; align-items:center;">
                        ${downloadLinks}
                        <button class="btn-danger" data-stop-panel="${j.id}" ${(['completed', 'error', 'canceled'].includes(this.norm(j.status))) ? 'disabled' : ''} title="${this.t('btn.stop')}">
                            ${this.t('btn.stop')}
                        </button>
                    </span>
                </div>
            </div>
        `;
    }).join('');

    if (this.filter === 'active') {
        const activeTitleKey = 'jobsPanel.activeGroupTitle';
        const activeTitle = this.t(activeTitleKey);

        this.list.innerHTML = `
            ${updateNotification}
            <section class="collapsible-section">
                <button
                    type="button"
                    class="collapsible-section__header"
                    aria-expanded="true"
                >
                    <span class="collapsible-section__title" data-i18n="${activeTitleKey}">
                        ${activeTitle}
                    </span>
                    <span class="collapsible-section__badge">${items.length}</span>
                    <span class="collapsible-section__icon" aria-hidden="true">▾</span>
                </button>
                <div class="collapsible-section__body">
                    ${jobsHtml}
                </div>
            </section>
        `;
    } else {
        this.list.innerHTML = `
            ${updateNotification}
            ${jobsHtml}
        `;
    }

    if (window.i18n?.apply) window.i18n.apply(this.list);
    if (this.filter === 'active' && items.length > 0) {
        const header = this.list.querySelector('.collapsible-section__header');
        const body   = this.list.querySelector('.collapsible-section__body');
        if (header && body) {
            header.addEventListener('click', () => {
                const expanded = header.getAttribute('aria-expanded') === 'true';
                header.setAttribute('aria-expanded', expanded ? 'false' : 'true');
                body.hidden = expanded;
                header.classList.toggle('is-collapsed', expanded);
            });
        }
    }

    const viewBtn = this.list.querySelector('.jobs-update-view');
        if (viewBtn) {
            viewBtn.addEventListener('click', () => {
                const url = this.state.releaseUrl;
                if (url) {
                    window.open(url, '_blank');
                }
            });
        }

    const dismissBtn = this.list.querySelector('.jobs-update-dismiss');
        if (dismissBtn) {
            dismissBtn.addEventListener('click', () => {
                this.state.hasUpdate = false;
                this.render();
            });
        }

    this.list.querySelectorAll('[data-stop-panel]').forEach(btn => {
        btn.onclick = async () => {
            const id = btn.getAttribute('data-stop-panel');
            btn.disabled = true;
            const j = this.state.items.find(x => x.id === id);
            const cb = j?.clientBatch || null;

            if (cb) {
                const sameBatch = this.state.items.filter(x => x.clientBatch === cb);
                try {
                    await Promise.allSettled(sameBatch.map(x =>
                        fetch(`/api/jobs/${encodeURIComponent(x.id)}/cancel`, { method: 'POST' })
                    ));
                    this.state.items = this.state.items.map(x =>
                        x.clientBatch === cb ? { ...x, status: 'canceled', phase: 'canceled' } : x
                    );
                    this.render();
                    return;
                } catch (_) { }
            }

            try {
                const r = await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
                if (!r.ok) {
                    const e = await r.json().catch(() => ({}));
                    throw new Error(e?.error?.message || this.t('notif.cancelFailed'));
                }
                const idx = this.state.items.findIndex(j => j.id === id);
                if (idx >= 0) {
                    this.state.items[idx] = { ...this.state.items[idx], status: 'canceled', phase: 'canceled' };
                    this.render();
                }
            } catch (e) {
                btn.disabled = false;
            }
        };
    });

    this.list.scrollTop = prevScrollTop;
    this.saveState();
}
    // Handles t in the browser UI layer.
    t(key, vars) {
        return (window.i18n?.t?.(key, vars)) ?? key;
    }
}

export const jobsPanelManager = new JobsPanelManager();

if (typeof window !== 'undefined') {
    window.jobsPanelManager = jobsPanelManager;
}
