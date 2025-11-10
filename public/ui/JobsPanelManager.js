export class JobsPanelManager {
    constructor() {
        this.tokenKey = "gharmonize_admin_token";
        this.panel = null;
        this.overlay = null;
        this.list = null;
        this.state = { items: [] };
        this.filter = 'active';
        this.eventSource = null;
        this.isStarted = false;
        this.pollingInterval = null;
    }

    initialize() {
        if (this.isStarted) return;

        this.panel = document.getElementById('jobsPanel');
        this.overlay = document.getElementById('jobsOverlay');
        this.list = document.getElementById('jobsList');

        this.setupEventListeners();
        this.isStarted = true;

        if (localStorage.getItem(this.tokenKey)) {
            this.goOnline();
        } else {
            this.goOffline();
        }
    }

    setupEventListeners() {
        document.getElementById('jobsBell')?.addEventListener('click', () => this.open());
        this.overlay?.addEventListener('click', () => this.close());
        document.getElementById('jobsClose')?.addEventListener('click', () => this.close());
        document.getElementById('jobsFilterActive')?.addEventListener('click', () => this.setFilter('active'));
        document.getElementById('jobsFilterAll')?.addEventListener('click', () => this.setFilter('all'));

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

    open() {
        this.panel?.setAttribute('aria-hidden', 'false');
        this.overlay && (this.overlay.hidden = false);
    }

    close() {
        this.panel?.setAttribute('aria-hidden', 'true');
        this.overlay && (this.overlay.hidden = true);
    }

    setFilter(newFilter) {
        this.filter = newFilter;
        document.getElementById('jobsFilterActive')?.classList.toggle('chip--active', newFilter === 'active');
        document.getElementById('jobsFilterAll')?.classList.toggle('chip--active', newFilter === 'all');
        this.render();
    }

    goOnline() {
        document.getElementById('jobsBell').hidden = false;
        this.startSSE();
    }

    goOffline() {
        document.getElementById('jobsBell').hidden = true;
        this.close();
        this.eventSource?.close();
        this.eventSource = null;
        this.state = { items: [] };
        this.render();

        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    startSSE() {
        try {
            const token = localStorage.getItem(this.tokenKey) || "";
            this.eventSource = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);

            this.eventSource.onmessage = (ev) => {
                try {
                    this.state = JSON.parse(ev.data) || { items: [] };
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

    startPolling() {
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
            .then(d => {
                if (d) {
                    this.state = { items: d.items || [] };
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

    norm(s) {
        const v = String(s || '').toLowerCase();
        return v === 'cancelled' ? 'canceled' : v;
    }

    titleOf(j) {
        const m = j.metadata || {};
        const ex = m.extracted || {};
        return m.frozenTitle || m.spotifyTitle || ex.title || m.originalName ||
               (m.isAutomix ? this.t('jobsPanel.automix') : (m.isPlaylist ? this.t('jobsPanel.playlist') : this.t('jobsPanel.job')));
    }

    sourcePill(j) {
        const s = j.metadata?.source || 'file';
        const sources = {
            youtube: this.t('jobsPanel.sourceYouTube'),
            spotify: this.t('jobsPanel.sourceSpotify'),
            direct_url: this.t('jobsPanel.sourceURL'),
            file: this.t('jobsPanel.sourceFile')
        };
        return sources[s] || s;
    }

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

    statusDot(j) {
        const s = this.norm(j.status);
        if (s === 'error') return '<span class="dot status-err">●</span>';
        if (s === 'completed') return '<span class="dot status-ok">●</span>';
        if (s === 'canceled') return '<span class="dot status-warn">●</span>';
        return '<span class="dot status-warn">●</span>';
    }

    prog(j) {
        if (typeof j.progress === 'number') return j.progress;
        const d = j.downloadProgress || 0, c = j.convertProgress || 0;
        return Math.floor((d + c) / 2);
    }

    currentIndex(j) {
        const total = j.playlist?.total;
        const done = j.playlist?.done;
        if (Number.isFinite(total) && Number.isFinite(done) && total > 0) {
            const idx0 = Math.min(Math.max(0, done || 0), Math.max(0, total - 1));
            return idx0;
        }
        return null;
    }

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

    render() {
        const allItems = this.state.items.slice();
        const items = (this.filter === 'active')
            ? allItems.filter(j => !['completed', 'error', 'canceled'].includes(this.norm(j.status)))
            : allItems;

        const activeCount = allItems.filter(j => !['completed', 'error', 'canceled'].includes(this.norm(j.status))).length;
        const badge = document.getElementById('jobsBadge');
        if (badge) {
            badge.textContent = String(activeCount);
            badge.hidden = activeCount <= 0;
        }

        if (items.length === 0) {
            const isActive = (this.filter === 'active');
            this.list.innerHTML = `
                <div class="jobs-panel__empty">
                    <div class="jobs-panel__empty-icon">🎵</div>
                    <div class="jobs-panel__empty-title">
                        ${isActive ? this.t('jobsPanel.emptyActive') : this.t('jobs.empty')}
                    </div>
                    <div class="jobs-panel__empty-subtitle">
                        ${isActive ? this.t('jobsPanel.emptyDescriptionActive') : this.t('jobsPanel.emptyDescriptionAll')}
                    </div>
                    <div class="jobs-panel__empty-actions">
                        <button class="jobs-panel__empty-action" onclick="focusUrlInputAndClose()">
                            ${this.t('jobsPanel.addUrl')}
                        </button>
                        <button class="jobs-panel__empty-action jobs-panel__empty-action--outline" onclick="focusFileInputAndClose()">
                            ${this.t('section.file')}
                        </button>
                    </div>
                </div>
            `;
            if (window.i18n?.apply) window.i18n.apply(this.list);
            return;
        }

        this.list.innerHTML = items.map(j => {
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

            return `
                <div class="job-card" data-job-id="${j.id}">
                    <div class="job-title">${this.statusDot(j)}<span>${titleText}</span></div>

                    <div class="job-meta">
                        <span class="pill">${this.sourcePill(j)}</span>
                        <span class="pill">${(j.format || '').toUpperCase()} ${j.bitrate || ''}</span>
                        ${j.sampleRate ? `<span class="pill">${Math.round(j.sampleRate / 1000)} kHz</span>` : ''}
                        <span class="pill">${this.phasePill(j)}</span>
                        ${skippedBadge}
                    </div>

                    ${(() => {
                        const nt = nowT;
                        return nt ? `<div class="muted" style="font-size:12px">▶️ <strong>${nt}</strong></div>` : '';
                    })()}

                    <div class="progress panel" role="progressbar"
                         aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}">
                        <span style="width:${p}%"></span>
                    </div>

                    <div class="row panel">
                        <span>${p}%</span>
                        <span style="display:flex; gap:8px; align-items:center;">
                            ${downloadLinks}
                            <button class="btn-danger" data-stop-panel="${j.id}" ${(['completed', 'error', 'canceled'].includes(this.norm(j.status))) ? 'disabled' : ''} title="${this.t('btn.stop')}">${this.t('btn.stop')}</button>
                        </span>
                    </div>
                </div>
            `;
        }).join('');

        if (window.i18n?.apply) window.i18n.apply(this.list);
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
    }

    t(key, vars) {
        return (window.i18n?.t?.(key, vars)) ?? key;
    }
}

export const jobsPanelManager = new JobsPanelManager();
