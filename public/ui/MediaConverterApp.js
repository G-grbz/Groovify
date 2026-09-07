import { VideoSettingsManager } from './VideoSettingsManager.js';
import { JobManager } from './JobManager.js';
import { PreviewManager } from './PreviewManager.js';
import { SpotifyManager } from './SpotifyManager.js';
import { UploadManager } from './UploadManager.js';
import { FormatManager } from './FormatManager.js';
import { notificationManager } from './NotificationManager.js';
import { modalManager } from './ModalManager.js';
import { settingsManager } from './SettingsManager.js';
import { RetagManager } from './RetagManager.js';
import { MusicUrlQueueManager } from './MusicUrlQueueManager.js';

export class MediaConverterApp {
    // Initializes class state and defaults for the browser UI layer.
    constructor() {
        this._escapeMap = {
            '&': '&amp;', '<': '&lt;', '>': '&gt;',
            '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;', '/': '&#47;'
        };

        this.includeLyrics = false;
        this.embedLyrics = false;
        this.currentSampleRate = 48000;
        this.currentVolumeGain = 1.0;
        this.currentLoudnorm = false;
        this.currentLoudnormMode = 'ebu_r128';
        this.videoManager = new VideoSettingsManager(this);
        this.jobManager = new JobManager(this);
        this.previewManager = new PreviewManager(this);
        this.spotifyManager = new SpotifyManager(this);
        this.uploadManager = new UploadManager(this);
        this.autoCreateZip = true;
        this.formatManager = new FormatManager(this);
        this.retagManager = new RetagManager(this);
        this.musicUrlQueueManager = new MusicUrlQueueManager(this);
        this.notificationManager = notificationManager;
        this.modalManager = modalManager;
        this.lastPreviewedPlaylistUrl = null;
        this.qualityLabelElement = null;
        this.outputLocations = null;
        this.ringtoneSettingsStorageKey = 'gharmonize_ringtone_settings';
        this.standardAudioSettingsStorageKey = 'gharmonize_standard_audio_settings';
        this.binaryFooterStatus = null;
        this.binaryStatusPollTimeoutId = null;
    }

    // Initializes startup state for the browser UI layer.
    async initialize() {
        this.initializeTheme();
        const savedAutoZip = localStorage.getItem('autoCreateZip');
        if (savedAutoZip !== null) {
            this.autoCreateZip = savedAutoZip === 'true';
        }
        this.applySavedRingtoneSettingsToUI();
        this.applySavedStandardAudioSettingsToUI();

        if (this.videoManager?.initialize) {
            await this.videoManager.initialize();
        }

        this.loadFfmpegCaps();
        this.loadOutputLocations();
        this.retagManager.initialize();
        this.musicUrlQueueManager.initialize();
        this.initializeEventListeners();
        this.jobManager.restoreSessionState();

        await this.formatManager.loadFormats();
        this.ensureWarnStyles();
        this.loadLocalFiles();
        this.renderBinaryFooterLabel();
        this.scheduleBinaryStatusPoll(0);
        this.loadBinaryVersions().catch(err => {
            console.error('Failed to load binary versions:', err);
        });
        this.scheduleBinaryVersionRefresh();
    }

    // Loads output locations for the browser UI layer.
    async loadOutputLocations() {
        try {
            const resp = await fetch('/api/outputs/location');
            if (!resp.ok) return;
            const data = await resp.json();
            if (!data || (!data.linuxPath && !data.windowsPath)) return;
            this.outputLocations = {
                linuxPath: String(data.linuxPath || ''),
                windowsPath: String(data.windowsPath || '')
            };

            for (const job of this.jobManager.jobStates.values()) {
                this.jobManager.updateJobUI(job, this.jobManager.jobToBatch.get(job.id) || null);
            }
        } catch (e) {
            console.warn('Failed to load output locations:', e);
        }
    }

    // Parses mapped music source type for the browser UI layer.
    parseSpotifyType(u) {
        if (!u) return null;
        const s = String(u).trim();
        const m1 = s.match(/^spotify:(track|album|playlist|artist|show|episode):/i);
        if (m1) return m1[1].toLowerCase();
        const m2 = s.match(/^deezer:(track|album|playlist|artist):/i);
        if (m2) return m2[1].toLowerCase();

        try {
            const url = new URL(s, window.location.origin);
            const host = url.hostname.toLowerCase();
            const isSpotifyHost =
            (host === 'spotify.com' || host.endsWith('.spotify.com')) ||
            (host === 'spotify.link' || host.endsWith('.spotify.link')) ||
            (host === 'spotify.app.link' || host.endsWith('.spotify.app.link'));
            const isAppleHost =
            host === 'music.apple.com' ||
            host === 'embed.music.apple.com';
            const isDeezerHost =
            host === 'deezer.com' ||
            host === 'www.deezer.com' ||
            host.endsWith('.deezer.com') ||
            host.endsWith('deezer.page.link');
            const isTidalHost = host === 'tidal.com' || host === 'www.tidal.com' || host === 'listen.tidal.com';
            const isSoundCloudHost = host === 'soundcloud.com' || host.endsWith('.soundcloud.com');

            if (isAppleHost) {
                const parts = url.pathname.split('/').filter(Boolean);
                const t = (parts[1] || '').toLowerCase();
                if (url.searchParams.has('i')) return 'track';
                if (['song', 'album', 'playlist'].includes(t)) {
                    return t === 'song' ? 'track' : t;
                }
                return null;
            }

            if (isTidalHost) {
                const parts = url.pathname.split('/').filter(Boolean).map((part) => part.toLowerCase());
                if (parts[0] === 'playlist' && parts[1]) return 'playlist';
                if (parts[0] === 'album' && parts[1]) {
                    return parts[2] === 'track' && parts[3] ? 'track' : 'album';
                }
                return null;
            }

            if (isDeezerHost) {
                const parts = url.pathname.split('/').filter(Boolean);
                const first = (parts[0] || '').toLowerCase();
                const second = (parts[1] || '').toLowerCase();
                const searchIndex = first === 'search'
                    ? 0
                    : second === 'search'
                        ? 1
                        : -1;
                if (
                    searchIndex >= 0 &&
                    (parts[searchIndex + 1] || '') &&
                    (parts[searchIndex + 2] || '').toLowerCase() === 'track'
                ) return 'playlist';

                const smartTracklistIndex = first === 'smarttracklist'
                    ? 0
                    : second === 'smarttracklist'
                        ? 1
                        : -1;
                if (
                    smartTracklistIndex >= 0 &&
                    /^inspired-by-\d+$/i.test(parts[smartTracklistIndex + 1] || '')
                ) return 'playlist';
                const typeIndex = ['track', 'album', 'playlist', 'artist'].includes(first) ? 0
                    : ['track', 'album', 'playlist', 'artist'].includes(second) ? 1
                    : -1;
                if (typeIndex >= 0) return (parts[typeIndex] || '').toLowerCase();
                return null;
            }

            if (isSoundCloudHost) {
                const parts = url.pathname.split('/').filter(Boolean);
                const first = (parts[0] || '').toLowerCase();
                const second = (parts[1] || '').toLowerCase();
                if (first === 'discover' && second === 'sets' && parts[2]) return 'playlist';
                if (first === 'buzzing-playlists' && second === 'sets' && parts[2]) return 'playlist';
                if (first === 'stations' && second === 'track' && parts[2]) return 'playlist';
                if (['discover', 'charts', 'buzzing-playlists', 'stations'].includes(first)) return null;
                if (second === 'sets' && parts[2]) return 'playlist';
                if (['tracks', 'likes', 'reposts', 'sets', 'albums', 'popular-tracks', 'spotlight'].includes(second) || parts.length === 1) return 'playlist';
                if (parts.length >= 2) return 'track';
                return null;
            }

            if (!isSpotifyHost) return null;

            const parts = url.pathname.split('/').filter(Boolean);
            const t = (parts[0] || '').toLowerCase();
            if (['track','album','playlist','artist','show','episode'].includes(t)) return t;

            return null;
        } catch {
            return null;
        }
    }

    // Handles sync embed lyrics metadata checkbox visibility in the browser UI layer.
    syncEmbedLyricsCheckboxVisibility() {
        const embedContainer = document.getElementById('embedLyricsCheckboxContainer');
        const lyricsContainer = document.getElementById('lyricsCheckboxContainer');

        if (!embedContainer || !lyricsContainer) return;

        const shouldShow = lyricsContainer.style.display !== 'none';
        embedContainer.style.display = shouldShow ? 'flex' : 'none';
    }

    // Updates auto zip visibility used for the browser UI layer.
    setAutoZipVisibility(show) {
        const c = document.getElementById('autoZipCheckboxContainer');
        if (!c) return;
        c.style.display = show ? 'flex' : 'none';
    }

    // Handles ensure warn styles in the browser UI layer.
    ensureWarnStyles() {
        if (document.getElementById('skipped-badge-style')) return;
        const st = document.createElement('style');
        st.id = 'skipped-badge-style';
        document.head.appendChild(st);
    }

    // Determines whether show auto zip for current UI state should run for the browser UI layer.
    shouldShowAutoZipForCurrentUI({ url, total = null } = {}) {
        if (this.isRetagMode()) return false;
        const format = this.getEffectiveFormat(document.getElementById('formatSelect')?.value || 'mp3');
        const isVideo = (format === 'mp4' || format === 'mkv');
        if (isVideo) return false;

        const u = (url ?? document.getElementById('urlInput')?.value ?? '').trim();
        if (!u) return false;

        if (this.isSpotifyUrl(u)) {
        if (total !== null && total !== undefined && total !== '') {
            const n = Number(total);
            if (Number.isFinite(n)) return n > 1;
        }

        if (/^https?:\/\/(spotify\.link|spotify\.app\.link)\//i.test(u)) return true;

        const t = this.parseSpotifyType(u);
        return (t === 'playlist' || t === 'album');
        }

        return this.isYoutubePlaylistUrl(u);
        }

    // Returns selected output mode for the browser UI layer.
    getOutputMode() {
        return document.getElementById('outputModeSelect')?.value || 'standard';
    }

    // Checks whether ringtone mode is active for the browser UI layer.
    isRingtoneMode() {
        return this.getOutputMode() === 'ringtone';
    }

    // Checks whether in-place metadata rewriting is active.
    isRetagMode() {
        return this.getOutputMode() === 'retag';
    }

    // Returns ringtone target for the browser UI layer.
    getRingtoneTarget() {
        const target = document.getElementById('ringtoneTargetSelect')?.value || 'android';
        return target === 'iphone' ? 'iphone' : 'android';
    }

    // Returns ringtone duration limit for the browser UI layer.
    getRingtoneDurationLimit(target = null) {
        return (target || this.getRingtoneTarget()) === 'iphone' ? 40 : 60;
    }

    // Returns localized ringtone target label for the browser UI layer.
    getRingtoneTargetLabel(target = null) {
        const key = (target || this.getRingtoneTarget()) === 'iphone'
            ? 'ringtone.target.iphone'
            : 'ringtone.target.android';
        return this.t(key);
    }

    // Returns ringtone UI defaults for the browser UI layer.
    getDefaultRingtoneSettings() {
        return {
            target: 'android',
            mode: 'auto',
            durationSec: 30,
            startSec: 30,
            fadeInSec: 0.5,
            fadeOutSec: 1
        };
    }

    // Normalizes ringtone settings for the browser UI layer.
    normalizeRingtoneSettings(raw = {}) {
        const defaults = this.getDefaultRingtoneSettings();
        const fadeAllowed = new Set([0.5, 1, 1.5]);
        const target = raw?.target === 'iphone' ? 'iphone' : 'android';
        const mode = raw?.mode === 'manual' ? 'manual' : 'auto';
        const durationValue = Number(raw?.durationSec);
        const startValue = Number(raw?.startSec);
        const fadeInValue = Number(raw?.fadeInSec);
        const fadeOutValue = Number(raw?.fadeOutSec);
        const maxDuration = this.getRingtoneDurationLimit(target);

        return {
            target,
            mode,
            durationSec: Math.min(
                maxDuration,
                Math.max(5, Number.isFinite(durationValue) ? durationValue : defaults.durationSec)
            ),
            startSec: Math.max(0, Number.isFinite(startValue) ? startValue : defaults.startSec),
            fadeInSec: fadeAllowed.has(fadeInValue) ? fadeInValue : defaults.fadeInSec,
            fadeOutSec: fadeAllowed.has(fadeOutValue) ? fadeOutValue : defaults.fadeOutSec
        };
    }

    // Loads saved ringtone settings for the browser UI layer.
    loadSavedRingtoneSettings() {
        const saved = localStorage.getItem(this.ringtoneSettingsStorageKey);
        if (!saved) return this.getDefaultRingtoneSettings();

        try {
            return this.normalizeRingtoneSettings(JSON.parse(saved));
        } catch (error) {
            console.warn('Failed to load ringtone settings:', error);
            return this.getDefaultRingtoneSettings();
        }
    }

    // Applies saved ringtone settings to current UI controls for the browser UI layer.
    applySavedRingtoneSettingsToUI() {
        const settings = this.loadSavedRingtoneSettings();
        const targetSelect = document.getElementById('ringtoneTargetSelect');
        const modeSelect = document.getElementById('ringtoneModeSelect');
        const durationInput = document.getElementById('ringtoneDurationInput');
        const startInput = document.getElementById('ringtoneStartInput');
        const fadeInSelect = document.getElementById('ringtoneFadeInSelect');
        const fadeOutSelect = document.getElementById('ringtoneFadeOutSelect');

        if (targetSelect) targetSelect.value = settings.target;
        if (modeSelect) modeSelect.value = settings.mode;
        if (durationInput) {
            durationInput.max = String(this.getRingtoneDurationLimit(settings.target));
            durationInput.value = String(settings.durationSec);
        }
        if (startInput) startInput.value = String(settings.startSec);
        if (fadeInSelect) fadeInSelect.value = String(settings.fadeInSec);
        if (fadeOutSelect) fadeOutSelect.value = String(settings.fadeOutSec);
    }

    // Persists ringtone settings to storage for the browser UI layer.
    persistRingtoneSettingsToStorage() {
        const settings = this.normalizeRingtoneSettings({
            target: document.getElementById('ringtoneTargetSelect')?.value,
            mode: document.getElementById('ringtoneModeSelect')?.value,
            durationSec: document.getElementById('ringtoneDurationInput')?.value,
            startSec: document.getElementById('ringtoneStartInput')?.value,
            fadeInSec: document.getElementById('ringtoneFadeInSelect')?.value,
            fadeOutSec: document.getElementById('ringtoneFadeOutSelect')?.value
        });

        localStorage.setItem(this.ringtoneSettingsStorageKey, JSON.stringify(settings));
        return settings;
    }

    // Returns whether the given format should be treated as video in the browser UI layer.
    isVideoFormat(format = null) {
        const effectiveFormat = String(format || this.getEffectiveFormat()).toLowerCase();
        return effectiveFormat === 'mp4' || effectiveFormat === 'mkv';
    }

    // Normalizes standard audio settings for the browser UI layer.
    normalizeStandardAudioSettings(settings = null) {
        const rawSampleRate = Number(settings?.sampleRate);
        const bitrates = {};
        const rawBitrates = settings?.bitrates;

        if (rawBitrates && typeof rawBitrates === 'object') {
            Object.entries(rawBitrates).forEach(([format, value]) => {
                const normalizedFormat = String(format || '').trim().toLowerCase();
                const normalizedValue = String(value || '').trim();
                if (normalizedFormat && normalizedValue) {
                    bitrates[normalizedFormat] = normalizedValue;
                }
            });
        }

        if (Object.keys(bitrates).length === 0) {
            const legacyBitrate = String(settings?.bitrate || '').trim();
            if (legacyBitrate) {
                bitrates.mp3 = legacyBitrate;
            }
        }

        return {
            sampleRate: Number.isFinite(rawSampleRate) && rawSampleRate > 0
                ? Math.round(rawSampleRate)
                : 48000,
            bitrates
        };
    }

    // Loads saved standard audio settings from storage for the browser UI layer.
    loadSavedStandardAudioSettingsFromStorage() {
        try {
            const saved = localStorage.getItem(this.standardAudioSettingsStorageKey);
            if (!saved) {
                return this.normalizeStandardAudioSettings();
            }

            return this.normalizeStandardAudioSettings(JSON.parse(saved));
        } catch (error) {
            console.warn('Failed to load standard audio settings:', error);
            return this.normalizeStandardAudioSettings();
        }
    }

    // Returns saved bitrate for the requested standard format in the browser UI layer.
    getSavedStandardBitrate(format = null) {
        const normalizedFormat = String(format || this.getEffectiveFormat()).trim().toLowerCase();
        if (!normalizedFormat) return '';

        const settings = this.loadSavedStandardAudioSettingsFromStorage();
        return String(settings?.bitrates?.[normalizedFormat] || '').trim();
    }

    // Applies saved standard audio settings to current UI controls for the browser UI layer.
    applySavedStandardAudioSettingsToUI() {
        const settings = this.loadSavedStandardAudioSettingsFromStorage();
        this.currentSampleRate = settings.sampleRate;

        const sampleRateSelect = document.getElementById('sampleRateSelect');
        if (!sampleRateSelect) return;

        const sampleRateValue = String(settings.sampleRate);
        const supportsSavedRate = Array.from(sampleRateSelect.options || []).some(
            (option) => String(option.value) === sampleRateValue
        );
        if (supportsSavedRate) {
            sampleRateSelect.value = sampleRateValue;
        }
    }

    // Persists standard-mode audio settings to storage for the browser UI layer.
    persistStandardAudioSettingsToStorage({ format = null, bitrate = null, sampleRate = null } = {}) {
        const effectiveFormat = String(format || this.getEffectiveFormat()).trim().toLowerCase();
        if (!effectiveFormat || this.isRingtoneMode() || this.isVideoFormat(effectiveFormat)) {
            return;
        }

        const currentSettings = this.loadSavedStandardAudioSettingsFromStorage();
        const nextSettings = {
            ...currentSettings,
            bitrates: {
                ...(currentSettings.bitrates || {})
            }
        };

        const normalizedSampleRate = Number(
            sampleRate ?? document.getElementById('sampleRateSelect')?.value ?? this.currentSampleRate ?? 48000
        );
        nextSettings.sampleRate = Number.isFinite(normalizedSampleRate) && normalizedSampleRate > 0
            ? Math.round(normalizedSampleRate)
            : 48000;
        this.currentSampleRate = nextSettings.sampleRate;

        const normalizedBitrate = String(
            bitrate ?? document.getElementById('bitrateSelect')?.value ?? ''
        ).trim();
        if (normalizedBitrate) {
            nextSettings.bitrates[effectiveFormat] = normalizedBitrate;
        }

        localStorage.setItem(
            this.standardAudioSettingsStorageKey,
            JSON.stringify(this.normalizeStandardAudioSettings(nextSettings))
        );
    }

    // Builds ringtone payload from current UI state for the browser UI layer.
    buildCurrentRingtonePayload() {
        if (!this.isRingtoneMode()) return null;

        const target = this.getRingtoneTarget();
        const maxDuration = this.getRingtoneDurationLimit(target);
        const mode = document.getElementById('ringtoneModeSelect')?.value === 'manual'
            ? 'manual'
            : 'auto';
        const durationInput = Number(document.getElementById('ringtoneDurationInput')?.value || 30);
        const startInput = Number(document.getElementById('ringtoneStartInput')?.value || 0);
        const fadeInRaw = Number(document.getElementById('ringtoneFadeInSelect')?.value || 0.5);
        const fadeOutRaw = Number(document.getElementById('ringtoneFadeOutSelect')?.value || 1);
        const fadeAllowed = new Set([0.5, 1, 1.5]);
        const durationSec = Math.min(maxDuration, Math.max(5, Number.isFinite(durationInput) ? durationInput : 30));
        const startSec = Math.max(0, Number.isFinite(startInput) ? startInput : 0);
        const fadeInSec = fadeAllowed.has(fadeInRaw) ? fadeInRaw : 0.5;
        const fadeOutSec = fadeAllowed.has(fadeOutRaw) ? fadeOutRaw : 1;

        return {
            enabled: true,
            target,
            mode,
            durationSec,
            fadeInSec,
            fadeOutSec,
            ...(mode === 'manual' ? { startSec } : {})
        };
    }

    // Returns effective output format based on current UI state for the browser UI layer.
    getEffectiveFormat(rawFormat = null) {
        if (this.isRingtoneMode()) {
            return this.getRingtoneTarget() === 'iphone' ? 'm4r' : 'mp3';
        }
        return rawFormat || document.getElementById('formatSelect')?.value || 'mp3';
    }

    // Resolves output settings from current UI state for the browser UI layer.
    resolveCurrentOutputSettings({ format = null, sampleRate = null, bitrate = null } = {}) {
        const ringtone = this.buildCurrentRingtonePayload();
        const effectiveFormat = this.getEffectiveFormat(format);
        const rawSampleRate = Number(sampleRate ?? document.getElementById('sampleRateSelect')?.value ?? 48000);
        const effectiveSampleRate = ringtone
            ? 44100
            : (Number.isFinite(rawSampleRate) && rawSampleRate > 0 ? rawSampleRate : 48000);

        return {
            format: effectiveFormat,
            sampleRate: effectiveSampleRate,
            bitrate: bitrate ?? document.getElementById('bitrateSelect')?.value ?? 'auto',
            ringtone
        };
    }

    // Applies current output profile to a payload for the browser UI layer.
    applyCurrentOutputProfile(payload, { isFormData = false } = {}) {
        const readField = (name) => {
            if (!isFormData) return payload?.[name];
            if (payload instanceof FormData) return payload.get(name);
            return null;
        };

        const resolved = this.resolveCurrentOutputSettings({
            format: readField('format'),
            sampleRate: readField('sampleRate'),
            bitrate: readField('bitrate')
        });

        if (!isFormData) {
            payload.format = resolved.format;
            payload.sampleRate = resolved.sampleRate;
            if (resolved.ringtone) payload.ringtone = resolved.ringtone;
            else delete payload.ringtone;
            return resolved;
        }

        if (!(payload instanceof FormData)) return resolved;

        const setValue = (name, value) => {
            try { payload.delete(name); } catch {}
            payload.append(name, value);
        };

        setValue('format', resolved.format);
        setValue('sampleRate', String(resolved.sampleRate));

        if (resolved.ringtone) {
            setValue('ringtone', JSON.stringify(resolved.ringtone));
        } else {
            try { payload.delete('ringtone'); } catch {}
        }

        return resolved;
    }

    // Returns current audio-processing settings for outgoing conversion payloads.
    getCurrentAudioProcessingSettings() {
        const rawVolume = Number(this.currentVolumeGain);
        return {
            volumeGain: Number.isFinite(rawVolume) && rawVolume > 0 ? rawVolume : 1.0,
            loudnorm: !!this.currentLoudnorm,
            loudnormMode: this.normalizeLoudnormMode(this.currentLoudnormMode)
        };
    }

    // Normalizes loudnorm mode identifiers used across browser UI and API payloads.
    normalizeLoudnormMode(value) {
        const mode = String(value || '').trim().toLowerCase();
        if (mode === 'two_pass') return 'two_pass';
        if (mode === 'dynamic') return 'dynamic';
        return 'ebu_r128';
    }

    // Updates loudnorm mode visibility and descriptive text in the browser UI layer.
    updateLoudnormModeUI(enabled = this.currentLoudnorm) {
        const group = document.getElementById('loudnormModeGroup');
        const help = document.getElementById('loudnormModeHelp');
        const visible = !!enabled;

        if (group) group.style.display = visible ? '' : 'none';
        if (help) help.style.display = visible ? 'block' : 'none';
    }

    // Applies current audio-processing settings to a payload before submission.
    applyCurrentAudioProcessingSettings(payload, { isFormData = false } = {}) {
        const settings = this.getCurrentAudioProcessingSettings();

        if (!isFormData) {
            if (payload && typeof payload === 'object') {
                if (payload.volumeGain == null) payload.volumeGain = settings.volumeGain;
                if (payload.loudnorm == null) payload.loudnorm = settings.loudnorm;
                if (payload.loudnormMode == null) payload.loudnormMode = settings.loudnormMode;
            }
            return settings;
        }

        if (!(payload instanceof FormData)) return settings;

        const existingVolumeGain = payload.get('volumeGain');
        const existingLoudnorm = payload.get('loudnorm');
        const existingLoudnormMode = payload.get('loudnormMode');

        if (typeof payload.set === 'function') {
            if (existingVolumeGain == null) {
                payload.set('volumeGain', String(settings.volumeGain));
            }
            if (existingLoudnorm == null) {
                payload.set('loudnorm', settings.loudnorm ? 'true' : 'false');
            }
            if (existingLoudnormMode == null) {
                payload.set('loudnormMode', settings.loudnormMode);
            }
        } else {
            if (existingVolumeGain == null) {
                payload.append('volumeGain', String(settings.volumeGain));
            }
            if (existingLoudnorm == null) {
                payload.append('loudnorm', settings.loudnorm ? 'true' : 'false');
            }
            if (existingLoudnormMode == null) {
                payload.append('loudnormMode', settings.loudnormMode);
            }
        }

        return settings;
    }

    // Initializes theme for the browser UI layer.
    initializeTheme() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
        setTimeout(() => {
            document.documentElement.classList.remove('no-theme-transition');
        }, 100);

        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', () => {
                document.documentElement.classList.add('no-transition');
                const currentTheme = document.documentElement.getAttribute('data-theme');
                const newTheme = currentTheme === 'light' ? 'dark' : 'light';
                document.documentElement.setAttribute('data-theme', newTheme);
                localStorage.setItem('theme', newTheme);
                const meta = document.querySelector('meta[name="color-scheme"]');
                if (meta) {
                    meta.content = newTheme;
                }
                setTimeout(() => {
                    document.documentElement.classList.remove('no-transition');
                }, 2);

                themeToggle.classList.add('switching');
                setTimeout(() => {
                    themeToggle.classList.remove('switching');
                }, 50);
            });
        }
    }

    // Initializes event listeners for the browser UI layer.
    initializeEventListeners() {
        document.getElementById('formatSelect').addEventListener('change', async (e) => {
            const format = this.getEffectiveFormat(e.target.value);
            this.updateQualityLabel(format);
            this.formatManager.toggleFormatSpecificOptions(format);
            const formats = await this.formatManager.getFormats();
            this.formatManager.updateBitrateOptions(format, formats);
            this.setAutoZipVisibility(this.shouldShowAutoZipForCurrentUI());
        });

        document.addEventListener('i18n:langChanged', (ev) => {
            const newLang = ev?.detail?.lang || window.i18n?.getCurrentLang?.();
            const langSelect = document.getElementById('langSelect');
            if (langSelect && newLang && langSelect.value !== newLang) {
                langSelect.value = newLang;
            }
            this.loadLocalFiles();
        });

        document.addEventListener('i18n:applied', () => {
            const localGroup = document.getElementById('localSourceGroup');
            if (localGroup && localGroup.style.display !== 'none') {
                this.loadLocalFiles();
            }
            this.formatManager?.updateRingtoneHint?.();
            this.retagManager?.syncUi?.();
            this.renderBinaryFooterLabel();
        });

        const fileForm = document.getElementById('fileForm');
        if (fileForm) {
            fileForm.addEventListener('submit', (e) => this.uploadManager.handleFileSubmit(e));
        }

        const initialFormat = this.getEffectiveFormat(document.getElementById('formatSelect')?.value || 'mp3');
         this.updateQualityLabel(initialFormat);

        document.getElementById('previewBtn').addEventListener('click', () => this.previewManager.handlePreviewClick());
        document.getElementById('convertSelectedBtn').addEventListener('click', () => this.previewManager.convertSelected());
        document.getElementById('convertAllBtn').addEventListener('click', () => this.previewManager.convertAll());
        document.getElementById('selectAllChk').addEventListener('change', (e) => this.previewManager.toggleSelectAll(e.target.checked));
        document.getElementById('playlistCheckbox').addEventListener('change', (e) => this.onPlaylistToggle(e.target.checked));
        document.getElementById('prevPageBtn').addEventListener('click', () => this.previewManager.loadPage(this.previewManager.currentPreview.page - 1));
        document.getElementById('nextPageBtn').addEventListener('click', () => this.previewManager.loadPage(this.previewManager.currentPreview.page + 1));
        document.getElementById('pageSizeSel').addEventListener('change', (e) => {
            this.previewManager.currentPreview.pageSize = Number(e.target.value) || 50;
            if (this.previewManager.currentPreview.url) this.previewManager.loadPage(1, true);
        });
        document.getElementById('startIntegratedBtn').addEventListener('click', () => {
            this.spotifyManager.startIntegratedSpotifyProcess();
        });

        const urlForm = document.getElementById('urlForm');
        if (urlForm) {
            urlForm.addEventListener('submit', (e) => this.handleUrlSubmitWithSpinner(e));
        }

        const startConvertBtn = document.getElementById('startConvertBtn');
        if (startConvertBtn) {
            startConvertBtn.addEventListener('click', (ev) => {
                if (this.isRetagMode()) return;
                const urlInput = document.getElementById('urlInput');
                const url = urlInput?.value.trim();
                const playlistCheckboxEl = document.getElementById('playlistCheckbox');

                if (
                    url &&
                    !this.isSpotifyUrl(url) &&
                    this.isYoutubePlaylistUrl(url) &&
                    playlistCheckboxEl &&
                    !playlistCheckboxEl.checked
                ) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    playlistCheckboxEl.checked = true;
                    this.onPlaylistToggle(true);
                    this.showNotification(
                        this.t('notif.autoPlaylistChecked') ||
                        'Bu URL bir YouTube/Dailymotion playlist gibi görünüyor. Playlist modunu açtım, önce listeyi önizleyip sonra dönüştürebilirsin.',
                        'info',
                        'default'
                    );
                }
            });
        }

        const startSpotifyBtn = document.getElementById('startSpotifyBtn');
        const convertMatchedBtn = document.getElementById('convertMatchedBtn');

        if (startSpotifyBtn) {
            startSpotifyBtn.addEventListener('click', () => this.spotifyManager.startSpotifyPreview());
        }

        if (convertMatchedBtn) {
            convertMatchedBtn.addEventListener('click', () => this.spotifyManager.convertMatchedSpotify());
        }

        document.getElementById('urlInput').addEventListener('input', (e) => {
            this.onUrlInputChange(e.target.value);
            this.musicUrlQueueManager?.updateButton();
        });

        const langSelect = document.getElementById('langSelect');
        if (langSelect) {
            const currentLang = window.i18n?.getCurrentLang?.();
            if (currentLang && langSelect.value !== currentLang) {
                langSelect.value = currentLang;
            }

            langSelect.addEventListener('change', async (e) => {
                const nextLang = e.target.value;
                try {
                    await window.i18n?.setLang(nextLang);
                } catch (err) {
                    console.error('Failed to change language:', err);
                }
            });
        }

        const autoZipCheckbox = document.getElementById('autoZipCheckbox');
        if (autoZipCheckbox) {
            autoZipCheckbox.checked = this.autoCreateZip;
            autoZipCheckbox.addEventListener('change', (e) => {
                this.autoCreateZip = e.target.checked;
                localStorage.setItem('autoCreateZip', this.autoCreateZip.toString());
                this.showNotification(
                this.t('notif.autoZipSettingChanged', {
                    state: e.target.checked
                    ? this.t('ui.on') ?? 'On'
                    : this.t('ui.off') ?? 'Off'
                }),
                'info',
                'default'
                );
            });
        }

        document.addEventListener('i18n:applied', () => {
            const modal = document.getElementById('settingsModal');
            if (modal) window.i18n?.apply?.(modal);
            if (this.previewManager.currentPreview.url) this.previewManager.renderPreview();
            for (const [id, job] of this.jobManager.jobStates.entries()) {
                this.jobManager.updateJobUI(job, this.jobManager.jobToBatch.get(id) || null);
            }
        });

        document.getElementById('lyricsCheckbox').addEventListener('change', (e) => {
            this.includeLyrics = e.target.checked;
            this.syncEmbedLyricsCheckboxVisibility();
        });
        document.getElementById('embedLyricsCheckbox')?.addEventListener('change', (e) => {
            this.embedLyrics = e.target.checked;
        });
        this.syncEmbedLyricsCheckboxVisibility();

        document.getElementById('sampleRateSelect').addEventListener('change', (e) => {
            this.currentSampleRate = parseInt(e.target.value, 10);
            this.persistStandardAudioSettingsToStorage({
                sampleRate: this.currentSampleRate
            });
        });

        document.getElementById('bitrateSelect').addEventListener('change', (e) => {
            this.persistStandardAudioSettingsToStorage({
                bitrate: e.target.value
            });
        });

        const volumeRange = document.getElementById('volumeGainRange');
        const volumeLabel = document.getElementById('volumeGainValue');

        if (volumeRange && volumeLabel) {
            const settings = this.videoManager?.videoSettings || {};
            const initial = (typeof settings.volumeGain === 'number')
                ? settings.volumeGain
                : 1.0;

            volumeRange.value = initial.toFixed(1);
            volumeLabel.textContent = initial.toFixed(1) + 'x';
            this.currentVolumeGain = initial;

            // Updates volume UI state for the browser UI layer.
            const updateVolumeUI = () => {
                const v = parseFloat(volumeRange.value) || 1.0;
                this.currentVolumeGain = v;
                volumeLabel.textContent = v.toFixed(1) + 'x';

                if (this.videoManager && this.videoManager.videoSettings) {
                    this.videoManager.videoSettings.volumeGain = v;
                    this.videoManager.saveToStorage();
                }
            };
            volumeRange.addEventListener('input', updateVolumeUI);
        }

        const loudnormCheckbox = document.getElementById('loudnormCheckbox');
        const loudnormModeSelect = document.getElementById('loudnormModeSelect');
        if (loudnormCheckbox) {
            const settings = this.videoManager?.videoSettings || {};
            const initialLoudnorm = !!settings.loudnorm;
            loudnormCheckbox.checked = initialLoudnorm;
            this.currentLoudnorm = initialLoudnorm;
            this.currentLoudnormMode = this.normalizeLoudnormMode(settings.loudnormMode);

            if (loudnormModeSelect) {
                loudnormModeSelect.value = this.currentLoudnormMode;
            }
            this.updateLoudnormModeUI(initialLoudnorm);

            loudnormCheckbox.addEventListener('change', (e) => {
                const enabled = !!e.target.checked;
                this.currentLoudnorm = enabled;
                this.updateLoudnormModeUI(enabled);

                if (this.videoManager && this.videoManager.videoSettings) {
                    this.videoManager.videoSettings.loudnorm = enabled;
                    this.videoManager.saveToStorage();
                }
            });
        }

        if (loudnormModeSelect) {
            loudnormModeSelect.value = this.normalizeLoudnormMode(this.currentLoudnormMode);
            loudnormModeSelect.addEventListener('change', (e) => {
                const mode = this.normalizeLoudnormMode(e.target.value);
                this.currentLoudnormMode = mode;
                e.target.value = mode;

                if (this.videoManager && this.videoManager.videoSettings) {
                    this.videoManager.videoSettings.loudnormMode = mode;
                    this.videoManager.saveToStorage();
                }
            });
        }

        const fileInput = document.getElementById('fileInput');
        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                this.uploadManager.resetUploadProgress();
            });
        }

        const sourceRadios = document.querySelectorAll('input[name="fileSourceType"]');
        if (sourceRadios.length) {
            sourceRadios.forEach(radio => {
                radio.addEventListener('change', () => {
                    const val = document.querySelector('input[name="fileSourceType"]:checked')?.value || 'upload';
                    const uploadGroup = document.getElementById('uploadSourceGroup');
                    const localGroup  = document.getElementById('localSourceGroup');

                    if (uploadGroup) {
                        uploadGroup.style.display = (val === 'upload') ? '' : 'none';
                    }
                    if (localGroup) {
                        localGroup.style.display = (val === 'local') ? '' : 'none';
                        if (val === 'local') {
                            this.loadLocalFiles();
                        }
                    }
                });
            });
        }

        const refreshLocalBtn = document.getElementById('refreshLocalFilesBtn');
        if (refreshLocalBtn) {
            refreshLocalBtn.addEventListener('click', () => this.loadLocalFiles());
        }

        const binaryFooter = document.getElementById('binaryFooter');
        const binaryFooterToggle = document.getElementById('binaryFooterToggle');

        if (binaryFooter && binaryFooterToggle) {
            binaryFooter.classList.add('collapsed');

            binaryFooterToggle.addEventListener('click', () => {
                binaryFooter.classList.toggle('collapsed');
            });
        }

        window.addEventListener('gharmonize:binaries-refresh-started', () => {
            this.scheduleBinaryStatusPoll(0);
        });

    window.addEventListener('gharmonize:auth', (ev) => {
            const isLoggedIn = ev?.detail?.loggedIn ?? false;
            this.handleAuthStateChange(isLoggedIn);
        });
        this.checkInitialAuthState();
    }

    // Updates quality label for the browser UI layer.
    updateQualityLabel(format) {
         const qualityLabel = document.querySelector('label[for="bitrateSelect"]');
         if (!qualityLabel) return;

         const isVideo = (format === 'mp4' || format === 'mkv');
         const i18nKey = isVideo ? 'label.quality' : 'label.audioBitrate';
         qualityLabel.setAttribute('data-i18n', i18nKey);
         const videoText = this.t('label.quality') || 'Video Bitrate:';
         const audioText = this.t('label.audioBitrate') || 'Audio Bitrate:';
         qualityLabel.textContent = isVideo ? videoText : audioText;
     }

    // Handles handle authentication state state change in the browser UI layer.
    handleAuthStateChange(isLoggedIn) {
        console.log('Auth state changed:', isLoggedIn);
        const jobsBell = document.getElementById('jobsBell');
        if (jobsBell) {
            jobsBell.hidden = !isLoggedIn;
        }
        if (!isLoggedIn && window.jobsPanelManager) {
            window.jobsPanelManager.close();
        }

        this.loadLocalFiles()?.catch?.(err => {
            console.error('loadLocalFiles after auth change failed:', err);
        });
    }

    // Handles check initial authentication state state in the browser UI layer.
    async checkInitialAuthState() {
        const token = localStorage.getItem('gharmonize_admin_token');
        const isLoggedIn = !!token;

        if (token) {
            try {
                const response = await fetch('/api/auth/verify', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });

                if (!response.ok) {
                    throw new Error('Token invalid');
                }
            } catch (error) {
                localStorage.removeItem('gharmonize_admin_token');
                this.handleAuthStateChange(false);
                return;
            }
        }

        this.handleAuthStateChange(isLoggedIn);
    }

        // Loads local files files for the browser UI layer.
        async loadLocalFiles() {
            const selectEl = document.getElementById('localFileSelect');
            const listEl   = document.getElementById('localFileCheckboxList');
            if (!selectEl && !listEl) return;

            const token = localStorage.getItem('gharmonize_admin_token') || '';
            if (!token) {
                const msg = this.t('ui.noAuthLocalFiles') || 'Giriş yapılmadı';

                if (selectEl) {
                    selectEl.disabled = true;
                    selectEl.innerHTML = `<option value="">${msg}</option>`;
                }
                if (listEl) {
                    listEl.innerHTML = `<div class="local-files-empty">${msg}</div>`;
                    this.addLoginButtonToLocalFiles(listEl);
                }
                return;
            }

            try {
                if (selectEl) {
                    selectEl.disabled = true;
                    selectEl.innerHTML = `<option value="">${this.t('ui.loading')}...</option>`;
                }
                if (listEl) {
                    listEl.innerHTML = `<div class="local-files-loading">${this.t('ui.loading') || 'Yükleniyor'}...</div>`;
                }

                const res = await fetch('/api/local-files', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });

                if (res.status === 401) {
                    const msg = this.t('ui.noAuthLocalFiles') || 'Giriş yapılmadı';

                    if (selectEl) {
                        selectEl.disabled = true;
                        selectEl.innerHTML = `<option value="">${msg}</option>`;
                    }
                    if (listEl) {
                        listEl.innerHTML = `<div class="local-files-empty">${msg}</div>`;
                        this.addLoginButtonToLocalFiles(listEl);
                    }
                    return;
                }

                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                const data = await res.json();
                const items = data.items || [];

                if (selectEl) {
                    selectEl.disabled = false;
                    selectEl.innerHTML = `<option value="">${this.t('ui.chooseServerFile') || '– Dosya seç –'}</option>`;
                    items.forEach(f => {
                        const opt = document.createElement('option');
                        opt.value = f.name;
                        const sizeMb = (f.size / (1024 * 1024)).toFixed(1);
                        opt.textContent = `${f.name} (${sizeMb} MB)`;
                        selectEl.appendChild(opt);
                    });
                }

                if (listEl) {
                    if (!items.length) {
                        listEl.innerHTML = `<div class="local-files-empty">${this.t('ui.noServerFiles') || 'Sunucuda dosya bulunamadı'}</div>`;
                    } else {
                        listEl.innerHTML = '';
                        items.forEach((f, idx) => {
                            const id = `local-file-${idx}`;
                            const sizeMb = (f.size / (1024 * 1024)).toFixed(1);

                            const wrapper = document.createElement('label');
                            wrapper.className = 'local-file-item';
                            wrapper.htmlFor = id;
                            wrapper.innerHTML = `
                                <input type="checkbox" id="${id}" name="localFileItem" value="${this.escapeHtml(f.name)}">
                                <span class="local-file-name">${this.escapeHtml(f.name)}</span>
                                <span class="local-file-size">(${sizeMb} MB)</span>
                            `;
                            listEl.appendChild(wrapper);
                        });

                        const info = document.createElement('div');
                        info.className = 'multi-select-info';
                        info.innerHTML = `💡 <strong>${this.t('ui.multiSelectHint') || 'Çoklu seçim:'}</strong> ${this.t('ui.multiSelectInstructions') || 'Birden fazla dosya seçebilirsiniz'}`;
                        listEl.appendChild(info);
                    }
                }
            } catch (e) {
                console.error('Local files list error:', e);

                this.showNotification(
                    `${this.t('notif.errorPrefix')}: ${e.message || 'local files'}`,
                    'error',
                    'error'
                );

                const msg = this.t('ui.noAuthLocalFiles') || 'Giriş yapılmadı';

                if (selectEl) {
                    selectEl.disabled = true;
                    selectEl.innerHTML = `<option value="">${msg}</option>`;
                }
                if (listEl) {
                    listEl.innerHTML = `<div class="local-files-empty">${msg}</div>`;
                    this.addLoginButtonToLocalFiles(listEl);
                }
            }
        }

        // Handles add login button to local files files in the browser UI layer.
        addLoginButtonToLocalFiles(listEl) {
        if (!listEl) return;
        if (listEl.querySelector('#localFilesLoginBtn')) return;

        const wrapper = document.createElement('div');
        wrapper.className = 'local-files-login-cta';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'localFilesLoginBtn';
        btn.className = 'btn-primary';
        btn.setAttribute('data-i18n', 'btn.login');
        btn.textContent = this.t('btn.login') || 'Login';

        wrapper.appendChild(btn);
        listEl.appendChild(wrapper);

        btn.addEventListener('click', () => {
            if (settingsManager?.openLoginOnly) {
                settingsManager.openLoginOnly();
            } else {
                settingsManager.open();
            }
        });
    }

    // Handles add selection info in the browser UI layer.
    addSelectionInfo() {
        const selectEl = document.getElementById('localFileSelect');
        const parent = selectEl.parentElement;
        const existingInfo = parent.querySelector('.multi-select-info');
        if (existingInfo) existingInfo.remove();

        const info = document.createElement('div');
        info.className = 'multi-select-info';
        info.style.fontSize = '12px';
        info.style.color = 'var(--text-muted)';
        info.style.marginTop = '8px';
        info.innerHTML = `💡 <strong>${this.t('ui.multiSelectHint') || 'Çoklu seçim için:'}</strong> ${this.t('ui.multiSelectInstructions') || 'Ctrl (Windows) veya Cmd (Mac) tuşuna basarak birden fazla dosya seçebilirsiniz.'}`;

        parent.appendChild(info);
    }

    // Handles on playlist data toggle in the browser UI layer.
    onPlaylistToggle(isChecked) {
            if (isChecked) {
                this.setAutoZipVisibility(this.shouldShowAutoZipForCurrentUI());
                const url = document.getElementById('urlInput').value.trim();
                if (!url) { this.previewManager.hidePreview(); return; }
                this.previewManager.previewPlaylist();
            } else {
                this.setAutoZipVisibility(false);
                this.previewManager.hidePreview();
            }
        }

    // Handles on URL input change in the browser UI layer.
    onUrlInputChange(url) {
        this.applyUrlDrivenDefaultFormat(url);
        const trimmed = (url || '').trim();
        const isSpotify = this.isSpotifyUrl(trimmed);
        const isYoutubePl = !isSpotify && this.isYoutubePlaylistUrl(trimmed);
        const spotifyConcContainer = document.getElementById('spotifyConcurrencyContainer');
        const youtubeConcContainer = document.getElementById('youtubeConcurrencyContainer');
        const playlistCheckboxEl = document.getElementById('playlistCheckbox');

        if (isSpotify) {
            document.getElementById('playlistCheckboxContainer').style.display = 'none';
            document.getElementById('normalUrlActions').style.display = 'none';
            document.getElementById('urlSpotifyActions').style.display = 'flex';
            document.getElementById('spotifyPreviewCard').style.display = 'block';
            if (spotifyConcContainer) spotifyConcContainer.style.display = 'flex';
            if (youtubeConcContainer) youtubeConcContainer.style.display = 'none';

            this.setAutoZipVisibility(this.shouldShowAutoZipForCurrentUI({ url: trimmed }));
            this.lastPreviewedPlaylistUrl = null;
            return;
        }

        document.getElementById('playlistCheckboxContainer').style.display = 'flex';
        document.getElementById('normalUrlActions').style.display = 'flex';
        document.getElementById('urlSpotifyActions').style.display = 'none';
        document.getElementById('spotifyPreviewCard').style.display = 'none';
        if (spotifyConcContainer) spotifyConcContainer.style.display = 'none';
        if (youtubeConcContainer) youtubeConcContainer.style.display = 'flex';

        if (!isYoutubePl || !trimmed) {
            this.lastPreviewedPlaylistUrl = null;
            this.setAutoZipVisibility(false);
            return;
        }

        if (this.lastPreviewedPlaylistUrl === trimmed) {
            return;
        }
        this.lastPreviewedPlaylistUrl = trimmed;
        this.setAutoZipVisibility(true);

        if (playlistCheckboxEl) {
            playlistCheckboxEl.checked = true;
        }
        this.onPlaylistToggle(true);
    }

    // Checks whether mapped music source URL is valid for the browser UI layer.
    isSpotifyUrl(u) {
        const s = String(u || "").trim();
        return /^(spotify:|deezer:(track|album|playlist|artist):|https?:\/\/(open\.spotify\.com|spotify\.link|spotify\.app\.link|(?:embed\.)?music\.apple\.com|(?:(?:www|link)\.)?deezer\.com|(?:[\w-]+\.)?deezer\.page\.link|(?:www\.|listen\.)?tidal\.com|(?:www\.|m\.)?soundcloud\.com))/i.test(s);
    }

    // Checks whether youtube playlist data URL is valid for the browser UI layer.
    isYoutubePlaylistUrl(u) {
        if (!u) return false;
        const str = String(u);

        try {
            const url = new URL(str, window.location.origin);

            const host = url.hostname.toLowerCase();
            const isYoutubeHost =
                (host === 'youtube.com' || host.endsWith('.youtube.com')) ||
                (host === 'youtu.be' || host.endsWith('.youtu.be')) ||
                host === 'music.youtube.com';
            const isDailymotionHost =
                (host === 'dailymotion.com' || host.endsWith('.dailymotion.com')) ||
                host === 'dai.ly' ||
                host.endsWith('.dai.ly');

            if (isYoutubeHost) {
                if (url.searchParams.has('list')) return true;
                if (/\/playlist/i.test(url.pathname)) return true;
            }
            if (isDailymotionHost) {
                if (url.searchParams.has('playlist')) return true;
                if (/\/playlist/i.test(url.pathname)) return true;
            }
        } catch {
    }

        if (/[?&]list=/.test(str)) return true;
        if (/\/playlist/i.test(str)) return true;
        if (/(dailymotion\.com|dai\.ly)/i.test(str) && /[?&]playlist=/.test(str)) return true;

        return false;
    }

    // Checks whether youtube shorts URL is valid for the browser UI layer.
    isYouTubeShortsUrl(u) {
        const s = String(u || '').trim();
        if (!s) return false;

        try {
            const url = new URL(s, window.location.origin);
            const host = url.hostname.toLowerCase();
            const isYoutubeHost =
                (host === 'youtube.com' || host.endsWith('.youtube.com')) ||
                (host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) ||
                host === 'youtu.be' ||
                host.endsWith('.youtu.be');

            if (isYoutubeHost && /^\/shorts(?:\/|$)/i.test(url.pathname || '')) {
                return true;
            }
        } catch {}

        return /(?:youtube(?:-nocookie)?\.com\/shorts(?:\/|[?#])|m\.youtube\.com\/shorts(?:\/|[?#])|www\.youtube\.com\/shorts(?:\/|[?#]))/i.test(s);
    }

    // Checks whether URL should default to mp4 for social video platforms in the browser UI layer.
    isMp4DefaultSocialUrl(u) {
        const s = String(u || '').trim();
        if (!s) return false;

        if (this.isYouTubeShortsUrl(s)) {
            return true;
        }

        try {
            const parsed = new URL(s, window.location.origin);
            const host = String(parsed.hostname || '').toLowerCase();

            if (
                (host === 'instagram.com' || host.endsWith('.instagram.com')) ||
                (host === 'instagr.am' || host.endsWith('.instagr.am')) ||
                (host === 'tiktok.com' || host.endsWith('.tiktok.com')) ||
                (host === 'facebook.com' || host.endsWith('.facebook.com')) ||
                host === 'fb.watch' ||
                host.endsWith('.fb.watch') ||
                (host === 'twitter.com' || host.endsWith('.twitter.com')) ||
                host === 'x.com' ||
                host.endsWith('.x.com') ||
                host === 't.co' ||
                host.endsWith('.t.co')
            ) {
                return true;
            }
        } catch {}

        return /(?:instagram\.com|instagr\.am|tiktok\.com|facebook\.com|fb\.watch|twitter\.com|(?:^|\/\/)(?:www\.)?x\.com|(?:^|\/\/)t\.co)/i.test(s);
    }

    // Applies URL-driven default format in the browser UI layer.
    applyUrlDrivenDefaultFormat(url) {
        if (this.isRingtoneMode()) return;
        const formatSelect = document.getElementById('formatSelect');
        if (!formatSelect) return;

        const desired = this.isMp4DefaultSocialUrl(url) ? 'mp4' : 'mp3';
        if (formatSelect.value === desired) return;

        const hasDesired = Array.from(formatSelect.options || []).some((opt) => opt.value === desired);
        if (!hasDesired) return;

        formatSelect.value = desired;
        formatSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Handles handle URL submit in the browser UI layer.
    async handleUrlSubmit(e) {
    e.preventDefault();
    if (this.isRetagMode()) {
        await this.retagManager.start();
        return;
    }
    const url = document.getElementById('urlInput').value.trim();
    const outputSettings = this.resolveCurrentOutputSettings();
    const format = outputSettings.format;
    const bitrate = outputSettings.bitrate;
    const sampleRate = outputSettings.sampleRate;
    const playlistCheckboxEl = document.getElementById('playlistCheckbox');
    const isPlaylist = playlistCheckboxEl?.checked;
    const sequential = document.getElementById('sequentialChk')?.checked;
    const includeLyrics = document.getElementById('lyricsCheckbox').checked;
    const embedLyrics = !!document.getElementById('embedLyricsCheckbox')?.checked;
    const volumeGain = this.currentVolumeGain || 1.0;
    const youtubeConcurrency = document.getElementById('youtubeConcurrencyInput')?.value || '4';
    const autoCreateZip = this.autoCreateZip;

    let compressionLevel = null;
    let bitDepth = null;

    const bitDepthSelect = document.getElementById('bitDepthSelect');
    if (bitDepthSelect && (format === 'flac' || format === 'wav')) {
        bitDepth = bitDepthSelect.value || null;
    }

    const compRange = document.getElementById('compressionLevelRange');
    if (compRange && format === 'flac') {
        compressionLevel = parseInt(compRange.value, 10);
        if (!Number.isFinite(compressionLevel)) compressionLevel = null;
    }

    if ((format === 'eac3' || format === 'ac3' || format === 'aac' || format === 'dts') && !sampleRate) {
        this.showNotification(this.t('notif.sampleRateRequired'), 'error', 'error');
        return;
    }

    if (this.isSpotifyUrl(url)) {
        if (!this.spotifyManager.currentSpotifyTask.completed) {
            this.showNotification(this.t('notif.completeSpotifyFirst'), 'error', 'error');
            return;
        }
        await this.spotifyManager.convertMatchedSpotify();
        return;
    }

    if (isPlaylist && this.isYoutubePlaylistUrl(url)) {
        this.onPlaylistToggle(true);
        this.showNotification(
            this.t('notif.usePlaylistControls') ||
            'Bu URL bir playlist. Dönüştürmek için playlist önizleme kartındaki butonları kullan.',
            'info',
            'default'
        );
        return;
    }

        const payload = {
            url,
            format,
            bitrate,
            isPlaylist: false,
            sampleRate: Number(sampleRate),
            includeLyrics,
            embedLyrics,
            volumeGain,
            autoCreateZip,
            ringtone: outputSettings.ringtone
        };
        await this.jobManager.submitJob(payload);

        document.getElementById('urlForm').reset();
        document.getElementById('playlistCheckbox').checked = false;
        document.getElementById('lyricsCheckbox').checked = false;
        if (document.getElementById('embedLyricsCheckbox')) {
            document.getElementById('embedLyricsCheckbox').checked = false;
        }
        this.syncEmbedLyricsCheckboxVisibility();
        this.previewManager.hidePreview();
        this.setAutoZipVisibility(false);
    }

    // Returns localized runtime binary status text for the footer label.
    getBinaryStatusDetail(status = this.binaryFooterStatus) {
        if (!status) return '';

        const tool = String(status.currentToolLabel || status.currentTool || '').trim();

        if (status.active) {
            if (status.phase === 'downloading' && tool) {
                return this.t('ui.binaryStatusDownloading', { tool });
            }

            if (status.phase === 'checking' && tool) {
                return this.t('ui.binaryStatusChecking', { tool });
            }

            return this.t('ui.binaryStatusUpdating');
        }

        if (
            status.phase === 'error' &&
            status.updatedAt &&
            (Date.now() - Number(status.updatedAt)) < 15000
        ) {
            return this.t('ui.binaryStatusFailed');
        }

        return '';
    }

    // Renders runtime binary footer label for the browser UI layer.
    renderBinaryFooterLabel() {
        const labelEl = document.querySelector('.binary-footer-toggle-label');
        if (!labelEl) return;

        const baseLabel = this.t('ui.binaryVersionsLabel') || 'Tools in use';
        const detail = this.getBinaryStatusDetail();
        labelEl.textContent = detail ? `${baseLabel} • ${detail}` : baseLabel;
    }

    // Schedules runtime binary status polling for the browser UI layer.
    scheduleBinaryStatusPoll(delay = 0) {
        if (this.binaryStatusPollTimeoutId) {
            window.clearTimeout(this.binaryStatusPollTimeoutId);
        }

        this.binaryStatusPollTimeoutId = window.setTimeout(() => {
            this.loadBinaryStatus().catch((err) => {
                console.error('Scheduled binary status refresh failed:', err);
            });
        }, Math.max(0, Number(delay) || 0));
    }

    // Loads runtime binary status for the browser UI layer.
    async loadBinaryStatus() {
        try {
            const previousActive = !!this.binaryFooterStatus?.active;
            const previousCompletedAt = this.binaryFooterStatus?.completedAt || null;
            const res = await fetch('/api/binaries/status', { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const data = await res.json();
            this.binaryFooterStatus = data;
            this.renderBinaryFooterLabel();

            const completedNow = (
                previousActive &&
                !data?.active &&
                data?.completedAt &&
                data.completedAt !== previousCompletedAt
            );

            if (completedNow) {
                this.loadBinaryVersions().catch((err) => {
                    console.error('Binary versions refresh after status completion failed:', err);
                });
            }

            this.scheduleBinaryStatusPoll(data?.active ? 2000 : 15000);
        } catch (e) {
            console.error('loadBinaryStatus error:', e);
            this.renderBinaryFooterLabel();
            this.scheduleBinaryStatusPoll(15000);
        }
    }

    // Loads binary versions for the browser UI layer.
    async loadBinaryVersions() {
        try {
            const res = await fetch('/api/binaries', { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            // Handles shorten version metadata in the browser UI layer.
            const shortenVersion = (v) => {
                if (!v) return '';
                const nightly = v.match(/^N-(\d+)-(?:g[0-9a-f]+-)?(\d{8})$/);
                if (nightly) {
                    return nightly[2];
                }

                if (v.length > 20) {
                    return v.slice(0, 19) + '…';
                }

                return v;
            };
            const el = document.getElementById('binaryVersionsText');
            if (!el) return;

            const parts = [];

        if (data.ffmpeg?.version) {
            parts.push(`ffmpeg: ${shortenVersion(data.ffmpeg.version)}`);
            }
        if (data.ffprobe?.version) {
            parts.push(`ffprobe: ${shortenVersion(data.ffprobe.version)}`);
        }
        if (data.mkvmerge?.version) {
            parts.push(`mkvmerge: ${shortenVersion(data.mkvmerge.version)}`);
        }
        if (data.ytdlp?.version) {
            parts.push(`yt-dlp: ${shortenVersion(data.ytdlp.version)}`);
        }
        if (data.deno?.version) {
            parts.push(`deno: ${shortenVersion(data.deno.version)}`);
        }

            el.textContent = parts.join(' • ');
        } catch (e) {
            console.error('loadBinaryVersions error:', e);
            const el = document.getElementById('binaryVersionsText');
            if (el) {
                el.textContent = this.t('ui.binaryVersionsError') || 'Binary versiyonları okunamadı';
            }
        }
    }

    // Schedules follow-up binary version refreshes for the browser UI layer.
    scheduleBinaryVersionRefresh() {
        const delays = [10000, 30000];
        for (const delay of delays) {
            window.setTimeout(() => {
                this.loadBinaryVersions().catch((err) => {
                    console.error('Scheduled binary version refresh failed:', err);
                });
            }, delay);
        }
    }

    // Loads FFmpeg arguments caps for the browser UI layer.
    async loadFfmpegCaps() {
    try {
        const res = await fetch('/api/ffmpeg/caps', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        if (data?.ok && data?.caps) {
            console.log('[ffmpegCaps] loaded:', data.caps);
            this.videoManager?.setFfmpegCaps(data.caps);
        } else {
            console.warn('[ffmpegCaps] api returned not-ok:', data);
            this.videoManager?.setFfmpegCaps(null);
        }
    } catch (err) {
        console.warn('[ffmpegCaps] load failed:', err);
        this.videoManager?.setFfmpegCaps(null);
    }
}

    // Handles handle URL submit with spinner in the browser UI layer.
    async handleUrlSubmitWithSpinner(e) {
        e.preventDefault();

        if (this.isRetagMode()) {
            const retagStartButton = document.getElementById('startConvertBtn');
            this.showButtonSpinner(
                retagStartButton,
                retagStartButton?.querySelector('.btn-spinner') || null,
                retagStartButton?.querySelector('.btn-text') || null
            );
            try {
                await this.retagManager.start();
            } catch (error) {
                console.error('Retag submission error:', error);
                this.showNotification(`${this.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
            } finally {
                this.hideButtonSpinner(
                    retagStartButton,
                    retagStartButton?.querySelector('.btn-spinner') || null,
                    retagStartButton?.querySelector('.btn-text') || null
                );
            }
            return;
        }

        const urlInput = document.getElementById('urlInput');
        const url = urlInput?.value.trim();
        const playlistCheckboxEl = document.getElementById('playlistCheckbox');

        if (
            url &&
            !this.isSpotifyUrl(url) &&
            this.isYoutubePlaylistUrl(url)
        ) {
            if (playlistCheckboxEl) {
                playlistCheckboxEl.checked = true;
            }
            this.onPlaylistToggle(true);

            this.showNotification(
                this.t('notif.autoPlaylistChecked') ||
                'Bu URL bir YouTube/Dailymotion playlist gibi görünüyor. Lütfen dönüşümleri önizleme penceresinden başlatın.',
                'info',
                'default'
            );
            return;
        }

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
            console.error('URL submission error:', error);
            this.showNotification(`${this.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
        } finally {
            this.hideButtonSpinner(
                startConvertBtn,
                startConvertBtn?.querySelector('.btn-spinner') || null,
                startConvertBtn?.querySelector('.btn-text') || null
            );
        }
    }

    // Shows button spinner in the browser UI layer.
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

    // Hides button spinner in the browser UI layer.
    hideButtonSpinner(button, spinner, btnText) {
        if (!button) return;
        button.classList.remove('btn-loading');
        if (spinner) spinner.style.display = 'none';
        button.disabled = false;
    }

    // Handles escape html in the browser UI layer.
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

    // Formats seconds for the browser UI layer.
    formatSeconds(sec) {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        return (h ? h.toString().padStart(2, '0') + ':' : '') + m.toString().padStart(2, '0') + ':' + s.toString().padStart(2, '0');
    }

    // Normalizes log for the browser UI layer.
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

    // Normalizes backend log for the browser UI layer.
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

    // Handles to relative in the browser UI layer.
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

    // Handles t in the browser UI layer.
    t(key, vars) {
        if (typeof key === 'string' && key.startsWith('log.download.')) {
            const fixed = key.replace('log.download.', 'log.downloading.');
            const out = window.i18n?.t?.(fixed, vars);
            if (out && out !== fixed) return out;
        }
        return (window.i18n?.t?.(key, vars)) ?? key;
    }

    // Shows notification in the browser UI layer.
    showNotification(message, type = 'info', group = 'default') {
        this.notificationManager.showNotification(message, type, group, 3000);
    }

    // Shows queue notification in the browser UI layer.
    showQueueNotification(message) {
        this.showNotification(message, 'success', 'queue');
    }

    // Shows error notification in the browser UI layer.
    showErrorNotification(message) {
        this.showNotification(message, 'error', 'error');
    }

    // Shows progress notification in the browser UI layer.
    showProgressNotification(message) {
        this.showNotification(message, 'info', 'progress');
    }
}
