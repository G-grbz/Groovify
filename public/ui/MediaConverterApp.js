import { notificationManager } from './NotificationManager.js';

export class MediaConverterApp {
    constructor() {
        this.currentJobs = new Map();
        this._escapeMap = {
            '&': '&amp;', '<': '&lt;', '>': '&gt;',
            '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;', '/': '&#47;'
        };
        this.includeLyrics = false;
        this.currentSampleRate = 48000;
        this.currentPreview = {
            url: null, items: [], selected: new Set(),
            title: '', count: 0, page: 1, pageSize: 25,
            isSpotify: false, streaming: false,
            indexToId: new Map(),
            indexToTitle: new Map()
        };
        this.currentSpotifyTask = {
            id: null,
            jobId: null,
            completed: false
        };
        this.integratedRenderedCount = 0;
        this.batches = new Map();
        this.jobToBatch = new Map();
        this.jobStates = new Map();
        this.previewAbort = null;
        this.spotifyEventSource = null;
        this.notificationManager = notificationManager;

        this.initializeEventListeners();
        this.initializeTheme();
        this.loadFormats();
        this.ensureWarnStyles();
    }

    ensureWarnStyles() {
        if (document.getElementById('skipped-badge-style')) return;
        const st = document.createElement('style');
        st.id = 'skipped-badge-style';
        document.head.appendChild(st);
    }

    computeSkipped(job) {
        const fromStats = Number(job?.metadata?.skipStats?.skippedCount);
        if (Number.isFinite(fromStats) && fromStats >= 0) return fromStats;
        const direct = Number(job?.skippedCount ?? job?.metadata?.skippedCount);
        if (Number.isFinite(direct) && direct >= 0) return direct;

        if (Number.isFinite(job?.playlist?.skipped)) {
            return Number(job.playlist.skipped);
        }

        if (Number.isFinite(job?.errorsCount)) {
            return Number(job.errorsCount);
        }

        if (job?.metadata?.isPlaylist && Array.isArray(job?.resultPath)) {
            const successful = job.resultPath.filter(r => r && r.outputPath && !r.error).length;
            const total = Number(job?.playlist?.total ?? job?.metadata?.frozenEntries?.length ?? successful);
            return Math.max(0, Math.min(total, total - successful));
        }

        if (job?.stderr) {
            const skipPattern = /(private|izin|skipp?ed|unavailable|atlan(?:d|an)|blocked|copyright|region|geo)/gi;
            const matches = job.stderr.match(skipPattern);
            return matches ? matches.length : 0;
        }

        return 0;
    }

    normalizeStatus(s) {
        const v = String(s || '').toLowerCase();
        return v === 'cancelled' ? 'canceled' : v;
    }

    initializeTheme() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);

        const themeToggle = document.getElementById('themeToggle');
        themeToggle.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'light' ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
        });
    }

    async loadFormats() {
        try {
            const response = await fetch('/api/formats');
            const data = await response.json();
            this.updateFormatOptions(data.formats);
            this.handleFormatChange();
        } catch (error) {
            console.error('Formatlar yüklenemedi:', error);
        }
    }

    handleFormatChange() {
        const formatSelect = document.getElementById('formatSelect');
        formatSelect.addEventListener('change', async (e) => {
            const format = e.target.value;
            this.toggleFormatSpecificOptions(format);

            const formats = await this.getFormats();
            this.updateBitrateOptions(format, formats);

            if (format === 'eac3' || format === 'ac3') {
             this.updateSampleRateOptionsForEac3Ac3();
            }
        });

        const currentFormat = formatSelect.value;
        this.toggleFormatSpecificOptions(currentFormat);

        if (currentFormat === 'eac3' || currentFormat === 'ac3') {
         this.updateSampleRateOptionsForEac3Ac3();
     }
    }

    updateSampleRateOptionsForEac3Ac3() {
     const sampleRateSelect = document.getElementById('sampleRateSelect');
     if (!sampleRateSelect) return;
     const supportedRates = [48000, 44100, 32000];

     sampleRateSelect.innerHTML = '';
     supportedRates.forEach(rate => {
         const option = document.createElement('option');
         option.value = rate;
         option.textContent = `${Math.round(rate / 1000)} kHz`;
         if (rate === 48000) option.selected = true;
         sampleRateSelect.appendChild(option);
     });

     if (this.currentSampleRate && supportedRates.includes(this.currentSampleRate)) {
         sampleRateSelect.value = this.currentSampleRate;
     }
 }

    toggleFormatSpecificOptions(format) {
        const sampleRateGroup = document.querySelector('.form-group:has(#sampleRateSelect)');
        const lyricsGroup = document.getElementById('lyricsCheckboxContainer');
        const isMp4 = format === 'mp4';
        const isEac3Ac3 = format === 'eac3' || format === 'ac3';

        if (sampleRateGroup) {
            sampleRateGroup.style.display = (isMp4) ? 'none' : '';
        }

        if (lyricsGroup) {
            lyricsGroup.style.display = (isMp4 || isEac3Ac3) ? 'none' : '';
        }
        this.toggleEac3Ac3Options(isEac3Ac3);
        }

        toggleEac3Ac3Options(show) {
        let container = document.getElementById('eac3Ac3Options');

        if (!container && show) {
            container = document.createElement('div');
            container.id = 'eac3Ac3Options';
            container.className = 'form-group';
            container.innerHTML = `
                <div class="form-group">
                      <label for="stereoConvertSelect" data-i18n="label.stereoConvert">Kanal Ayarları:</label>
                      <select id="stereoConvertSelect">
                        <option value="auto" data-i18n="option.auto">Orijinal Kanal Sayısını Koru</option>
                        <option value="force" data-i18n="option.forceStereo">Stereo'ya Dönüştür (2 Kanal)</option>
                      </select>
                    </div>

            <div class="form-group">
                <label for="atempoSelect" data-i18n="label.atempoAdjust">Ses Hızı Düzeltme (FPS Uyumu):</label>
                <select id="atempoSelect">
                  <option value="none" data-i18n="option.none">Ses hızını değiştirme</option>
                  <option value="23976_24000" data-i18n="option.23976_24000">23.976 FPS → 24 FPS (TV/stream → sinema)</option>
                  <option value="23976_24000" data-i18n="option.23976_24000">23.976 FPS → 24 FPS (TV/stream → sinema)</option>
                  <option value="23976_25000" data-i18n="option.23976_25000">23.976 FPS → 25 FPS (NTSC → PAL TV)</option>
                  <option value="24000_23976" data-i18n="option.24000_23976">24 FPS → 23.976 FPS (sinema → TV/stream)</option>
                  <option value="24000_25000" data-i18n="option.24000_25000">24 FPS → 25 FPS (sinema → PAL TV)</option>
                  <option value="25_24" data-i18n="option.25_24">25 FPS → 24 FPS (PAL TV → sinema)</option>
                  <option value="25_23976" data-i18n="option.25_23976">25 FPS → 23.976 FPS (PAL TV → NTSC/stream)</option>
                  <option value="30_23976" data-i18n="option.30_23976">30 FPS → 23.976 FPS (NTSC → film/TV)</option>
                  <option value="30_24" data-i18n="option.30_24">30 FPS → 24 FPS (NTSC → sinema)</option>
                  <option value="30000_25000" data-i18n="option.30000_25000">30 FPS → 25 FPS (NTSC → PAL TV)</option>
                </select>
            </div>
            `;

            const formatSelect = document.getElementById('formatSelect');
            formatSelect.parentNode.insertBefore(container, formatSelect.nextSibling);
        }

        if (container) {
            container.style.display = show ? 'flex' : 'none';
            if (show && window.i18n?.apply) window.i18n.apply(container);
        }
    }

    updateFormatOptions(formats) {
        const formatSelect = document.getElementById('formatSelect');
        formatSelect.innerHTML = '';
        formats.forEach((format) => {
            const option = document.createElement('option');
            option.value = format.format;
            option.textContent = format.format.toUpperCase();
            formatSelect.appendChild(option);
        });
        this.updateBitrateOptions(formats[0].format, formats);
        const currentFormat = formatSelect.value;
        this.toggleFormatSpecificOptions(currentFormat);
    }

    async getFormats() {
        try {
            const response = await fetch('/api/formats');
            const data = await response.json();
            return data.formats;
        } catch {
            return [];
        }
    }

    updateBitrateOptions(format, formats) {
        const bitrateSelect = document.getElementById('bitrateSelect');
        const formatData = formats.find((f) => f.format === format);
        if (!formatData) return;
        bitrateSelect.innerHTML = '';
        formatData.bitrates.forEach((bitrate) => {
            const option = document.createElement('option');
            option.value = bitrate;
            option.textContent = bitrate === 'lossless' ? this.t('quality.lossless') : bitrate;
            bitrateSelect.appendChild(option);
        });
    }

    initializeEventListeners() {
        document.getElementById('formatSelect').addEventListener('change', async (e) => {
            const format = e.target.value;
            this.toggleFormatSpecificOptions(format);
            const formats = await this.getFormats();
            this.updateBitrateOptions(format, formats);
        });

        document.getElementById('previewBtn').addEventListener('click', () => this.handlePreviewClick());
        document.getElementById('fileForm').addEventListener('submit', (e) => this.handleFileSubmit(e));
        document.getElementById('convertSelectedBtn').addEventListener('click', () => this.convertSelected());
        document.getElementById('convertAllBtn').addEventListener('click', () => this.convertAll());
        document.getElementById('selectAllChk').addEventListener('change', (e) => this.toggleSelectAll(e.target.checked));
        document.getElementById('playlistCheckbox').addEventListener('change', (e) => this.onPlaylistToggle(e.target.checked));
        document.getElementById('prevPageBtn').addEventListener('click', () => this.loadPage(this.currentPreview.page - 1));
        document.getElementById('nextPageBtn').addEventListener('click', () => this.loadPage(this.currentPreview.page + 1));
        document.getElementById('pageSizeSel').addEventListener('change', (e) => {
            this.currentPreview.pageSize = Number(e.target.value) || 50;
            if (this.currentPreview.url) this.loadPage(1, true);
        });
        document.getElementById('startIntegratedBtn').addEventListener('click', () => {
            this.startIntegratedSpotifyProcess();
        });

        document.getElementById('urlForm').addEventListener('submit', (e) => this.handleUrlSubmitWithSpinner(e));

        const startSpotifyBtn = document.getElementById('startSpotifyBtn');
        const convertMatchedBtn = document.getElementById('convertMatchedBtn');

        if (startSpotifyBtn) {
            startSpotifyBtn.addEventListener('click', () => this.startSpotifyPreview());
        }

        if (convertMatchedBtn) {
            convertMatchedBtn.addEventListener('click', () => this.convertMatchedSpotify());
        }

        document.getElementById('urlInput').addEventListener('input', (e) => {
            this.onUrlInputChange(e.target.value);
        });

        document.querySelectorAll('.lang-toggle [data-lang]').forEach(btn => {
            btn.addEventListener('click', async () => {
                await window.i18n?.setLang(btn.getAttribute('data-lang'));
            });
        });

        document.addEventListener('i18n:applied', () => {
            const modal = document.getElementById('settingsModal');
            if (modal) window.i18n?.apply?.(modal);
            if (this.currentPreview.url) this.renderPreview();
            for (const [id, job] of this.jobStates.entries()) {
                this.updateJobUI(job, this.jobToBatch.get(id) || null);
            }
        });

        document.getElementById('lyricsCheckbox').addEventListener('change', (e) => {
            this.includeLyrics = e.target.checked;
        });

        document.getElementById('sampleRateSelect').addEventListener('change', (e) => {
            this.currentSampleRate = parseInt(e.target.value);
        });
    }

    onUrlInputChange(url) {
        const isSpotify = this.isSpotifyUrl(url);

        if (isSpotify) {
            document.getElementById('playlistCheckboxContainer').style.display = 'none';
            document.getElementById('normalUrlActions').style.display = 'none';
            document.getElementById('urlSpotifyActions').style.display = 'flex';
            document.getElementById('spotifyPreviewCard').style.display = 'block';
        } else {
            document.getElementById('playlistCheckboxContainer').style.display = 'flex';
            document.getElementById('normalUrlActions').style.display = 'flex';
            document.getElementById('urlSpotifyActions').style.display = 'none';
            document.getElementById('spotifyPreviewCard').style.display = 'none';
        }
    }

    isSpotifyUrl(u) {
        return /^(https?:\/\/open\.spotify\.com|spotify:)/i.test(String(u || ""));
    }

    handlePreviewClick() {
        const url = document.getElementById('urlInput').value.trim();
        if (this.isSpotifyUrl(url)) {
            this.startSpotifyPreview();
        } else {
            this.previewPlaylist();
        }
    }

    onPlaylistToggle(isChecked) {
        if (isChecked) {
            const url = document.getElementById('urlInput').value.trim();
            if (!url) { this.hidePreview(); return; }
            this.previewPlaylist();
        } else {
            this.hidePreview();
        }
    }

    async startSpotifyPreview() {
        const url = document.getElementById('urlInput').value.trim();
        if (!url) {
            this.showNotification(this.t('notif.needUrl'), 'error', 'error');
            return;
        }

        try {
            const btn = document.getElementById('startSpotifyBtn');
            btn.classList.add('btn-loading');
            btn.disabled = true;

            const response = await fetch('/api/spotify/preview/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url })
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                const code = error?.error?.code;
                const msg = code ? this.t(`errors.${code}`) : (error?.error?.message || this.t('errors.startFailed'));
                throw new Error(msg);
            }

            const data = await response.json();
            this.currentSpotifyTask.id = data.mapId;

            document.getElementById('spotifyTitle').textContent = data.title || '-';
            document.getElementById('spotifyTotal').textContent = data.total || 0;
            document.getElementById('spotifyStatus').style.display = 'block';
            document.getElementById('spotifyStatusText').textContent = this.t('status.mappingStarted');

            this.streamSpotifyLogs(data.mapId);

        } catch (error) {
            this.showNotification(`${this.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
        } finally {
            const btn = document.getElementById('startSpotifyBtn');
            btn.classList.remove('btn-loading');
            btn.disabled = false;
        }
    }

    showSpotifyPreview(data) {
        this.hidePreview();

        document.getElementById('spotifyPreviewCard').style.display = 'block';
        document.getElementById('spotifyTitle').textContent = data.title;
        document.getElementById('spotifyTotal').textContent = data.total;
        document.getElementById('spotifyMatched').textContent = '0';
        document.getElementById('spotifyProgress').textContent = '0%';
        document.getElementById('urlSpotifyActions').style.display = 'none';
        document.getElementById('spotifyStartActions').style.display = 'flex';
        document.getElementById('spotifyConvertActions').style.display = 'none';
        document.getElementById('spotifyDownloadSection').style.display = 'none';
        document.getElementById('spotifyLogs').innerHTML = '';
        document.getElementById('spotifyPreviewList').innerHTML = '';
        document.getElementById('spotifyDownloadList').innerHTML = '';
    }

    streamSpotifyLogs(mapId) {
        if (this.spotifyEventSource) {
            this.spotifyEventSource.close();
        }

        this.spotifyEventSource = new EventSource(`/api/spotify/preview/stream-logs/${mapId}`);
        const logsContainer = document.getElementById('spotifyLogs');
        const listContainer = document.getElementById('spotifyPreviewList');

        this.spotifyEventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);

            switch (data.type) {
                case 'init':
                    document.getElementById('spotifyTitle').textContent = data.title || '-';
                    document.getElementById('spotifyTotal').textContent = data.total || 0;
                    if (data.items && Array.isArray(data.items)) {
                        data.items.forEach(item => this.addSpotifyItem(item));
                    }
                    break;

                case 'item':
                    this.addSpotifyItem(data.item);
                    if (data.logKey || data.log) {
                        const msg = data.logKey ? this.t(data.logKey, data.logVars || {}) : this.normalizeLog(data.log);
                        this.addLogEntry(msg, 'success');
                    }
                    break;

                case 'progress':
                    this.updateSpotifyProgress(data.done, data.total);
                    break;

                case 'log':
                    {
                        const msg = data.logKey
                            ? this.t(data.logKey, data.logVars || {})
                            : this.normalizeLog(data.message);
                        this.addLogEntry(msg, data.level || 'info');
                    }
                    break;

                case 'done':
                    {
                        const msg = data.logKey
                            ? this.t(data.logKey, data.logVars || {})
                            : this.normalizeLog(data.log || this.t('status.completed'));
                        this.addLogEntry(msg, data.status === 'completed' ? 'success' : 'error');

                        if (data.status === 'completed') {
                            this.addLogEntry(this.t('status.allMatchesCompleted'), 'success');
                            this.onSpotifyMappingCompleted();
                        }
                        if (data.status === 'completed' || data.status === 'error') {
                            this.spotifyEventSource.close();
                        }
                    }
                    break;
            }
        };

        this.spotifyEventSource.onerror = (error) => {
            this.addLogEntry(this.t('errors.connectionError'), 'error');
            this.spotifyEventSource.close();
        };
    }

    addSpotifyItem(item) {
        const listContainer = document.getElementById('spotifyPreviewList');
        const matched = item.id !== null;

        const itemElement = document.createElement('div');
        itemElement.className = `spotify-track-item ${matched ? 'matched' : 'unmatched'}`;
        if (matched) {
            itemElement.dataset.ytId = item.id;
        }

        itemElement.innerHTML = `
            <div class="track-status">${matched ? '✅' : '❌'}</div>
            <div class="track-info">
                <div class="track-title">${item.index}. ${this.escapeHtml(item.title)}</div>
                <div class="track-artist">${this.escapeHtml(item.uploader)}</div>
            </div>
            ${matched ? `<div class="progress-bar-mini"><div class="progress-fill-mini" style="width: 0%"></div></div>` : ''}
        `;

        listContainer.appendChild(itemElement);
        const matchedCount = listContainer.querySelectorAll('.matched').length;
        document.getElementById('spotifyMatched').textContent = matchedCount;
    }

    normalizeLog(msg) {
        if (msg == null) return '';
        if (typeof msg === 'string') {
            if (msg.startsWith('log.') || msg.startsWith('phase.') || msg.startsWith('status.')) {
                return this.t(msg);
            }
            return msg;
        }
        if (typeof msg === 'object') {
            if (msg.logKey) return this.t(msg.logKey, msg.logVars || {});
            if (msg.message) return this.normalizeLog(msg.message);
            if (msg.fallback) return msg.fallback;
            try { return JSON.stringify(msg); } catch { return String(msg); }
        }
        return String(msg);
    }

    addLogEntry(message, level = 'info') {
        const logsContainer = document.getElementById('spotifyLogs');
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${level}`;
        const timestamp = new Date().toLocaleTimeString();
        logEntry.textContent = `[${timestamp}] ${this.normalizeLog(message)}`;
        logsContainer.appendChild(logEntry);
        logsContainer.scrollTop = logsContainer.scrollHeight;
    }

    updateSpotifyProgress(done, total) {
        const progress = total > 0 ? Math.round((done / total) * 100) : 0;
        document.getElementById('spotifyProgress').textContent = `${progress}%`;
        document.querySelectorAll('.progress-fill-mini').forEach(bar => {
            bar.style.width = `${progress}%`;
        });
    }

    onSpotifyMappingCompleted() {
        this.currentSpotifyTask.completed = true;

        document.getElementById('spotifyStatusText').textContent = this.t('status.mappingCompleted');
        const convertMatchedBtn = document.getElementById('convertMatchedBtn');
        if (convertMatchedBtn) {
            convertMatchedBtn.style.display = 'inline-block';
        }
    }

    async startIntegratedSpotifyProcess() {
        const url = document.getElementById('urlInput').value.trim();
        const format = document.getElementById('formatSelect').value;
        const bitrate = document.getElementById('bitrateSelect').value;
        const sampleRate = document.getElementById('sampleRateSelect').value;
        const includeLyrics = document.getElementById('lyricsCheckbox').checked;

        if (!url) {
            this.showNotification(this.t('notif.needUrl'), 'error', 'error');
            return;
        }

        try {
            const btn = document.getElementById('startIntegratedBtn');
            btn.classList.add('btn-loading');
            btn.disabled = true;

            document.getElementById('spotifyPreviewCard').style.display = 'block';
            document.getElementById('spotifyTitle').textContent = this.t('status.starting');
            document.getElementById('spotifyTotal').textContent = '0';
            document.getElementById('spotifyMatched').textContent = '0';
            document.getElementById('spotifyProgress').textContent = '0%';
            document.getElementById('spotifyLogs').innerHTML = '';
            const listEl = document.getElementById('spotifyPreviewList');
            if (listEl) listEl.innerHTML = '';
            this.integratedRenderedCount = 0;

            const response = await fetch('/api/spotify/process/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url,
                    format,
                    bitrate,
                    sampleRate: sampleRate,
                    includeLyrics
                })
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                const code = error?.error?.code;
                const msg = code ? this.t(`errors.${code}`) : (error?.error?.message || this.t('errors.startFailed'));
                throw new Error(msg);
            }

            const data = await response.json();
            document.getElementById('spotifyTitle').textContent = data.title || '-';
            document.getElementById('spotifyTotal').textContent = data.total || '0';
            this.trackJob(data.jobId);
            this.showNotification(this.t('notif.queue'), 'success', 'queue');
            this.streamIntegratedLogs(data.jobId);

        } catch (error) {
            this.showNotification(`${this.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
            document.getElementById('spotifyLogs').innerHTML +=
                `<div class="log-entry error">[${new Date().toLocaleTimeString()}] ❌ ${this.t('notif.errorPrefix')}: ${this.escapeHtml(error.message)}</div>`;
        } finally {
            const btn = document.getElementById('startIntegratedBtn');
            btn.classList.remove('btn-loading');
            btn.disabled = false;
        }
    }

    streamIntegratedLogs(jobId) {
        const eventSource = new EventSource(`/api/stream/${jobId}`);
        const logsContainer = document.getElementById('spotifyLogs');

        eventSource.onmessage = (event) => {
            const job = JSON.parse(event.data);

            if (job.progress) {
                document.getElementById('spotifyProgress').textContent = `${job.progress}%`;
            }

            (() => {
                try {
                    let line = '';
                    if (job && job.__event && job.type === 'skip-hint') {
                        if (job.lastLogKey) line = this.t(job.lastLogKey, job.lastLogVars || {});
                        else if (job.raw) line = this.normalizeBackendLog(job.raw);
                        else if (job.message) line = this.normalizeBackendLog(job.message);
                    } else if (typeof job.raw === 'string' && /SKIP_(HINT|SUMMARY):/i.test(job.raw)) {
                        line = this.normalizeBackendLog(job.raw);
                    }
                    if (line) {
                        this.addLogEntry(line, 'warning');
                    }
                } catch (_) { }
            })();

            if (job.playlist) {
                document.getElementById('spotifyMatched').textContent = `${job.playlist.done || 0}/${job.playlist.total || 0}`;
            }

            if (job.phase || job.lastLog || job.lastLogKey) {
                const phaseText = {
                    mapping: this.t('phase.mapping'),
                    downloading: this.t('phase.downloading'),
                    converting: this.t('phase.converting'),
                    completed: this.t('phase.completed'),
                    error: this.t('phase.error')
                };

                if (typeof job.lastLog === 'string') {
                    job.lastLog = this.normalizeBackendLog(job.lastLog);
                }

                const logEntry = document.createElement('div');
                logEntry.className = `log-entry ${job.phase === 'error' ? 'error' : 'info'}`;

                const timestamp = new Date().toLocaleTimeString();

                if (job.lastLogKey) {
                    logEntry.textContent = `[${timestamp}] ${this.t(job.lastLogKey, job.lastLogVars || {})}`;
                } else if (job.lastLog) {
                    const txt = (typeof job.lastLog === 'string' && (job.lastLog.startsWith('log.') || job.lastLog.startsWith('phase.') || job.lastLog.startsWith('status.')))
                        ? this.t(job.lastLog, job.lastLogVars || {})
                        : job.lastLog;
                    logEntry.textContent = `[${timestamp}] ${txt}`;
                } else if (job.phase) {
                    logEntry.textContent = `[${timestamp}] ${phaseText[job.phase] || job.phase}`;
                }

                logsContainer.appendChild(logEntry);
                logsContainer.scrollTop = logsContainer.scrollHeight;
            }

            if (job?.metadata?.frozenEntries && Array.isArray(job.metadata.frozenEntries)) {
                const arr = job.metadata.frozenEntries;
                for (let i = this.integratedRenderedCount; i < arr.length; i++) {
                    this.addSpotifyItem(arr[i]);
                }
                this.integratedRenderedCount = arr.length;
                const matchedCount = document.getElementById('spotifyPreviewList')
                    .querySelectorAll('.matched').length;
                document.getElementById('spotifyMatched').textContent = matchedCount;
            }
        };

        eventSource.onerror = (error) => {
            console.error('Entegre log SSE error:', error);
            const logEntry = document.createElement('div');
            logEntry.className = 'log-entry error';
            logEntry.textContent = `[${new Date().toLocaleTimeString()}] ❌ ${this.t('errors.streamDisconnected')}`;
            logsContainer.appendChild(logEntry);
            logsContainer.scrollTop = logsContainer.scrollHeight;
            eventSource.close();
        };
    }

    updateSpotifyPreviewList(entries) {
        const listContainer = document.getElementById('spotifyPreviewList');
        listContainer.innerHTML = '';

        entries.forEach((item, index) => {
            const matched = item.id !== null;

            const itemElement = document.createElement('div');
            itemElement.className = `spotify-track-item ${matched ? 'matched' : 'unmatched'}`;
            if (matched) {
                itemElement.dataset.ytId = item.id;
            }

            itemElement.innerHTML = `
                <div class="track-status">${matched ? '✅' : '❌'}</div>
                <div class="track-info">
                    <div class="track-title">${item.index}. ${this.escapeHtml(item.title)}</div>
                    <div class="track-artist">${this.escapeHtml(item.uploader)}</div>
                </div>
                ${matched ? `<div class="progress-bar-mini"><div class="progress-fill-mini" style="width: 0%"></div></div>` : ''}
            `;

            listContainer.appendChild(itemElement);
        });

        const matchedCount = listContainer.querySelectorAll('.matched').length;
        document.getElementById('spotifyMatched').textContent = matchedCount;
    }

    async convertMatchedSpotify() {
        if (!this.currentSpotifyTask.id) {
            this.showNotification(this.t('notif.spotifyMappingFirst'), 'error', 'error');
            return;
        }

        try {
            const format = document.getElementById('formatSelect').value;
            const bitrate = document.getElementById('bitrateSelect').value;
            const sampleRate = document.getElementById('sampleRateSelect').value;
            const includeLyrics = document.getElementById('lyricsCheckbox').checked;
            const validItems = this.getCurrentSpotifyMatchedItems();
            if (validItems.length === 0) {
                this.showNotification(this.t('notif.noMatchedTracks'), 'error', 'error');
                return;
            }

            const payload = {
                url: document.getElementById('urlInput').value.trim(),
                format,
                bitrate,
                sampleRate: sampleRate,
                isPlaylist: true,
                selectedIndices: validItems.map(item => item.index),
                spotifyMapId: this.currentSpotifyTask.id,
                metadata: {
                    source: "spotify",
                    spotifyTitle: document.getElementById('spotifyTitle').textContent,
                    selectedIds: validItems.map(item => item.id),
                    frozenEntries: validItems,
                    spotifyMapId: this.currentSpotifyTask.id,
                    includeLyrics
                }
            };

            document.getElementById('spotifyStatusText').textContent = this.t('status.conversionStarting');

            const jobId = await this.submitSpotifyJob(payload);

            if (jobId) {
                this.currentSpotifyTask.jobId = jobId;
                document.getElementById('spotifyStatusText').textContent = this.t('status.conversionStarted');
                this.showNotification(this.t('notif.tracksQueued', { count: validItems.length }), 'success', 'queue');
                this.trackJob(jobId);
            }

        } catch (error) {
            this.showNotification(`${this.t('notif.conversionError')}: ${error.message}`, 'error', 'error');
            document.getElementById('spotifyStatusText').textContent = this.t('status.conversionFailed');
        }
    }

    getCurrentSpotifyMatchedItems() {
        const validItems = [];
        const listItems = document.querySelectorAll('.spotify-track-item.matched');

        listItems.forEach(item => {
            const titleEl = item.querySelector('.track-title');
            const artistEl = item.querySelector('.track-artist');
            if (titleEl && artistEl) {
                const title = titleEl.textContent.replace(/^\d+\.\s/, '');
                const artist = artistEl.textContent;
                const index = parseInt(titleEl.textContent.match(/^(\d+)\./)?.[1]) || validItems.length + 1;
                const ytId = item.dataset.ytId || `spotify_${index}_${Date.now()}`;

                validItems.push({
                    title,
                    uploader: artist,
                    index: index,
                    id: ytId
                });
            }
        });

        return validItems;
    }

    async getValidSpotifyItems() {
        const validItems = [];
        const listItems = document.querySelectorAll('.spotify-track-item.matched');

        listItems.forEach(item => {
            const titleEl = item.querySelector('.track-title');
            const artistEl = item.querySelector('.track-artist');
            if (titleEl && artistEl) {
                const title = titleEl.textContent.replace(/^\d+\.\s/, '');
                const artist = artistEl.textContent;
                const index = parseInt(titleEl.textContent.match(/^(\d+)\./)?.[1]) || validItems.length + 1;
                const tempId = `spotify_${index}_${Date.now()}`;

                validItems.push({
                    title,
                    uploader: artist,
                    index: index,
                    id: tempId
                });
            }
        });

        return validItems;
    }

    async submitSpotifyJob(payload) {
        try {
            const response = await fetch('/api/jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const e = await response.json().catch(() => ({}));
                throw new Error(e?.error?.message || this.t('errors.jobCreationFailed'));
            }

            const result = await response.json();
            return result.id;

        } catch (error) {
            console.error('Spotify job submission error:', error);
            throw error;
        }
    }

    trackSpotifyJob(jobId) {
        const eventSource = new EventSource(`/api/stream/${jobId}`);

        eventSource.onmessage = (event) => {
            const job = JSON.parse(event.data);
            job.status = this.normalizeStatus(job.status);
            job.currentPhase = this.normalizeStatus(job.currentPhase);
            job.phase = this.normalizeStatus(job.phase);
            this.updateSpotifyJobUI(job);

            if (job.status === 'completed' || job.status === 'error' || job.status === 'canceled') {
                eventSource.close();
                this.onSpotifyJobCompleted(job);
            }
        };

        eventSource.onerror = (error) => {
            console.error('Spotify job SSE error:', error);
            eventSource.close();
        };
    }

    updateSpotifyJobUI(job) {
        let statusText = `${this.t('status.' + job.status) || job.status} - ${job.progress}%`;

        if (job.playlist) {
            statusText += ` (${job.playlist.done}/${job.playlist.total})`;
        }

        document.getElementById('convertStatusText').textContent = statusText;
    }

    onSpotifyJobCompleted(job) {
        if (job.status === 'completed') {
            document.getElementById('convertStatusText').textContent = this.t('status.completed');
            if (job.resultPath || job.zipPath) {
                this.showSpotifyDownloads(job);
            }
        } else {
            document.getElementById('convertStatusText').textContent = this.t('status.error');
            document.getElementById('convertMatchedBtn').disabled = false;
        }
    }

    showSpotifyDownloads(job) {
        const downloadList = document.getElementById('spotifyDownloadList');
        downloadList.innerHTML = '';
        const hasLyrics = !!job?.metadata?.includeLyrics;
        if (Array.isArray(job.resultPath)) {
            job.resultPath.forEach((result, index) => {
                const item = document.createElement('div');
                item.className = 'download-item';
                const trackTitle = job.metadata?.frozenEntries?.[index]?.title || this.t('ui.track', { number: index + 1 });
                item.innerHTML = `
                    <span>${index + 1}. ${this.escapeHtml(trackTitle)}</span>
                    <a href="${this.toRelative(result.outputPath)}" class="download-btn" download>
                        ${this.t('download.single')}
                    </a>
                `;
                downloadList.appendChild(item);
            });
        }

        if (job.zipPath) {
            const zipItem = document.createElement('div');
            zipItem.className = 'download-item zip-all';
            zipItem.innerHTML = `
                <strong>${this.t('ui.all')}:</strong>
                <a href="${this.toRelative(job.zipPath)}" class="download-btn" download>
                    ${hasLyrics ? this.t('download.allWithLyrics') : this.t('download.all')}
                </a>
            `;
            downloadList.appendChild(zipItem);
        }
        document.getElementById('spotifyDownloadSection').style.display = 'block';
    }

    async handleUrlSubmit(e) {
        e.preventDefault();
        const url = document.getElementById('urlInput').value.trim();
        const format = document.getElementById('formatSelect').value;
        const bitrate = document.getElementById('bitrateSelect').value;
        const sampleRateSelect = document.getElementById('sampleRateSelect');
        const sampleRate = sampleRateSelect ? parseInt(sampleRateSelect.value) : 48000;
        const isPlaylist = document.getElementById('playlistCheckbox').checked;
        const sequential = document.getElementById('sequentialChk')?.checked;
        const includeLyrics = document.getElementById('lyricsCheckbox').checked;

        if ((format === 'eac3' || format === 'ac3') && !sampleRate) {
         this.showNotification(this.t('notif.sampleRateRequired'), 'error', 'error');
         return;
     }

        if (this.isSpotifyUrl(url)) {
            if (!this.currentSpotifyTask.completed) {
                this.showNotification(this.t('notif.completeSpotifyFirst'), 'error', 'error');
                return;
            }
            await this.convertMatchedSpotify();
            return;
        }

        if (isPlaylist) {
            const selectedIndices = Array.from(this.currentPreview.selected);
            if (sequential && selectedIndices.length > 1) {
                const batchId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
                this.ensureBatch(batchId, selectedIndices.length, { format, bitrate, source: this.t('ui.youtubePlaylist') });
                for (const idx of selectedIndices) {
                    const payload = {
                        url, format, bitrate,
                        sampleRate: sampleRate,
                        isPlaylist: true,
                        selectedIndices: [idx],
                        clientBatch: batchId,
                        includeLyrics
                    };
                    this.submitJob(payload);
                }
            } else {
                const payload = {
                    url, format, bitrate,
                    isPlaylist: true,
                    sampleRate: sampleRate,
                    selectedIndices: selectedIndices.length ? selectedIndices : 'all',
                    includeLyrics
                };
                await this.submitJob(payload);
            }
        } else {
            const payload = {
                url, format, bitrate,
                isPlaylist: false,
                sampleRate: Number(sampleRate),
                includeLyrics
            };
            await this.submitJob(payload);
        }

        document.getElementById('urlForm').reset();
        document.getElementById('playlistCheckbox').checked = false;
        document.getElementById('lyricsCheckbox').checked = false;
        this.hidePreview();
    }

    async handleFileSubmit(e) {
        e.preventDefault();
        const fileInput = document.getElementById('fileInput');
        const format = document.getElementById('formatSelect').value;
        const bitrate = document.getElementById('bitrateSelect').value;
        const sampleRate = document.getElementById('sampleRateSelect').value;
        const includeLyrics = document.getElementById('lyricsCheckbox').checked;

        if (!fileInput.files.length) {
            this.showNotification(this.t('notif.pickFile'), 'error', 'error');
            return;
        }

        const formData = new FormData();
        formData.append('file', fileInput.files[0]);
        formData.append('format', format);
        formData.append('bitrate', bitrate);
        formData.append('sampleRate', sampleRate);
        formData.append('includeLyrics', includeLyrics);

        await this.submitJob(formData, true);
        document.getElementById('fileForm').reset();
        document.getElementById('lyricsCheckbox').checked = false;
    }

    async submitJob(payload, isFormData = false) {
        try {
            console.log("Gönderilen payload:", payload);

            const format = document.getElementById('formatSelect').value;
            if (format === 'eac3' || format === 'ac3') {
                const stereoConvert = document.getElementById('stereoConvertSelect')?.value || 'auto';
                const atempoAdjust = document.getElementById('atempoSelect')?.value || 'none';

                if (!isFormData) {
                    payload.stereoConvert = stereoConvert;
                    payload.atempoAdjust = atempoAdjust;
                } else {
                    payload.append('stereoConvert', stereoConvert);
                    payload.append('atempoAdjust', atempoAdjust);
                }
            }

            const response = await fetch('/api/jobs', {
                method: 'POST',
                headers: isFormData ? {} : { 'Content-Type': 'application/json' },
                body: isFormData ? payload : JSON.stringify(payload)
            });

            if (!response.ok) {
                const e = await response.json().catch(() => ({}));
                const msg = e?.error?.code ? this.t(`errors.${e.error.code}`) : (e?.error?.message || 'error');
                throw new Error(msg);
            }

            const result = await response.json();
            console.log("Job oluşturuldu:", result);

            if (result.clientBatch) {
                this.jobToBatch.set(result.id, result.clientBatch);
                this.ensureBatch(result.clientBatch, result.batchTotal, {
                    format: result.format,
                    bitrate: result.bitrate,
                    source: result.source
                });
                this.trackJob(result.id, result.clientBatch);
            } else {
                const empty = document.getElementById('job-empty');
                if (empty) empty.remove();
                this.trackJob(result.id);
            }

            this.showNotification(this.t('notif.queue'), 'success', 'queue');
        } catch (error) {
            console.error("Job gönderme hatası:", error);
            this.showNotification(`${this.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
        }
    }

    trackJob(jobId, batchId = null) {
        if (this.currentJobs.has(jobId)) return;
        const eventSource = new EventSource(`/api/stream/${jobId}`);
        let firstUpdate = true;

        eventSource.onmessage = (event) => {
            const job = JSON.parse(event.data);
            job.status = this.normalizeStatus(job.status);
            job.currentPhase = this.normalizeStatus(job.currentPhase);
            job.phase = this.normalizeStatus(job.phase);
            this.jobStates.set(jobId, job);

            if (firstUpdate) {
                firstUpdate = false;
                document.dispatchEvent(new CustomEvent('job:first-update', { detail: { jobId, job } }));
            }

            this.updateJobUI(job, batchId);
            if (job.status === 'completed' || job.status === 'error' || job.status === 'canceled') {
                eventSource.close();
                this.currentJobs.delete(jobId);
            }
        };

        eventSource.onerror = (error) => {
            console.error('SSE error:', error);
            eventSource.close();
            this.currentJobs.delete(jobId);
        };

        this.currentJobs.set(jobId, eventSource);
    }

    uiCurrentIndex(job) {
        const total = job.playlist?.total;
        const done = job.playlist?.done;
        const current = job.playlist?.current || done;
        if (Number.isFinite(total) && Number.isFinite(done) && total > 0) {
            return Math.min(Math.max(0, done || 0), Math.max(0, total - 1));
        }
        return null;
    }

    uiNowTitle(job) {
        if (job.metadata?.isPlaylist && Array.isArray(job.metadata?.frozenEntries) && job.metadata.frozenEntries.length) {
            const i0 = job.playlist?.current || this.uiCurrentIndex(job);
            if (i0 !== null && job.metadata.frozenEntries[i0]) {
                const e = job.metadata.frozenEntries[i0];
                return `${e.index}. ${e.title}`;
            }
        }
        const ex = job.metadata?.extracted || {};
        return ex.track || ex.title || job.metadata?.originalName || null;
    }

    updateJobUI(job, batchId = null) {
        const statusNorm = this.normalizeStatus(job.status);
        const batchKey = batchId || job.clientBatch;

        if (batchKey) {
            const batch = this.batches.get(batchKey);
            if (batch) {
                batch.jobs.add(job.id);
                this.jobStates.set(job.id, job);

                if (statusNorm === 'completed' && job.resultPath && !Array.isArray(job.resultPath)) {
                    const selIdx = Array.isArray(job.metadata?.selectedIndices)
                        ? job.metadata.selectedIndices[0]
                        : null;

                    let resolvedTitle =
                        job.metadata?.extracted?.track ||
                        job.metadata?.originalName ||
                        (selIdx && this.currentPreview.indexToTitle.get(selIdx)) ||
                        this.t('ui.track');

                    this.appendBatchRow(batchKey, {
                        title: resolvedTitle,
                        href: this.toRelative(job.resultPath)
                    });
                }
                this.updateBatchProgress(batchKey);
                const allJobs = Array.from(batch.jobs);
                const completedJobs = allJobs.filter(jobId => {
                    const j = this.jobStates.get(jobId);
                    return j && this.normalizeStatus(j.status) === 'completed';
                }).length;
                if (completedJobs >= batch.total && !batch.el.querySelector('.zip-all')) {
                    const lastCompletedJob = allJobs.map(id => this.jobStates.get(id))
                        .find(j => j && this.normalizeStatus(j.status) === 'completed' && j.zipPath);

                    if (lastCompletedJob && lastCompletedJob.zipPath) {
                        const zipBtn = document.createElement('div');
                        zipBtn.className = 'download-item zip-all';
                        zipBtn.innerHTML = `
                            <strong>${this.t('ui.all')}:</strong>
                            <a href="${this.toRelative(lastCompletedJob.zipPath)}" class="download-btn" download>${this.t('download.allZip')}</a>
                        `;
                        batch.el.querySelector('.download-list').appendChild(zipBtn);
                    }
                }
            }
            return;
        }

        let phaseInfo = '';
        if (job.metadata?.source === 'spotify' && job.phase) {
            const phaseText = {
                mapping: this.t('phase.mapping'),
                downloading: this.t('phase.downloading'),
                converting: this.t('phase.converting'),
                completed: this.t('phase.completed')
            };
            phaseInfo = ` • ${phaseText[job.phase] || job.phase}`;
        }

        let phaseDetails = '';
        if (job.currentPhase) {
            const phaseTexts = {
                preparing: this.t('phase.preparing'),
                downloading: this.t('phase.downloading'),
                converting: this.t('phase.converting'),
                completed: this.t('phase.completed'),
                canceled: this.t('status.canceled'),
                cancelled: this.t('status.canceled'),
                error: this.t('phase.error')
            };

            const currentPhaseText = phaseTexts[job.currentPhase] || job.currentPhase;

            if (job.playlist && job.playlist.total) {
                if (job.metadata?.source === 'spotify') {
                    let downloaded, converted;

                    if (job.currentPhase === 'downloading') {
                        downloaded = job.playlist.done || 0;
                        converted = 0;
                    } else if (job.currentPhase === 'converting') {
                        downloaded = job.playlist.total;
                        converted = job.playlist.done || 0;
                    } else {
                        downloaded = job.playlist.done || 0;
                        converted = job.playlist.done || 0;
                    }

                    phaseDetails = `
                        <div class="phase-details">
                            <div class="phase-details__title">${currentPhaseText}</div>
                            <div class="phase-details__grid">
                                <span class="phase-details__item">
                                    🎵 ${this.t('ui.current')}:
                                    <span class="phase-details__value">${(job.playlist.current || job.playlist.done || 0) + 1}</span>
                                </span>
                                <span class="phase-details__item">
                                    📥 ${this.t('ui.downloading')}:
                                    <span class="phase-details__value">${downloaded}/${job.playlist.total}</span>
                                </span>
                                <span class="phase-details__item">
                                    ⚡ ${this.t('ui.converting')}:
                                    <span class="phase-details__value">${converted}/${job.playlist.total}</span>
                                </span>
                            </div>
                        </div>
                    `;
                } else {
                    let downloaded, converted;

                    if (job.counters && typeof job.counters.dlDone === 'number' && typeof job.counters.cvDone === 'number') {
                        downloaded = job.counters.dlDone;
                        converted = job.counters.cvDone;
                    } else {
                        downloaded = job.downloadProgress >= 100 ? job.playlist.total : Math.floor((job.downloadProgress / 100) * job.playlist.total);
                        converted = job.convertProgress >= 100 ? job.playlist.total : Math.floor((job.convertProgress / 100) * job.playlist.total);
                    }
                    const currentTrack = job.playlist.current !== undefined ? job.playlist.current + 1 : (downloaded + 1);

                    phaseDetails = `
                        <div class="phase-details">
                            <div class="phase-details__title">${currentPhaseText}</div>
                            <div class="phase-details__grid">
                                <span class="phase-details__item">
                                    🎵 ${this.t('ui.current')}:
                                    <span class="phase-details__value">${currentTrack}</span>
                                </span>
                                <span class="phase-details__item">
                                    📥 ${this.t('ui.downloading')}:
                                    <span class="phase-details__value">${downloaded}/${job.playlist.total}</span>
                                </span>
                                <span class="phase-details__item">
                                    ⚡ ${this.t('ui.converting')}:
                                    <span class="phase-details__value">${converted}/${job.playlist.total}</span>
                                </span>
                            </div>
                        </div>
                    `;
                }
            } else if (job.metadata?.isPlaylist) {
            const dlDone = Number(job?.counters?.dlDone || 0);
            const cvDone = Number(job?.counters?.cvDone || 0);
            const total  = Number(
                (job?.playlist && job.playlist.total) ||
                (job?.counters && job.counters.dlTotal) || 0
            );
            const totalTxt = total > 0 ? total : '?';
            const curIdx = (job.playlist && Number.isFinite(job.playlist.current))
                ? (job.playlist.current + 1)
                : (dlDone + 1);
            phaseDetails = `
                <div class="phase-details">
                    <div class="phase-details__title">${currentPhaseText}</div>
                    <div class="phase-details__grid">
                        <span class="phase-details__item">
                            🎵 ${this.t('ui.current')}:
                            <span class="phase-details__value">${curIdx}</span>
                        </span>
                        <span class="phase-details__item">
                            📥 ${this.t('ui.downloading')}:
                            <span class="phase-details__value">${dlDone}/${totalTxt}</span>
                        </span>
                        <span class="phase-details__item">
                            ⚡ ${this.t('ui.converting')}:
                            <span class="phase-details__value">${cvDone}/${totalTxt}</span>
                        </span>
                    </div>
                </div>
            `;
        } else {
            phaseDetails = `
                <div class="phase-details" style="margin-top: 8px;">
                    <div class="phase-details__title" style="margin-bottom: 6px;">${currentPhaseText}</div>
                        <div class="phase-details__grid">
                            <span class="phase-details__item">
                                📥 ${this.t('ui.downloading')}:
                                <span class="phase-details__value">${Math.floor(job.downloadProgress || 0)}%</span>
                            </span>
                                <span class="phase-details__item">
                                ⚡ ${this.t('ui.converting')}:
                                <span class="phase-details__value">${Math.floor(job.convertProgress || 0)}%</span>
                            </span>
                        </div>
                    </div>
                `;
            }
        }

        let jobElement = document.getElementById(`job-${job.id}`);

        if (!jobElement) {
            const empty = document.getElementById('job-empty');
            if (empty) empty.remove();
            jobElement = document.createElement('div');
            jobElement.id = `job-${job.id}`;
            jobElement.className = 'job-item';
            document.getElementById('jobList').appendChild(jobElement);
        }

        const statusText = {
            queued: this.t('status.queued'),
            running: this.t('status.running'),
            completed: this.t('status.completed'),
            error: this.t('status.error'),
            canceled: this.t('status.canceled'),
            cancelled: this.t('status.canceled')
        };

        let jobTitle = job.metadata?.originalName || job.metadata?.source || '';

        if (job.metadata?.source === 'spotify') {
            jobTitle = `🎵 ${job.metadata.spotifyTitle || this.t('ui.spotifyPlaylist')}`;
        }
        {
            const nowTrack = this.uiNowTitle(job);
            if (job.metadata?.isPlaylist && nowTrack) {
                const listName =
                    job.metadata?.frozenTitle
                    || (job.metadata?.source === 'spotify'
                        ? (job.metadata?.spotifyTitle || this.t('ui.spotifyPlaylist'))
                        : this.t('ui.youtubePlaylist'));
                jobTitle = `${this.escapeHtml(listName)} — ${this.escapeHtml(nowTrack)}`;
            }
        }

        const skippedCount = this.computeSkipped(job);
        const skippedKeywords = /(private|izin|skipp?ed|unavailable|atlan(?:d|an)|blocked|copyright|region|geo)/i;
        const showSkippedBadge =
            (skippedCount > 0) ||
            (job.lastLog && skippedKeywords.test(String(job.lastLog))) ||
            (job.lastLogKey && skippedKeywords.test(String(job.lastLogKey))) ||
            (job.error && skippedKeywords.test(String(job.error?.message || job.error)));

        const skippedBadge = showSkippedBadge
            ? `<span class="chip chip--warn" title="${this.escapeHtml(job.lastLog || 'atlananlar')}">⚠️ ${this.t('jobs.skipped')}${skippedCount ? ` (${skippedCount})` : ''}</span>`
            : '';

        let resultContent = '';

        if (job.status === 'completed') {
            if (Array.isArray(job.resultPath)) {
                const successfulResults = job.resultPath.filter(r => r.outputPath && !r.error);
                if (successfulResults.length > 0) {
                    const hasLyrics = job.metadata.includeLyrics;
                    const downloadText = hasLyrics ? this.t('download.withLyrics') : this.t('download.single');
                    resultContent = `
                        <div class="download-list">
                            ${successfulResults.map((r, i) => {
                                const trackTitle = job.metadata?.frozenEntries?.[i]?.title || this.t('ui.track', { number: i + 1 });
                                const lrcBtn = r.lyricsPath
                                    ? `<a href="${this.toRelative(r.lyricsPath)}" class="download-btn" download>${this.t('download.lyrics')}</a>`
                                    : '';
                                return `
                                    <div class="download-item">
                                        <span>${i + 1}. ${this.escapeHtml(trackTitle)}</span>
                                        <a href="${this.toRelative(r.outputPath)}" class="download-btn" download>${this.t('download.single')}</a>
                                        ${lrcBtn}
                                    </div>
                                `;
                            }).join('')}
                            ${job.zipPath ? `
                                <div class="download-item" style="margin-top:8px;">
                                    <strong>${this.t('ui.all')}:</strong>
                                    <a href="${this.toRelative(job.zipPath)}" class="download-btn" download>
                                        ${hasLyrics ? this.t('download.allWithLyrics') : this.t('download.all')}
                                    </a>
                                </div>` : ''}
                        </div>
                    `;
                } else {
                    resultContent = `<div style="color: var(--error); font-size: 13px;">❌ ${this.t('ui.noFilesConverted')}</div>`;
                }
            } else if (job.resultPath) {
                const rp = (typeof job.resultPath === 'string')
                    ? { outputPath: job.resultPath }
                    : job.resultPath;
                const hasLyricsFlag = !!rp.lyricsPath;
                const baseBtn = `<a href="${this.toRelative(rp.outputPath)}" class="download-btn" download>${this.t('download.single')}</a>`;
                const lrcBtn = hasLyricsFlag
                    ? `<a href="${this.toRelative(rp.lyricsPath)}" class="download-btn" download>${this.t('download.lyrics')}</a>`
                    : '';
                resultContent = `${baseBtn} ${lrcBtn}`;
            }
        }

        const totalProgress = job.progress || 0;

        let lyricsInfo = '';

        if (job.metadata?.includeLyrics && job.metadata?.lyricsStats) {
            const stats = job.metadata.lyricsStats;
            lyricsInfo = `<div class="lyrics-stats" style="font-size: 12px; color: var(--text-muted); margin: 4px 0;">
                🎼 ${this.t('label.includeLyrics2')}: ${this.t('ui.found')} ${stats.found}, ${this.t('ui.notFound')} ${stats.notFound}
            </div>`;
        }

        let lastLogInfo = '';

        if (job.lastLog || job.lastLogKey) {
            const raw = job.lastLogKey ? this.t(job.lastLogKey, job.lastLogVars || {}) : this.normalizeLog(job.lastLog);
            lastLogInfo = `<div class="last-log" style="font-size: 12px; color: var(--text-muted); margin: 4px 0; font-style: italic;">
                ${this.escapeHtml(raw)}
            </div>`;
        }

        jobElement.innerHTML = `
            <strong>${this.escapeHtml(jobTitle)}</strong>
            <div style="font-size: 13px; color: var(--text-muted); margin: 8px 0;">
                ${job.format.toUpperCase()} • ${job.bitrate}
                ${job.sampleRate ? ` • ${Math.round(job.sampleRate / 1000)} kHz` : ''}
                ${job.metadata?.isPlaylist ? ` • ${this.t('ui.playlist')}` : ''}
                ${job.metadata?.includeLyrics ? ` • 🎼 ${this.t('label.includeLyrics2')}` : ''}
                ${phaseInfo}
                ${skippedBadge}
            </div>

            ${lyricsInfo}
            ${lastLogInfo}

            ${phaseDetails}

            ${(() => {
                const nt = this.uiNowTitle(job);
                return nt ? `<div class="muted" style="font-size:12px; margin: 8px 0 4px 0;">▶️ <strong>${this.escapeHtml(nt)}</strong></div>` : '';
            })()}

            <div class="progress-bar">
                <div class="progress-fill" style="width: ${totalProgress}%"></div>
            </div>
            <div class="job-actions" style="display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px;">
                <span class="status status-${job.status}">${statusText[job.status]}</span>
                <div style="display:flex; gap:8px; align-items:center; flex-direction: column;">
                    ${resultContent}
                    <button class="btn-danger" data-stop="${job.id}" ${(['completed', 'error', 'canceled'].includes(statusNorm)) ? 'disabled' : ''} title="${this.t('btn.stop')}">${this.t('btn.stop')}</button>
                </div>
            </div>
            ${job.error ? `<div style="color: var(--error); font-size: 13px; margin-top: 8px; padding: 8px; background: var(--bg-card); border-radius: 6px;">${this.escapeHtml(job.error)}</div>` : ''}
        `;

        const stopBtn = jobElement.querySelector(`[data-stop="${job.id}"]`);
        if (stopBtn) {
            stopBtn.addEventListener('click', async () => {
                stopBtn.disabled = true;

                const bId = this.jobToBatch.get(job.id) || job.clientBatch || null;

                try {
                    if (bId) {
                        await this.cancelBatch(bId);
                    } else {
                        const r = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST' });
                        if (!r.ok) {
                            const e = await r.json().catch(() => ({}));
                            throw new Error(e?.error?.message || this.t('notif.cancelFailed'));
                        }
                        const js = this.jobStates.get(job.id) || {};
                        js.status = 'canceled';
                        js.phase = 'canceled';
                        this.jobStates.set(job.id, js);
                        this.updateJobUI(js, this.jobToBatch.get(job.id) || null);
                    }

                    this.showNotification(this.t('notif.canceledByUser'), 'success', 'action');
                } catch (e) {
                    stopBtn.disabled = false;
                    this.showNotification(`${this.t('notif.cancelFailed')}: ${e.message}`, 'error', 'error');
                }
            });
        }
    }

    ensureBatch(batchId, total, meta) {
        let batch = this.batches.get(batchId);

        if (batch) {
            if (Number.isFinite(total)) batch.total = total;
            return batch;
        }

        const jobList = document.getElementById('jobList');
        const empty = document.getElementById('job-empty');
        if (empty) empty.remove();

        const batchElement = document.createElement('div');
        batchElement.className = 'job-item';
        batchElement.id = `batch-${batchId}`;
        const sourceText = meta?.source || this.t('ui.playlist');
        const seqText = this.t('label.sequential');
        batchElement.innerHTML = `
            <strong>${sourceText} — ${this.t('label.sequential')}</strong>
            <div style="font-size: 13px; color: var(--text-muted); margin: 8px 0;">
                ${meta?.format?.toUpperCase() || ''} • ${meta?.bitrate || ''}
            </div>
            <div class="progress-bar">
                <div class="progress-fill" id="batch-progress-${batchId}" style="width: 0%"></div>
            </div>
            <div class="batch-info">
                ${this.t('batch.done')}: <span id="batch-done-${batchId}">0</span> / <span id="batch-total-${batchId}">${total || '?'}</span>
            </div>
            <div class="batch-actions" style="margin:8px 0 4px; display:flex; justify-content:flex-end;">
                <button class="btn-danger" data-stop-batch="${batchId}">
                    ${this.t('btn.stop') || 'Hepsini Durdur'}
                </button>
            </div>
            <div class="download-list" id="batch-list-${batchId}"></div>
        `;

        jobList.appendChild(batchElement);

        batch = {
            el: batchElement,
            total: total || 0,
            done: 0,
            jobs: new Set()
        };

        this.batches.set(batchId, batch);
        const stopBtn = batchElement.querySelector(`[data-stop-batch="${batchId}"]`);
        if (stopBtn) {
            stopBtn.addEventListener('click', () => this.cancelBatch(batchId));
        }
        return batch;
    }

    appendBatchRow(batchId, { title, href }) {
        const list = document.getElementById(`batch-list-${batchId}`);
        if (!list) return;

        const row = document.createElement('div');
        row.className = 'download-item';
        row.innerHTML = `
            <span>${this.escapeHtml(title || this.t('ui.track'))}</span>
            <a href="${this.toRelative(href)}" class="download-btn" download>${this.t('download.single')}</a>
        `;
        list.appendChild(row);
    }

    updateBatchProgress(batchId) {
        const batch = this.batches.get(batchId);
        if (!batch) return;
        const completedJobs = Array.from(batch.jobs).filter(jobId => {
            const job = this.jobStates.get(jobId);
            return job && job.status === 'completed';
        }).length;

        batch.done = completedJobs;

        const progressElement = document.getElementById(`batch-progress-${batchId}`);
        const doneElement = document.getElementById(`batch-done-${batchId}`);
        const totalElement = document.getElementById(`batch-total-${batchId}`);

        if (progressElement && doneElement && totalElement) {
            const percentage = batch.total > 0 ? Math.min(100, (completedJobs / batch.total) * 100) : 0;
            progressElement.style.width = `${percentage}%`;
            doneElement.textContent = completedJobs;
            totalElement.textContent = batch.total;
        }

        const anyActive = Array.from(batch.jobs).some(jobId => {
            const j = this.jobStates.get(jobId);
            const s = j ? this.normalizeStatus(j.status) : 'completed';
            return !['completed', 'error', 'canceled'].includes(s);
        });
        const stopBtn = document.querySelector(`[data-stop-batch="${batchId}"]`);
        if (stopBtn) stopBtn.disabled = !anyActive;
    }

    async previewPlaylist() {
        const url = document.getElementById('urlInput').value.trim();
        const isPlaylist = document.getElementById('playlistCheckbox').checked;
        const btn = document.getElementById('previewBtn');
        if (!url) {
            this.showNotification(this.t('notif.needUrl'), 'error', 'error');
            return;
        }
        if (this.isSpotifyUrl(url)) {
            try {
                btn?.classList.add('btn-loading');
                btn?.setAttribute('disabled', 'disabled');
                btn.textContent = this.t('ui.loading');
                const batchSize = Number(document.getElementById('pageSizeSel').value) || 10;
                await this.streamPreviewByPaging(url, Math.max(1, Math.min(50, batchSize)));
            } catch (e) {
                this.showNotification(`${this.t('notif.errorPrefix')}: ${e.message}`, 'error', 'error');
            } finally {
                btn?.classList.remove('btn-loading');
                btn?.removeAttribute('disabled');
                btn.textContent = this.t('btn.preview');
            }
            return;
        }
        if (!isPlaylist) {
            this.showNotification(this.t('notif.checkPlaylist'), 'error', 'error');
            return;
        }
        this.currentPreview.url = url;
        this.currentPreview.page = 1;
        this.currentPreview.pageSize = Number(document.getElementById('pageSizeSel').value) || 25;
        try {
            btn?.classList.add('btn-loading');
            btn?.setAttribute('disabled', 'disabled');
            btn.textContent = this.t('ui.loading');
            if (this.previewAbort) this.previewAbort.abort();
            this.previewAbort = new AbortController();
            const res = await fetch('/api/playlist/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url,
                    page: this.currentPreview.page,
                    pageSize: this.currentPreview.pageSize
                }),
                signal: this.previewAbort.signal
            });
            const data = await res.json();
            if (!res.ok) {
                const code = data?.error?.code || 'PREVIEW_FAILED';
                throw new Error(this.t(`errors.${code}`) || this.t('errors.previewFailed'));
            }

            this.currentPreview.items = data.items || [];
            this.currentPreview.title = data.playlist?.title || '';
            this.currentPreview.count = data.playlist?.count || 0;
            document.getElementById('pageNo').textContent = String(this.currentPreview.page);
            document.getElementById('pageSizeSel').value = String(this.currentPreview.pageSize);
            this.renderPreview();
            this.showPreview();
        } catch (e) {
            this.showNotification(`${this.t('notif.errorPrefix')}: ${e.message}`, 'error', 'error');
        } finally {
            btn?.classList.remove('btn-loading');
            btn?.removeAttribute('disabled');
            btn.textContent = this.t('btn.preview');
        }
    }

    async streamPreviewByPaging(url, batchSize) {
        this.currentPreview.url = url;
        this.currentPreview.isSpotify = true;
        this.currentPreview.streaming = true;
        this.currentPreview.selected = new Set();
        this.currentPreview.items = [];
        this.currentPreview.page = 1;
        this.currentPreview.pageSize = batchSize;
        this.showPreview();

        const listEl = document.getElementById('previewList');
        const pagerPrev = document.getElementById('prevPageBtn');
        const pagerNext = document.getElementById('nextPageBtn');
        pagerPrev.disabled = true;
        pagerNext.disabled = true;

        const first = await fetch('/api/playlist/preview', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, page: 1, pageSize: batchSize })
        });
        const firstData = await first.json();
        if (!first.ok) throw new Error(firstData?.error?.message || this.t('errors.previewFailed'));
        this.currentPreview.title = firstData?.playlist?.title || '-';
        this.currentPreview.count = Number(firstData?.playlist?.count || 0);
        document.getElementById('plTitle').textContent = this.currentPreview.title;
        document.getElementById('plCount').textContent = this.currentPreview.count;
        document.getElementById('plSelected').textContent = this.currentPreview.selected.size;
        listEl.innerHTML = '';

        this.appendPreviewItems(firstData.items || []);
        this.updateStreamLog(firstData.items?.at(-1));
        const totalPages = Math.max(1, Math.ceil(this.currentPreview.count / batchSize));
        for (let p = 2; p <= totalPages; p++) {
            if (this.previewAbort) this.previewAbort.abort();
            this.previewAbort = new AbortController();
            const res = await fetch('/api/playlist/preview', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, page: p, pageSize: batchSize }),
                signal: this.previewAbort.signal
            });
            const data = await res.json();
            if (!res.ok) break;
            this.appendPreviewItems(data.items || []);
            this.updateStreamLog(data.items?.at(-1));
        }
        this.currentPreview.streaming = false;
        this.updateStreamLog(null, true);
    }

    appendPreviewItems(items) {
        const listEl = document.getElementById('previewList');
        for (const item of items) {
            this.currentPreview.items.push(item);
            if (item && Number.isFinite(item.index) && item.id) {
                this.currentPreview.indexToId.set(item.index, item.id);
            }
            if (item && Number.isFinite(item.index) && item.title) {
                this.currentPreview.indexToTitle.set(item.index, item.title);
            }
            const row = document.createElement('div');
            row.className = 'preview-row';
            row.innerHTML = `
                <img class="preview-thumb" src="${item.thumbnail || ''}" alt="thumb" onerror="this.style.display='none'" />
                <div>
                    <div class="preview-title">${item.index}. ${this.escapeHtml(item.title || '')}</div>
                    <div class="muted">${this.escapeHtml(item.uploader || '')}</div>
                </div>
                <div class="row-right muted">${item.duration_string || (item.duration ? this.formatSeconds(item.duration) : '-')}</div>
                <div class="row-right"><input type="checkbox" data-index="${item.index}" /></div>
            `;
            listEl.appendChild(row);
            const chk = row.querySelector('input[type="checkbox"]');
            chk.checked = this.currentPreview.selected.has(item.index);
            chk.addEventListener('change', (e) => {
                const i = Number(e.target.getAttribute('data-index'));
                if (e.target.checked) this.currentPreview.selected.add(i);
                else this.currentPreview.selected.delete(i);
                document.getElementById('plSelected').textContent = this.currentPreview.selected.size;
                this.updateSelectAllState();
            });
        }
    }

    updateStreamLog(lastItem, done = false) {
        const el = document.getElementById('plStreamLog');
        if (!el) return;
        el.style.display = 'block';
        const total = this.currentPreview.items.length;
        if (done) {
            el.textContent = this.t('ui.streamDone') + ` • ${this.t('ui.totalTracksLoaded', { count: total })}`;
            setTimeout(() => { el.style.display = 'none'; }, 2500);
            return;
        }
        if (lastItem) {
            const name = (lastItem?.title || '').toString();
            el.textContent = this.t('ui.streamAdded') + `: ${name} • ${total} / ${this.currentPreview.count}`;
        } else {
            el.textContent = `${this.t('ui.loading')}… ${total} / ${this.currentPreview.count}`;
        }
    }

    async loadPage(p, force = false) {
        if (!this.currentPreview.url) return;
        if (this.currentPreview.isSpotify && this.currentPreview.streaming) {
            this.showNotification(this.t('ui.liveModeNoPaging'), 'info');
            return;
        }
        const total = this.currentPreview.count || 0;
        const maxPage = Math.max(1, Math.ceil(total / this.currentPreview.pageSize));
        const next = Math.min(Math.max(1, p), maxPage);
        if (next === this.currentPreview.page && !force) return;
        try {
            const prevBtn = document.getElementById('prevPageBtn');
            const nextBtn = document.getElementById('nextPageBtn');
            prevBtn.disabled = true;
            nextBtn.disabled = true;
            const listEl = document.getElementById('previewList');
            listEl.innerHTML = `<div class="muted" style="padding:16px">${this.t('ui.loading')}</div>`;
            if (this.previewAbort) this.previewAbort.abort();
            this.previewAbort = new AbortController();
            const res = await fetch('/api/playlist/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: this.currentPreview.url,
                    page: next,
                    pageSize: this.currentPreview.pageSize
                }),
                signal: this.previewAbort.signal
            });
            const data = await res.json();
            if (!res.ok) {
                const code = data?.error?.code || 'PAGE_FETCH_FAILED';
                throw new Error(this.t(`errors.${code}`) || this.t('errors.pageLoadFailed'));
            }
            this.currentPreview.page = data.page || next;
            this.currentPreview.items = data.items || [];
            this.currentPreview.title = data.playlist?.title || this.currentPreview.title;
            this.currentPreview.count = data.playlist?.count ?? this.currentPreview.count;
            document.getElementById('pageNo').textContent = String(this.currentPreview.page);
            this.renderPreview();
        } catch (e) {
            this.showNotification(`${this.t('notif.errorPrefix')}: ${e.message}`, 'error', 'error');
        } finally {
            const prevBtn = document.getElementById('prevPageBtn');
            const nextBtn = document.getElementById('nextPageBtn');
            prevBtn.disabled = false;
            nextBtn.disabled = false;
        }
    }

    renderPreview() {
        const listEl = document.getElementById('previewList');
        const titleEl = document.getElementById('plTitle');
        const countEl = document.getElementById('plCount');
        const selectedEl = document.getElementById('plSelected');
        const selectAllEl = document.getElementById('selectAllChk');

        if (this.currentPreview.isSpotify && this.currentPreview.streaming) {
            titleEl.textContent = this.currentPreview.title || '-';
            countEl.textContent = this.currentPreview.count;
            selectedEl.textContent = this.currentPreview.selected.size;
            return;
        }

        listEl.innerHTML = '';
        titleEl.textContent = this.currentPreview.title || '-';
        countEl.textContent = this.currentPreview.count;
        selectedEl.textContent = this.currentPreview.selected.size;

        this.currentPreview.items.forEach((item) => {
            if (item && Number.isFinite(item.index) && item.id) {
                this.currentPreview.indexToId.set(item.index, item.id);
            }
            if (item && Number.isFinite(item.index) && item.title) {
                this.currentPreview.indexToTitle.set(item.index, item.title);
            }
            const row = document.createElement('div');
            row.className = 'preview-row';
            row.innerHTML = `
                <img class="preview-thumb" src="${item.thumbnail || ''}" alt="thumb" onerror="this.style.display='none'" />
                <div>
                    <div class="preview-title">${item.index}. ${this.escapeHtml(item.title || '')}</div>
                    <div class="muted">${this.escapeHtml(item.uploader || '')}</div>
                </div>
                <div class="row-right muted">${item.duration_string || (item.duration ? this.formatSeconds(item.duration) : '-')}</div>
                <div class="row-right"><input type="checkbox" data-index="${item.index}" /></div>
            `;
            listEl.appendChild(row);
        });

        listEl.querySelectorAll('input[type="checkbox"]').forEach((chk) => {
            const idx = Number(chk.getAttribute('data-index'));
            chk.checked = this.currentPreview.selected.has(idx);
            chk.addEventListener('change', (e) => {
                const i = Number(e.target.getAttribute('data-index'));
                if (e.target.checked) this.currentPreview.selected.add(i);
                else this.currentPreview.selected.delete(i);
                document.getElementById('plSelected').textContent = this.currentPreview.selected.size;
                this.updateSelectAllState();
            });
        });

        this.updateSelectAllState();
    }

    updateSelectAllState() {
        const listEl = document.getElementById('previewList');
        const chks = [...listEl.querySelectorAll('input[type="checkbox"]')];
        const totalVisible = chks.length;
        const selectedVisible = chks.filter(c => c.checked).length;
        const allEl = document.getElementById('selectAllChk');

        if (totalVisible === 0) {
            allEl.checked = false;
            allEl.indeterminate = false;
            return;
        }
        if (selectedVisible === 0) {
            allEl.checked = false;
            allEl.indeterminate = false;
        } else if (selectedVisible === totalVisible) {
            allEl.checked = true;
            allEl.indeterminate = false;
        } else {
            allEl.checked = false;
            allEl.indeterminate = true;
        }

        document.getElementById('plSelected').textContent = this.currentPreview.selected.size;
    }

    toggleSelectAll(flag) {
        const listEl = document.getElementById('previewList');
        const chks = listEl.querySelectorAll('input[type="checkbox"]');
        chks.forEach((chk) => {
            const idx = Number(chk.getAttribute('data-index'));
            chk.checked = !!flag;
            if (flag) this.currentPreview.selected.add(idx);
            else this.currentPreview.selected.delete(idx);
        });
        this.updateSelectAllState();
    }

    async convertSelected() {
        if (!this.currentPreview.url) {
            this.showNotification(this.t('notif.previewFirst'), 'error', 'error');
            return;
        }

        const selected = Array.from(this.currentPreview.selected);
        if (!selected.length) {
            this.showNotification(this.t('notif.selectAtLeastOne'), 'error', 'error');
            return;
        }

        const convertBtn = document.getElementById('convertSelectedBtn');
        const originalText = convertBtn.textContent;

        try {
            convertBtn.classList.add('btn-loading');
            convertBtn.disabled = true;
            convertBtn.textContent = this.t('ui.processing') || 'İşleniyor...';

            const format = document.getElementById('formatSelect').value;
            const bitrate = document.getElementById('bitrateSelect').value;
            const sampleRate = document.getElementById('sampleRateSelect').value;
            const sequential = document.getElementById('sequentialChk')?.checked;
            const includeLyrics = document.getElementById('lyricsCheckbox').checked;
            const selectedIds = selected
                .map(i => this.currentPreview.indexToId.get(i))
                .filter(Boolean);

            console.log("Seçilen ID'ler:", selectedIds);

            if (sequential && selected.length > 1) {
                const batchId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
                this.ensureBatch(batchId, selected.length, { format, bitrate, source: this.t('ui.youtubePlaylist') });
                for (const idx of selected) {
                    const idFromMap = this.currentPreview.indexToId.get(idx);
                    const itemId = idFromMap ? [idFromMap] : null;

                    await this.submitJob({
                        url: this.currentPreview.url,
                        isPlaylist: true,
                        selectedIndices: [idx],
                        selectedIds: itemId,
                        format,
                        bitrate,
                        sampleRate: sampleRate,
                        clientBatch: batchId,
                        includeLyrics
                    });
                }
            } else {
                await this.submitJob({
                    url: this.currentPreview.url,
                    isPlaylist: true,
                    selectedIndices: selected,
                    selectedIds: selectedIds.length ? selectedIds : null,
                    format,
                    bitrate,
                    sampleRate: sampleRate,
                    includeLyrics
                });
            }

            this.showNotification(this.t('notif.tracksQueued', { count: selected.length }), 'success', 'queue');

        } catch (error) {
            console.error('Seçilenleri dönüştürme hatası:', error);
            this.showNotification(`${this.t('notif.conversionError')}: ${error.message}`, 'error', 'error');
        } finally {
            convertBtn.classList.remove('btn-loading');
            convertBtn.disabled = false;
            convertBtn.textContent = originalText;
        }
    }

    async convertAll() {
        if (!this.currentPreview.url) {
            this.showNotification(this.t('notif.previewFirst'), 'error', 'error');
            return;
        }

        const convertAllBtn = document.getElementById('convertAllBtn');
        const originalText = convertAllBtn.textContent;

        try {
            convertAllBtn.classList.add('btn-loading');
            convertAllBtn.disabled = true;
            convertAllBtn.textContent = this.t('ui.processing') || 'İşleniyor...';

            const format = document.getElementById('formatSelect').value;
            const bitrate = document.getElementById('bitrateSelect').value;
            const sampleRate = document.getElementById('sampleRateSelect').value;
            const includeLyrics = document.getElementById('lyricsCheckbox').checked;
            const allIds = this.currentPreview.items.map(item => item.id).filter(Boolean);

            await this.submitJob({
                url: this.currentPreview.url,
                isPlaylist: true,
                selectedIndices: 'all',
                selectedIds: allIds,
                format,
                bitrate,
                sampleRate: sampleRate,
                includeLyrics
            });

            this.showNotification(this.t('notif.allTracksQueued'), 'success', 'queue');

        } catch (error) {
            console.error('Tümünü dönüştürme hatası:', error);
            this.showNotification(`${this.t('notif.conversionError')}: ${error.message}`, 'error', 'error');
        } finally {
            convertAllBtn.classList.remove('btn-loading');
            convertAllBtn.disabled = false;
            convertAllBtn.textContent = originalText;
        }
    }

    showPreview() {
        document.getElementById('spotifyPreviewCard').style.display = 'none';
        document.getElementById('playlistPreviewCard').style.display = 'block';
    }

    hidePreview() {
        document.getElementById('playlistPreviewCard').style.display = 'none';
        const spotifyCard = document.getElementById('spotifyPreviewCard');
        spotifyCard.style.display = 'none';
        document.getElementById('spotifyLogs').innerHTML = '';
        document.getElementById('spotifyPreviewList').innerHTML = '';

        const convertMatchedBtn = document.getElementById('convertMatchedBtn');
        if (convertMatchedBtn) {
            convertMatchedBtn.style.display = 'none';
        }

        if (this.spotifyEventSource) {
            this.spotifyEventSource.close();
            this.spotifyEventSource = null;
        }
        if (this.previewAbort) {
            try { this.previewAbort.abort(); } catch { }
            this.previewAbort = null;
        }

        this.currentPreview = {
            url: null, items: [], selected: new Set(),
            title: '', count: 0, page: 1, pageSize: 50,
            isSpotify: false, streaming: false,
            indexToId: new Map(),
            indexToTitle: new Map()
        };
        this.currentSpotifyTask = {
            id: null,
            jobId: null,
            completed: false
        };

        const logEl = document.getElementById('plStreamLog');
        if (logEl) { logEl.style.display = 'none'; logEl.textContent = ''; }
    }

    showQueueNotification(message) {
        this.showNotification(message, 'success', 'queue');
    }

    showErrorNotification(message) {
        this.showNotification(message, 'error', 'error');
    }

    showProgressNotification(message) {
        this.showNotification(message, 'info', 'progress');
    }

    showNotification(message, type = 'info', group = 'default') {
        this.notificationManager.showNotification(message, type, group, 3000);
    }

    normalizeBackendLog(txt) {
        if (txt == null) return '';
        try { txt = String(txt); } catch { return ''; }
        txt = txt.replace(/^SKIP_HINT:\s*/i, '');
        txt = txt.replace(/^SKIP_SUMMARY:\s*/i, '');
        if (txt.startsWith('log.') || txt.startsWith('phase.') || txt.startsWith('status.')) {
            try { return this.t(txt); } catch { }
        }
        return txt.replace(/\s+/g, ' ').trim();
    }

    escapeHtml(str) {
        if (str == null) return "";
        if (typeof str === "object") {
            const key = str.key || str.logKey || null;
            const vars = str.vars || str.logVars || null;
            const txt = str.text || str.fallback || "";
            if (key && typeof this.t === "function") {
                try { str = this.t(key, vars || {}) ?? txt ?? key; }
                catch { str = txt || key || ""; }
            } else {
                try { str = txt || JSON.stringify(str); } catch { str = String(str); }
            }
        }
        str = String(str);
        return str.replace(/[&<>"'`=\/]/g, s => this._escapeMap[s] || s);
    }

    formatSeconds(sec) {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        return (h ? h.toString().padStart(2, '0') + ':' : '') + m.toString().padStart(2, '0') + ':' + s.toString().padStart(2, '0');
    }

    async cancelBatch(batchId) {
        const batch = this.batches.get(batchId);
        if (!batch) return;
        const ids = Array.from(batch.jobs || []);
        if (!ids.length) return;

        const stopBtn = document.querySelector(`[data-stop-batch="${batchId}"]`);
        if (stopBtn) stopBtn.disabled = true;

        const tasks = ids.map(async (id) => {
            const j = this.jobStates.get(id);
            const s = this.normalizeStatus(j?.status);
            if (!j || ['completed', 'error', 'canceled'].includes(s)) return;
            try {
                const r = await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
                if (r.ok) {
                    const js = this.jobStates.get(id) || {};
                    js.status = 'canceled';
                    js.phase = 'canceled';
                    js.currentPhase = 'canceled';
                    this.jobStates.set(id, js);
                    this.updateJobUI(js, batchId);
                }
            } catch (_) { }
        });

        await Promise.allSettled(tasks);
        this.updateBatchProgress(batchId);
        this.showNotification(this.t('notif.canceledByUser') || 'Batch iptal edildi', 'success', 'action');
    }

    async handleUrlSubmitWithSpinner(e) {
        e.preventDefault();

        const startConvertBtn =
            document.getElementById('startConvertBtn') ||
            document.querySelector('#urlForm [type="submit"]');
        const spinner = startConvertBtn?.querySelector('.btn-spinner') || null;
        const btnText = startConvertBtn?.querySelector('.btn-text') || null;
        this.showButtonSpinner(startConvertBtn, spinner, btnText);

        try {
            const waitFirstUpdate = new Promise((resolve) => {
                const onFirst = () => resolve();
                const timeout = setTimeout(resolve, 15000);
                document.addEventListener('job:first-update', function handler() {
                    clearTimeout(timeout);
                    document.removeEventListener('job:first-update', handler);
                    onFirst();
                }, { once: true });
            });

            await this.handleUrlSubmit(e);
            await waitFirstUpdate;
        } catch (error) {
            console.error('URL gönderme hatası:', error);
            this.showNotification(`${this.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
        } finally {
            this.hideButtonSpinner(startConvertBtn, startConvertBtn?.querySelector('.btn-spinner') || null, startConvertBtn?.querySelector('.btn-text') || null);
        }
    }

    showButtonSpinner(button, spinner, btnText) {
        if (!button) return;
        if (!spinner) {
            const sp = document.createElement('span');
            sp.className = 'btn-spinner';
            sp.style.display = 'inline-block';
            sp.style.marginRight = '6px';
            button.prepend(sp);
            spinner = sp;
        }
        if (!btnText) {
            const textNodes = [];
            button.childNodes.forEach(n => {
                if (n.nodeType === 3 && n.textContent.trim()) textNodes.push(n);
            });
            const txt = document.createElement('span');
            txt.className = 'btn-text';
            if (textNodes.length) {
                const raw = textNodes.map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
                if (raw) txt.textContent = raw;
            }
            textNodes.forEach(n => n.remove());
            button.appendChild(txt);
            btnText = txt;
        }
        button.classList.add('btn-loading');
        if (spinner) spinner.style.display = 'inline-block';
        button.disabled = true;
    }

    hideButtonSpinner(button, spinner, btnText) {
        if (!button) return;
        button.classList.remove('btn-loading');
        if (spinner) spinner.style.display = 'none';
        button.disabled = false;
    }

    toRelative(u) {
        if (!u) return u;
        try {
            const url = new URL(u, location.origin);
            if (url.origin === location.origin) {
                return url.pathname + url.search + url.hash;
            }
            return u;
        } catch {
            return u.replace(/^https?:\/\/[^/]+/i, '');
        }
    }

    t(key, vars) {
        if (typeof key === 'string' && key.startsWith('log.download.')) {
            const fixed = key.replace('log.download.', 'log.downloading.');
            const out = window.i18n?.t?.(fixed, vars);
            if (out && out !== fixed) return out;
        }
        return (window.i18n?.t?.(key, vars)) ?? key;
    }
}
