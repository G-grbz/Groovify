import { collectJobOutputPaths, outputExistenceClient } from './OutputExistenceClient.js';

export class JobManager {
    // Initializes class state and defaults for the browser UI layer.
    constructor(app) {
        this.app = app;
        this.currentJobs = new Map();
        this.jobStates = new Map();
        this.batches = new Map();
        this.jobToBatch = new Map();
        this.sessionSectionsInitialized = false;
        this.storageKey = (typeof window !== 'undefined' && window.electronAPI)
            ? 'gharmonize_job_session_desktop'
            : 'gharmonize_job_session';
        this.progressCache = new Map();
        this.lastSessionSavedAt = 0;
        this.restoreSessionInFlight = false;

        if (typeof window !== 'undefined') {
            // Handles do restore in the browser UI layer.
            const doRestore = () => {
                try {
                    this.restoreSessionState();
                } catch (e) {
                    console.warn('[JobManager] restoreSessionState failed:', e);
                }
            };

            if (document.readyState === 'loading') {
                window.addEventListener('DOMContentLoaded', doRestore, { once: true });
            } else {
                doRestore();
            }

            window.addEventListener('storage', (event) => {
                if (event.key !== this.storageKey || !event.newValue) return;
                try {
                    const data = JSON.parse(event.newValue);
                    const savedAt = Number(data?.savedAt || 0);
                    if (savedAt && savedAt <= this.lastSessionSavedAt) return;
                    if (savedAt) this.lastSessionSavedAt = savedAt;
                    this.restoreSessionState({ persist: false });
                } catch (e) {
                    console.warn('[JobManager] external session sync failed:', e);
                }
            });
        }

        if (typeof document !== 'undefined') {
            this.handleOutputLocationBadgeClick = this.handleOutputLocationBadgeClick.bind(this);
            this.handleOutputLocationBadgeKeydown = this.handleOutputLocationBadgeKeydown.bind(this);
            document.addEventListener('click', this.handleOutputLocationBadgeClick);
            document.addEventListener('keydown', this.handleOutputLocationBadgeKeydown);
        }
    }

        // Handles track job state in the browser UI layer.
        trackJob(jobId, batchId = null) {
        if (this.currentJobs.has(jobId)) return;

        const maxRetries = 3;

        // Handles start job state sse in the browser UI layer.
        const startJobSSE = (retryCount = 0) => {
        const eventSource = new EventSource(`/api/stream/${jobId}`);
        this.currentJobs.set(jobId, eventSource);

        let firstUpdate = (retryCount === 0);

        eventSource.onmessage = (event) => {
        const incoming = JSON.parse(event.data);
        const prevJob = this.jobStates.get(jobId) || {};
        const job = this.mergeJobState(prevJob, incoming);

        job.status = this.normalizeStatus(job.status);

        const phaseNorm = this.normalizeStatus(job.currentPhase || job.phase);
        job.currentPhase = phaseNorm;
        job.phase = phaseNorm;

        this.jobStates.set(jobId, job);
        const isTerminal = ['completed', 'error', 'canceled'].includes(job.status);

        if (firstUpdate || isTerminal) {
            try {
                this.saveSessionState();
                } catch (e) {
                console.warn('[JobManager] autosave after SSE update failed:', e);
            }
        }

        if (firstUpdate) {
            firstUpdate = false;
            document.dispatchEvent(new CustomEvent('job:first-update', { detail: { jobId, job } }));
        }

        this.updateJobUI(job, batchId);

        if (isTerminal) {
            eventSource.close();
            this.currentJobs.delete(jobId);
        }
    };

        eventSource.onerror = (error) => {
        console.error('SSE error:', error, 'retry:', retryCount);
        eventSource.close();
        this.currentJobs.delete(jobId);

        if (retryCount < maxRetries) {
            const delay = 500 * (retryCount + 1);
            setTimeout(() => {
                startJobSSE(retryCount + 1);
            }, delay);
            return;
        }

        (async () => {
            await new Promise(r => setTimeout(r, 2000));

                try {
                    const job = this.jobStates.get(jobId);
                    if (!job) return;

                    const statusNow = this.normalizeStatus(job.status);
                    if (['completed', 'error', 'canceled'].includes(statusNow)) {
                        this.saveSessionState();
                        return;
                    }

                    let resolvedJob = null;
                    let probeDone   = false;

                    let adminToken = null;
                    try {
                        adminToken = localStorage.getItem('gharmonize_admin_token');
                    } catch (_) {
                        adminToken = null;
                    }

                    if (adminToken) {
                        try {
                            const resp = await fetch('/api/jobs?status=all', {
                                headers: { 'Authorization': 'Bearer ' + adminToken }
                            });

                            if (resp.ok) {
                                const data  = await resp.json().catch(() => null);
                                const items = data && Array.isArray(data.items) ? data.items : [];
                                resolvedJob = items.find(x => x.id === jobId) || null;
                                probeDone   = true;
                            } else if (resp.status === 404) {
                                probeDone   = true;
                                resolvedJob = null;
                            }
                        } catch (err) {
                            console.warn('[JobManager] status probe after SSE error failed:', err);
                        }
                    }

                    if (probeDone && resolvedJob) {
                        const serverStatus = this.normalizeStatus(resolvedJob.status);
                        job.status       = serverStatus;
                        job.phase        = this.normalizeStatus(resolvedJob.phase || job.phase);
                        job.currentPhase = this.normalizeStatus(resolvedJob.currentPhase || job.currentPhase);
                        if (resolvedJob.resultPath !== undefined) job.resultPath = resolvedJob.resultPath;
                        if (resolvedJob.zipPath    !== undefined) job.zipPath    = resolvedJob.zipPath;
                        this.jobStates.set(jobId, job);
                        this.updateJobUI(job, this.jobToBatch.get(jobId) || null);
                        this.saveSessionState();
                        return;
                    } else if (probeDone && !resolvedJob) {
                        this.removeJobCompletely(jobId);
                        this.app.showNotification(
                            this.app.t('errors.jobLost') || 'İş sunucuda bulunamadı, listeden kaldırıldı.',
                            'info',
                            'action'
                        );
                        return;
                    }

                    if (statusNow !== 'completed') {
                        const hasAnyPath = Boolean(
                            job.resultPath ||
                            (Array.isArray(job.resultPath) && job.resultPath.length) ||
                            job.zipPath
                        );

                        if (!hasAnyPath) {
                            this.removeJobCompletely(jobId);
                            this.app.showNotification(
                                this.app.t('errors.jobLost') || 'İş sunucuda bulunamadı, listeden kaldırıldı.',
                                'info',
                                'action'
                            );
                            return;
                        }

                        job.connectionLost = true;
                        this.jobStates.set(jobId, job);
                        this.updateJobUI(job, this.jobToBatch.get(jobId) || null);
                        this.saveSessionState();
                        return;
                    }

                    let keep = true;

                    if (Array.isArray(job.resultPath)) {
                        keep = await this.prunePlaylistOutputs(job);
                    } else {
                        keep = await this.jobHasExistingOutput(job);
                    }

                    if (!keep) {
                        this.removeJobCompletely(jobId);
                        this.app.showNotification(
                            this.app.t('errors.jobLost') || 'İş sunucuda bulunamadı, listeden kaldırıldı.',
                            'info',
                            'action'
                        );
                        return;
                    } else {
                        job.connectionLost = true;
                        this.jobStates.set(jobId, job);
                        this.updateJobUI(job, this.jobToBatch.get(jobId) || null);
                        this.saveSessionState();
                    }
                } catch (e) {
                    console.warn('[JobManager] autosave after SSE error failed:', e);
                }
            })();
        };
    };
    startJobSSE(0);
    }

    // Normalizes status for the browser UI layer.
    normalizeStatus(s) {
        const v = String(s || '').toLowerCase();
        return v === 'cancelled' ? 'canceled' : v;
    }

    // Formats date/time values for the browser UI layer.
    formatDateTime(value) {
        const ts = Number(value);
        const date = Number.isFinite(ts) ? new Date(ts) : new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
    }

    // Formats milliseconds as HH:MM:SS for the browser UI layer.
    formatDurationMs(ms) {
        if (!Number.isFinite(ms) || ms < 0) return null;
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return [hours, minutes, seconds].map(v => String(v).padStart(2, '0')).join(':');
    }

    // Detects playlist platform for the browser UI layer.
    detectPlaylistPlatform(job) {
        const mediaPlatform = String(job?.metadata?.mediaPlatform || '').toLowerCase();
        if (mediaPlatform === 'dailymotion' || mediaPlatform === 'youtube') {
            return mediaPlatform;
        }

        const source = String(job?.metadata?.source || '').toLowerCase();
        if (source === 'spotify') return 'spotify';
        if (source === 'apple_music') return 'apple_music';
        if (source === 'deezer') return 'deezer';
        if (source === 'tidal') return 'tidal';
        if (source === 'soundcloud') return 'soundcloud';

        const urlCandidate =
            job?.metadata?.url ||
            job?.metadata?.originalUrl ||
            job?.metadata?.extracted?.webpage_url ||
            '';
        if (/(?:dailymotion\.com|dai\.ly)/i.test(String(urlCandidate))) return 'dailymotion';
        return 'youtube';
    }

    // Resolves playlist source title for the browser UI layer.
    playlistSourceTitle(job) {
        const platform = this.detectPlaylistPlatform(job);
        if (platform === 'spotify') return this.app.t('ui.spotifyPlaylist');
        if (platform === 'apple_music') return this.app.t('ui.appleMusicPlaylist');
        if (platform === 'deezer') return this.app.t('ui.deezerPlaylist');
        if (platform === 'tidal') return this.app.t('ui.tidalPlaylist');
        if (platform === 'soundcloud') return this.app.t('ui.soundCloudPlaylist');
        if (platform === 'dailymotion') return this.app.t('ui.dailymotionPlaylist');
        return this.app.t('ui.youtubePlaylist');
    }

    // Resolves batch source text for the browser UI layer.
    formatBatchSource(meta = {}) {
        const src = String(meta?.source || '').toLowerCase();
        if (src === 'spotify') return this.app.t('ui.spotifyPlaylist');
        if (src === 'apple_music') return this.app.t('ui.appleMusicPlaylist');
        if (src === 'deezer') return this.app.t('ui.deezerPlaylist');
        if (src === 'tidal') return this.app.t('ui.tidalPlaylist');
        if (src === 'soundcloud') return this.app.t('ui.soundCloudPlaylist');
        if (src === 'dailymotion') return this.app.t('ui.dailymotionPlaylist');
        if (src === 'youtube') return this.app.t('ui.youtubePlaylist');
        if (meta?.source) return String(meta.source);
        return this.app.t('ui.playlist');
    }

    // Handles safe num in the browser UI layer.
    safeNum(v, d = 0) {
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
    }

    // Returns dl cv counts used for the browser UI layer.
    getDlCvCounts(job, parsed = null) {
        const p = job?.playlist || {};
        const c = job?.counters || {};

        const totalFallback = this.safeNum(
            c.dlTotal ?? c.cvTotal ?? p.downloadTotal ?? p.convertTotal ?? p.total ?? parsed?.total ?? 0,
            0
        );

        const dlTotal = this.safeNum(c.dlTotal ?? p.downloadTotal ?? p.total ?? totalFallback, 0);
        const cvTotal = this.safeNum(c.cvTotal ?? p.convertTotal ?? p.total ?? totalFallback, 0);

        let dlDone = this.safeNum(c.dlDone ?? p.downloaded ?? p.done ?? parsed?.done ?? 0, 0);
        let cvDone = this.safeNum(c.cvDone ?? p.converted ?? p.done ?? 0, 0);

        const dlPct = this.safeNum(job?.downloadProgress ?? 0, 0);
        const cvPct = this.safeNum(job?.convertProgress ?? 0, 0);
        if (!dlDone && dlTotal > 0 && dlPct > 0) dlDone = Math.floor((dlPct / 100) * dlTotal);
        if (!cvDone && cvTotal > 0 && cvPct > 0) cvDone = Math.floor((cvPct / 100) * cvTotal);

        return { dlDone, cvDone, dlTotal, cvTotal };
    }

    // Handles merge job state state in the browser UI layer.
    mergeJobState(prev, next) {
        const merged = { ...prev, ...next };

        merged.metadata = { ...(prev?.metadata || {}), ...(next?.metadata || {}) };
        merged.playlist = { ...(prev?.playlist || {}), ...(next?.playlist || {}) };
        merged.counters = { ...(prev?.counters || {}), ...(next?.counters || {}) };

        if (next?.resultPath === undefined) merged.resultPath = prev?.resultPath;
        if (next?.zipPath === undefined) merged.zipPath = prev?.zipPath;
        if (next?.error === undefined) merged.error = prev?.error;
        if (!merged.id) merged.id = prev?.id || next?.id;
        return merged;
    }

    // Parses xof y for the browser UI layer.
    parseXofY(text) {
        const m = String(text || '').match(/\((\d+)\s*\/\s*(\d+)\)/);
        if (!m) return null;
        return { done: Number(m[1]), total: Number(m[2]) };
    }

    // Computes raw prog for the browser UI layer.
    computeRawProg(job) {
    const source = job.metadata?.source || 'file';
    const isLocalSource = source === 'local' || source === 'file' || source === 'retag';

    if (isLocalSource) {
        let convertProgress = Number(job.convertProgress) || 0;

        if (convertProgress === 0 && this.normalizeStatus(job.status) !== 'completed') {
            convertProgress = Number(job.progress) || 0;
        }

        if (convertProgress === 0 && this.normalizeStatus(job.status) === 'completed') {
            return 100;
        }

        return convertProgress;
    }

    const isMultiAudio =
        !job.metadata?.isPlaylist &&
        job.metadata?.selectedStreams &&
        Array.isArray(job.metadata.selectedStreams.audio) &&
        job.metadata.selectedStreams.audio.length > 1;

    const isVideoTranscode = job.format?.toLowerCase() === 'mp4' ||
                           job.format?.toLowerCase() === 'mkv' ||
                           job.format?.toLowerCase() === 'webm' ||
                           (job.videoSettings && job.videoSettings.transcodeEnabled);

    // For playlists, counters represent actual completed items and are immune to
    // out-of-order concurrent processing. Treat download + conversion as two
    // equal stages so 96 downloaded / 94 converted of 199 is ~48%, not a jump
    // caused by whichever high-index track happens to finish first.
    if (job.metadata?.isPlaylist) {
        const status = this.normalizeStatus(job.status);
        if (status === 'completed') return 100;

        const { dlDone, cvDone, dlTotal, cvTotal } = this.getDlCvCounts(job);
        const playlistTotal = Math.max(
            0,
            Number(job.playlist?.total || 0),
            Number(dlTotal || 0),
            Number(cvTotal || 0),
            Array.isArray(job.metadata?.frozenEntries) ? job.metadata.frozenEntries.filter(Boolean).length : 0
        );

        if (playlistTotal > 0) {
            const effectiveDlTotal = Number(dlTotal) > 0 ? Number(dlTotal) : playlistTotal;
            const effectiveCvTotal = Number(cvTotal) > 0 ? Number(cvTotal) : playlistTotal;
            const dlPct = Math.max(0, Math.min(100, (Number(dlDone || 0) / effectiveDlTotal) * 100));
            const cvPct = Math.max(0, Math.min(100, (Number(cvDone || 0) / effectiveCvTotal) * 100));
            return Math.floor((dlPct + cvPct) / 2);
        }
    }

    if (typeof job.progress === 'number' && Number.isFinite(job.progress)) {
        return job.progress;
    }

    if (isMultiAudio) {
        const total = Number(job.counters?.cvTotal || job.counters?.dlTotal || 0);
        const done  = Number(job.counters?.cvDone || job.counters?.dlDone || 0);

        if (total > 0) {
            const ratio = Math.max(0, Math.min(1, done / total));
            const pct = Math.floor(ratio * 100);
            console.log('🔊 Multi-audio progress:', { total, done, ratio, pct });
            if (pct > 0) return pct;
        }
    }

    const phase = this.normalizeStatus(job.currentPhase || job.phase);

    let d = Number(job.downloadProgress || 0);
    let c = Number(job.convertProgress || 0);

    console.log('📥 Download/Convert progress:', { d, c, phase });

    if (isVideoTranscode) {
        const result = Math.floor((d + c) / 2);
        console.log('🎬 Video transcode progress:', result);
        return result;
    } else if (phase === 'converting' || phase === 'completed') {
        if (c > 0) {
            console.log('⚡ Converting phase with convert progress:', c);
            return c;
        } else if (d > 0) {
            console.log('⚡ Converting phase with download progress:', d);
            return d;
        }
    }

    if (d || c) {
        const result = Math.floor((d + c) / 2);
        console.log('📈 Normal source average progress:', result);
        return result;
    }

    console.log('❌ No progress data found, returning 0');
    return 0;
}

computeProg(job) {
    const id = job.id;
    const source = job.metadata?.source || 'file';
    const isLocalSource = source === 'local' || source === 'file' || source === 'retag';

    const baseRaw = this.computeRawProg(job);

    if (!Number.isFinite(baseRaw)) {
        return 0;
    }

    const status = this.normalizeStatus(job.status);
    const prev = this.progressCache ? this.progressCache.get(id) || 0 : 0;

    let next = baseRaw;

    if (isLocalSource) {
        if (status !== 'completed') {
            if (next > 95) next = 95;
        } else {
            next = 100;
        }

        if (next < prev) next = prev;
        } else {
        const isVideoTranscode = job.format?.toLowerCase() === 'mp4' ||
                               (job.videoSettings && job.videoSettings.transcodeEnabled);

        if (isVideoTranscode && !job.metadata?.isPlaylist) {
            next = Math.floor((Number(job.downloadProgress || 0) + Number(job.convertProgress || 0)) / 2);
        }
        if (status !== 'completed') {
            if (next > 95) next = 95;
        } else {
            next = 100;
        }
        if (next < prev) next = prev;
    }
    if (id && this.progressCache) {
        this.progressCache.set(id, next);
    }

    return next;
}

    // Computes skipped for the browser UI layer.
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

    // Handles UI state current index in the browser UI layer.
    getPlaylistUiState(job) {
        const entries = Array.isArray(job?.metadata?.frozenEntries) ? job.metadata.frozenEntries : [];
        const { dlDone, cvDone, dlTotal, cvTotal } = this.getDlCvCounts(job);
        const totalRaw = this.safeNum(
            job?.playlist?.total ?? dlTotal ?? cvTotal ?? entries.length ?? 0,
            0
        );
        const total = Math.max(totalRaw, entries.length);
        const clampCount = (value) => {
            const safe = Math.max(0, this.safeNum(value, 0));
            return total > 0 ? Math.min(total, safe) : safe;
        };

        const downloaded = clampCount(dlDone);
        const converted = clampCount(cvDone);
        const phase = this.normalizeStatus(job?.currentPhase || job?.phase);
        const playlistCurrent = Number(job?.playlist?.current);

        let activeIndex = null;
        if (total > 0) {
            if (phase === 'downloading') {
                const fallbackIndex = downloaded;
                activeIndex = Number.isFinite(playlistCurrent) && playlistCurrent >= 0
                    ? Math.max(playlistCurrent, fallbackIndex)
                    : fallbackIndex;
            } else if (phase === 'converting') {
                activeIndex = Number.isFinite(playlistCurrent) && playlistCurrent >= 0
                    ? playlistCurrent
                    : converted;
            } else if (phase === 'completed') {
                activeIndex = total - 1;
            } else if (Number.isFinite(playlistCurrent) && playlistCurrent >= 0) {
                activeIndex = playlistCurrent;
            } else {
                activeIndex = Math.max(downloaded, converted);
            }
        }

        if (activeIndex !== null && total > 0) {
            activeIndex = Math.min(Math.max(0, activeIndex), Math.max(0, total - 1));
        }

        let processed = downloaded;
        if (phase === 'converting') {
            processed = converted;
        } else if (phase === 'completed') {
            processed = total || Math.max(downloaded, converted);
        }

        return {
            entries,
            total,
            downloaded,
            converted,
            processed: clampCount(processed),
            activeIndex,
            phase
        };
    }

    // Handles UI state current index in the browser UI layer.
    uiCurrentIndex(job) {
        return this.getPlaylistUiState(job).activeIndex;
    }

    // Resolves playlist display name for the browser UI layer.
    playlistDisplayName(job) {
        return (
            job.metadata?.frozenTitle ||
            (job.metadata?.source === 'spotify'
                ? (job.metadata?.spotifyTitle || this.app.t('ui.spotifyPlaylist'))
                : job.metadata?.source === 'apple_music'
                ? (job.metadata?.spotifyTitle || this.app.t('ui.appleMusicPlaylist'))
                : job.metadata?.source === 'deezer'
                ? (job.metadata?.spotifyTitle || this.app.t('ui.deezerPlaylist'))
                : job.metadata?.source === 'tidal'
                ? (job.metadata?.spotifyTitle || this.app.t('ui.tidalPlaylist'))
                : job.metadata?.source === 'soundcloud'
                ? (job.metadata?.spotifyTitle || this.app.t('ui.soundCloudPlaylist'))
                : this.playlistSourceTitle(job))
        );
    }

    // Handles UI state now title in the browser UI layer.
    uiNowTitle(job) {
        if (job.metadata?.isPlaylist) {
            const { entries, activeIndex } = this.getPlaylistUiState(job);
            if (!entries.length) return null;

            const i0 = activeIndex ?? 0;
            const entry =
                entries[i0] ||
                entries.find((item) => Number(item?.index) === i0 + 1) ||
                null;

            if (!entry?.title) return null;

            const labelIndex = Number.isFinite(Number(entry.index))
                ? Number(entry.index)
                : (i0 + 1);
            return `${labelIndex}. ${entry.title}`;
        }
        const ex = job.metadata?.extracted || {};
        return ex.track || ex.title || job.metadata?.originalName || null;
    }

    // Returns channels text used for the browser UI layer.
    getChannelsText(channels) {
       const texts = {
           stereo: '2.0',
           mono: '1.0',
           original: 'Orig'
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

getOutputLocationBadgeHtml(job = null) {
    const title = this.app.t('jobsPanel.outputLocationTitle') || 'Output Location';
    const linuxLabel = this.app.t('jobsPanel.outputLocationLinux') || 'Linux';
    const windowsLabel = this.app.t('jobsPanel.outputLocationWindows') || 'Windows';
    const openFolderLabel = this.app.t('download.openFolder') || 'Open folder';

    const linuxPath = this.app.outputLocations?.linuxPath || '/path/to/outputs';
    const windowsPath = this.app.outputLocations?.windowsPath || 'C:\\path\\to\\outputs';
    const platformHint = `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
    const isWindows = platformHint.includes('win');
    const osLabel = isWindows ? windowsLabel : linuxLabel;
    let outputPath = isWindows ? windowsPath : linuxPath;

    const rawSubdir = job?.metadata?.isPlaylist ? job?.metadata?.outputSubdir : '';
    const subdir = typeof rawSubdir === 'string'
        ? rawSubdir.trim().replace(/^[/\\]+|[/\\]+$/g, '')
        : '';
    if (subdir) {
        const sep = isWindows ? '\\' : '/';
        const normalizedSubdir = subdir.replace(/[\\/]+/g, sep);
        outputPath = outputPath.replace(/[\\/]+$/g, '') + sep + normalizedSubdir;
    }

    return `
        <div class="output-location-badge" role="button" tabindex="0" title="${this.app.escapeHtml(openFolderLabel)}" aria-label="${this.app.escapeHtml(`${openFolderLabel}: ${outputPath}`)}" data-output-subdir="${this.app.escapeHtml(subdir)}" style="cursor:pointer;">
            <div class="output-location-badge__title">📁 ${this.app.escapeHtml(title)}</div>
            <div class="output-location-badge__row">
                <span class="output-location-badge__os">${this.app.escapeHtml(osLabel)}</span>
                <code>${this.app.escapeHtml(outputPath)}</code>
            </div>
        </div>
    `;
}

// Handles output location badge click in the browser UI layer.
handleOutputLocationBadgeClick(event) {
    const badge = event?.target?.closest?.('.output-location-badge');
    if (!badge) return;
    event.preventDefault();
    event.stopPropagation();
    this.openOutputLocationBadge(badge);
}

// Handles output location badge keyboard activation in the browser UI layer.
handleOutputLocationBadgeKeydown(event) {
    if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;
    const badge = event?.target?.closest?.('.output-location-badge');
    if (!badge) return;
    event.preventDefault();
    event.stopPropagation();
    this.openOutputLocationBadge(badge);
}

// Opens output folder from badge context for the browser UI layer.
async openOutputLocationBadge(badge) {
    const subdir = String(badge?.dataset?.outputSubdir || '').trim();

    try {
        if (window.electronAPI?.openOutputFolder) {
            const ret = await window.electronAPI.openOutputFolder(subdir);
            if (!ret?.success) {
                throw new Error(ret?.error || 'Failed to open output folder');
            }
            return;
        }

        const resp = await fetch('/api/outputs/open', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subdir })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data?.ok) {
            throw new Error(data?.error || `HTTP ${resp.status}`);
        }
    } catch (err) {
        const label = this.app.t('download.openFolder') || 'Open folder';
        const reason = err?.message ? `: ${err.message}` : '';
        this.app.showNotification(`${label}${reason}`, 'error', 'error');
    }
}

updateJobUI(job, batchId = null) {
    const statusNorm = this.normalizeStatus(job.status);
    const prev = this.jobStates.get(job.id);

    if (statusNorm === 'completed') {
        if (!job.completedAt) {
            job.completedAt = prev?.completedAt || null;
        }
    } else if (prev?.completedAt && !job.completedAt) {
        job.completedAt = prev.completedAt;
    }

    const batchKey = batchId || job.clientBatch;
    const listRoot = document.getElementById('jobList');
    if (!listRoot) return;

    if (!this.sessionSectionsInitialized) {
        const empty = document.getElementById('job-empty');
        if (empty) empty.remove();

        const activeTitleKey = 'jobsPanel.activeGroupTitle';
        const completedTitleKey = 'jobsPanel.completedGroupTitle';

        const activeTitle = this.app.t(activeTitleKey);
        const completedTitle = this.app.t(completedTitleKey);

        listRoot.innerHTML = `
            <section class="collapsible-section" data-section="active-session">
                <button
                    type="button"
                    class="collapsible-section__header"
                    aria-expanded="true"
                >
                    <span class="collapsible-section__title" data-i18n="${activeTitleKey}">
                        ${activeTitle}
                    </span>
                    <span class="collapsible-section__badge" id="session-active-count">0</span>
                    <span class="collapsible-section__icon" aria-hidden="true">▾</span>
                </button>
                <div class="collapsible-section__body" id="session-active-body"></div>
            </section>

            <section class="collapsible-section" data-section="completed-session">
                <button
                    type="button"
                    class="collapsible-section__header"
                    aria-expanded="false"
                >
                    <span class="collapsible-section__title" data-i18n="${completedTitleKey}">
                        ${completedTitle}
                    </span>
                    <span class="collapsible-section__badge" id="session-completed-count">0</span>
                    <span class="collapsible-section__icon" aria-hidden="true">▾</span>
                </button>
                <div class="collapsible-section__body" id="session-completed-body" hidden></div>
            </section>
        `;

        if (window.i18n?.apply) window.i18n.apply(listRoot);

        listRoot.querySelectorAll('.collapsible-section__header').forEach(header => {
            const body = header.parentElement.querySelector('.collapsible-section__body');
            if (!body) return;
            header.addEventListener('click', () => {
                const expanded = header.getAttribute('aria-expanded') === 'true';
                header.setAttribute('aria-expanded', expanded ? 'false' : 'true');
                body.hidden = expanded;
                header.classList.toggle('is-collapsed', expanded);
            });
        });

        this.sessionSectionsInitialized = true;
    }

    const activeBody = document.getElementById('session-active-body');
    const completedBody = document.getElementById('session-completed-body');
    if (batchKey) {
        const batch = this.batches.get(batchKey);
        if (batch) {
            batch.jobs.add(job.id);
            this.jobStates.set(job.id, job);
            this.jobToBatch.set(job.id, batchKey);

            if (statusNorm === 'completed' && job.resultPath && !Array.isArray(job.resultPath)) {
                const nowTrackTitle = this.uiNowTitle(job);

                const selIdx = Array.isArray(job.metadata?.selectedIndices)
                    ? Number(job.metadata.selectedIndices[0])
                    : null;

                let entryBySel = null;
                if (Number.isFinite(selIdx) && Array.isArray(job.metadata?.frozenEntries)) {
                    entryBySel =
                        job.metadata.frozenEntries.find(e => e.index === selIdx) ||
                        job.metadata.frozenEntries[selIdx - 1] ||
                        null;
                }

                const entry0 = Array.isArray(job.metadata?.frozenEntries) && job.metadata.frozenEntries.length
                    ? job.metadata.frozenEntries[0]
                    : null;

                let resolvedTitle =
                    nowTrackTitle ||
                    job.metadata?.extracted?.track ||
                    job.metadata?.extracted?.title ||
                    entryBySel?.title ||
                    entry0?.title ||
                    job.metadata?.originalName ||
                    (Number.isFinite(selIdx) &&
                     this.app.previewManager?.currentPreview?.indexToTitle?.get(selIdx)) ||
                    this.app.t('ui.track');

                let hrefRaw;
                if (typeof job.resultPath === 'string') {
                    hrefRaw = job.resultPath;
                } else if (job.resultPath && typeof job.resultPath === 'object') {
                    hrefRaw = job.resultPath.outputPath || job.resultPath.path || '';
                } else {
                    hrefRaw = '';
                }

                if (hrefRaw) {
                    this.appendBatchRow(batchKey, {
                        title: resolvedTitle,
                        href: hrefRaw
                    });
                }
            }

            this.updateBatchProgress(batchKey);

            const allJobs = Array.from(batch.jobs);
            const completedJobs = allJobs.filter(jobId => {
                const j = this.jobStates.get(jobId);
                return j && this.normalizeStatus(j.status) === 'completed';
            }).length;

            if (completedJobs >= batch.total && !batch.el.querySelector('.zip-all')) {
                const lastCompletedJob = allJobs
                    .map(id => this.jobStates.get(id))
                    .find(j => j && this.normalizeStatus(j.status) === 'completed' && j.zipPath);

                if (lastCompletedJob && lastCompletedJob.zipPath) {
                    const zipBtn = document.createElement('div');
                    zipBtn.className = 'download-item zip-all';
                    zipBtn.innerHTML = `
                        <strong>${this.app.t('ui.all')}:</strong>
                        <a href="${this.app.toRelative(lastCompletedJob.zipPath)}" class="download-btn" download>
                            ${this.app.t('download.allZip')}
                        </a>
                    `;
                    batch.el.querySelector('.download-list').appendChild(zipBtn);
                }
            }
        }
    }

	    const isMusicMatchJob =
	        job.metadata?.source === 'spotify' ||
	        job.metadata?.source === 'apple_music' ||
	        job.metadata?.source === 'deezer' ||
	        job.metadata?.source === 'tidal' ||
	        job.metadata?.source === 'soundcloud';

	    let phaseInfo = '';
	    if (isMusicMatchJob && job.phase) {
	        const phaseText = {
	            preparing: this.app.t('phase.preparing'),
	            mapping: this.app.t('phase.mapping'),
	            downloading: this.app.t('phase.downloading'),
	            converting: this.app.t('phase.converting'),
	            completed: this.app.t('phase.completed')
	        };
        phaseInfo = ` • ${phaseText[job.phase] || job.phase}`;
    }

    let phaseDetails = '';
	if (job.currentPhase) {
	    const phaseTexts = {
	        preparing: this.app.t('phase.preparing'),
	        mapping: this.app.t('phase.mapping'),
	        downloading: this.app.t('phase.downloading'),
	        converting: this.app.t('phase.converting'),
	        completed: this.app.t('phase.completed'),
        canceled: this.app.t('status.canceled'),
        cancelled: this.app.t('status.canceled'),
        error: this.app.t('phase.error')
    };

    const currentPhaseText = phaseTexts[job.currentPhase] || job.currentPhase;
    const source = job.metadata?.source || 'file';
    const isLocalSource = source === 'local' || source === 'file' || source === 'retag';

    if (isLocalSource) {
        const cvPctRaw =
            Number(job.convertProgress) ||
            (this.normalizeStatus(job.status) !== 'completed' ? Number(job.progress) : 100) ||
            0;
        phaseDetails = `
            <div class="phase-details">
                <div class="phase-details__title">${currentPhaseText}</div>
                <div class="phase-details__grid">
                    <span class="phase-details__item">
                        ⚡ ${this.app.t('ui.converting')}:
                        <span class="phase-details__value">${Math.floor(cvPctRaw)}%</span>
                    </span>
                </div>
            </div>
        `;
	    } else if (job.playlist && job.playlist.total) {
	            if (isMusicMatchJob) {
	            const phaseNorm = this.normalizeStatus(job.currentPhase || job.phase);
	            const parsed = this.parseXofY(job.lastLog) || null;
	            const liveMatched = Number(job.playlist?.matched);
	            const matchedCount = Number.isFinite(liveMatched)
	                ? Math.max(0, Math.min(Number(job.playlist?.total) || liveMatched, liveMatched))
	                : (Array.isArray(job.metadata?.frozenEntries)
	                    ? job.metadata.frozenEntries.filter(Boolean).length
	                    : 0);

	            const { dlDone, cvDone, dlTotal, cvTotal } = this.getDlCvCounts(job, parsed);
	            const total = this.safeNum(dlTotal || cvTotal || job.playlist?.total || parsed?.total || 0, 0);

	            let downloaded = dlDone;
	            let converted  = cvDone;

	            if (phaseNorm === 'mapping') {
	                const totalTxt = (dlTotal || total) ? (dlTotal || total) : '?';
	                phaseDetails = `
	                    <div class="phase-details">
	                        <div class="phase-details__title">${currentPhaseText}</div>
	                        <div class="phase-details__grid">
	                            <span class="phase-details__item">
	                                ✅ ${String(this.app.t('chip.matched') || 'Matched').replace(/[:：]\s*$/, '')}:
	                                <span class="phase-details__value">${matchedCount}/${totalTxt}</span>
	                            </span>
	                            <span class="phase-details__item">
	                                🎵 ${String(this.app.t('chip.total') || 'Total').replace(/[:：]\s*$/, '')}:
	                                <span class="phase-details__value">${totalTxt}</span>
	                            </span>
	                        </div>
	                    </div>
	                `;
	            } else if (phaseNorm === 'downloading') {
	                converted = 0;
	            } else if (phaseNorm === 'converting') {
	            } else if (phaseNorm === 'completed') {
	                downloaded = dlTotal || total;
	                converted  = cvTotal || total;
	            }

	            if (phaseNorm !== 'mapping') {
	                const totalTxt = (dlTotal || total) ? (dlTotal || total) : '?';

	                let processedCount = downloaded;
	                if (phaseNorm === 'converting') {
	                    processedCount = converted;
	                } else if (phaseNorm === 'completed') {
	                    processedCount = converted || downloaded || total;
	                }
	                processedCount = Math.max(0, Math.min((dlTotal || total || 0), processedCount || 0));

	                phaseDetails = `
	                    <div class="phase-details">
	                        <div class="phase-details__title">${currentPhaseText}</div>
	                        <div class="phase-details__grid">
	                            <span class="phase-details__item">
	                                🎵 ${this.app.t('ui.current')}:
	                                <span class="phase-details__value">${processedCount}</span>
	                            </span>
	                            <span class="phase-details__item">
	                                📥 ${this.app.t('ui.downloading')}:
	                                <span class="phase-details__value">${downloaded}/${totalTxt}</span>
	                            </span>
	                            <span class="phase-details__item">
	                                ⚡ ${this.app.t('ui.converting')}:
	                                <span class="phase-details__value">${converted}/${totalTxt}</span>
	                            </span>
	                        </div>
	                    </div>
	                `;
	            }
	        } else {
                const playlistUi = this.getPlaylistUiState(job);
                const total = playlistUi.total;
                const downloaded = playlistUi.downloaded;
                const converted = playlistUi.converted;
                const processed = playlistUi.processed;
                const phase = playlistUi.phase;

                const isVideoTranscode = job.format?.toLowerCase() === 'mp4' ||
                                       job.format?.toLowerCase() === 'mkv' ||
                                       job.format?.toLowerCase() === 'webm' ||
                                       (job.videoSettings && job.videoSettings.transcodeEnabled);

                if (isVideoTranscode) {
                    phaseDetails = `
                        <div class="phase-details">
                            <div class="phase-details__title">🎬 ${this.app.t('ui.videoTranscode') || 'Video Dönüşümü'}</div>
                        </div>
                    `;
                }

                phaseDetails = `
                    <div class="phase-details">
                        <div class="phase-details__title">${currentPhaseText}</div>
                        <div class="phase-details__grid">
                            <span class="phase-details__item">
                                🎵 ${this.app.t('ui.current')}:
                                <span class="phase-details__value">${processed}</span>
                            </span>
                            <span class="phase-details__item">
                                📥 ${this.app.t('ui.downloading')}:
                                <span class="phase-details__value">${downloaded}/${total || '?'}</span>
                            </span>
                            <span class="phase-details__item">
                                ⚡ ${this.app.t('ui.converting')}:
                                <span class="phase-details__value">${converted}/${total || '?'}</span>
                            </span>
                        </div>
                    </div>
                `;
            }
        } else if (job.metadata?.isPlaylist) {
            const playlistUi = this.getPlaylistUiState(job);
            const dlDone = playlistUi.downloaded;
            const cvDone = playlistUi.converted;
            const total  = playlistUi.total;
            const totalTxt = total > 0 ? total : '?';
            phaseDetails = `
                <div class="phase-details">
                    <div class="phase-details__title">${currentPhaseText}</div>
                    <div class="phase-details__grid">
                        <span class="phase-details__item">
                            🎵 ${this.app.t('ui.current')}:
                            <span class="phase-details__value">${playlistUi.processed}</span>
                        </span>
                        <span class="phase-details__item">
                            📥 ${this.app.t('ui.downloading')}:
                            <span class="phase-details__value">${dlDone}/${totalTxt}</span>
                        </span>
                        <span class="phase-details__item">
                            ⚡ ${this.app.t('ui.converting')}:
                            <span class="phase-details__value">${cvDone}/${totalTxt}</span>
                        </span>
                    </div>
                </div>
            `;
        } else {
            const phaseNorm = this.normalizeStatus(job.currentPhase || job.phase);
            const isVideoTranscode = job.format?.toLowerCase() === 'mp4' ||
                                job.format?.toLowerCase() === 'mkv' ||
                                job.format?.toLowerCase() === 'webm' ||
                                (job.videoSettings && job.videoSettings.transcodeEnabled);

            const dlPct = Math.floor(
                Number.isFinite(Number(job.downloadProgress))
                    ? Number(job.downloadProgress)
                    : (Number(job.progress) || 0)
            );

            let cvBase = 0;

            if (Number.isFinite(Number(job.convertProgress))) {
            cvBase = Number(job.convertProgress);
            } else if (phaseNorm === 'converting' || phaseNorm === 'completed') {
            cvBase = Number(job.progress) || 0;
            }

            const cvPct = Math.floor(cvBase);
            const totalPct = isVideoTranscode
                ? Math.floor((dlPct + cvPct) / 2)
                : Math.max(dlPct, cvPct);

            const showDl = Number.isFinite(dlPct) && dlPct > 0;
            const showCv = Number.isFinite(cvPct) && cvPct > 0;

            phaseDetails = `
            <div class="phase-details" style="margin-top: 8px;">
                <div class="phase-details__title" style="margin-bottom: 6px;">
                ${isVideoTranscode ? '🎬 ' : ''}${currentPhaseText}
                </div>
                <div class="phase-details__grid">
                ${showDl ? `
                    <span class="phase-details__item">
                    📥 ${this.app.t('ui.downloading')}:
                    <span class="phase-details__value">${dlPct}%</span>
                    </span>` : ''}
                ${showCv ? `
                    <span class="phase-details__item">
                    ⚡ ${this.app.t('ui.converting')}:
                    <span class="phase-details__value">${cvPct}%</span>
                    </span>` : ''}
                </div>
            </div>
            `;
        }
    }

    const fmt = String(job.format || '').toLowerCase();
    const videoFormats = ['mp4', 'mkv', 'webm', 'avi', 'mov'];
    const audioFormats = ['mp3', 'aac', 'm4a', 'ogg', 'opus', 'flac', 'wav', 'alac', 'eac3', 'ac3'];
    const codecIcon = '⚡';

    let formatInnerEmoji = '⚡';
    if (fmt === 'retag') {
        formatInnerEmoji = '🏷️';
    } else if (videoFormats.includes(fmt)) {
        formatInnerEmoji = '🎬';
    } else if (audioFormats.includes(fmt)) {
        formatInnerEmoji = '🎧';
    }

    const formatCards = [];
    const bitrateEmoji = '📶';
    const sampleRateEmoji = '📡';
    const fpsEmoji = '🎯';
    const channelsEmoji = '🎚️';
    const videoFpsText = this.getDisplayedVideoFps(job);
    const basicCards = [];
    const formatFeatures = [];
    const featureCards = [];

    formatFeatures.push(`
        <span class="info-feature">
            ${formatInnerEmoji} ${(job.format || '').toUpperCase() || '—'}
        </span>
    `);

    const phaseNorm = this.normalizeStatus(job.currentPhase || job.phase);
    const source = job.metadata?.source || 'file';
    const isLocalSource = (source === 'local' || source === 'file' || source === 'retag');
    const dlPct = Number(job.downloadProgress || 0) || 0;
    const showSourceQuality = !isLocalSource && job.bitrate && (phaseNorm === 'downloading' || dlPct > 0);

    if (showSourceQuality) {
        formatFeatures.push(`
            <span class="info-feature">
                📺 ${this.app.escapeHtml(String(job.bitrate))}
            </span>
        `);
    }

    basicCards.push(`
        <div class="info-card info-card--features">
            <div class="info-card__icon">${codecIcon}</div>
            <div class="info-card__content">
                <div class="info-card__title">${this.app.t('label.format')}</div>
                <div class="info-features-grid">
                    ${formatFeatures.join('')}
                </div>
            </div>
        </div>
    `);

    const videoFeatures = [];
    if (job.videoSettings?.transcodeEnabled) {
        videoFeatures.push(`<span class="info-feature">🎬 ${this.app.t('label.videoTranscodejob') || 'Transcode'}</span>`);

        if (job.videoSettings.hwaccel && job.videoSettings.hwaccel !== 'off') {
            const hwaccelText = this.app.t(`option.${job.videoSettings.hwaccel}`) || job.videoSettings.hwaccel.toUpperCase();
            videoFeatures.push(`<span class="info-feature">${this.getHwaccelIcon(job.videoSettings.hwaccel)} ${hwaccelText}</span>`);
        }

        if (job.videoSettings.videoCodec && job.videoSettings.videoCodec !== 'auto') {
            const codecMap = {
                h264: 'H.264',
                h265: 'H.265'
            };
            const codecText = codecMap[job.videoSettings.videoCodec] || job.videoSettings.videoCodec.toUpperCase();
            videoFeatures.push(`<span class="info-feature">📹 ${codecText}</span>`);
        }

        let presetText = '';
        if (job.videoSettings.hwaccel === 'nvenc' && job.videoSettings.nvencSettings?.preset) {
            presetText = job.videoSettings.nvencSettings.preset.toUpperCase();
        } else if (job.videoSettings.hwaccel === 'qsv' && job.videoSettings.qsvSettings?.preset) {
            presetText = job.videoSettings.qsvSettings.preset.toUpperCase();
        } else if (job.videoSettings.hwaccel === 'vaapi') {
            presetText = 'VAAPI';
        } else if (job.videoSettings.hwaccel === 'off') {
            presetText = 'CPU';
        }

        if (presetText) {
            videoFeatures.push(`<span class="info-feature">⚙️ ${presetText}</span>`);
        }

        let displayText = '';
        let qualityText = '';
        if (job.videoSettings.hwaccel === 'nvenc' && job.videoSettings.nvencSettings?.quality) {
            qualityText = `CRF ${job.videoSettings.nvencSettings.quality}`;
        } else if (job.videoSettings.hwaccel === 'qsv' && job.videoSettings.qsvSettings?.quality) {
            qualityText = `CRF ${job.videoSettings.qsvSettings.quality}`;
        } else if (job.videoSettings.hwaccel === 'vaapi' && job.videoSettings.vaapiSettings?.quality) {
            qualityText = `CRF ${job.videoSettings.vaapiSettings.quality}`;
        }

        const wMode = String(job.videoSettings.scaleMode || 'auto');
        const hMode = String(job.videoSettings.heightMode || 'auto');
        const wVal  = (wMode === 'custom' && job.videoSettings.targetWidth) ? String(job.videoSettings.targetWidth) : '';
        const hVal  = (hMode === 'custom' && job.videoSettings.targetHeight) ? String(job.videoSettings.targetHeight) : '';

        let sizeText = null;
        if (wVal || hVal) {
          const wTxt = wVal ? wVal : 'auto';
          const hTxt =
            hMode === 'source' ? 'src'
            : hVal ? hVal
            : (wVal ? 'auto' : 'auto');
          sizeText = `${wTxt}×${hTxt}`;

          if (hMode === 'custom' && job.videoSettings.allowUpscale) {
            sizeText += ' ↑';
          }
        } else if (hMode === 'source') {
          sizeText = 'src';
        }

        const components = [];
        if (qualityText) components.push(qualityText);
        if (sizeText) components.push(sizeText);

        if (components.length > 0) {
            displayText = components.join(' • ');
            videoFeatures.push(`<span class="info-feature">⭐ ${displayText}</span>`);
        } else if (qualityText) {
            videoFeatures.push(`<span class="info-feature">⭐ ${qualityText}</span>`);
        } else if (sizeText) {
            videoFeatures.push(`<span class="info-feature">📏 ${sizeText}</span>`);
        }

        if (videoFpsText) {
            videoFeatures.push(`<span class="info-feature">🎯 ${videoFpsText} FPS</span>`);
        }
    }

    const audioFeatures = [];
    if (job.videoSettings?.audioTranscodeEnabled) {
        const audioCodecText =
            this.app.t(`option.${job.videoSettings.audioCodec}`) ||
            job.videoSettings.audioCodec?.toUpperCase() ||
            'AAC';

        audioFeatures.push(`
            <span class="info-feature">
                🎵 ${audioCodecText}
            </span>
        `);

        if (job.videoSettings.audioBitrate && job.videoSettings.audioBitrate !== '192k') {
            audioFeatures.push(`
                <span class="info-feature">
                    ${bitrateEmoji} ${job.videoSettings.audioBitrate}
                </span>
            `);
        }

        if (job.videoSettings.audioChannels && job.videoSettings.audioChannels !== 'original') {
            const channelsText = this.getChannelsText(job.videoSettings.audioChannels);
            audioFeatures.push(`
                <span class="info-feature">
                    ${channelsEmoji} ${channelsText}
                </span>
            `);
        }

        let addedSampleRate = false;
        if (job.videoSettings.audioSampleRate && job.videoSettings.audioSampleRate !== '48000') {
            audioFeatures.push(`
                <span class="info-feature">
                    ${sampleRateEmoji} ${parseInt(job.videoSettings.audioSampleRate, 10) / 1000} kHz
                </span>
            `);
            addedSampleRate = true;
        }

        if (!addedSampleRate && job.sampleRate) {
            audioFeatures.push(`
                <span class="info-feature">
                    ${sampleRateEmoji} ${Math.round(job.sampleRate / 1000)} kHz
                </span>
            `);
        }
    } else if (job.sampleRate) {
        audioFeatures.push(`
            <span class="info-feature">
                ${sampleRateEmoji} ${Math.round(job.sampleRate / 1000)} kHz
            </span>
        `);
    }

    const extraFeatures = [];
    if (job.metadata?.source === 'retag' && job.metadata?.retagStats) {
        const stats = job.metadata.retagStats;
        extraFeatures.push(`<span class="info-feature">🏷️ ${Number(stats.tagged || 0)}/${Number(stats.total || 0)}</span>`);
        extraFeatures.push(`<span class="info-feature">🌐 ${this.app.t('retag.stats.online')}: ${Number(stats.onlineMatched || 0)}</span>`);
        extraFeatures.push(`<span class="info-feature">🗂️ ${this.app.t('retag.stats.existing')}: ${Number(stats.existingOnly || 0)}</span>`);
        extraFeatures.push(`<span class="info-feature">🖼️ ${this.app.t('retag.stats.covers')}: ${Number(stats.coversUpdated || 0)}</span>`);
        extraFeatures.push(`<span class="info-feature">✏️ ${this.app.t('retag.stats.renamed')}: ${Number(stats.renamed || 0)}</span>`);
        if (Number(stats.nameCollisions || 0) > 0) {
            extraFeatures.push(`<span class="info-feature">🛡️ ${this.app.t('retag.stats.nameCollisions')}: ${Number(stats.nameCollisions || 0)}</span>`);
        }
        if (Number(stats.failed || 0) > 0) {
            extraFeatures.push(`<span class="info-feature">⚠️ ${Number(stats.failed || 0)}</span>`);
        }
    }
    if (job.metadata?.includeLyrics) {
        extraFeatures.push(`<span class="info-feature">🎼 ${this.app.t('label.includeLyrics2') || 'Lyrics'}</span>`);
    }
    if (job.metadata?.ringtone?.enabled) {
        const ringtoneTarget = job.metadata.ringtone.target === 'iphone'
            ? this.app.t('ringtone.target.iphone')
            : this.app.t('ringtone.target.android');
        const ringtoneMode = job.metadata.ringtone.mode === 'manual'
            ? this.app.t('ringtone.mode.manual')
            : this.app.t('ringtone.mode.auto');
        const durationText = `${Math.round(Number(job.metadata.ringtone.durationSec || 0))}s`;
        extraFeatures.push(`<span class="info-feature">🔔 ${ringtoneTarget} • ${durationText}</span>`);
        extraFeatures.push(`<span class="info-feature">✂️ ${ringtoneMode}</span>`);
        if (Number.isFinite(Number(job.metadata.ringtone.fadeInSec)) && Number(job.metadata.ringtone.fadeInSec) > 0) {
            const fadeInSec = Number(job.metadata.ringtone.fadeInSec);
            const fadeInText = Number.isInteger(fadeInSec) ? String(fadeInSec) : fadeInSec.toFixed(1);
            extraFeatures.push(`<span class="info-feature">↗ ${fadeInText}s</span>`);
        }
        if (Number.isFinite(Number(job.metadata.ringtone.fadeOutSec)) && Number(job.metadata.ringtone.fadeOutSec) > 0) {
            const fadeOutSec = Number(job.metadata.ringtone.fadeOutSec);
            const fadeOutText = Number.isInteger(fadeOutSec) ? String(fadeOutSec) : fadeOutSec.toFixed(1);
            extraFeatures.push(`<span class="info-feature">↘ ${fadeOutText}s</span>`);
        }
        if (job.metadata.ringtone.mode === 'manual' && Number.isFinite(Number(job.metadata.ringtone.startSec))) {
            extraFeatures.push(`<span class="info-feature">⏱️ ${this.app.formatSeconds(Number(job.metadata.ringtone.startSec))}</span>`);
        }
    }
    if (job.metadata?.volumeGain && job.metadata.volumeGain !== 1.0) {
        extraFeatures.push(`<span class="info-feature">🔊 ${job.metadata.volumeGain}x</span>`);
    }
    if (job.metadata?.loudnorm) {
        const loudnormMode = String(job.metadata?.loudnormMode || 'ebu_r128');
        const loudnormModeLabel = loudnormMode === 'two_pass'
            ? (this.app.t('option.loudnormMode.twoPass') || 'Two-Pass Processing')
            : loudnormMode === 'dynamic'
                ? (this.app.t('option.loudnormMode.dynamic') || 'Dynamic Range Control')
                : (this.app.t('option.loudnormMode.ebuR128') || 'EBU R128 Standard');
        extraFeatures.push(`<span class="info-feature">🎚 ${loudnormModeLabel}</span>`);
    }
    if (job.metadata?.isPlaylist) {
        extraFeatures.push(`<span class="info-feature">📜 ${this.app.t('ui.playlist')}</span>`);
    }

    if (videoFeatures.length > 0) {
        featureCards.push(`
            <div class="info-card info-card--features">
                <div class="info-card__icon">🎬</div>
                <div class="info-card__content">
                    <div class="info-card__title">${this.app.t('label.video')}</div>
                    <div class="info-features-grid">
                        ${videoFeatures.join('')}
                    </div>
                </div>
            </div>
        `);
    }

    if (audioFeatures.length > 0) {
        featureCards.push(`
            <div class="info-card info-card--features">
                <div class="info-card__icon">🎵</div>
                <div class="info-card__content">
                    <div class="info-card__title">${this.app.t('label.audio')}</div>
                    <div class="info-features-grid">
                        ${audioFeatures.join('')}
                    </div>
                </div>
            </div>
        `);
    }

    if (extraFeatures.length > 0) {
        featureCards.push(`
            <div class="info-card info-card--features">
                <div class="info-card__icon">⚙️</div>
                <div class="info-card__content">
                    <div class="info-card__title">${this.app.t('label.extras') || 'Ekstra'}</div>
                    <div class="info-features-grid">
                        ${extraFeatures.join('')}
                    </div>
                </div>
            </div>
        `);
    }

    const allCards = [...basicCards, ...featureCards];
    const formatInfoHTML = `
        <div class="info-cards-grid">
            ${allCards.join('')}
        </div>
    `;

    let jobElement = document.getElementById(`job-${job.id}`);
    const statusText = {
        queued: this.app.t('status.queued'),
        processing: this.app.t('status.processing'),
        completed: this.app.t('status.completed'),
        error: this.app.t('status.error'),
        canceled: this.app.t('status.canceled'),
        cancelled: this.app.t('status.canceled')
    };

    const exMeta  = job.metadata?.extracted || {};
    const entry0  = Array.isArray(job.metadata?.frozenEntries) && job.metadata.frozenEntries.length
        ? job.metadata.frozenEntries[0]
        : null;
    const trackLabel = exMeta.track || exMeta.title || entry0?.title || null;

    let jobTitle = trackLabel || job.metadata?.originalName || job.metadata?.source || '';

    if (job.metadata?.isPlaylist) {
        jobTitle = this.playlistDisplayName(job);
    }

    if (job.metadata?.source === 'spotify') {
        jobTitle = `🎵 ${job.metadata.spotifyTitle || this.app.t('ui.spotifyPlaylist')}`;
    }
    if (job.metadata?.source === 'apple_music') {
        jobTitle = `🎵 ${job.metadata.spotifyTitle || this.app.t('ui.appleMusicPlaylist')}`;
    }
    if (job.metadata?.source === 'deezer') {
        jobTitle = `🎵 ${job.metadata.spotifyTitle || this.app.t('ui.deezerPlaylist')}`;
    }
    if (job.metadata?.source === 'tidal') {
        jobTitle = `🎵 ${job.metadata.spotifyTitle || this.app.t('ui.tidalPlaylist')}`;
    }
    if (job.metadata?.source === 'soundcloud') {
        jobTitle = `🎵 ${job.metadata.spotifyTitle || this.app.t('ui.soundCloudPlaylist')}`;
    }
    {
        const nowTrack = this.uiNowTitle(job);
        if (job.metadata?.isPlaylist && nowTrack) {
            jobTitle = `${this.playlistDisplayName(job)} — ${nowTrack}`;
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
        ? `<span class="chip chip--warn" title="${this.app.escapeHtml(job.lastLog || 'atlananlar')}">⚠️ ${this.app.t('jobs.skipped')}${skippedCount ? ` (${skippedCount})` : ''}</span>`
        : '';

    let resultContent = '';

    if (job.status === 'completed') {
        if (Array.isArray(job.resultPath)) {
            const successfulResults = job.resultPath.filter(r => r.outputPath && !r.error);
            if (successfulResults.length > 0) {
                const hasLyrics = job.metadata.includeLyrics;
                resultContent = `
                    <div class="download-list">
                        ${successfulResults.map((r, i) => {
                            const trackTitle = job.metadata?.frozenEntries?.[i]?.title || this.app.t('ui.track', { number: i + 1 });
                            const lrcBtn = r.lyricsPath
                                ? `<a href="${this.app.toRelative(r.lyricsPath)}" class="download-btn" download>${this.app.t('download.lyrics')}</a>`
                                : '';
                            return `
                                <div class="download-item">
                                    <span>${i + 1}. ${this.app.escapeHtml(trackTitle)}</span>
                                    <a href="${this.app.toRelative(r.outputPath)}" class="download-btn" download>${this.app.t('download.single')}</a>
                                    ${lrcBtn}
                                </div>
                            `;
                        }).join('')}
                        ${job.zipPath ? `
                            <div class="download-item" style="margin-top:8px;">
                                <strong>${this.app.t('ui.all')}:</strong>
                                <a href="${this.app.toRelative(job.zipPath)}" class="download-btn" download>
                                    ${hasLyrics ? this.app.t('download.allWithLyrics') : this.app.t('download.all')}
                                </a>
                            </div>` : ''}
                    </div>
                `;
            } else {
                resultContent = `<div style="color: var(--error); font-size: 13px;">❌ ${this.app.t('ui.noFilesConverted')}</div>`;
            }
        } else if (job.resultPath) {
            const rp = (typeof job.resultPath === 'string')
                ? { outputPath: job.resultPath }
                : job.resultPath;
            const hasLyricsFlag = !!rp.lyricsPath;
            const baseBtn = `<a href="${this.app.toRelative(rp.outputPath)}" class="download-btn" download>${this.app.t('download.single')}</a>`;
            const lrcBtn = hasLyricsFlag
                ? `<a href="${this.app.toRelative(rp.lyricsPath)}" class="download-btn" download>${this.app.t('download.lyrics')}</a>`
                : '';
            resultContent = `${baseBtn} ${lrcBtn}`;
        }

        if (resultContent) {
            resultContent += this.getOutputLocationBadgeHtml(job);
        }
    }

    let totalProgress = this.computeProg(job);
    const isMultiAudio =
        !job.metadata?.isPlaylist &&
        job.metadata?.selectedStreams &&
        Array.isArray(job.metadata.selectedStreams.audio) &&
        job.metadata.selectedStreams.audio.length > 1;

    const isVideoTranscode = job.format?.toLowerCase() === 'mp4' ||
                        job.format?.toLowerCase() === 'mkv' ||
                        job.format?.toLowerCase() === 'webm' ||
                        (job.videoSettings && job.videoSettings.transcodeEnabled);

    if (!Number.isFinite(totalProgress) || totalProgress <= 0) {
        totalProgress = this.computeProg(job);
    }

    totalProgress = Math.max(0, Math.min(100, totalProgress));

    let lyricsInfo = '';

    if (job.metadata?.includeLyrics && job.metadata?.lyricsStats) {
        const stats = job.metadata.lyricsStats;
        lyricsInfo = `<div class="lyrics-stats" style="font-size: 12px; color: var(--text-muted); margin: 4px 0;">
            🎼 ${this.app.t('label.includeLyrics2')}: ${this.app.t('ui.found')} ${stats.found}, ${this.app.t('ui.notFound')} ${stats.notFound}
        </div>`;
    }

    let lastLogInfo = '';

    if (job.lastLog || job.lastLogKey) {
        const raw = job.lastLogKey ? this.app.t(job.lastLogKey, job.lastLogVars || {}) : this.app.normalizeLog(job.lastLog);
        lastLogInfo = `<div class="last-log" style="font-size: 12px; color: var(--text-muted); margin: 4px 0; font-style: italic;">
            ${this.app.escapeHtml(raw)}
        </div>`;
    }

    let cancelInfo = '';
    if (job.canceledBy === 'user') {
        const selIdx = Array.isArray(job.metadata?.selectedIndices)
            ? job.metadata.selectedIndices[0]
            : null;

        const textKey = Number.isFinite(selIdx)
            ? 'status.canceledIndexed'
            : 'status.canceled';

        const msg = this.app.t(textKey, Number.isFinite(selIdx) ? { index: selIdx } : undefined);

        cancelInfo = `<div style="font-size: 12px; color: var(--text-muted); margin: 4px 0;">
           ${this.app.escapeHtml(msg)}
       </div>`;
    }

    let completedAtInfo = '';
    if (job.completedAt || job.createdAt) {
        const startedLabel = this.app.escapeHtml(this.app.t('jobsPanel.timeStart'));
        const endedLabel = this.app.escapeHtml(this.app.t('jobsPanel.timeEnd'));
        const totalLabel = this.app.escapeHtml(this.app.t('jobsPanel.timeTotal'));

        const startedFormatted = this.formatDateTime(job.createdAt);
        const completedFormatted = this.formatDateTime(job.completedAt);

        const startedAtMs = new Date(job.createdAt).getTime();
        const completedAtMs = new Date(job.completedAt).getTime();
        const elapsedMs = Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
            ? completedAtMs - startedAtMs
            : NaN;
        const elapsedFormatted = this.formatDurationMs(elapsedMs);

        const rows = [];
        if (startedFormatted) rows.push(`🟢 ${startedLabel}: ${this.app.escapeHtml(startedFormatted)}`);
        if (completedFormatted) rows.push(`🔴 ${endedLabel}: ${this.app.escapeHtml(completedFormatted)}`);
        if (elapsedFormatted) rows.push(`⏱️ ${totalLabel}: ${this.app.escapeHtml(elapsedFormatted)}`);

        if (rows.length) {
            completedAtInfo = `
                <div class="job-time" style="font-size: 12px; color: var(--text-muted); margin: 4px 0;">
                    ${rows.map(row => `<div>${row}</div>`).join('')}
                </div>
            `;
        }
    }

    const jobContent = `
    <div class="job-item-content">
        <strong>${this.app.escapeHtml(jobTitle)}</strong>
        <div style="font-size: 13px; color: var(--text-muted); margin: 8px 0;">
            ${phaseInfo}
            ${skippedBadge}
        </div>
        ${formatInfoHTML}
        ${lyricsInfo}
        ${lastLogInfo}
        ${cancelInfo}
        ${completedAtInfo}
        ${phaseDetails}

        ${(() => {
            const nt = this.uiNowTitle(job);
            return nt ? `<div class="muted" style="font-size:12px; margin: 8px 0 4px 0;">▶️ <strong>${this.app.escapeHtml(nt)}</strong></div>` : '';
        })()}

        <div class="progress-bar">
            <div class="progress-fill" style="width: ${totalProgress}%"></div>
        </div>
        <div class="job-actions" style="display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px;">
            <span class="status status-${job.status}">${statusText[job.status]}</span>
            <div style="display:flex; gap:8px; align-items:center; flex-direction: column;">
                ${resultContent}
                <button class="btn-danger" data-stop="${job.id}" ${(['completed', 'error', 'canceled'].includes(statusNorm)) ? 'disabled' : ''} title="${this.app.t('btn.stop')}">${this.app.t('btn.stop')}</button>
            </div>
        </div>
        ${job.error ? `<div style="color: var(--error); font-size: 13px; margin-top: 8px; padding: 8px; background: var(--bg-card); border-radius: 6px;">${this.app.escapeHtml(job.error)}</div>` : ''}
    </div>
`;

    if (!jobElement) {
        jobElement = document.createElement('div');
        jobElement.id = `job-${job.id}`;

        if (statusNorm === 'completed') {
            jobElement.className = 'job-item job-item--collapsible';
            const isExpanded = false;
            jobElement.innerHTML = `
                <button class="job-item-header" aria-expanded="${isExpanded}">
                    <div class="job-item-header__content">
                        <span class="job-item-header__title">${this.app.escapeHtml(jobTitle)}</span>
                        <span class="job-item-header__status status status-${job.status}">${statusText[job.status]}</span>
                    </div>
                    <span class="job-item-header__icon" aria-hidden="true">▾</span>
                </button>
                <div class="job-item-body" ${isExpanded ? '' : 'hidden'}>
                    ${jobContent}
                </div>
            `;
        } else {
            jobElement.className = 'job-item';
            jobElement.innerHTML = jobContent;
        }
    } else {
        if (statusNorm === 'completed' && !jobElement.classList.contains('job-item--collapsible')) {
            jobElement.className = 'job-item job-item--collapsible';
            const isExpanded = false;
            jobElement.innerHTML = `
                <button class="job-item-header" aria-expanded="${isExpanded}">
                    <div class="job-item-header__content">
                        <span class="job-item-header__title">${this.app.escapeHtml(jobTitle)}</span>
                        <span class="job-item-header__status status status-${job.status}">${statusText[job.status]}</span>
                    </div>
                    <span class="job-item-header__icon" aria-hidden="true">▾</span>
                </button>
                <div class="job-item-body" ${isExpanded ? '' : 'hidden'}>
                    ${jobContent}
                </div>
            `;
        } else if (statusNorm === 'completed') {
            const header = jobElement.querySelector('.job-item-header');
            const body = jobElement.querySelector('.job-item-body');
            if (header && body) {
                const titleSpan = header.querySelector('.job-item-header__title');
                const statusSpan = header.querySelector('.job-item-header__status');
                if (titleSpan) titleSpan.textContent = this.app.escapeHtml(jobTitle);
                if (statusSpan) statusSpan.textContent = statusText[job.status];
                statusSpan.className = `job-item-header__status status status-${job.status}`;

                body.innerHTML = jobContent;
            }
        } else {
            jobElement.innerHTML = jobContent;
        }
    }

    const parentForJob = ['completed', 'canceled', 'error'].includes(statusNorm)
        ? completedBody
        : activeBody;

    if (parentForJob) {
        const isTerminal = ['completed', 'canceled', 'error'].includes(statusNorm);

        if (isTerminal) {
            parentForJob.insertBefore(jobElement, parentForJob.firstChild || null);
        } else {
            if (jobElement.parentElement !== parentForJob) {
                parentForJob.appendChild(jobElement);
            }
        }
    }

    if (statusNorm === 'completed' || statusNorm === 'error' || statusNorm === 'canceled') {
        const header = jobElement.querySelector('.job-item-header');
        const body = jobElement.querySelector('.job-item-body');
        if (header && body) {
            if (!header.dataset.hasListener) {
                header.addEventListener('click', () => {
                    const expanded = header.getAttribute('aria-expanded') === 'true';
                    header.setAttribute('aria-expanded', expanded ? 'false' : 'true');
                    body.hidden = expanded;
                    header.classList.toggle('is-collapsed', expanded);
                });
                header.dataset.hasListener = 'true';
            }
        }
    }

    this.jobStates.set(job.id, job);

    let activeCount = 0;
    let completedCount = 0;
    for (const j of this.jobStates.values()) {
        const s = this.normalizeStatus(j.status);
        if (['completed', 'canceled', 'error'].includes(s)) {
            completedCount++;
        } else {
            activeCount++;
        }
    }
    const activeBadge = document.getElementById('session-active-count');
    const completedBadge = document.getElementById('session-completed-count');
    if (activeBadge) activeBadge.textContent = String(activeCount);
    if (completedBadge) completedBadge.textContent = String(completedCount);
    const stopBtn = jobElement.querySelector(`[data-stop="${job.id}"]`);
    if (stopBtn) {
    const newStopBtn = stopBtn.cloneNode(true);
    stopBtn.parentNode.replaceChild(newStopBtn, stopBtn);

    newStopBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        newStopBtn.disabled = true;

        try {
            const r = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, {
                method: 'POST'
            });

            if (r.status === 404) {
                this.removeJobCompletely(job.id);
                this.app.showNotification(
                    this.app.t('errors.jobLost') || 'İş sunucuda bulunamadı, listeden kaldırıldı.',
                    'info',
                    'action'
                );
                return;
            }
            if (!r.ok) {
                const eData = await r.json().catch(() => ({}));
                throw new Error(eData?.error?.message || this.app.t('notif.cancelFailed'));
            }
            const js = this.jobStates.get(job.id) || {};
            js.status = 'canceled';
            js.phase = 'canceled';
            js.currentPhase = 'canceled';
            this.jobStates.set(job.id, js);
            this.updateJobUI(js, this.jobToBatch.get(job.id) || null);

            this.app.showNotification(this.app.t('notif.canceledByUser'), 'success', 'action');
            this.saveSessionState();
        } catch (e) {
            newStopBtn.disabled = false;
            this.app.showNotification(
                `${this.app.t('notif.cancelFailed')}: ${e.message}`,
                'error',
                'error'
            );
            this.saveSessionState();
            }
        });
    }
}
    // Handles ensure batch in the browser UI layer.
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
        const sourceText = this.formatBatchSource(meta);
        batchElement.innerHTML = `
            <strong>${sourceText} — ${this.app.t('label.sequential')}</strong>
            <div style="font-size: 13px; color: var(--text-muted); margin: 8px 0;">
                ${meta?.format?.toUpperCase() || ''} • ${meta?.bitrate || ''}
            </div>
            <div class="progress-bar">
                <div class="progress-fill" id="batch-progress-${batchId}" style="width: 0%"></div>
            </div>
            <div class="batch-info">
                ${this.app.t('batch.done')}: <span id="batch-done-${batchId}">0</span> / <span id="batch-total-${batchId}">${total || '?'}</span>
            </div>
            <div class="batch-actions" style="margin:8px 0 4px; display:flex; justify-content:flex-end;">
                <button class="btn-danger" data-stop-batch="${batchId}">
                    ${this.app.t('btn.stop') || 'Hepsini Durdur'}
                </button>
            </div>
            <div class="download-list" id="batch-list-${batchId}"></div>
        `;

        jobList.appendChild(batchElement);

        batch = {
            el: batchElement,
            total: total || 0,
            done: 0,
            jobs: new Set(),
            meta: meta || {}
        };

        this.batches.set(batchId, batch);
        const stopBtn = batchElement.querySelector(`[data-stop-batch="${batchId}"]`);
        if (stopBtn) {
            stopBtn.addEventListener('click', () => this.cancelBatch(batchId));
        }
        this.saveSessionState();
        return batch;
    }

    // Handles append batch row in the browser UI layer.
    appendBatchRow(batchId, { title, href }) {
        const list = document.getElementById(`batch-list-${batchId}`);
        if (!list) return;

        let raw = '';
            if (typeof href === 'string') {
                raw = href;
            } else if (href && typeof href === 'object') {
                raw = href.outputPath || href.path || '';
            }
            if (!raw) return;

    const finalHref = this.app.toRelative(raw);

        const row = document.createElement('div');
        row.className = 'download-item';
        row.innerHTML = `
            <span>${this.app.escapeHtml(title || this.app.t('ui.track'))}</span>
            <a href="${finalHref}" class="download-btn" download>${this.app.t('download.single')}</a>
        `;
        list.appendChild(row);
    }

    // Updates batch progress for the browser UI layer.
    updateBatchProgress(batchId) {
        const batch = this.batches.get(batchId);
        if (!batch) return;

        const jobs = Array.from(batch.jobs)
            .map(id => this.jobStates.get(id))
            .filter(Boolean);

        const total = batch.total || jobs.length || 1;

        let totalProgressSum = 0;
        let completedCount = 0;

        for (const j of jobs) {
            const status = this.normalizeStatus(j.status);

            if (status === 'completed') {
                totalProgressSum += 100;
                completedCount++;
                continue;
            }

            const phase = this.normalizeStatus(j.currentPhase || j.phase);
            const dl = Number(j.downloadProgress ?? j.progress ?? 0) || 0;
            let cv = 0;
            if (phase === 'converting' || phase === 'completed') {
                cv = Number(j.convertProgress ?? 0) || 0;
            }

            let single;
            if (dl && cv) {
                single = dl * 0.5 + cv * 0.5;
            } else {
                single = dl || cv;
            }
            totalProgressSum += Math.max(0, Math.min(100, single));
        }

        const percentage = Math.min(100, Math.max(0, totalProgressSum / total));

        batch.done = completedCount;

        const progressElement = document.getElementById(`batch-progress-${batchId}`);
        const doneElement = document.getElementById(`batch-done-${batchId}`);
        const totalElement = document.getElementById(`batch-total-${batchId}`);

        if (progressElement) progressElement.style.width = `${percentage}%`;
        if (doneElement) doneElement.textContent = completedCount;
        if (totalElement) totalElement.textContent = total;

        const anyActive = jobs.some(j => {
            const s = this.normalizeStatus(j.status);
            return !['completed', 'error', 'canceled'].includes(s);
        });
        const stopBtn = document.querySelector(`[data-stop-batch="${batchId}"]`);
        if (stopBtn) stopBtn.disabled = !anyActive;
    }

    // Removes job state completely from the browser UI layer.
    removeJobCompletely(jobId) {
    const batchId = this.jobToBatch.get(jobId) || null;
    this.jobStates.delete(jobId);

    if (batchId && this.batches.has(batchId)) {
        const batch = this.batches.get(batchId);
        batch.jobs.delete(jobId);
        this.updateBatchProgress(batchId);
        if (batch.jobs.size === 0 && batch.el && batch.el.parentElement) {
            batch.el.parentElement.removeChild(batch.el);
            this.batches.delete(batchId);
        }
    }

    const el = document.getElementById(`job-${jobId}`);
    if (el && el.parentElement) {
        el.parentElement.removeChild(el);
    }

    let activeCount = 0;
    let completedCount = 0;
    for (const j of this.jobStates.values()) {
        const s = this.normalizeStatus(j.status);
        if (['completed', 'canceled', 'error'].includes(s)) {
            completedCount++;
        } else {
            activeCount++;
        }
    }
    const activeBadge = document.getElementById('session-active-count');
    const completedBadge = document.getElementById('session-completed-count');
    if (activeBadge) activeBadge.textContent = String(activeCount);
    if (completedBadge) completedBadge.textContent = String(completedCount);
    this.saveSessionState();
}
    // Cancels batch in the browser UI layer.
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
        this.app.showNotification(this.app.t('notif.canceledByUser') || 'Batch iptal edildi', 'success', 'action');
        this.saveSessionState();
    }

        // Determines whether persist job state should run for the browser UI layer.
        shouldPersistJob(job) {
        const s = this.normalizeStatus(job.status);
        if (s === 'canceled' || s === 'error') {
            return false;
        }
        return true;
    }
        // Persists session state for the browser UI layer.
        saveSessionState() {
        try {
            const all = Array.from(this.jobStates.values())
                .filter(job => this.shouldPersistJob(job));

            const activeJobs = all.filter(job => {
                const s = this.normalizeStatus(job.status);
                return s !== 'completed';
            });

            const completedJobs = all.filter(job => {
                const s = this.normalizeStatus(job.status);
                return s === 'completed';
            });

            completedJobs.sort((a, b) => {
                const ta = a.completedAt || 0;
                const tb = b.completedAt || 0;
                return tb - ta;
            });

            const limitedCompleted = completedJobs.slice(0, 15);
            const jobs = [...activeJobs, ...limitedCompleted];
            const validIds = new Set(jobs.map(j => j.id));
            const batches = Array.from(this.batches.entries())
                .map(([id, b]) => ({
                    id,
                    total: b.total,
                    meta: b.meta || {},
                    jobs: Array.from(b.jobs || []).filter(jobId => validIds.has(jobId))
                }))
                .filter(b => b.jobs.length > 0);

            const jobToBatch = {};
            this.jobToBatch.forEach((batchId, jobId) => {
                if (validIds.has(jobId)) {
                    jobToBatch[jobId] = batchId;
                }
            });

            const payload = {
                jobs,
                batches,
                jobToBatch,
                savedAt: Date.now(),
                version: 1
            };

            this.lastSessionSavedAt = payload.savedAt;
            localStorage.setItem(this.storageKey, JSON.stringify(payload));
        } catch (e) {
            console.warn('[JobManager] saveSessionState error:', e);
        }
    }

        // Handles job state has existing output in the browser UI layer.
        async jobHasExistingOutput(job) {
            const s = this.normalizeStatus(job.status);
            if (s !== 'completed') return true;

            const candidates = [];

            if (typeof job.resultPath === 'string' && job.resultPath) {
                candidates.push(job.resultPath);
            }
            else if (Array.isArray(job.resultPath)) {
                const firstOk = job.resultPath.find(r => r && r.outputPath && !r.error);
                if (firstOk && firstOk.outputPath) candidates.push(firstOk.outputPath);
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

            return await this.checkOutputExists(candidates[0]);
        }

        // Checks output existence through the API to avoid noisy /download 404 requests.
        async checkOutputExists(rawPath) {
            const path = String(rawPath || '').trim();
            if (!path) return false;
            return outputExistenceClient.check(path);
        }

        // Handles prune playlist data outputs in the browser UI layer.
        async prunePlaylistOutputs(job) {
            const s = this.normalizeStatus(job.status);
            if (s !== 'completed') return true;

            if (!Array.isArray(job.resultPath)) {
                return true;
            }

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
                if (!existence.get(String(job.zipPath).trim())) {
                    job.zipPath = null;
                }
            }

            if (keptResults.length === 0 && !job.zipPath) {
                return false;
            }

            job.resultPath = keptResults;
            return true;
        }

        // Handles restore session state in the browser UI layer.
        async restoreSessionState({ persist = true } = {}) {
            if (this.restoreSessionInFlight) return;
            this.restoreSessionInFlight = true;

            try {
                const raw = localStorage.getItem(this.storageKey);
                if (!raw) return;

                const data = JSON.parse(raw);
                if (!data || !Array.isArray(data.jobs)) return;
                this.lastSessionSavedAt = Number(data.savedAt || this.lastSessionSavedAt || 0);

                this.sessionSectionsInitialized = false;

                const allJobs = data.jobs || [];
                const completedOutputPaths = allJobs
                    .filter((job) => this.normalizeStatus(job?.status) === 'completed')
                    .flatMap((job) => collectJobOutputPaths(job));
                await outputExistenceClient.checkMany(completedOutputPaths);

                const validJobs = [];
                const validIds = new Set();

                for (const job of allJobs) {
                if (!this.shouldPersistJob(job)) continue;

                const status = this.normalizeStatus(job.status);

                if (status === 'completed') {
                    let keep = true;

                    if (Array.isArray(job.resultPath)) {
                        keep = await this.prunePlaylistOutputs(job);
                    } else {
                        const hasOutput = await this.jobHasExistingOutput(job);
                        keep = hasOutput;
                    }
                    if (!keep) {
                        continue;
                    }
                }

                validJobs.push(job);
                validIds.add(job.id);
            }
                this.batches.clear();
                this.jobToBatch.clear();
                this.jobStates.clear();

                (data.batches || []).forEach(b => {
                    const jobIds = (b.jobs || []).filter(id => validIds.has(id));
                    if (!jobIds.length) return;

                    const batch = this.ensureBatch(b.id, b.total, b.meta || {});
                    jobIds.forEach(jobId => {
                        batch.jobs.add(jobId);
                        this.jobToBatch.set(jobId, b.id);
                    });
                });

                for (const job of validJobs) {
                    this.jobStates.set(job.id, job);
                    const batchId = data.jobToBatch?.[job.id] || null;

                    this.updateJobUI(job, batchId);

                    const s = this.normalizeStatus(job.status);
                    if (!['completed', 'error', 'canceled'].includes(s)) {
                        this.trackJob(job.id, batchId);
                    }
                }

                if (persist) this.saveSessionState();
            } catch (e) {
                console.warn('[JobManager] restoreSessionState error:', e);
                try { localStorage.removeItem(this.storageKey); } catch (_) {}
            } finally {
                this.restoreSessionInFlight = false;
            }
        }

    // Handles submit job state in the browser UI layer.
    async submitJob(payload, isFormData = false) {
        try {
            console.log("Sent payload:", payload);

            const outputProfile = this.app.applyCurrentOutputProfile(payload, { isFormData });
            this.app.applyCurrentAudioProcessingSettings(payload, { isFormData });
            const format = String(outputProfile.format || '').toLowerCase();
            const disableAutoZip = format === 'mp4' || format === 'mkv';

            if (disableAutoZip) {
                if (!isFormData) {
                    payload.autoCreateZip = false;
                } else if (typeof payload?.set === 'function') {
                    payload.set('autoCreateZip', 'false');
                } else if (typeof payload?.append === 'function') {
                    payload.append('autoCreateZip', 'false');
                }
            }

            if (!isFormData && payload.youtubeConcurrency != null) {
            payload.youtubeConcurrency = Number(payload.youtubeConcurrency) || 4;
        } else if (isFormData && payload.youtubeConcurrency != null && typeof payload.append === 'function') {
            payload.append('youtubeConcurrency', String(payload.youtubeConcurrency));
        }

            if ((format === 'mp4' || format === 'mkv' || format === 'webm') && this.app.videoManager.videoSettings.transcodeEnabled) {
                console.log("🎬 Adding video settings to payload:", this.app.videoManager.videoSettings);
                if (!isFormData) {
                    payload.videoSettings = this.app.videoManager.videoSettings;
                } else {
                    payload.append('videoSettings', JSON.stringify(this.app.videoManager.videoSettings));
                }
            } else {
            }

            if (payload.selectedStreams && !isFormData) {
                payload.selectedStreams = JSON.stringify(payload.selectedStreams);
            } else if (payload.selectedStreams && isFormData) {
                payload.append('selectedStreams', JSON.stringify(payload.selectedStreams));
            }

            const wantStereoTempo = ['eac3', 'ac3', 'aac', 'dts'].includes(format);

                if (wantStereoTempo) {
                const stereoConvert =
                    (!isFormData && payload?.stereoConvert) ? payload.stereoConvert
                    : (document.getElementById('stereoConvertSelect')?.value || 'auto');

                const atempoAdjust =
                    (!isFormData && payload?.atempoAdjust) ? payload.atempoAdjust
                    : (document.getElementById('atempoSelect')?.value || 'none');

                if (!isFormData) {
                    payload.stereoConvert = stereoConvert;
                    payload.atempoAdjust = atempoAdjust;
                } else {
                    payload.append('stereoConvert', stereoConvert);
                    payload.append('atempoAdjust', atempoAdjust);
                }
            }

            if (format === 'flac' || format === 'wav') {
                const bitDepth = document.getElementById('bitDepthSelect')?.value || '16';
                if (!isFormData) {
                    payload.bitDepth = bitDepth;
                } else {
                    payload.append('bitDepth', bitDepth);
                }
            }

            if (format === 'flac') {
                const compEl = document.getElementById('compressionLevelRange');
                const compVal = compEl ? compEl.value : '5';
                if (!isFormData) payload.compressionLevel = compVal;
                else payload.append('compressionLevel', compVal);
            }

            const response = await fetch('/api/jobs', {
                method: 'POST',
                headers: isFormData ? {} : { 'Content-Type': 'application/json' },
                body: isFormData ? payload : JSON.stringify(payload)
            });

            if (!response.ok) {
                const e = await response.json().catch(() => ({}));
                const msg = e?.error?.code ? this.app.t(`errors.${e.error.code}`) : (e?.error?.message || 'error');
                throw new Error(msg);
            }

            const result = await response.json();
            console.log("Job created:", result);

            if (result.clientBatch) {
                this.jobToBatch.set(result.id, result.clientBatch);
                this.ensureBatch(result.clientBatch, result.batchTotal, {
                    format: result.format,
                    bitrate: result.bitrate,
                    source: result.mediaPlatform || result.source
                });
                this.trackJob(result.id, result.clientBatch);
            } else {
                const empty = document.getElementById('job-empty');
                if (empty) empty.remove();
                this.trackJob(result.id);
            }

            this.app.showNotification(this.app.t('notif.queue'), 'success', 'queue');
            this.saveSessionState();
        } catch (error) {
            console.error("Job submission error:", error);
            this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
        }
    }
}
