import { settingsManager } from './SettingsManager.js';
import { accessManager } from './AccessManager.js';
import { accessInboxManager } from './AccessInboxManager.js';

async function waitForRuntimeBinariesReady() {
  const overlay = document.getElementById('binaryStartupOverlay');
  if (!overlay) return;

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  while (true) {
    try {
      const response = await fetch('/api/binaries/status', { cache: 'no-store' });
      if (response.ok) {
        const status = await response.json();
        if (!status?.active) return;
      }
    } catch (error) {
      console.warn('Runtime binary readiness check failed:', error);
    }
    await sleep(500);
  }
}

function hideRuntimeBinariesOverlay() {
  const overlay = document.getElementById('binaryStartupOverlay');
  if (!overlay) return;
  overlay.classList.add('is-ready');
  overlay.setAttribute('aria-busy', 'false');
}

function isHostOrSubdomain(host, domain) {
  const value = String(host || '').toLowerCase();
  const expected = String(domain || '').toLowerCase();
  return value === expected || value.endsWith(`.${expected}`);
}

function urlHasHost(value, domain) {
  try {
    return isHostOrSubdomain(new URL(String(value || '')).hostname, domain);
  } catch {
    return false;
  }
}

function safeExternalHttpUrl(value) {
  try {
    const url = new URL(String(value || ''), window.location.origin);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

class YTLiveMusicApp {
  constructor() {
    this.results = [];
    this.currentItem = null;
    this.quickAddLimit = 25;
    this.musicTitle = 'Gharmonize Music';
    this.musicSubtitle = '';
    this.resultLoadLimit = 18;
    this.formats = [];
    this.jobs = new Map();
    this.jobStreams = new Map();
    this.queuePollTimer = null;
    this.queueHoverOpenDelay = 350;
    this.queueHoverTimer = null;
    this.searchController = null;
    this.searchSerial = 0;
    this.activePreset = null;
    this.activeSearchQuery = '';
    this.activeSearchType = 'track';
    this.discoverPresets = [
      'energizing',
      'workout',
      'feel-good',
      'relax',
      'sad',
      'romance',
      'commute',
      'party',
      'focus',
      'sleep'
    ];
    this.resultKeys = new Set();
    this.presetPaging = null;
    this.isLoadingMore = false;
    this.hasMoreResults = false;
    this.loadMoreObserver = null;
    this.fallbackScrollHandler = null;
    this.loadMoreCheckTimer = null;
    this.maxLoadMoreAttempts = 3;
    this.playlistTracks = [];
    this.playlistTracksSerial = 0;
    this.playlistTracksController = null;
    this.mappedMusicPreviewStream = null;
    this.activeCollection = null;
    this.currentPlaybackItem = null;
    this.musicHomeShelves = [];
    this.musicHomeController = null;
    this.musicHomeRetryTimer = null;
    this.discoverResultCache = new Map();
    this.youtubePlayer = null;
    this.youtubeApiPromise = null;
    this.youtubePlaybackToken = 0;
    this.youtubeRevealTimer = null;
    this.outputSettingsKey = 'gharmonize_ytlive_output_settings';
    this.musicHomeShelfCountKey = 'gharmonize_ytlive_music_home_shelf_count';
    this.autoPlayModeKey = 'gharmonize_ytlive_auto_play_mode';
    this.collapsibleStateKey = 'gharmonize_ytlive_collapsible_panels';
    this.classicJobSessionKey = (typeof window !== 'undefined' && window.electronAPI)
      ? 'gharmonize_job_session_desktop'
      : 'gharmonize_job_session';
    this.jobsPanelTokenKey = 'gharmonize_admin_token';
    this.outputSettings = this.loadOutputSettings();
    this.musicHomeShelfCount = this.loadMusicHomeShelfCount();
    this.autoPlayMode = this.loadAutoPlayMode();
    this.autoAdvanceInProgress = false;
    this.autoPlayHistory = [];
    this.collapsibleState = this.loadCollapsibleState();
    this.collapsiblePanels = ['downloadListsPanel', 'playlistTracksPanel', 'musicHomeSection', 'discover'];
    this.downloadLists = [];
    this.expandedDownloadListIds = new Set();
    this.activeDownloadListMenu = null;
    this.presetCounters = new Map();
    this.escapeMap = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '`': '&#96;',
      '=': '&#61;',
      '/': '&#47;'
    };
  }

  renderDownloadIcon() {
    return '<svg class="download-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  async initialize() {
    // The startup overlay only represents runtime binary preparation. Do not
    // leave it visible while the rest of YTLive loads after the tools are ready.
    const runtimeBinariesReady = waitForRuntimeBinariesReady();
    runtimeBinariesReady.then(hideRuntimeBinariesOverlay);

    try {
      await window.i18nInit?.();
    } catch (error) {
      console.warn('i18n initialization failed:', error);
    }

    await accessManager.ensureAccess();
    await runtimeBinariesReady;

    window.app = {
      showNotification: (message, type = 'info') => this.notify(message, type),
      t: (key, vars) => this.t(key, vars),
      reloadUiConfig: () => this.loadUiConfig()
    };
    window.versionManager = window.versionManager || {
      checkNow: () => this.notify(this.tt('ytlive.version.classicOnly', 'Güncelleme kontrolü klasik UI içinde kullanılabilir.'), 'info')
    };

    await settingsManager.initialize();
    accessInboxManager.initialize();
    this.bindEvents();
    this.applyLocalizedUi();
    // Recommendations do not depend on download lists, output formats or the
    // queue snapshot. Start them as soon as access and runtime tools are ready.
    this.loadMusicHomeShelves();
    await Promise.all([
      this.search('', { preset: 'energizing' }),
      this.refreshDownloadLists(),
      this.loadUiConfig(),
      this.loadFormats().then(() => this.renderFormatOptions()),
      this.refreshQueueStatus().then(() => this.scheduleQueuePoll())
    ]);
  }

  bindEvents() {
    document.getElementById('settingsBtn')?.addEventListener('click', () => settingsManager.open());
    document.getElementById('themeToggle')?.addEventListener('click', () => this.toggleTheme());
    document.getElementById('searchForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const query = document.getElementById('searchInput')?.value || '';
      this.search(query);
    });
    const searchInput = document.getElementById('searchInput');
    searchInput?.addEventListener('focus', () => this.scrollToDiscoverSection());
    searchInput?.addEventListener('click', () => this.scrollToDiscoverSection());

    document.getElementById('playUrlBtn')?.addEventListener('click', () => this.playUrlInput());
    document.getElementById('previousTrackBtn')?.addEventListener('click', () => {
      this.playPreviousCollectionTrack(null, { silent: true, autoplay: true, forceAutoplay: true });
    });
    document.getElementById('nextTrackBtn')?.addEventListener('click', () => {
      void this.playNextTrackNow();
    });
    document.getElementById('autoPlayModeBtn')?.addEventListener('click', () => this.toggleAutoPlayMode());
    document.getElementById('addUrlBtn')?.addEventListener('click', () => this.addUrlInput());
    document.getElementById('addUrlToListBtn')?.addEventListener('click', (event) => this.addUrlInputToList(event));
    document.getElementById('addCurrentBtn')?.addEventListener('click', () => {
      if (this.currentItem) this.addItem(this.currentItem);
    });
    document.getElementById('addCurrentToListBtn')?.addEventListener('click', (event) => {
      if (this.currentItem) this.openDownloadListMenu(event, this.currentItem);
    });
    document.getElementById('refreshQueueBtn')?.addEventListener('click', () => this.refreshQueueStatus(true));
    document.getElementById('refreshMusicHomeBtn')?.addEventListener('click', () => this.loadMusicHomeShelves({ showToast: true, forceRefresh: true }));
    this.syncMusicHomeShelfCountInput();
    document.getElementById('musicHomeShelfCountInput')?.addEventListener('change', () => this.handleMusicHomeShelfCountChange());
    document.getElementById('formatSelect')?.addEventListener('change', () => this.handleFormatChange());
    ['bitrateSelect', 'sampleRateSelect', 'includeLyrics', 'embedLyrics', 'autoZip', 'loudnormModeSelect'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', () => this.handleOutputSettingChange());
    });
    document.getElementById('youtubeConcurrencyInput')?.addEventListener('input', () => this.handleOutputSettingChange());

    const volumeGainRange = document.getElementById('volumeGainRange');
    volumeGainRange?.addEventListener('input', () => this.syncAudioOutputControls());
    volumeGainRange?.addEventListener('change', () => this.handleOutputSettingChange());
    document.getElementById('loudnormCheckbox')?.addEventListener('change', () => {
      this.syncAudioOutputControls();
      this.handleOutputSettingChange();
    });

    document.querySelectorAll('[data-scroll]').forEach((button) => {
      button.addEventListener('click', () => {
        this.scrollToPageSection(button.dataset.scroll, button.dataset.scrollFallback);
      });
    });

    document.querySelectorAll('[data-focus]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = document.querySelector(button.dataset.focus);
        target?.focus();
      });
    });

    document.querySelectorAll('[data-preset]').forEach((button) => {
      button.addEventListener('click', () => {
        const preset = button.dataset.preset || 'popular';
        const input = document.getElementById('searchInput');
        if (input) input.value = '';
        this.search('', { preset });
      });
    });

    this.setupCollapsiblePanels();
    this.setupQueueHoverIntent();

    document.addEventListener('i18n:applied', () => {
      this.applyLocalizedUi();
      this.applyCollapsibleStates();
      this.renderResults();
      this.renderMusicHomeShelves();
      this.renderDownloadLists();
      this.renderJobs();
      this.renderPlaylistTracks();
      this.renderQueueChip(this.getActiveJobCount());
      this.updateLoadMoreState();
      this.updatePlayerNavigationControls();
      this.handleLocaleChanged();
    });

    document.getElementById('discover')?.addEventListener('click', (event) => this.handleResultInteraction(event));
    document.getElementById('discover')?.addEventListener('click', (event) => this.handleSearchTypeClick(event));
    document.getElementById('musicHomeSection')?.addEventListener('click', (event) => this.handleMusicHomeInteraction(event));
    document.getElementById('playlistTracksPanel')?.addEventListener('click', (event) => this.handlePlaylistTrackInteraction(event));
    document.getElementById('playlistTracksPanel')?.addEventListener('keydown', (event) => this.handlePlaylistTrackKeyInteraction(event));
    document.getElementById('downloadListsPanel')?.addEventListener('click', (event) => this.handleDownloadListPanelInteraction(event));
    document.getElementById('downloadListsGrid')?.addEventListener('scroll', (event) => this.syncDownloadListArrows(event.currentTarget), { passive: true });
    this.setupInfiniteScroll();
    this.updatePlayerNavigationControls();
    document.addEventListener('error', (event) => this.handleThumbnailError(event), true);
  }

  setupQueueHoverIntent() {
    const queuePanel = document.getElementById('queuePanel');
    if (!queuePanel) return;

    const hoverMedia = window.matchMedia('(min-width: 1181px) and (hover: hover) and (pointer: fine)');

    const clearOpenTimer = () => {
      if (this.queueHoverTimer === null) return;
      window.clearTimeout(this.queueHoverTimer);
      this.queueHoverTimer = null;
    };

    const closeQueue = () => {
      clearOpenTimer();
      queuePanel.classList.remove('is-hover-open');
    };

    queuePanel.addEventListener('pointerenter', () => {
      if (!hoverMedia.matches || queuePanel.classList.contains('is-hover-open')) return;
      clearOpenTimer();
      this.queueHoverTimer = window.setTimeout(() => {
        this.queueHoverTimer = null;
        if (hoverMedia.matches && queuePanel.matches(':hover')) {
          queuePanel.classList.add('is-hover-open');
        }
      }, this.queueHoverOpenDelay);
    });

    queuePanel.addEventListener('pointerleave', closeQueue);
    hoverMedia.addEventListener?.('change', (event) => {
      if (!event.matches) closeQueue();
    });
  }

  async loadUiConfig() {
    try {
      const response = await fetch('/api/ui-config', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      const limit = Number(data.quickAddLimit);
      if (Number.isFinite(limit) && limit > 0) {
        this.quickAddLimit = Math.max(1, Math.min(100, Math.round(limit)));
      }
      this.musicTitle = String(data.musicTitle || '').trim() || 'Gharmonize Music';
      this.musicSubtitle = String(data.musicSubtitle || '').trim();
      this.applyConfiguredNowPanel();
    } catch (error) {
      console.warn('UI config could not be loaded:', error);
    }
  }

  getConfiguredNowTitle() {
    return this.musicTitle || 'Gharmonize Music';
  }

  getConfiguredNowSubtitle() {
    return this.musicSubtitle || this.tt(
      'ytlive.now.subtitle',
      'YouTube içeriklerini ara, oynat ve dönüşüm kuyruğuna ekle.'
    );
  }

  applyConfiguredNowPanel() {
    if (this.currentItem || this.activeCollection) return;
    const title = document.getElementById('nowTitle');
    const subtitle = document.getElementById('nowSubtitle');
    if (title) title.textContent = this.getConfiguredNowTitle();
    if (subtitle) subtitle.textContent = this.getConfiguredNowSubtitle();
  }

  loadMusicHomeShelfCount() {
    try {
      const saved = Number(localStorage.getItem(this.musicHomeShelfCountKey));
      if (Number.isFinite(saved)) return Math.max(1, Math.min(50, Math.round(saved)));
    } catch {}
    return 6;
  }

  saveMusicHomeShelfCount(value) {
    this.musicHomeShelfCount = Math.max(1, Math.min(50, Math.round(Number(value) || 6)));
    try {
      localStorage.setItem(this.musicHomeShelfCountKey, String(this.musicHomeShelfCount));
    } catch {}
    this.syncMusicHomeShelfCountInput();
  }

  syncMusicHomeShelfCountInput() {
    const input = document.getElementById('musicHomeShelfCountInput');
    if (input) input.value = String(this.musicHomeShelfCount);
  }

  loadAutoPlayMode() {
    try {
      return localStorage.getItem(this.autoPlayModeKey) === '1';
    } catch {
      return false;
    }
  }

  saveAutoPlayMode() {
    try {
      localStorage.setItem(this.autoPlayModeKey, this.autoPlayMode ? '1' : '0');
    } catch {}
  }

  toggleAutoPlayMode() {
    this.autoPlayMode = !this.autoPlayMode;
    this.saveAutoPlayMode();
    this.updatePlayerNavigationControls();
    this.notify(
      this.autoPlayMode
        ? this.tt('ytlive.player.autoOnNotice', 'Auto mode enabled. Playback will continue with random tracks.')
        : this.tt('ytlive.player.autoOffNotice', 'Auto mode disabled.'),
      this.autoPlayMode ? 'success' : 'info'
    );
  }

  handleMusicHomeShelfCountChange() {
    const input = document.getElementById('musicHomeShelfCountInput');
    this.saveMusicHomeShelfCount(input?.value || this.musicHomeShelfCount);
    this.loadMusicHomeShelves({ showToast: true });
  }

  loadCollapsibleState() {
    try {
      const raw = localStorage.getItem(this.collapsibleStateKey);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  saveCollapsibleState() {
    try {
      localStorage.setItem(this.collapsibleStateKey, JSON.stringify(this.collapsibleState || {}));
    } catch {}
  }

  setupCollapsiblePanels() {
    document.querySelectorAll('[data-collapsible-toggle]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.toggleCollapsiblePanel(button.dataset.collapsibleToggle || '');
      });
    });

    document.querySelectorAll('[data-collapsible-trigger]').forEach((header) => {
      header.addEventListener('click', (event) => {
        const interactive = event.target.closest('button,a,input,select,textarea,label,[data-preset],[data-action],[data-list-action],[data-music-action]');
        if (interactive) return;
        this.toggleCollapsiblePanel(header.dataset.collapsibleTrigger || '');
      });
    });

    this.applyCollapsibleStates();
  }

  toggleCollapsiblePanel(panelId) {
    if (!panelId) return;
    const collapsed = !this.isCollapsiblePanelCollapsed(panelId);
    this.collapsibleState = {
      ...(this.collapsibleState || {}),
      [panelId]: collapsed
    };
    this.saveCollapsibleState();
    this.applyCollapsibleState(panelId);
  }

  isCollapsiblePanelCollapsed(panelId) {
    return Boolean(this.collapsibleState?.[panelId]);
  }

  applyCollapsibleStates() {
    (this.collapsiblePanels || []).forEach((panelId) => this.applyCollapsibleState(panelId));
  }

  applyCollapsibleState(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;

    const collapsed = this.isCollapsiblePanelCollapsed(panelId);
    panel.classList.toggle('is-collapsed', collapsed);
    panel.setAttribute('aria-expanded', String(!collapsed));

    const body = panel.querySelector('[data-collapsible-body]');
    if (body) body.hidden = collapsed;

    const label = collapsed
      ? this.tt('ytlive.panel.expand', 'Aç')
      : this.tt('ytlive.panel.collapse', 'Daralt');
    document.querySelectorAll('[data-collapsible-toggle]').forEach((button) => {
      if (button.dataset.collapsibleToggle !== panelId) return;
      button.setAttribute('aria-expanded', String(!collapsed));
      button.setAttribute('aria-label', label);
      button.title = label;
    });
  }

  scrollToDiscoverSection() {
    const discover = document.getElementById('discover') || document.querySelector('.content-section');
    if (!discover) return;

    this.scrollToPageSection(discover);
  }

  scrollToPageSection(targetOrSelector, fallbackSelector = '') {
    let target = typeof targetOrSelector === 'string'
      ? document.querySelector(targetOrSelector)
      : targetOrSelector;
    if (this.isElementHiddenFromLayout(target) && fallbackSelector) {
      target = document.querySelector(fallbackSelector);
    }
    if (!target) return;

    requestAnimationFrame(() => {
      const offset = this.getStickyScrollOffset();
      const targetTop = target.getBoundingClientRect().top + window.scrollY - offset;

      window.scrollTo({
        top: Math.max(0, targetTop),
        behavior: 'smooth'
      });
    });
  }

  getStickyScrollOffset() {
    const topbar = document.querySelector('.topbar');
    if (!topbar) return 18;

    const styles = window.getComputedStyle(topbar);
    const stickyTop = Number.parseFloat(styles.top) || 0;
    const topbarHeight = topbar.offsetHeight || topbar.getBoundingClientRect().height || 0;

    return Math.ceil(stickyTop + topbarHeight + 18);
  }

  isElementHiddenFromLayout(element) {
    if (!element) return true;
    return element.hidden || element.offsetParent === null;
  }

  async loadFormats() {
    try {
      const response = await fetch('/api/formats', { cache: 'no-store' });
      const data = await response.json();
      this.formats = Array.isArray(data.formats) ? data.formats.filter((f) => !f.hidden) : [];
    } catch (error) {
      console.warn('Formats could not be loaded:', error);
      this.formats = [
        { format: 'mp3', bitrates: ['auto', '192k', '320k'], defaultBitrate: '192k', type: 'audio' },
        { format: 'mp4', bitrates: ['1080p', '720p', '480p'], defaultBitrate: '1080p', type: 'video' }
      ];
    }
  }

  renderFormatOptions() {
    const formatSelect = document.getElementById('formatSelect');
    if (!formatSelect) return;
    formatSelect.innerHTML = '';

    const formats = this.formats.length ? this.formats : [{ format: 'mp3', bitrates: ['192k'] }];
    const savedFormat = String(this.outputSettings?.format || '').toLowerCase();
    formats.forEach((format) => {
      const option = document.createElement('option');
      option.value = format.format;
      option.textContent = format.format.toUpperCase();
      formatSelect.appendChild(option);
    });

    if (formats.some((f) => f.format === savedFormat)) {
      formatSelect.value = savedFormat;
    } else if (formats.some((f) => f.format === 'mp3')) {
      formatSelect.value = 'mp3';
    }

    this.updateBitrateOptions(this.outputSettings?.bitrate);
    this.applyOutputSettings();
  }

  handleFormatChange({ save = true } = {}) {
    this.updateBitrateOptions();
    this.syncOutputAvailability();
    if (save) this.saveOutputSettings();
  }

  updateBitrateOptions(preferredBitrate = null) {
    const format = this.getSelectedFormat();
    const bitrateSelect = document.getElementById('bitrateSelect');
    const match = this.formats.find((item) => item.format === format) || {};
    const bitrates = Array.isArray(match.bitrates) && match.bitrates.length ? match.bitrates : ['auto'];
    const previousValue = String(preferredBitrate || bitrateSelect?.value || '');

    if (bitrateSelect) {
      bitrateSelect.innerHTML = '';
      bitrates.forEach((bitrate) => {
        const option = document.createElement('option');
        option.value = bitrate;
        option.textContent = bitrate === 'auto' ? 'Auto' : bitrate;
        bitrateSelect.appendChild(option);
      });
      const available = bitrates.map((bitrate) => String(bitrate));
      const fallback = String(match.defaultBitrate || bitrates[0]);
      bitrateSelect.value = available.includes(previousValue) ? previousValue : fallback;
    }
  }

  syncOutputAvailability() {
    const format = this.getSelectedFormat();
    const isVideo = this.isVideoFormat(format);
    const includeLyrics = document.getElementById('includeLyrics');
    const embedLyrics = document.getElementById('embedLyrics');
    const autoZip = document.getElementById('autoZip');
    if (includeLyrics) includeLyrics.disabled = isVideo;
    if (embedLyrics) embedLyrics.disabled = isVideo;
    if (autoZip) autoZip.disabled = isVideo;
  }

  normalizeLoudnormMode(value) {
    const mode = String(value || 'ebu_r128').trim().toLowerCase();
    return ['ebu_r128', 'two_pass', 'dynamic'].includes(mode) ? mode : 'ebu_r128';
  }

  syncAudioOutputControls() {
    const volumeGainRange = document.getElementById('volumeGainRange');
    const volumeGainValue = document.getElementById('volumeGainValue');
    const loudnormCheckbox = document.getElementById('loudnormCheckbox');
    const loudnormModeGroup = document.getElementById('loudnormModeGroup');
    const loudnormModeSelect = document.getElementById('loudnormModeSelect');

    if (volumeGainRange && volumeGainValue) {
      const raw = Number(volumeGainRange.value);
      const gain = Number.isFinite(raw) ? Math.max(1, Math.min(5, raw)) : 1;
      volumeGainValue.textContent = `${gain.toFixed(1)}x`;
      volumeGainRange.setAttribute('aria-valuetext', `${gain.toFixed(1)}x`);
    }

    const loudnormEnabled = !!loudnormCheckbox?.checked;
    if (loudnormModeGroup) loudnormModeGroup.hidden = !loudnormEnabled;
    if (loudnormModeSelect) loudnormModeSelect.disabled = !loudnormEnabled;
  }

  syncLyricsControls() {
    this.syncOutputAvailability();
    this.saveOutputSettings();
  }

  handleOutputSettingChange() {
    this.syncOutputAvailability();
    this.saveOutputSettings();
  }

  applyOutputSettings() {
    const settings = this.outputSettings || {};

    const bitrateSelect = document.getElementById('bitrateSelect');
    if (bitrateSelect && settings.bitrate) {
      const value = String(settings.bitrate);
      if (Array.from(bitrateSelect.options).some((option) => option.value === value)) {
        bitrateSelect.value = value;
      }
    }

    const sampleRateSelect = document.getElementById('sampleRateSelect');
    if (sampleRateSelect && settings.sampleRate) {
      const value = String(settings.sampleRate);
      if (Array.from(sampleRateSelect.options).some((option) => option.value === value)) {
        sampleRateSelect.value = value;
      }
    }

    const youtubeConcurrency = document.getElementById('youtubeConcurrencyInput');
    const savedConcurrency = settings.spotifyConcurrency ?? settings.youtubeConcurrency;
    if (youtubeConcurrency && Number.isFinite(Number(savedConcurrency))) {
      youtubeConcurrency.value = String(Math.max(1, Math.min(16, Math.round(Number(savedConcurrency)))));
    }

    [
      ['includeLyrics', 'includeLyrics'],
      ['embedLyrics', 'embedLyrics'],
      ['autoZip', 'autoCreateZip'],
      ['loudnormCheckbox', 'loudnorm']
    ].forEach(([id, key]) => {
      const checkbox = document.getElementById(id);
      if (checkbox && typeof settings[key] === 'boolean') {
        checkbox.checked = settings[key];
      }
    });

    const volumeGainRange = document.getElementById('volumeGainRange');
    if (volumeGainRange) {
      const rawGain = Number(settings.volumeGain ?? 1);
      const gain = Number.isFinite(rawGain) ? Math.max(1, Math.min(5, rawGain)) : 1;
      volumeGainRange.value = gain.toFixed(1);
    }

    const loudnormModeSelect = document.getElementById('loudnormModeSelect');
    if (loudnormModeSelect) {
      loudnormModeSelect.value = this.normalizeLoudnormMode(settings.loudnormMode);
    }

    this.syncOutputAvailability();
    this.syncAudioOutputControls();
  }

  loadOutputSettings() {
    try {
      const raw = localStorage.getItem(this.outputSettingsKey);
      return raw ? JSON.parse(raw) || {} : {};
    } catch {
      return {};
    }
  }

  saveOutputSettings() {
    const concurrency = this.getSpotifyConcurrency();
    const settings = {
      format: this.getSelectedFormat(),
      bitrate: document.getElementById('bitrateSelect')?.value || 'auto',
      sampleRate: Number(document.getElementById('sampleRateSelect')?.value || 48000),
      youtubeConcurrency: concurrency,
      spotifyConcurrency: concurrency,
      includeLyrics: !!document.getElementById('includeLyrics')?.checked,
      embedLyrics: !!document.getElementById('embedLyrics')?.checked,
      autoCreateZip: !!document.getElementById('autoZip')?.checked,
      volumeGain: Math.max(1, Math.min(5, Number(document.getElementById('volumeGainRange')?.value || 1))),
      loudnorm: !!document.getElementById('loudnormCheckbox')?.checked,
      loudnormMode: this.normalizeLoudnormMode(document.getElementById('loudnormModeSelect')?.value)
    };
    this.outputSettings = settings;
    try {
      localStorage.setItem(this.outputSettingsKey, JSON.stringify(settings));
    } catch (error) {
      console.warn('Output settings could not be saved:', error);
    }
  }

  getSpotifyConcurrency() {
    const raw =
      document.getElementById('spotifyConcurrencyInput')?.value ??
      document.getElementById('youtubeConcurrencyInput')?.value ??
      4;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 4;
    return Math.max(1, Math.min(16, Math.round(n)));
  }

  async search(rawQuery, { preset = null, type = null } = {}) {
    const query = String(rawQuery || '').trim();
    const discoverPreset = this.isDiscoverPreset(preset);
    if (!query && !discoverPreset) {
      this.setResultsStatus(this.tt('ytlive.search.needQuery', 'Arama metni gir.'));
      return;
    }

    if (!discoverPreset && type) {
      this.activeSearchType = this.normalizeSearchType(type);
    }

    this.setActivePreset(preset);
    const pagingKey = discoverPreset ? this.getPresetDisplayLabel(preset) : query;
    this.resetInfiniteResults(preset, pagingKey, { mode: discoverPreset ? 'discover' : 'search' });
    if (this.searchController) {
      this.searchController.abort();
    }
    this.searchController = new AbortController();
    const searchId = ++this.searchSerial;
    this.setResultsStatus(this.tt('ytlive.search.loading', 'Aranıyor...'));
    this.renderSkeletonResults();

    try {
      const searchType = discoverPreset
        ? (preset === 'playlist' ? 'playlist' : '')
        : this.activeSearchType;
      const result = discoverPreset
        ? await this.fetchDiscoverItems({
          preset,
          page: 1,
          signal: this.searchController.signal
        })
        : {
          items: await this.fetchSearchItems(query, {
            preset,
            type: searchType,
            signal: this.searchController.signal
          }),
          hasMore: this.canLoadMorePresetQueries()
        };
      if (searchId !== this.searchSerial) return;

      this.results = this.mergeUniqueResults(result.items, { reset: true });
      this.hasMoreResults = this.results.length > 0 && (discoverPreset ? result.hasMore : this.canLoadMorePresetQueries());
      this.renderResults();
      this.setResultsStatus(
        this.results.length
          ? this.tt('ytlive.results.count', '{count} sonuç bulundu.', { count: this.results.length })
          : searchType === 'playlist'
            ? this.tt('ytlive.results.noPlaylists', 'Çalma listesi bulunamadı.')
            : this.tt('ytlive.results.empty', 'Sonuç bulunamadı.')
      );
      this.updateLoadMoreState();
      window.setTimeout(() => this.maybeLoadMoreByScroll(), 80);

      if (discoverPreset && this.results[0] && !this.hasActivePlayback()) {
        this.playRandomPlayerContent({ source: 'results' });
      } else if (!this.results.length && searchType === 'playlist' && !this.hasActivePlayback()) {
        this.clearPlayer(this.tt('ytlive.results.noPlaylists', 'Çalma listesi bulunamadı.'));
      }
    } catch (error) {
      if (error.name === 'AbortError' || searchId !== this.searchSerial) return;
      this.results = [];
      this.hasMoreResults = false;
      this.renderResults();
      this.updateLoadMoreState();
      this.setResultsStatus(this.tt('ytlive.search.error', 'Arama hatası: {message}', { message: error.message }));
      this.notify(error.message, 'error');
    }
  }

  async fetchSearchItems(query, { preset = null, type = null, signal = null, limit = this.resultLoadLimit } = {}) {
    const searchType = preset === 'playlist' ? 'playlist' : this.normalizeSearchType(type || this.activeSearchType);
    const params = new URLSearchParams({
      q: query,
      limit: String(limit),
      lang: this.getCurrentLang(),
      region: this.getCurrentRegion()
    });
    if (searchType) params.set('type', searchType);
    const presetOptions = this.getPresetSearchOptions(preset);
    Object.entries(presetOptions).forEach(([key, value]) => {
      if (value) params.set(key, String(value));
    });

    const response = await fetch(`/api/youtube/search?${params}`, {
      signal,
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data?.error?.message || this.tt('ytlive.search.failed', 'Arama başarısız.'));
    }

    return (Array.isArray(data.items) ? data.items : [])
      .map((item) => this.normalizeItem(item))
      .filter((item) => {
        if (!searchType) return true;
        if (searchType === 'track') return item.type === 'track';
        if (searchType === 'playlist') return this.isPlaylistLike(item) && item.type !== 'album';
        if (searchType === 'album') return item.type === 'album';
        return true;
      });
  }

  async fetchDiscoverItems({ preset = 'energizing', page = 1, signal = null, limit = this.resultLoadLimit } = {}) {
    const params = new URLSearchParams({
      preset: preset || 'energizing',
      page: String(page || 1),
      limit: String(limit),
      lang: this.getCurrentLang(),
      region: this.getCurrentRegion()
    });

    const cacheKey = params.toString();
    const cached = this.discoverResultCache.get(cacheKey);
    if (cached?.expiresAt > Date.now()) return cached.result;
    this.discoverResultCache.delete(cacheKey);

    const response = await fetch(`/api/youtube/discover?${params}`, {
      signal,
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data?.error?.message || this.tt('ytlive.search.failed', 'Arama başarısız.'));
    }

    const items = (Array.isArray(data.items) ? data.items : [])
      .map((item) => this.normalizeItem(item))
      .filter((item) => preset !== 'playlist' || this.isPlaylistLike(item));
    if (!items.length && Number(data.retryAfterMs) > 0) {
      throw new Error(data.warning || 'YouTube geçici istek sınırı uyguladı; lütfen bir süre sonra tekrar dene.');
    }

    const result = {
      items,
      hasMore: !!data.hasMore
    };
    if (items.length >= limit) {
      if (this.discoverResultCache.size >= 40) {
        this.discoverResultCache.delete(this.discoverResultCache.keys().next().value);
      }
      this.discoverResultCache.set(cacheKey, { result, expiresAt: Date.now() + 120000 });
    }
    return result;
  }

  async readMusicHomeShelfStream(params, { signal = null, onProgress = null } = {}) {
    const response = await fetch(`/api/youtube/music-home-stream?${params}`, {
      signal,
      cache: 'no-store'
    });
    if (!response.ok) {
      throw new Error(this.tt('ytlive.musicHome.failed', 'YouTube Music ana sayfası okunamadı.'));
    }

    if (!response.body?.getReader) {
      const fallbackResponse = await fetch(`/api/youtube/music-home?${params}`, {
        signal,
        cache: 'no-store'
      });
      const fallbackData = await fallbackResponse.json().catch(() => ({}));
      if (!fallbackResponse.ok || fallbackData.ok === false) {
        throw new Error(fallbackData?.error?.message || this.tt('ytlive.musicHome.failed', 'YouTube Music ana sayfası okunamadı.'));
      }
      return fallbackData;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalData = null;

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const frame = JSON.parse(trimmed);
      if (frame.type === 'progress') {
        onProgress?.(frame);
        return;
      }
      if (frame.type === 'done') {
        finalData = frame;
        return;
      }
      if (frame.type === 'error') {
        throw new Error(frame?.error?.message || this.tt('ytlive.musicHome.failed', 'YouTube Music ana sayfası okunamadı.'));
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          processLine(line);
          newlineIndex = buffer.indexOf('\n');
        }
        if (done) break;
      }
      if (buffer.trim()) processLine(buffer);
      if (!finalData) throw new Error(this.tt('ytlive.musicHome.failed', 'YouTube Music ana sayfası okunamadı.'));
      return finalData;
    } finally {
      reader.releaseLock();
    }
  }

  normalizeMusicHomeShelfPayload(data = {}) {
    return (Array.isArray(data.shelves) ? data.shelves : [])
      .map((shelf) => ({
        title: shelf?.title || this.tt('ytlive.musicHome.shelfFallback', 'YouTube Music'),
        pinned: false,
        items: (Array.isArray(shelf?.items) ? shelf.items : [])
          .map((item) => this.normalizeItem(item))
          .filter((item) => item.webpage_url)
      }))
      .filter((shelf) => shelf.items.length);
  }

  async loadMusicHomeShelves({ showToast = false, forceRefresh = false, retryAttempt = 0 } = {}) {
    const section = document.getElementById('musicHomeSection');
    const status = document.getElementById('musicHomeStatus');
    if (!section) return;

    window.clearTimeout(this.musicHomeRetryTimer);
    this.musicHomeRetryTimer = null;
    if (this.musicHomeController) {
      this.musicHomeController.abort();
    }
    const controller = new AbortController();
    this.musicHomeController = controller;
    const isCurrent = () => this.musicHomeController === controller && !controller.signal.aborted;
    const retry = (retryAfterMs = 0) => {
      if (!isCurrent() || retryAttempt >= 3) return false;
      this.musicHomeRetryTimer = window.setTimeout(() => {
        if (isCurrent()) return this.loadMusicHomeShelves({ forceRefresh: false, retryAttempt: retryAttempt + 1 });
      }, Math.max([1000, 3000, 6000][retryAttempt], Math.min(3600000, Number(retryAfterMs) || 0)));
      return true;
    };
    if (status) status.title = '';

    if (this.musicHomeShelves.length && status) {
      status.textContent = this.tt('ytlive.musicHome.refreshing', 'YouTube Music rafları yenileniyor...');
    }

    try {
      const params = new URLSearchParams({
        shelves: String(this.musicHomeShelfCount),
        limit: '12',
        lang: this.getCurrentLang(),
        region: this.getCurrentRegion(),
        refresh: forceRefresh ? '1' : '0'
      });
      let lastProgressShelfCount = retryAttempt ? this.musicHomeShelves.length : 0;
      let receivedPersonalProgress = false;
      const data = await this.readMusicHomeShelfStream(params, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (!isCurrent()) return;
          const progressiveShelves = this.normalizeMusicHomeShelfPayload(progress);
          if (!progressiveShelves.length || progressiveShelves.length < lastProgressShelfCount) return;
          lastProgressShelfCount = progressiveShelves.length;
          receivedPersonalProgress =
            receivedPersonalProgress ||
            (String(progress.source || '').toLowerCase() === 'innertube' && progress.personalized !== false);
          this.musicHomeShelves = progressiveShelves;
          this.renderMusicHomeShelves({ preserveScroll: true });

          if (status) {
            const authUser = progress.authUser == null || progress.authUser === '' ? '' : String(progress.authUser);
            const continuationPages = Number(progress.continuationPages || 0);
            const elapsedMs = Number(progress.elapsedMs || 0);
            const elapsedLabel = elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(elapsedMs >= 10000 ? 0 : 1)} sn` : '';
            const diagnostics = [
              authUser ? `YT hesap ${authUser}` : '',
              continuationPages > 0 ? `${continuationPages} devam sayfası` : '',
              elapsedLabel
            ].filter(Boolean);
            status.textContent = `${progressiveShelves.length} kişisel raf hazır · devamı yükleniyor${diagnostics.length ? ` · ${diagnostics.join(' · ')}` : ''}`;
          }
        }
      });
      if (!isCurrent()) return;
      if (data?.error?.message) {
        throw new Error(data.error.message);
      }

      const finalShelves = this.normalizeMusicHomeShelfPayload(data);
      const finalSource = String(data.source || '').toLowerCase();
      const isDirectPersonalHome = finalSource === 'innertube' && data.personalized !== false;
      // A stream may already have delivered authenticated shelves before a
      // continuation fails. Never replace that real personal Home with a later
      // anonymous fallback response.
      const preservingPersonalProgress = receivedPersonalProgress && !isDirectPersonalHome;
      if (finalShelves.length && !preservingPersonalProgress) {
        this.musicHomeShelves = finalShelves;
        this.renderMusicHomeShelves({ preserveScroll: true });
      }

      if (this.musicHomeShelves.length) {
        const source = finalSource;
        const usingPersonalShelves = isDirectPersonalHome || preservingPersonalProgress;
        const retryScheduled = usingPersonalShelves && data.partial && data.hasMore !== false && retry(data.retryAfterMs);
        const authUser = data.authUser == null || data.authUser === '' ? '' : String(data.authUser);
        const continuationPages = Number(data.continuationPages || 0);
        const elapsedMs = Number(data.elapsedMs || 0);
        const elapsedLabel = elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(elapsedMs >= 10000 ? 0 : 1)} sn` : '';

        if (status) {
          if (usingPersonalShelves) {
            const base = this.tt('ytlive.musicHome.loaded', '{count} kişisel raf yüklendi.', {
              count: this.musicHomeShelves.length
            });
            const diagnostics = [
              authUser ? `YT hesap ${authUser}` : '',
              continuationPages > 0 ? `${continuationPages} devam sayfası` : '',
              elapsedLabel,
              retryScheduled ? (data.retryAfterMs > 10000 ? 'YouTube için bekleme süresi' : 'devamı yeniden deneniyor') : (data.partial || preservingPersonalProgress) ? 'devamı tamamlanamadı' : '',
              data.cached ? 'sunucu önbelleğinden' : ''
            ].filter(Boolean);
            status.textContent = diagnostics.length ? `${base} · ${diagnostics.join(' · ')}` : base;
          } else if (source === 'yt-dlp') {
            status.textContent = `${this.musicHomeShelves.length} raf yüklendi · yt-dlp fallback${elapsedLabel ? ` · ${elapsedLabel}` : ''} (Innertube kişisel Home kullanılamadı)`;
          } else {
            status.textContent = `${this.musicHomeShelves.length} genel raf yüklendi${elapsedLabel ? ` · ${elapsedLabel}` : ''} · kişisel YouTube Music oturumu kullanılamadı`;
          }
          if (data.warning) status.title = String(data.warning);
        }

        if (!usingPersonalShelves) {
          console.warn('YouTube Music personal home fallback is active:', {
            source: data.source || 'unknown',
            personalized: data.personalized,
            authUser: data.authUser,
            warning: data.warning || ''
          });
        }

        if (!retryAttempt) this.playRandomPlayerContent({ source: 'musicHome' });
        if (showToast) {
          if (usingPersonalShelves && !data.partial && !preservingPersonalProgress) {
            this.notify(this.tt('ytlive.musicHome.updated', 'YouTube Music rafları yenilendi.'), 'success');
          } else if (usingPersonalShelves && !retryScheduled) {
            this.notify(
              'Kişisel raflar korundu; YouTube Music bağlantısı yavaş olduğu için devamı henüz tamamlanamadı.',
              'warning'
            );
          } else if (!usingPersonalShelves) {
            this.notify(
              String(data.warning || 'YouTube Music kişisel Home kullanılamadı; fallback rafları gösteriliyor.'),
              'warning'
            );
          }
        }
        return;
      }

      section.hidden = true;
      if (Number(data.retryAfterMs) > 0) retry(data.retryAfterMs);
      if (showToast) {
        const message = data.warning
          ? String(data.warning)
          : data.cookieAvailable === false
          ? this.tt('ytlive.musicHome.noCookie', 'YouTube Music oturumu bulunamadı.')
          : this.tt('ytlive.musicHome.empty', 'YouTube Music kişisel raf döndürmedi.');
        this.notify(message, 'info');
      }
    } catch (error) {
      if (error.name === 'AbortError' || !isCurrent()) return;
      const retryScheduled = retry();
      if (status) {
        status.textContent = retryScheduled
          ? 'YouTube Music bağlantısı yeniden deneniyor; yüklenen raflar korundu.'
          : 'YouTube Music yüklemesi tamamlanamadı. Yenile düğmesiyle tekrar deneyebilirsin.';
      }
      if (!this.musicHomeShelves.length) section.hidden = true;
      if (showToast && !retryScheduled) {
        this.notify(error.message || this.tt('ytlive.musicHome.failed', 'YouTube Music ana sayfası okunamadı.'), 'error');
      } else {
        console.warn('YouTube Music home could not be loaded:', error);
      }
    }
  }

  renderMusicHomeShelves({ preserveScroll = false } = {}) {
    const section = document.getElementById('musicHomeSection');
    const host = document.getElementById('musicHomeShelves');
    if (!section || !host) return;

    if (!this.musicHomeShelves.length) {
      section.hidden = true;
      host.innerHTML = '';
      return;
    }

    const previousScroll = preserveScroll
      ? Array.from(host.querySelectorAll('.music-shelf__rail')).map((rail) => rail.scrollLeft)
      : [];

    section.hidden = false;
    const downloadTitle = this.escapeHtml(this.tt('ytlive.download.now', 'İndir'));
    const listTitle = this.escapeHtml(this.tt('ytlive.lists.addMenu', 'İndirme listesine ekle'));
    const playTitle = this.escapeHtml(this.tt('ytlive.play', 'Oynat'));
    const scrollLeftTitle = this.escapeHtml(this.tt('ytlive.musicHome.scrollLeft', 'Sola kaydır'));
    const scrollRightTitle = this.escapeHtml(this.tt('ytlive.musicHome.scrollRight', 'Sağa kaydır'));

    host.innerHTML = this.musicHomeShelves.map((shelf, shelfIndex) => {
      const title = this.escapeHtml(shelf.title || this.tt('ytlive.musicHome.shelfFallback', 'YouTube Music'));
      const count = this.escapeHtml(this.tt('ytlive.musicHome.itemCount', '{count} içerik', { count: shelf.items.length }));
      const items = shelf.items.map((item, index) => {
        const thumbImage = this.renderThumbnailImage(item, {
          className: 'music-home-card__image',
          sizes: '(max-width: 640px) 72vw, 248px'
        });
        const itemTitle = this.escapeHtml(item.title || this.tt('ytlive.youtubeContent', 'YouTube içeriği'));
        const uploader = this.escapeHtml(item.uploader || 'YouTube Music');
        const type = this.escapeHtml(this.getItemTypeLabel(item));
        const duration = this.escapeHtml(item.duration_string || (item.duration ? this.formatSeconds(item.duration) : ''));
        const initials = this.escapeHtml(this.getTitleInitials(item.title || item.uploader || 'YT'));

        return `
          <article class="music-home-card" data-music-action="play" data-shelf="${shelfIndex}" data-index="${index}">
            <div class="music-home-card__actions">
              <button class="music-home-card__download" type="button" data-music-action="download" data-shelf="${shelfIndex}" data-index="${index}" title="${downloadTitle}" aria-label="${downloadTitle}">${this.renderDownloadIcon()}</button>
              <button class="music-home-card__add" type="button" data-music-action="list-menu" data-shelf="${shelfIndex}" data-index="${index}" title="${listTitle}" aria-label="${listTitle}">+</button>
            </div>
            <div class="music-home-card__thumb ${thumbImage ? '' : 'music-home-card__thumb--fallback'}">
              ${thumbImage || `<span>${initials}</span>`}
              ${duration ? `<span class="duration-pill">${duration}</span>` : ''}
            </div>
            <div class="music-home-card__body">
              <div class="card-kicker">
                <span class="type-pill">${type}</span>
                <span>YouTube Music</span>
              </div>
              <h3>${itemTitle}</h3>
              <p>${uploader}</p>
              <div class="card-footer">
                <span>${duration || type}</span>
                <span>${playTitle}</span>
              </div>
            </div>
          </article>
        `;
      }).join('');

      return `
        <section class="music-shelf">
          <div class="music-shelf__header">
            <h3>${title}</h3>
            <span>${count}</span>
          </div>
          <div class="music-shelf__rail-shell">
            <button class="music-shelf__arrow music-shelf__arrow--prev" type="button" data-shelf-scroll="-1" aria-label="${scrollLeftTitle}">‹</button>
            <div class="music-shelf__rail" data-shelf-rail="${shelfIndex}">${items}</div>
            <button class="music-shelf__arrow music-shelf__arrow--next" type="button" data-shelf-scroll="1" aria-label="${scrollRightTitle}">›</button>
          </div>
        </section>
      `;
    }).join('');

    host.querySelectorAll('.music-shelf__rail').forEach((rail, index) => {
      if (preserveScroll && Number.isFinite(previousScroll[index])) {
        rail.scrollLeft = previousScroll[index];
      }
      rail.addEventListener('scroll', () => this.syncMusicShelfArrows(rail), { passive: true });
      this.syncMusicShelfArrows(rail);
    });
  }

  syncMusicShelfArrows(rail) {
    if (!rail) return;
    const shell = rail.closest('.music-shelf__rail-shell');
    if (!shell) return;
    const prev = shell.querySelector('[data-shelf-scroll="-1"]');
    const next = shell.querySelector('[data-shelf-scroll="1"]');
    const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
    const atStart = rail.scrollLeft <= 2;
    const atEnd = rail.scrollLeft >= maxScroll - 2;
    shell.classList.toggle('has-overflow', maxScroll > 4);
    if (prev) {
      prev.removeAttribute('aria-disabled');
      prev.dataset.atEdge = atStart ? 'true' : 'false';
    }
    if (next) {
      next.removeAttribute('aria-disabled');
      next.dataset.atEdge = atEnd ? 'true' : 'false';
    }
  }

  bumpMusicShelfEdge(rail, direction) {
    if (!rail) return;
    const className = direction < 0 ? 'is-edge-bump-start' : 'is-edge-bump-end';
    rail.classList.remove('is-edge-bump-start', 'is-edge-bump-end');
    void rail.offsetWidth;
    rail.classList.add(className);
    rail.addEventListener('animationend', () => {
      rail.classList.remove(className);
    }, { once: true });
  }

  scrollMusicShelf(button) {
    const shell = button?.closest?.('.music-shelf__rail-shell');
    const rail = shell?.querySelector?.('.music-shelf__rail');
    if (!rail) return;
    const direction = Number(button.dataset.shelfScroll || 0) < 0 ? -1 : 1;
    const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
    const atStart = rail.scrollLeft <= 2;
    const atEnd = rail.scrollLeft >= maxScroll - 2;

    if (direction < 0 && atStart) {
      this.bumpMusicShelfEdge(rail, direction);
      return;
    }
    if (direction > 0 && atEnd) {
      this.bumpMusicShelfEdge(rail, direction);
      return;
    }

    const distance = Math.max(280, Math.round(rail.clientWidth * 0.82));
    rail.scrollBy({ left: direction * distance, behavior: 'smooth' });
  }

  renderSkeletonResults() {
    const grid = document.getElementById('resultsGrid');
    if (!grid) return;
    this.renderDiscoverySummary({ loading: true });
    this.updateLoadMoreState('hidden');
    grid.innerHTML = Array.from({ length: 8 }).map(() => `
      <article class="content-card is-loading">
        <div class="thumb-placeholder"></div>
        <div class="line-placeholder"></div>
        <div class="line-placeholder short"></div>
      </article>
    `).join('');
  }

  renderResults() {
    const grid = document.getElementById('resultsGrid');
    if (!grid) return;
    this.renderSearchTypeTabs();

    if (!this.results.length) {
      this.renderDiscoverySummary();
      grid.innerHTML = `<div class="empty-state full-row">${this.escapeHtml(this.tt('ytlive.results.emptyShort', 'Sonuç yok.'))}</div>`;
      return;
    }

    this.renderDiscoverySummary();
    grid.innerHTML = this.results.map((item, index) => {
      const thumbImage = this.renderThumbnailImage(item, {
        className: 'card-thumb__image',
        sizes: '(max-width: 420px) 100vw, (max-width: 640px) 50vw, 280px'
      });
      const title = this.escapeHtml(item.title || this.tt('ytlive.youtubeContent', 'YouTube içeriği'));
      const uploader = this.escapeHtml(item.uploader || 'YouTube');
      const type = this.escapeHtml(this.getItemTypeLabel(item));
      const duration = this.escapeHtml(item.duration_string || (item.duration ? this.formatSeconds(item.duration) : ''));
      const downloadTitle = this.escapeHtml(this.tt('ytlive.download.now', 'İndir'));
      const listTitle = this.escapeHtml(this.tt('ytlive.lists.addMenu', 'İndirme listesine ekle'));
      const playTitle = this.escapeHtml(this.tt('ytlive.play', 'Oynat'));
      const rank = String(index + 1).padStart(2, '0');
      const tags = this.getContentTags(item, index)
        .map((tag) => `<span>${this.escapeHtml(tag)}</span>`)
        .join('');
      const sourceLabel = this.escapeHtml(this.getSourceLabel(item));
      const initials = this.escapeHtml(this.getTitleInitials(item.title || uploader || 'YT'));

      return `
        <article class="content-card" data-action="play" data-index="${index}">
          <div class="content-card__actions">
            <button class="download-button" type="button" data-action="download" data-index="${index}" title="${downloadTitle}" aria-label="${downloadTitle}">${this.renderDownloadIcon()}</button>
            <button class="add-button" type="button" data-action="list-menu" data-index="${index}" title="${listTitle}" aria-label="${listTitle}">+</button>
          </div>
          <div class="card-thumb ${thumbImage ? '' : 'card-thumb--fallback'}">
            ${thumbImage}
            <span class="rank-pill">#${rank}</span>
            ${thumbImage ? '' : `<span class="thumb-initials">${initials}</span>`}
            ${duration ? `<span class="duration-pill">${duration}</span>` : ''}
          </div>
          <div class="content-card__body">
            <div class="card-kicker">
              <span class="type-pill">${type}</span>
              <span>${sourceLabel}</span>
            </div>
            <h3>${title}</h3>
            <p>${uploader}</p>
            ${tags ? `<div class="card-tags">${tags}</div>` : ''}
            <div class="card-footer">
              <span>${duration || type}</span>
              <span>${playTitle}</span>
            </div>
          </div>
        </article>
      `;
    }).join('');
  }

  renderSearchTypeTabs() {
    const grid = document.getElementById('resultsGrid');
    if (!grid?.parentElement) return;

    let host = document.getElementById('searchTypeTabs');
    if (!host) {
      host = document.createElement('div');
      host.id = 'searchTypeTabs';
      host.className = 'search-type-tabs';
      grid.parentElement.insertBefore(host, grid);
    }

    if (!this.activeSearchQuery || this.activePreset) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }

    const tabs = [
      ['track', this.tt('ytlive.searchType.tracks', 'Şarkılar')],
      ['playlist', this.tt('ytlive.searchType.playlists', 'Oynatma listeleri')],
      ['album', this.tt('ytlive.searchType.albums', 'Albümler')]
    ];

    host.hidden = false;
    host.innerHTML = tabs.map(([type, label]) => `
      <button
        type="button"
        class="secondary-button compact-action ${this.activeSearchType === type ? 'is-active' : ''}"
        data-search-type="${type}">
        ${this.escapeHtml(label)}
      </button>
    `).join('');
  }

  handleSearchTypeClick(event) {
    const button = event.target.closest('[data-search-type]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();

    const type = this.normalizeSearchType(button.dataset.searchType);
    if (!type || type === this.activeSearchType || !this.activeSearchQuery) return;

    const input = document.getElementById('searchInput');
    if (input) input.value = this.activeSearchQuery;
    this.search(this.activeSearchQuery, { type });
  }

  normalizeSearchType(value) {
    const type = String(value || '').trim().toLowerCase();
    if (['playlist', 'playlists'].includes(type)) return 'playlist';
    if (['album', 'albums'].includes(type)) return 'album';
    return 'track';
  }

  renderDiscoverySummary({ loading = false } = {}) {
    const host = this.getDiscoverySummaryHost();
    if (!host) return;

    if (loading || !this.results.length) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }

    const lead = this.results[0];
    const title = this.escapeHtml(lead.title || this.tt('ytlive.youtubeContent', 'YouTube içeriği'));
    const uploader = this.escapeHtml(lead.uploader || 'YouTube');
    const thumbImage = this.renderThumbnailImage(lead, {
      className: 'spotlight-art__image',
      loading: 'eager',
      priority: true,
      sizes: '(max-width: 640px) 100vw, 240px'
    });
    const type = this.escapeHtml(this.getItemTypeLabel(lead));
    const duration = this.escapeHtml(lead.duration_string || (lead.duration ? this.formatSeconds(lead.duration) : ''));
    const presetLabel = this.escapeHtml(this.getPresetDisplayLabel(this.activePreset));
    const initials = this.escapeHtml(this.getTitleInitials(lead.title || uploader || 'YT'));
    const playlistCount = this.results.filter((item) => this.isPlaylistLike(item)).length;
    const trackCount = Math.max(0, this.results.length - playlistCount);
    const totalDuration = this.formatResultDuration(this.results);
    const downloadTitle = this.escapeHtml(this.tt('ytlive.download.now', 'İndir'));
    const listTitle = this.escapeHtml(this.tt('ytlive.lists.addMenu', 'İndirme listesine ekle'));
    const playTitle = this.escapeHtml(this.tt('ytlive.play', 'Oynat'));
    const miniItems = this.results.slice(1, 5).map((item, offset) => {
      const index = offset + 1;
      const itemTitle = this.escapeHtml(item.title || this.tt('ytlive.youtubeContent', 'YouTube içeriği'));
      const itemMeta = this.escapeHtml(item.uploader || this.getItemTypeLabel(item));
      const itemThumbImage = this.renderThumbnailImage(item, {
        className: 'mini-result__image',
        sizes: '52px'
      });
      return `
        <button class="mini-result" type="button" data-action="play" data-index="${index}">
          <span class="mini-result__thumb ${itemThumbImage ? '' : 'mini-result__thumb--fallback'}">
            ${itemThumbImage || this.escapeHtml(this.getTitleInitials(item.title || item.uploader || 'YT'))}
          </span>
          <span class="mini-result__copy">
            <strong>${itemTitle}</strong>
            <small>${itemMeta}</small>
          </span>
        </button>
      `;
    }).join('');

    host.hidden = false;
    host.innerHTML = `
      <article class="discovery-spotlight" data-action="play" data-index="0">
        <div class="spotlight-art ${thumbImage ? '' : 'spotlight-art--fallback'}">
          ${thumbImage || `<span>${initials}</span>`}
          ${duration ? `<span class="duration-pill">${duration}</span>` : ''}
        </div>
        <div class="spotlight-copy">
          <div class="card-kicker">
            <span class="type-pill">${type}</span>
            <span>${presetLabel}</span>
          </div>
          <h3>${title}</h3>
          <p>${uploader}</p>
          <div class="spotlight-actions">
            <button class="primary-button compact-action" type="button" data-action="play" data-index="0">${playTitle}</button>
            <button class="secondary-button compact-action" type="button" data-action="download" data-index="0" title="${downloadTitle}">${downloadTitle}</button>
            <button class="secondary-button compact-action icon-button" type="button" data-action="list-menu" data-index="0" title="${listTitle}" aria-label="${listTitle}">+</button>
          </div>
        </div>
      </article>
      <div class="discovery-side">
        <div class="metric-grid">
          <div><strong>${this.results.length}</strong><span>${this.escapeHtml(this.tt('ytlive.content.loaded', 'içerik'))}</span></div>
          <div><strong>${trackCount}</strong><span>${this.escapeHtml(this.tt('ytlive.type.track', 'Tek parça'))}</span></div>
          <div><strong>${playlistCount}</strong><span>${this.escapeHtml(this.tt('ytlive.type.playlist', 'Çalma listesi'))}</span></div>
          <div><strong>${this.escapeHtml(totalDuration)}</strong><span>${this.escapeHtml(this.tt('ytlive.content.duration', 'süre'))}</span></div>
        </div>
        ${miniItems ? `<div class="mini-result-list">${miniItems}</div>` : ''}
      </div>
    `;
  }

  getDiscoverySummaryHost() {
    let host = document.getElementById('discoverySummary');
    if (host) return host;
    const status = document.getElementById('resultsStatus');
    if (!status?.parentElement) return null;
    host = document.createElement('div');
    host.id = 'discoverySummary';
    host.className = 'discovery-summary';
    host.hidden = true;
    status.parentElement.insertBefore(host, status);
    return host;
  }

  handleResultInteraction(event) {
    const actionButton = event.target.closest('[data-action]');
    const discover = document.getElementById('discover');
    if (!actionButton || !discover?.contains(actionButton)) return;

    const index = Number(actionButton.dataset.index);
    const item = this.results[index];
    if (!item) return;

    if (actionButton.dataset.action === 'download' || actionButton.dataset.action === 'add') {
      event.stopPropagation();
      this.addItem(item);
      return;
    }

    if (actionButton.dataset.action === 'list-menu') {
      event.stopPropagation();
      this.openDownloadListMenu(event, item);
      return;
    }

    this.playItem(item);
  }

  handleMusicHomeInteraction(event) {
    const section = document.getElementById('musicHomeSection');
    if (!section) return;

    const scrollButton = event.target.closest('[data-shelf-scroll]');
    if (scrollButton && section.contains(scrollButton)) {
      event.preventDefault();
      event.stopPropagation();
      this.scrollMusicShelf(scrollButton);
      return;
    }

    const actionButton = event.target.closest('[data-music-action]');
    if (!actionButton || !section.contains(actionButton)) return;

    const shelfIndex = Number(actionButton.dataset.shelf);
    const index = Number(actionButton.dataset.index);
    const item = this.musicHomeShelves[shelfIndex]?.items?.[index];
    if (!item) return;

    if (actionButton.dataset.musicAction === 'download' || actionButton.dataset.musicAction === 'add') {
      event.stopPropagation();
      this.addItem(item);
      return;
    }

    if (actionButton.dataset.musicAction === 'list-menu') {
      event.stopPropagation();
      this.openDownloadListMenu(event, item);
      return;
    }

    this.playItem(item);
  }

  handlePlaylistTrackInteraction(event) {
    const actionButton = event.target.closest('[data-action]');
    const panel = document.getElementById('playlistTracksPanel');
    if (!actionButton || !panel?.contains(actionButton)) return;

    const index = Number(actionButton.dataset.index);
    const item = this.playlistTracks[index];
    if (!item) return;

    if (actionButton.dataset.action === 'playlist-download' || actionButton.dataset.action === 'playlist-add') {
      event.stopPropagation();
      this.addItem(item);
      return;
    }

    if (actionButton.dataset.action === 'playlist-list-menu') {
      event.stopPropagation();
      this.openDownloadListMenu(event, item);
      return;
    }

    this.playPlaylistTrackAt(index);
  }

  handlePlaylistTrackKeyInteraction(event) {
    if (!['Enter', ' '].includes(event.key)) return;
    if (event.target.closest('button,a,input,select,textarea')) return;

    const row = event.target.closest('.playlist-track[data-index]');
    const panel = document.getElementById('playlistTracksPanel');
    if (!row || !panel?.contains(row)) return;

    event.preventDefault();
    this.playPlaylistTrackAt(Number(row.dataset.index));
  }

  async loadPlaylistTracks(rawItem, { autoplayFirst = false, silent = false } = {}) {
    const item = this.normalizeItem(rawItem);
    const panel = document.getElementById('playlistTracksPanel');
    if (!panel || !item.webpage_url) return;

    if (this.isMappedMusicItem(item)) {
      await this.startMappedMusicCollectionPlayback(item, { autoplayFirst, silent });
      return;
    }

    const serial = ++this.playlistTracksSerial;
    this.closeMappedMusicPreviewStream();
    const collectionKey = this.getCollectionKey(item);
    if (this.playlistTracksController) {
      this.playlistTracksController.abort();
    }
    this.playlistTracksController = new AbortController();
    this.playlistTracks = [];
    if (this.activeCollection?.key === collectionKey) {
      this.activeCollection = {
        ...this.activeCollection,
        item,
        title: item.title || this.tt('ytlive.youtubePlaylist', 'YouTube Playlist'),
        total: 0,
        tracks: [],
        currentIndex: -1,
        loading: true
      };
      this.updateNowPanelForCollection();
    }
    this.renderPlaylistTracks({
      loading: true,
      title: item.title || this.tt('ytlive.youtubePlaylist', 'YouTube Playlist')
    });

    try {
      const pageSize = 100;
      let page = 1;
      let total = 0;
      let title = item.title || this.tt('ytlive.youtubePlaylist', 'YouTube Playlist');
      const seen = new Set();
      let autoplayDone = false;

      while (page <= 100) {
        const response = await fetch('/api/playlist/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: item.webpage_url,
            page,
            pageSize
          }),
          signal: this.playlistTracksController.signal
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) {
          throw new Error(data?.error?.message || this.tt('ytlive.playlist.readFailed', 'Playlist okunamadı.'));
        }
        if (serial !== this.playlistTracksSerial) return;

        const rawEntries = Array.isArray(data.items) ? data.items : [];
        const entries = rawEntries
          .map((entry, idx) => this.normalizePlaylistEntry(entry, ((page - 1) * pageSize) + idx))
          .filter((entry) => {
            const key = this.getPlaylistTrackKey(entry);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

        total = Number(data?.playlist?.count || total || 0);
        title = data?.playlist?.title || title;
        this.playlistTracks = [...this.playlistTracks, ...entries];
        this.syncActiveCollectionTracks(item, {
          title,
          total,
          loading: rawEntries.length === pageSize && (!total || this.playlistTracks.length < total)
        });
        this.renderPlaylistTracks({
          loading: rawEntries.length === pageSize && (!total || this.playlistTracks.length < total),
          title,
          total
        });

        if (autoplayFirst && !autoplayDone && this.playlistTracks[0]) {
          autoplayDone = true;
          this.playPlaylistTrackAt(0, { silent });
        }

        if (!rawEntries.length || rawEntries.length < pageSize || (total && this.playlistTracks.length >= total)) {
          break;
        }
        page += 1;
      }

      this.syncActiveCollectionTracks(item, { title, total, loading: false });
      this.renderPlaylistTracks({ title, total });
    } catch (error) {
      if (error.name === 'AbortError') return;
      this.syncActiveCollectionTracks(item, { loading: false });
      this.renderPlaylistTracks({
        error: error.message || this.tt('ytlive.playlist.loadFailed', 'Playlist parçaları yüklenemedi.'),
        title: item.title || this.tt('ytlive.youtubePlaylist', 'YouTube Playlist')
      });
    }
  }

  renderPlaylistTracks({ loading = false, error = '', title = '', total = 0 } = {}) {
    const panel = document.getElementById('playlistTracksPanel');
    const titleEl = document.getElementById('playlistTracksTitle');
    const metaEl = document.getElementById('playlistTracksMeta');
    const list = document.getElementById('playlistTracksList');
    if (!panel || !titleEl || !metaEl || !list) return;

    if (!this.playlistTracks.length && !loading && !error) {
      panel.hidden = true;
      list.innerHTML = '';
      return;
    }

    panel.hidden = false;
    titleEl.textContent = title || this.tt('ytlive.playlist.tracksTitle', 'Playlist parçaları');
    if (error) {
      metaEl.textContent = error;
      list.innerHTML = `<div class="empty-state">${this.escapeHtml(error)}</div>`;
      return;
    }

    const count = this.playlistTracks.length;
    metaEl.textContent = loading
      ? this.tt('ytlive.playlist.tracksLoading', 'Playlist parçaları yükleniyor...')
      : total && total > count
        ? this.tt('ytlive.playlist.tracksCountTotal', '{count}/{total} parça', { count, total })
        : this.tt('ytlive.playlist.tracksCount', '{count} parça', { count });

    if (!count) {
      const emptyText = loading
        ? this.tt('ytlive.playlist.tracksLoading', 'Playlist parçaları yükleniyor...')
        : this.tt('ytlive.playlist.noItems', 'Playlist içinde eklenebilir parça bulunamadı.');
      list.innerHTML = `<div class="empty-state">${this.escapeHtml(emptyText)}</div>`;
      return;
    }

    const downloadTitle = this.escapeHtml(this.tt('ytlive.download.now', 'İndir'));
    const listTitle = this.escapeHtml(this.tt('ytlive.lists.addMenu', 'İndirme listesine ekle'));
    const playTitle = this.escapeHtml(this.tt('ytlive.play', 'Oynat'));
    const playingTitle = this.escapeHtml(this.tt('ytlive.playlist.playing', 'Çalıyor'));
    const trackLabel = this.escapeHtml(this.tt('ytlive.type.track', 'Tek parça'));
    const activeIndex = Number(this.activeCollection?.currentIndex);
    const displayTotal = Math.max(Number(total) || 0, count);

    list.innerHTML = this.playlistTracks.map((track, index) => {
      const isActive = activeIndex === index;
      const rawTitle = track.title || this.tt('ytlive.playlist.trackFallback', 'Parça {index}', { index: index + 1 });
      const rawArtist = track.artist || track.album_artist || track.uploader || 'YouTube';
      const trackTitle = this.escapeHtml(rawTitle);
      const artist = this.escapeHtml(rawArtist);
      const duration = this.escapeHtml(track.duration_string || (track.duration ? this.formatSeconds(track.duration) : ''));
      const thumbImage = this.renderThumbnailImage(track, {
        className: 'playlist-track__image',
        sizes: '(max-width: 560px) 70px, 88px'
      });
      const initials = this.escapeHtml(this.getTitleInitials(rawTitle || rawArtist || 'YT'));
      const activeClass = isActive ? ' is-active' : '';
      const rowNumber = String(index + 1).padStart(2, '0');
      const sourceLabelRaw = this.getSourceLabel(track);
      const sourceLabel = this.escapeHtml(sourceLabelRaw);
      const sourceCode = this.escapeHtml(this.getPlaylistTrackSourceCode(track));
      const metaChips = this.renderPlaylistTrackMeta(track, index);
      const rowTitle = this.escapeHtml([
        rawTitle,
        rawArtist,
        track.album,
        duration
      ].filter(Boolean).join(' • '));

      return `
        <article class="playlist-track${activeClass}" data-action="playlist-play" data-index="${index}"
          tabindex="0" aria-current="${isActive ? 'true' : 'false'}" aria-label="${rowTitle}" title="${rowTitle}">
          <div class="playlist-track__lead" aria-hidden="true">
            <span class="playlist-track__index">${rowNumber}</span>
            <span class="playlist-track__play-state">
              ${isActive
                ? '<span class="playlist-track__equalizer"><i></i><i></i><i></i></span>'
                : '<svg viewBox="0 0 24 24" focusable="false"><path d="M8 5.8v12.4L18 12 8 5.8Z" fill="currentColor"/></svg>'}
            </span>
          </div>

          <div class="playlist-track__thumb ${thumbImage ? '' : 'playlist-track__thumb--fallback'}">
            ${thumbImage || `<span class="playlist-track__initials">${initials}</span>`}
            <span class="playlist-track__source-code" title="${sourceLabel}">${sourceCode}</span>
            ${duration ? `<span class="playlist-track__duration-badge">${duration}</span>` : ''}
          </div>

          <div class="playlist-track__eyebrow">
            ${isActive ? `<span class="playlist-track__playing-pill">${playingTitle}</span>` : ''}
            <span>${trackLabel}</span>
            <span aria-hidden="true">•</span>
            <span>${sourceLabel}</span>
          </div>

          <div class="playlist-track__copy">
            <h3>${trackTitle}</h3>
            <p class="playlist-track__artist">${artist}</p>
            ${metaChips ? `<div class="playlist-track__meta">${metaChips}</div>` : ''}
          </div>

          <div class="playlist-track__stats" aria-label="${this.escapeHtml(this.tt('ytlive.playlist.trackInfo', 'Parça bilgisi'))}">
            <strong>${duration || '—:—'}</strong>
            <span>${index + 1} / ${displayTotal}</span>
          </div>

          <div class="playlist-track__actions">
            <button class="playlist-track__play" type="button" data-action="playlist-play" data-index="${index}"
              title="${isActive ? playingTitle : playTitle}" aria-label="${isActive ? playingTitle : playTitle}">
              ${isActive
                ? '<span class="playlist-track__equalizer"><i></i><i></i><i></i></span>'
                : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.8v12.4L18 12 8 5.8Z" fill="currentColor"/></svg>'}
            </button>
            <button class="playlist-track__download" type="button" data-action="playlist-download" data-index="${index}"
              title="${downloadTitle}" aria-label="${downloadTitle}">${this.renderDownloadIcon()}</button>
            <button class="playlist-track__add" type="button" data-action="playlist-list-menu" data-index="${index}"
              title="${listTitle}" aria-label="${listTitle}">+</button>
          </div>
        </article>
      `;
    }).join('');
  }

  renderPlaylistTrackMeta(track = {}, index = 0) {
    const values = [];
    const album = String(track.album || '').trim();
    const albumArtist = String(track.album_artist || '').trim();
    const year = String(track.release_year || track.upload_year || '').trim();
    const genre = String(track.genre || '').trim();
    const trackNumber = Number(track.track_number);
    const trackTotal = Number(track.track_total);

    if (album) {
      values.push({ icon: 'album', label: this.tt('ytlive.type.album', 'Albüm'), value: album });
    } else if (albumArtist && albumArtist !== track.artist && albumArtist !== track.uploader) {
      values.push({ icon: 'artist', label: this.tt('ytlive.playlist.albumArtist', 'Albüm sanatçısı'), value: albumArtist });
    }

    if (Number.isFinite(trackNumber) && trackNumber > 0) {
      const numberValue = Number.isFinite(trackTotal) && trackTotal > 0
        ? `${trackNumber}/${trackTotal}`
        : String(trackNumber);
      values.push({ icon: 'track', label: this.tt('ytlive.playlist.trackNumber', 'Parça no'), value: numberValue });
    }

    if (year) values.push({ icon: 'year', label: this.tt('ytlive.playlist.year', 'Yıl'), value: year });
    if (genre) values.push({ icon: 'genre', label: this.tt('ytlive.playlist.genre', 'Tür'), value: genre });

    if (!values.length && track.id) {
      values.push({ icon: 'id', label: 'YouTube ID', value: String(track.id) });
    }

    return values.slice(0, 4).map(({ icon, label, value }) => `
      <span class="playlist-track__meta-chip playlist-track__meta-chip--${icon}" title="${this.escapeHtml(`${label}: ${value}`)}">
        <span>${this.escapeHtml(value)}</span>
      </span>
    `).join('');
  }

  getPlaylistTrackSourceCode(track = {}) {
    const provider = track.sourceProvider || this.getMappedMusicSource(track.webpage_url || track.url || '');
    if (provider === 'spotify') return 'SP';
    if (provider === 'apple_music') return 'AM';
    if (provider === 'deezer') return 'DZ';
    if (provider === 'tidal') return 'TD';
    if (provider === 'soundcloud') return 'SC';
    if (urlHasHost(track.webpage_url || track.url || '', 'music.youtube.com')) return 'YTM';
    return 'YT';
  }

  clearPlaylistTracks() {
    this.playlistTracksSerial += 1;
    this.closeMappedMusicPreviewStream();
    if (this.playlistTracksController) {
      this.playlistTracksController.abort();
      this.playlistTracksController = null;
    }
    this.playlistTracks = [];
    this.activeCollection = null;
    this.renderPlaylistTracks();
    this.updatePlayerNavigationControls();
  }

  closeMappedMusicPreviewStream() {
    if (!this.mappedMusicPreviewStream) return;
    try { this.mappedMusicPreviewStream.close(); } catch {}
    this.mappedMusicPreviewStream = null;
  }

  getPlaylistTrackKey(item = {}) {
    return this.normalizeResultKey(item.id || item.webpage_url || item.url || `${item.title || ''}:${item.uploader || ''}:${item.index || ''}`);
  }

  getCollectionKey(item = {}) {
    const url = item.webpage_url || item.url || '';
    return this.normalizeResultKey(
      this.getAlbumBrowseId(url) ||
      this.getPlaylistId(url) ||
      item.playlistId ||
      item.browseId ||
      item.id ||
      url ||
      item.title ||
      ''
    );
  }

  syncActiveCollectionTracks(item = {}, { title = '', total = 0, loading } = {}) {
    if (!this.activeCollection) return;
    const collectionKey = this.getCollectionKey(item);
    if (collectionKey && this.activeCollection.key !== collectionKey) return;

    const nextTotal = Number(total);
    const currentTrack = this.getCurrentCollectionTrack();
    const collectionItem = {
      ...(this.activeCollection.item || {}),
      ...item,
      title: title || item.title || this.activeCollection.title || this.activeCollection.item?.title || ''
    };

    this.activeCollection = {
      ...this.activeCollection,
      item: collectionItem,
      title: collectionItem.title || this.activeCollection.title || '',
      total: Number.isFinite(nextTotal) && nextTotal > 0 ? nextTotal : this.activeCollection.total,
      tracks: this.playlistTracks.slice(),
      loading: loading === undefined ? this.activeCollection.loading : !!loading
    };
    this.updateNowPanelForCollection(currentTrack);
  }

  getCurrentCollectionTrack() {
    if (!this.activeCollection) return null;
    const index = Number(this.activeCollection.currentIndex);
    const tracks = this.playlistTracks.length ? this.playlistTracks : (this.activeCollection.tracks || []);
    return Number.isInteger(index) && index >= 0 ? (tracks[index] || null) : null;
  }

  setNowPanelItem(item = {}, { subtitle = '', linkItem = item } = {}) {
    const typeEl = document.getElementById('nowType');
    const titleEl = document.getElementById('nowTitle');
    const subtitleEl = document.getElementById('nowSubtitle');
    const addCurrent = document.getElementById('addCurrentBtn');
    const addCurrentToList = document.getElementById('addCurrentToListBtn');
    const openLink = document.getElementById('openCurrentLink');
    const linkUrl = safeExternalHttpUrl(linkItem?.webpage_url || linkItem?.url || item.webpage_url || item.url || '');

    if (typeEl) typeEl.textContent = this.getItemTypeLabel(item);
    if (titleEl) titleEl.textContent = item.title || this.tt('ytlive.youtubeContent', 'YouTube içeriği');
    if (subtitleEl) subtitleEl.textContent = subtitle || item.uploader || item.webpage_url || '';
    if (addCurrent) addCurrent.disabled = false;
    if (addCurrentToList) addCurrentToList.disabled = false;
    if (openLink) {
      openLink.href = linkUrl || '#';
      openLink.classList.toggle('is-disabled', !linkUrl);
    }
  }

  updateNowPanelForCollection(track = null) {
    const collection = this.activeCollection;
    this.updatePlayerNavigationControls();
    if (!collection?.item) return;

    const activeTrack = track || this.getCurrentCollectionTrack();
    let subtitle = collection.item.uploader || collection.item.webpage_url || '';
    if (activeTrack) {
      const position = Number(collection.currentIndex) + 1;
      const total = Number(collection.total || this.playlistTracks.length || 0);
      const positionText = position > 0 ? (total ? `${position}/${total}` : String(position)) : '';
      const trackText = [
        positionText,
        activeTrack.title || this.tt('ytlive.playlist.trackFallback', 'Parça {index}', { index: position || 1 }),
        activeTrack.uploader || ''
      ].filter(Boolean).join(' - ');
      subtitle = this.tt('ytlive.now.collectionTrack', 'Çalıyor: {track}', { track: trackText });
    }

    this.setNowPanelItem(collection.item, {
      subtitle,
      linkItem: collection.item
    });
  }

  playPlaylistTrackAt(index, { silent = false, autoplay = true, forceAutoplay = false } = {}) {
    const safeIndex = Number(index);
    if (!Number.isInteger(safeIndex) || safeIndex < 0) return false;
    const track = this.playlistTracks[safeIndex];
    if (!track) return false;

    if (this.activeCollection) {
      this.activeCollection = {
        ...this.activeCollection,
        currentIndex: safeIndex,
        tracks: this.playlistTracks.slice()
      };
      this.renderPlaylistTracks({
        loading: !!this.activeCollection.loading,
        title: this.activeCollection.title || this.activeCollection.item?.title || '',
        total: this.activeCollection.total || this.playlistTracks.length
      });
    }

    this.playItem(track, {
      keepPlaylist: true,
      collectionContext: this.activeCollection,
      playlistIndex: safeIndex,
      silent,
      autoplay,
      forceAutoplay
    });
    return true;
  }

  getCollectionNavigationState(currentItem = null) {
    const collection = this.activeCollection;
    if (!collection) return { collection: null, tracks: [], currentIndex: -1 };

    const tracks = this.playlistTracks.length ? this.playlistTracks : (collection.tracks || []);
    if (!this.playlistTracks.length && tracks.length) {
      this.playlistTracks = tracks.slice();
    }

    let currentIndex = Number(collection.currentIndex);
    if (!Number.isInteger(currentIndex) || currentIndex < 0) {
      const currentKey = this.getPlaylistTrackKey(currentItem || this.currentPlaybackItem || {});
      currentIndex = tracks.findIndex((track) => this.getPlaylistTrackKey(track) === currentKey);
    }

    return { collection, tracks, currentIndex };
  }

  updatePlayerNavigationControls() {
    const controls = document.getElementById('playerNavigationControls');
    const previousButton = document.getElementById('previousTrackBtn');
    const nextButton = document.getElementById('nextTrackBtn');
    const autoButton = document.getElementById('autoPlayModeBtn');
    const autoLabel = document.getElementById('autoPlayModeLabel');
    const position = document.getElementById('playerTrackPosition');
    if (!controls || !previousButton || !nextButton || !autoButton || !autoLabel || !position) return;

    const { collection, tracks, currentIndex } = this.getCollectionNavigationState();
    const hasCollection = !!collection;
    const hasPlayback = !!this.currentPlaybackItem;
    const hasCurrentTrack = currentIndex >= 0 && currentIndex < tracks.length;
    const total = Math.max(Number(collection?.total || 0), tracks.length);
    autoButton.hidden = hasCollection;
    autoButton.disabled = hasCollection;

    controls.hidden = !hasPlayback && !hasCollection;
    previousButton.disabled = !hasCurrentTrack || currentIndex <= 0;
    nextButton.disabled = hasCollection
      ? (!hasCurrentTrack || currentIndex >= tracks.length - 1)
      : (!hasPlayback || this.autoAdvanceInProgress);

    const previousLabel = this.tt('ytlive.player.previousTrack', 'Previous track');
    const nextLabel = this.tt('ytlive.player.nextTrack', 'Next track');
    previousButton.setAttribute('aria-label', previousLabel);
    previousButton.title = previousLabel;
    nextButton.setAttribute('aria-label', nextLabel);
    nextButton.title = nextLabel;

    const autoStateLabel = this.autoPlayMode
      ? this.tt('ytlive.player.autoOn', 'Auto ON')
      : this.tt('ytlive.player.autoOff', 'Auto OFF');
    const autoTitle = this.autoPlayMode
      ? this.tt('ytlive.player.disableAuto', 'Disable automatic random playback')
      : this.tt('ytlive.player.enableAuto', 'Enable automatic random playback');
    autoButton.setAttribute('aria-pressed', String(this.autoPlayMode));
    autoButton.setAttribute('aria-label', autoTitle);
    autoButton.title = autoTitle;
    autoLabel.textContent = autoStateLabel;

    position.hidden = !hasCollection;
    if (!hasCollection) {
      position.textContent = '';
      position.removeAttribute('aria-label');
      return;
    }

    const shownPosition = hasCurrentTrack ? currentIndex + 1 : 0;
    position.textContent = total > 0 ? `${shownPosition} / ${total}` : '…';
    position.setAttribute('aria-label', this.tt(
      'ytlive.player.trackPosition',
      'Track {current} of {total}',
      { current: shownPosition, total: total || tracks.length || 0 }
    ));
  }

  playPreviousCollectionTrack(currentItem = null, { silent = true, autoplay = true, forceAutoplay = false } = {}) {
    const { tracks, currentIndex } = this.getCollectionNavigationState(currentItem);
    const previousIndex = currentIndex - 1;
    if (previousIndex < 0 || previousIndex >= tracks.length) return false;
    return this.playPlaylistTrackAt(previousIndex, { silent, autoplay, forceAutoplay });
  }

  playNextCollectionTrack(currentItem = null, { silent = true, autoplay = true, forceAutoplay = false } = {}) {
    const { tracks, currentIndex } = this.getCollectionNavigationState(currentItem);
    const nextIndex = currentIndex + 1;
    if (nextIndex < 0 || nextIndex >= tracks.length) return false;
    return this.playPlaylistTrackAt(nextIndex, { silent, autoplay, forceAutoplay });
  }

  async playNextTrackNow() {
    if (this.playNextCollectionTrack(null, {
      silent: true,
      autoplay: true,
      forceAutoplay: true
    })) return true;

    // Playlist veya albüm sonundaysa rastgele moda geçme.
    if (this.activeCollection || !this.currentPlaybackItem || this.autoAdvanceInProgress) {
      return false;
    }

    const currentItem = this.currentPlaybackItem;
    const token = this.youtubePlaybackToken;
    this.autoAdvanceInProgress = true;
    this.updatePlayerNavigationControls();

    try {
      const candidate = await this.findAutoPlayCandidate(currentItem);
      if (token !== this.youtubePlaybackToken || !candidate) return false;

      this.rememberAutoPlayItem(currentItem);
      this.rememberAutoPlayItem(candidate);
      this.playItem(candidate, {
        silent: true,
        autoplay: true,
        forceAutoplay: true
      });
      return true;
    } finally {
      this.autoAdvanceInProgress = false;
      this.updatePlayerNavigationControls();
    }
  }

  handleYouTubePlaybackEnded(item, token) {
  if (token !== this.youtubePlaybackToken) return;
  if (this.playNextCollectionTrack(item, {
    silent: true,
    autoplay: true,
    forceAutoplay: true
  })) return;

  if (this.activeCollection?.loading) {
    window.setTimeout(() => {
      if (token !== this.youtubePlaybackToken) return;

      if (this.playNextCollectionTrack(item, {
        silent: true,
        autoplay: true,
        forceAutoplay: true
      })) return;

      if (this.activeCollection) return;

      void this.playAutoRandomTrack(item, token);
    }, 900);

    return;
  }

  if (this.activeCollection) return;
  void this.playAutoRandomTrack(item, token);
}

  handleYouTubePlaybackError(item, token, silent = false) {
    if (token !== this.youtubePlaybackToken) return false;
    const shouldAutoplayNext = !silent;
    if (!this.playNextCollectionTrack(item, {
      silent: true,
      autoplay: shouldAutoplayNext,
      forceAutoplay: shouldAutoplayNext
    })) return false;
    if (!silent) {
      this.notify(this.tt('ytlive.play.skippedUnavailable', 'Parça oynatılamadı, sonraki parçaya geçiliyor.'), 'info');
    }
    return true;
  }

  setupInfiniteScroll() {
    const sentinel = this.getLoadMoreSentinel();
    if (!sentinel) return;

    if (this.loadMoreObserver) {
      this.loadMoreObserver.disconnect();
      this.loadMoreObserver = null;
    }
    if (this.fallbackScrollHandler) {
      window.removeEventListener('scroll', this.fallbackScrollHandler);
      window.removeEventListener('resize', this.fallbackScrollHandler);
      this.fallbackScrollHandler = null;
    }

    this.fallbackScrollHandler = () => {
      if (this.loadMoreCheckTimer) return;
      this.loadMoreCheckTimer = window.setTimeout(() => {
        this.loadMoreCheckTimer = null;
        this.maybeLoadMoreByScroll();
      }, 90);
    };
    window.addEventListener('scroll', this.fallbackScrollHandler, { passive: true });
    window.addEventListener('resize', this.fallbackScrollHandler, { passive: true });

    if ('IntersectionObserver' in window) {
      this.loadMoreObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          this.loadMorePresetResults();
        }
      }, { rootMargin: '720px 0px 900px', threshold: 0.01 });
      this.loadMoreObserver.observe(sentinel);
      return;
    }
  }

  getLoadMoreSentinel() {
    let sentinel = document.getElementById('resultsLoadMore');
    if (sentinel) return sentinel;
    const grid = document.getElementById('resultsGrid');
    if (!grid?.parentElement) return null;
    sentinel = document.createElement('div');
    sentinel.id = 'resultsLoadMore';
    sentinel.className = 'load-more-sentinel';
    sentinel.hidden = true;
    grid.insertAdjacentElement('afterend', sentinel);
    return sentinel;
  }

  resetInfiniteResults(preset, query, { mode = 'search' } = {}) {
    this.activePreset = preset || null;
    this.activeSearchQuery = String(query || '').trim();
    this.resultKeys = new Set();
    this.isLoadingMore = false;
    this.hasMoreResults = false;
    this.presetPaging = {
      mode,
      loadedQueries: new Set([this.normalizeResultKey(query)]),
      page: mode === 'discover' ? 1 : 0,
      failedLoads: 0
    };
    this.updateLoadMoreState('hidden');
  }

  async loadMorePresetResults() {
    if (!this.hasMoreResults || this.isLoadingMore || !this.presetPaging) return;

    const searchId = this.searchSerial;
    const paging = this.presetPaging;
    const signal = this.searchController?.signal;
    const isCurrent = () => searchId === this.searchSerial && paging === this.presetPaging && !signal?.aborted;
    this.isLoadingMore = true;
    this.updateLoadMoreState('loading');

    try {
      if (this.presetPaging.mode === 'discover') {
        const nextPage = Number(this.presetPaging.page || 1) + 1;
        const result = await this.fetchDiscoverItems({ preset: this.activePreset, page: nextPage, signal });
        if (!isCurrent()) return;
        const added = this.mergeUniqueResults(result.items);

        if (added.length) {
          this.results = [...this.results, ...added];
          this.presetPaging.page = nextPage;
          this.presetPaging.failedLoads = 0;
          this.hasMoreResults = !!result.hasMore;
          this.renderResults();
          this.setResultsStatus(
            this.tt('ytlive.results.loadedMorePreset', '{count} içerik yüklendi. Kategori: {preset}', {
              count: this.results.length,
              preset: this.getPresetDisplayLabel(this.activePreset)
            })
          );
        } else {
          this.presetPaging.failedLoads += 1;
          if (!result.hasMore || this.presetPaging.failedLoads >= 2) {
            this.hasMoreResults = false;
          }
        }
        return;
      }

      let added = [];
      let lastQuery = '';
      for (let attempt = 0; attempt < this.maxLoadMoreAttempts && !added.length; attempt += 1) {
        const query = this.getNextPresetPageQuery();
        if (!query) {
          this.hasMoreResults = false;
          break;
        }
        lastQuery = query;
        const items = await this.fetchSearchItems(query, {
          preset: this.activePreset,
          type: this.activeSearchType,
          signal
        });
        if (!isCurrent()) return;
        added = this.mergeUniqueResults(items);
      }

      if (added.length) {
        this.results = [...this.results, ...added];
        this.presetPaging.failedLoads = 0;
        this.renderResults();
        this.setResultsStatus(
          this.tt('ytlive.results.loadedMore', '{count} içerik yüklendi. Son eklenen arama: {query}', {
            count: this.results.length,
            query: lastQuery || this.activeSearchQuery
          })
        );
      } else {
        this.presetPaging.failedLoads += 1;
        if (!this.canLoadMorePresetQueries() || this.presetPaging.failedLoads >= 2) {
          this.hasMoreResults = false;
        }
      }
    } catch (error) {
      if (error.name === 'AbortError' || !isCurrent()) return;
      this.presetPaging.failedLoads += 1;
      this.notify(error.message || this.tt('ytlive.search.failed', 'Arama başarısız.'), 'error');
      if (this.presetPaging.failedLoads >= 2) this.hasMoreResults = false;
    } finally {
      if (isCurrent()) {
        this.isLoadingMore = false;
        this.updateLoadMoreState(this.hasMoreResults ? '' : 'done');
        window.setTimeout(() => this.maybeLoadMoreByScroll(), 80);
      }
    }
  }

  getNextPresetPageQuery() {
    if (!this.activeSearchQuery || !this.presetPaging) return '';
    const maxAttempts = 60;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      this.presetPaging.page += 1;
      const query = this.activePreset
        ? this.getPresetPageQuery(this.activePreset, this.presetPaging.page)
        : this.getSearchPageQuery(this.activeSearchQuery, this.presetPaging.page);
      const key = this.normalizeResultKey(query);
      if (!this.presetPaging.loadedQueries.has(key)) {
        this.presetPaging.loadedQueries.add(key);
        return query;
      }
    }

    return '';
  }

  canLoadMorePresetQueries() {
    if (this.presetPaging?.mode === 'discover') {
      return !!this.activePreset && !!this.presetPaging;
    }
    return !!this.activeSearchQuery && !!this.presetPaging;
  }

  mergeUniqueResults(items, { reset = false } = {}) {
    if (reset) this.resultKeys = new Set();
    const unique = [];

    (Array.isArray(items) ? items : []).forEach((item) => {
      const key = this.getResultKey(item);
      if (this.resultKeys.has(key)) return;
      this.resultKeys.add(key);
      unique.push(item);
    });

    return unique;
  }

  getResultKey(item = {}) {
    const url = item.webpage_url || item.url || '';
    const id = item.id || this.getVideoId(url) || this.getPlaylistId(url);
    const type = this.isPlaylistLike(item) ? 'playlist' : 'track';
    return `${type}:${this.normalizeResultKey(id || url || `${item.title || ''}:${item.uploader || ''}`)}`;
  }

  normalizeResultKey(value) {
    return String(value || '').trim().toLowerCase();
  }

  updateLoadMoreState(state = '') {
    const sentinel = this.getLoadMoreSentinel();
    if (!sentinel) return;

    const shouldHide =
      state === 'hidden' ||
      !this.presetPaging ||
      (!this.activeSearchQuery && this.presetPaging.mode !== 'discover') ||
      !this.results.length ||
      (!this.hasMoreResults && state !== 'done');
    if (shouldHide) {
      sentinel.hidden = true;
      sentinel.classList.remove('is-loading');
      sentinel.textContent = '';
      return;
    }

    sentinel.hidden = false;
    const loading = state === 'loading' || this.isLoadingMore;
    sentinel.classList.toggle('is-loading', loading);
    sentinel.textContent = loading
      ? this.tt('ytlive.results.loadingMore', 'Yeni içerikler yükleniyor...')
      : this.hasMoreResults
        ? this.tt('ytlive.results.scrollMore', 'Daha fazla içerik için aşağı kaydır.')
        : this.tt('ytlive.results.noMore', 'Bu kategori için daha fazla öneri yok.');
  }

  maybeLoadMoreByScroll() {
    if (!this.canLoadMorePresetQueries() || !this.hasMoreResults || this.isLoadingMore) return;
    const sentinel = this.getLoadMoreSentinel();
    if (!sentinel || sentinel.hidden) return;
    const rect = sentinel.getBoundingClientRect();
    const doc = document.documentElement;
    const scrollBottom = window.scrollY + window.innerHeight;
    const nearSentinel = rect.top < window.innerHeight + 900;
    const nearDocumentBottom = scrollBottom >= (doc.scrollHeight - 1100);
    if (nearSentinel || nearDocumentBottom) {
      this.loadMorePresetResults();
    }
  }

  getMusicHomeItems() {
    return this.musicHomeShelves.flatMap((shelf) => Array.isArray(shelf.items) ? shelf.items : []);
  }

  hasActivePlayback() {
    return !!(this.currentPlaybackItem || this.currentItem || this.youtubePlayer);
  }

  getRandomPlayableItem(items = [], { tracksOnly = true, excludeKeys = [] } = {}) {
    const excluded = new Set((Array.isArray(excludeKeys) ? excludeKeys : []).filter(Boolean));
    const candidates = (Array.isArray(items) ? items : [])
      .map((item) => this.normalizeItem(item))
      .filter((item) => item.webpage_url)
      .filter((item) => !tracksOnly || (item.type === 'track' && !this.isPlaylistLike(item)))
      .filter((item) => !excluded.has(this.getPlaylistTrackKey(item)));
    const embeddable = candidates.filter((item) => this.getEmbedUrl(item));
    if (!embeddable.length) return null;
    return embeddable[Math.floor(Math.random() * embeddable.length)];
  }

  rememberAutoPlayItem(item = {}) {
    const key = this.getPlaylistTrackKey(item);
    if (!key) return;
    this.autoPlayHistory = [...this.autoPlayHistory.filter((value) => value !== key), key].slice(-12);
  }

  async findAutoPlayCandidate(currentItem = {}) {
    const currentKey = this.getPlaylistTrackKey(currentItem || this.currentPlaybackItem || {});
    const strictExclusions = [currentKey, ...this.autoPlayHistory].filter(Boolean);
    const relaxedExclusions = [currentKey].filter(Boolean);
    const pools = [this.results, this.getMusicHomeItems(), this.playlistTracks];

    for (const exclusions of [strictExclusions, relaxedExclusions]) {
      for (const pool of pools) {
        const candidate = this.getRandomPlayableItem(pool, { excludeKeys: exclusions });
        if (candidate) return candidate;
      }
    }

    const presets = Array.isArray(this.discoverPresets) && this.discoverPresets.length
      ? this.discoverPresets
      : ['energizing', 'feel-good', 'relax', 'focus'];
    const preset = presets[Math.floor(Math.random() * presets.length)] || 'energizing';

    try {
      const result = await this.fetchDiscoverItems({
        preset,
        page: 1,
        limit: Math.max(12, this.resultLoadLimit || 18)
      });
      return this.getRandomPlayableItem(result.items, { excludeKeys: strictExclusions })
        || this.getRandomPlayableItem(result.items, { excludeKeys: relaxedExclusions });
    } catch (error) {
      console.warn('Auto mode could not load a random track:', error);
      return null;
    }
  }

  async playAutoRandomTrack(currentItem = {}, token = this.youtubePlaybackToken) {
    if (!this.autoPlayMode || this.autoAdvanceInProgress) return false;
    this.autoAdvanceInProgress = true;
    this.updatePlayerNavigationControls();

    try {
      const candidate = await this.findAutoPlayCandidate(currentItem);
      if (!this.autoPlayMode || token !== this.youtubePlaybackToken) return false;
      if (!candidate) {
        this.notify(this.tt('ytlive.player.autoNoTrack', 'Auto mode could not find another playable track.'), 'info');
        return false;
      }

      this.rememberAutoPlayItem(currentItem);
      this.rememberAutoPlayItem(candidate);
      this.playItem(candidate, {
        silent: true,
        autoplay: true,
        forceAutoplay: true
      });
      return true;
    } finally {
      this.autoAdvanceInProgress = false;
      this.updatePlayerNavigationControls();
    }
  }

  playRandomPlayerContent({ source = 'results' } = {}) {
    if (this.hasActivePlayback()) return false;
    const pools = source === 'musicHome'
      ? [this.getMusicHomeItems(), this.results]
      : [this.results, this.getMusicHomeItems()];

    for (const pool of pools) {
      const item = this.getRandomPlayableItem(pool);
      if (item) {
        this.playItem(item, { silent: true });
        return true;
      }
    }
    return false;
  }

  async playUrlInput() {
    const item = this.itemFromUrl(document.getElementById('quickUrlInput')?.value || '');
    if (!item) {
      this.notify(this.tt('ytlive.url.invalid', 'Geçerli bir YouTube, Spotify, Apple Music, Deezer, TIDAL veya SoundCloud linki gir.'), 'error');
      return;
    }
    try {
      if (this.isMappedMusicItem(item)) {
        await this.playMappedMusicUrl(item);
        return;
      }
      this.playItem(item);
    } catch (error) {
      this.notify(error.message || this.tt('ytlive.playlist.loadFailed', 'Playlist parçaları yüklenemedi.'), 'error');
    }
  }

  async addUrlInput() {
    const item = this.itemFromUrl(document.getElementById('quickUrlInput')?.value || '');
    if (!item) {
      this.notify(this.tt('ytlive.url.invalid', 'Geçerli bir YouTube, Spotify, Apple Music, Deezer, TIDAL veya SoundCloud linki gir.'), 'error');
      return;
    }
    await this.addItem(item);
  }

  addUrlInputToList(event) {
    const item = this.itemFromUrl(document.getElementById('quickUrlInput')?.value || '');
    if (!item) {
      this.notify(this.tt('ytlive.url.invalid', 'Geçerli bir YouTube, Spotify, Apple Music, Deezer, TIDAL veya SoundCloud linki gir.'), 'error');
      return;
    }
    this.openDownloadListMenu(event, item);
  }

  async playMappedMusicUrl(rawItem, { silent = false } = {}) {
    const item = this.normalizeItem(rawItem);
    const url = item.webpage_url || item.url || '';
    if (!url) throw new Error(this.tt('ytlive.url.invalid', 'Geçerli bir YouTube, Spotify, Apple Music, Deezer, TIDAL veya SoundCloud linki gir.'));

    this.notify(this.tt('ytlive.musicUrl.matching', 'Link eşleştiriliyor...'), 'info');
    const task = await this.startMappedMusicPreviewTask(item);
    const resolvedType = this.getMappedMusicPlaybackType(item, task.total);

    if (resolvedType === 'track') {
      this.streamMappedMusicTrackPlayback(task, item, { silent });
      return;
    }

    this.streamMappedMusicCollectionPlayback(task, {
      ...item,
      type: resolvedType,
      title: task.title || item.title || this.getMappedMusicFallbackTitle(item.sourceProvider, resolvedType),
      uploader: this.getMappedMusicLabel(item.sourceProvider),
      webpage_url: url,
      url
    }, { autoplayFirst: true, silent });
  }

  async startMappedMusicPreviewTask(rawItem) {
    const item = this.normalizeItem(rawItem);
    const url = item.webpage_url || item.url || '';
    const spotifyConcurrency = this.getSpotifyConcurrency();
    const response = await fetch('/api/spotify/preview/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        market: this.getCurrentRegion(),
        youtubeConcurrency: spotifyConcurrency,
        spotifyConcurrency
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data?.error?.message || this.tt('ytlive.playlist.readFailed', 'Playlist okunamadı.'));
    }
    return {
      mapId: data.mapId,
      title: data.title || item.title || this.getMappedMusicFallbackTitle(item.sourceProvider, item.type),
      total: Number(data.total || 0),
      source: data.source || item.sourceProvider || this.getMappedMusicSource(url)
    };
  }

  streamMappedMusicTrackPlayback(task, rawItem, { silent = false } = {}) {
    const item = this.normalizeItem(rawItem);
    const serial = ++this.playlistTracksSerial;
    this.closeMappedMusicPreviewStream();
    if (this.playlistTracksController) {
      this.playlistTracksController.abort();
      this.playlistTracksController = null;
    }
    this.playlistTracks = [];
    this.renderPlaylistTracks({
      loading: true,
      title: task.title || item.title,
      total: task.total || 1
    });

    let settled = false;
    const playResolvedTrack = (rawTrack) => {
      if (settled || serial !== this.playlistTracksSerial) return false;
      const track = this.normalizePlaylistEntry(rawTrack, 0);
      if (!track?.webpage_url && !track?.id) return false;

      settled = true;
      this.closeMappedMusicPreviewStream();
      this.playlistTracks = [track];
      this.renderPlaylistTracks({
        title: task.title || item.title,
        total: 1
      });
      this.playItem(track, {
        silent,
        autoplay: true,
        forceAutoplay: !silent
      });
      return true;
    };

    const failIfUnresolved = (message = '') => {
      if (settled || serial !== this.playlistTracksSerial) return;
      settled = true;
      this.closeMappedMusicPreviewStream();
      this.renderPlaylistTracks({
        error: message || this.tt('ytlive.playlist.noItems', 'Playlist içinde eklenebilir parça bulunamadı.'),
        title: task.title || item.title
      });
    };

    if (!task.mapId) {
      failIfUnresolved(this.tt('ytlive.playlist.readFailed', 'Playlist okunamadı.'));
      return;
    }

    const stream = new EventSource(`/api/spotify/preview/stream/${encodeURIComponent(task.mapId)}`);
    this.mappedMusicPreviewStream = stream;
    stream.onmessage = (event) => {
      if (serial !== this.playlistTracksSerial) {
        try { stream.close(); } catch {}
        return;
      }
      const data = JSON.parse(event.data || '{}');
      if (data.type === 'init') {
        const items = Array.isArray(data.items) ? data.items : [];
        items.some((entry) => playResolvedTrack(entry));
        return;
      }
      if (data.type === 'item') {
        playResolvedTrack(data.item);
        return;
      }
      if (data.type === 'done') {
        if (data.status === 'error') {
          failIfUnresolved(data.error || this.tt('ytlive.playlist.loadFailed', 'Playlist parçaları yüklenemedi.'));
        } else {
          failIfUnresolved();
        }
      }
    };
    stream.onerror = () => {
      failIfUnresolved(this.tt('ytlive.playlist.loadFailed', 'Playlist parçaları yüklenemedi.'));
    };
  }

  async startMappedMusicCollectionPlayback(rawItem, { autoplayFirst = true, silent = false } = {}) {
    const item = this.normalizeItem(rawItem);
    this.notify(this.tt('ytlive.musicUrl.matching', 'Link eşleştiriliyor...'), 'info');
    const task = await this.startMappedMusicPreviewTask(item);
    const resolvedType = this.getMappedMusicPlaybackType(item, task.total);
    this.streamMappedMusicCollectionPlayback(task, {
      ...item,
      type: resolvedType === 'track' ? 'playlist' : resolvedType,
      title: task.title || item.title || this.getMappedMusicFallbackTitle(item.sourceProvider, resolvedType)
    }, { autoplayFirst, silent });
  }

  streamMappedMusicCollectionPlayback(task, rawItem, { autoplayFirst = true, silent = false } = {}) {
    const item = this.normalizeItem(rawItem);
    const serial = ++this.playlistTracksSerial;
    this.closeMappedMusicPreviewStream();
    if (this.playlistTracksController) {
      this.playlistTracksController.abort();
      this.playlistTracksController = null;
    }

    const title = task.title || item.title || this.getMappedMusicFallbackTitle(item.sourceProvider, item.type);
    const total = Number(task.total || 0);
    const collectionKey = this.getCollectionKey(item);
    this.playlistTracks = [];
    this.activeCollection = {
      item: { ...item, title },
      key: collectionKey,
      title,
      total,
      tracks: [],
      currentIndex: -1,
      loading: true
    };
    this.currentItem = this.activeCollection.item;
    this.currentPlaybackItem = this.activeCollection.item;
    this.stopYouTubePlayback();
    this.showPlayerPlaceholder(
      this.tt('ytlive.player.emptyTitle', 'Select content'),
      this.tt('ytlive.player.emptyText', 'Click a search result or pasted link to play it here.')
    );
    this.updateNowPanelForCollection();
    this.renderPlaylistTracks({ loading: true, title, total });

    const seen = new Set();
    let autoplayDone = false;
    const addResolvedTrack = (rawTrack) => {
      if (serial !== this.playlistTracksSerial) return null;
      const track = this.normalizePlaylistEntry(rawTrack, this.playlistTracks.length);
      if (!track?.webpage_url && !track?.id) return null;
      const key = this.getPlaylistTrackKey(track);
      if (seen.has(key)) return null;
      seen.add(key);

      this.playlistTracks = [...this.playlistTracks, track];
      this.syncActiveCollectionTracks(item, {
        title,
        total,
        loading: true
      });
      this.renderPlaylistTracks({
        loading: true,
        title,
        total
      });

      if (autoplayFirst && !autoplayDone) {
        autoplayDone = true;
        this.playPlaylistTrackAt(this.playlistTracks.length - 1, { silent });
      }
      return track;
    };

    const finish = (error = '') => {
      if (serial !== this.playlistTracksSerial) return;
      this.closeMappedMusicPreviewStream();
      this.syncActiveCollectionTracks(item, { title, total, loading: false });
      if (error && !this.playlistTracks.length) {
        this.renderPlaylistTracks({ error, title, total });
        return;
      }
      if (!this.playlistTracks.length) {
        this.renderPlaylistTracks({
          error: this.tt('ytlive.playlist.noItems', 'Playlist içinde eklenebilir parça bulunamadı.'),
          title,
          total
        });
        return;
      }
      this.renderPlaylistTracks({ title, total });
    };

    if (!task.mapId) {
      finish(this.tt('ytlive.playlist.readFailed', 'Playlist okunamadı.'));
      return;
    }

    const stream = new EventSource(`/api/spotify/preview/stream/${encodeURIComponent(task.mapId)}`);
    this.mappedMusicPreviewStream = stream;
    stream.onmessage = (event) => {
      if (serial !== this.playlistTracksSerial) {
        try { stream.close(); } catch {}
        return;
      }
      const data = JSON.parse(event.data || '{}');
      if (data.type === 'init') {
        (Array.isArray(data.items) ? data.items : []).forEach((entry) => addResolvedTrack(entry));
        return;
      }
      if (data.type === 'item') {
        addResolvedTrack(data.item);
        return;
      }
      if (data.type === 'progress') {
        const nextTotal = Number(data.total || total || 0);
        this.syncActiveCollectionTracks(item, { title, total: nextTotal, loading: data.status !== 'completed' });
        this.renderPlaylistTracks({
          loading: data.status !== 'completed',
          title,
          total: nextTotal
        });
        return;
      }
      if (data.type === 'done') {
        finish(data.status === 'error'
          ? (data.error || this.tt('ytlive.playlist.loadFailed', 'Playlist parçaları yüklenemedi.'))
          : '');
      }
    };
    stream.onerror = () => {
      finish(this.tt('ytlive.playlist.loadFailed', 'Playlist parçaları yüklenemedi.'));
    };
  }

  playItem(rawItem, { silent = false, keepPlaylist = false, autoplay = true, collectionContext = null, playlistIndex = null, forceAutoplay = false } = {}) {
    const item = this.normalizeItem(rawItem);
    if (this.isMappedMusicItem(item)) {
      this.playMappedMusicUrl(item, { silent }).catch((error) => {
        this.notify(error.message || this.tt('ytlive.playlist.loadFailed', 'Playlist parçaları yüklenemedi.'), 'error');
      });
      return;
    }
    const collectionLike = this.isPlaylistLike(item);

    if (collectionLike) {
      const collectionKey = this.getCollectionKey(item);
      this.activeCollection = {
        item,
        key: collectionKey,
        title: item.title || this.tt('ytlive.youtubePlaylist', 'YouTube Playlist'),
        total: 0,
        tracks: [],
        currentIndex: -1,
        loading: true
      };
      this.currentItem = item;
      this.currentPlaybackItem = item;
      this.stopYouTubePlayback();
      this.showPlayerPlaceholder(
        this.tt('ytlive.player.emptyTitle', 'Select content'),
        this.tt('ytlive.player.emptyText', 'Click a search result or pasted link to play it here.')
      );

      this.updateNowPanelForCollection();

      this.loadPlaylistTracks(item, { autoplayFirst: true, silent });
      if (!silent) this.notify(this.tt('ytlive.playlist.loading', 'Loading content...'), 'info');
      return;
    }

    const shouldAutoplay = autoplay && (!silent || forceAutoplay);
    const embedUrl = this.getEmbedUrl(item, { autoplay: shouldAutoplay });
    if (!embedUrl) {
      const shouldAutoplayNext = !silent;
      if (collectionContext && this.playNextCollectionTrack(item, {
        silent: true,
        autoplay: shouldAutoplayNext,
        forceAutoplay: shouldAutoplayNext
      })) return;
      this.notify(this.tt('ytlive.play.unavailable', 'Bu içerik oynatılamıyor, ama link olarak eklenebilir.'), 'info');
      return;
    }

    const activeCollection = collectionContext || (keepPlaylist ? this.activeCollection : null);
    if (activeCollection) {
      const safeIndex = Number(playlistIndex);
      this.activeCollection = {
        ...activeCollection,
        currentIndex: Number.isInteger(safeIndex) && safeIndex >= 0 ? safeIndex : activeCollection.currentIndex,
        tracks: this.playlistTracks.length ? this.playlistTracks.slice() : (activeCollection.tracks || [])
      };
      this.currentItem = this.activeCollection.item;
      this.currentPlaybackItem = item;
    } else {
      this.activeCollection = null;
      this.currentItem = item;
      this.currentPlaybackItem = item;
    }

    this.startYouTubePlayback(item, { autoplay: shouldAutoplay, silent });

    if (this.activeCollection) {
      this.updateNowPanelForCollection(item);
    } else {
      this.setNowPanelItem(item);
    }

    if (!keepPlaylist) {
      this.clearPlaylistTracks();
    }

  }

  clearPlayer(subtitle = '') {
    this.currentItem = null;
    this.currentPlaybackItem = null;
    this.activeCollection = null;
    this.stopYouTubePlayback();
    this.showPlayerPlaceholder(
      this.tt('ytlive.player.emptyTitle', 'Select content'),
      this.tt('ytlive.player.emptyText', 'Click a search result or pasted link to play it here.')
    );

    document.getElementById('nowType').textContent = 'YouTube';
    document.getElementById('nowTitle').textContent = this.getConfiguredNowTitle();
    document.getElementById('nowSubtitle').textContent =
      subtitle || this.getConfiguredNowSubtitle();

    const addCurrent = document.getElementById('addCurrentBtn');
    if (addCurrent) addCurrent.disabled = true;

    const addCurrentToList = document.getElementById('addCurrentToListBtn');
    if (addCurrentToList) addCurrentToList.disabled = true;

    const openLink = document.getElementById('openCurrentLink');
    if (openLink) {
      openLink.href = '#';
      openLink.classList.add('is-disabled');
    }

    this.clearPlaylistTracks();
  }

  ensureYouTubeIframeApi() {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (this.youtubeApiPromise) return this.youtubeApiPromise;

    this.youtubeApiPromise = new Promise((resolve, reject) => {
      const previousReady = window.onYouTubeIframeAPIReady;
      const timeoutId = window.setTimeout(() => reject(new Error('YouTube player API timeout')), 7000);

      window.onYouTubeIframeAPIReady = () => {
        try {
          if (typeof previousReady === 'function') previousReady();
        } catch {}
        window.clearTimeout(timeoutId);
        resolve(window.YT);
      };

      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.async = true;
        script.onerror = () => {
          window.clearTimeout(timeoutId);
          reject(new Error('YouTube player API could not be loaded'));
        };
        document.head.appendChild(script);
      }
    }).catch((error) => {
      this.youtubeApiPromise = null;
      throw error;
    });

    return this.youtubeApiPromise;
  }

  ensureYouTubePlayerHost() {
    const frame = document.querySelector('.player-frame');
    if (!frame) return null;

    let host = document.getElementById('youtubePlayer');
    if (host) {
      host.hidden = false;
      if (!host.classList.contains('youtube-player') && host.tagName !== 'IFRAME') {
        host.classList.add('youtube-player');
      }
      return host;
    }

    host = document.createElement('div');
    host.id = 'youtubePlayer';
    host.className = 'youtube-player';
    const empty = document.getElementById('playerEmpty');
    frame.insertBefore(host, empty || null);
    return host;
  }

  setYouTubePlayerVisible(visible) {
    document.querySelector('.player-frame')?.classList.toggle('is-player-visible', !!visible);
    const host = document.getElementById('youtubePlayer');
    if (host) host.hidden = false;
  }

  createYouTubePlayerIframe({ videoId = '', playlistId = '', autoplay = true } = {}) {
    const frame = document.querySelector('.player-frame');
    if (!frame) return null;

    const currentHost = document.getElementById('youtubePlayer');
    const iframe = document.createElement('iframe');
    iframe.id = 'youtubePlayer';
    iframe.className = 'youtube-player';
    iframe.title = 'YouTube video player';
    iframe.frameBorder = '0';
    iframe.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';

    const embedTarget = playlistId
      ? 'videoseries'
      : encodeURIComponent(String(videoId || '').trim());
    const url = new URL(`https://www.youtube.com/embed/${embedTarget}`);
    url.searchParams.set('enablejsapi', '1');
    url.searchParams.set('origin', window.location.origin);
    url.searchParams.set('playsinline', '1');
    url.searchParams.set('rel', '0');
    url.searchParams.set('autoplay', autoplay ? '1' : '0');
    if (playlistId) url.searchParams.set('list', playlistId);

    if (currentHost) currentHost.replaceWith(iframe);
    else {
      const empty = document.getElementById('playerEmpty');
      frame.insertBefore(iframe, empty || null);
    }

    iframe.src = url.toString();
    return iframe;
  }

  waitForYouTubeIframeLoad(iframe, token, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!iframe) {
        reject(new Error('YouTube player iframe could not be created'));
        return;
      }

      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        iframe.removeEventListener('load', onLoad);
        iframe.removeEventListener('error', onError);
        if (error) reject(error);
        else resolve(iframe);
      };
      const onLoad = () => {
        if (token !== this.youtubePlaybackToken) {
          finish(new Error('YouTube playback superseded'));
          return;
        }
        finish();
      };
      const onError = () => finish(new Error('YouTube player iframe could not be loaded'));
      const timeoutId = window.setTimeout(
        () => finish(new Error('YouTube player iframe timeout')),
        timeoutMs
      );

      iframe.addEventListener('load', onLoad, { once: true });
      iframe.addEventListener('error', onError, { once: true });
    });
  }

  showPlayerPlaceholder(title, text) {
    const empty = document.getElementById('playerEmpty');
    if (!empty) return;
    const titleEl = empty.querySelector('.player-empty__title');
    const textEl = empty.querySelector('.player-empty__text');
    if (titleEl) titleEl.textContent = title || '';
    if (textEl) textEl.textContent = text || '';
    empty.hidden = false;
    empty.setAttribute('aria-hidden', 'false');
  }

  hidePlayerPlaceholder() {
    const empty = document.getElementById('playerEmpty');
    if (!empty) return;
    empty.hidden = true;
    empty.setAttribute('aria-hidden', 'true');
  }

  stopYouTubePlayback() {
    this.youtubePlaybackToken += 1;
    window.clearTimeout(this.youtubeRevealTimer);
    this.youtubeRevealTimer = null;
    this.setYouTubePlayerVisible(false);
    if (this.youtubePlayer) {
      try { this.youtubePlayer.destroy(); } catch {}
      this.youtubePlayer = null;
    }
    this.ensureYouTubePlayerHost();
    const host = document.getElementById('youtubePlayer');
    if (host) host.hidden = true;
  }

  startYouTubePlayback(item, { autoplay = true, silent = false } = {}) {
    const token = ++this.youtubePlaybackToken;
    const videoId = this.getVideoId(item?.webpage_url || item?.url || '') ||
      (String(item?.id || '').match(/^[A-Za-z0-9_-]{11}$/) ? item.id : '');
    const playlistId = this.getPlaylistId(item?.webpage_url || item?.url || '');
    const isPlaylist = this.isPlaylistLike(item) && playlistId;

    window.clearTimeout(this.youtubeRevealTimer);
    this.youtubeRevealTimer = null;
    this.setYouTubePlayerVisible(false);
    this.showPlayerPlaceholder(
      silent
        ? (item?.title || this.tt('ytlive.player.emptyTitle', 'Select content'))
        : this.tt('ytlive.player.loadingTitle', 'Loading player'),
      silent
        ? this.tt('ytlive.player.emptyText', 'Click a search result or pasted link to play it here.')
        : this.tt('ytlive.player.loadingText', 'Checking whether this video can be played here.')
    );

    if (!videoId && !isPlaylist) {
      this.showEmbedFallback(item, token, silent);
      return;
    }

    this.ensureYouTubeIframeApi()
      .then((YT) => {
        if (token !== this.youtubePlaybackToken) return;
        if (this.youtubePlayer) {
          try { this.youtubePlayer.destroy(); } catch {}
          this.youtubePlayer = null;
        }
        const iframe = this.createYouTubePlayerIframe({
          videoId: isPlaylist ? '' : videoId,
          playlistId: isPlaylist ? playlistId : '',
          autoplay
        });
        if (!iframe) return;

        let revealed = false;
        let notifiedPlayable = false;
        const reveal = (delay = 0) => {
          window.clearTimeout(this.youtubeRevealTimer);
          this.youtubeRevealTimer = window.setTimeout(() => {
            if (token !== this.youtubePlaybackToken) return;
            if (revealed) return;
            revealed = true;
            this.hidePlayerPlaceholder();
            this.setYouTubePlayerVisible(true);
          }, delay);
        };
        const notifyPlayable = () => {
          if (silent || notifiedPlayable) return;
          notifiedPlayable = true;
          this.notify(this.tt('ytlive.playing', 'Playing.'), 'success');
        };

        return this.waitForYouTubeIframeLoad(iframe, token).then(() => {
          if (token !== this.youtubePlaybackToken) return;
          this.youtubePlayer = new YT.Player(iframe, {
            events: {
              onReady: (event) => {
                if (token !== this.youtubePlaybackToken) return;
                if (autoplay) {
                  try { event.target.playVideo(); } catch {}
                }
                reveal(silent ? 1800 : 900);
              },
              onStateChange: (event) => {
                if (token !== this.youtubePlaybackToken) return;
                const states = window.YT?.PlayerState || {};
                if (event.data === states.ENDED || event.data === 0) {
                  this.handleYouTubePlaybackEnded(item, token);
                  return;
                }
                if ([states.PLAYING, states.BUFFERING, states.CUED].includes(event.data)) {
                  notifyPlayable();
                  reveal(120);
                }
              },
              onError: () => {
                if (this.handleYouTubePlaybackError(item, token, silent)) return;
                this.showEmbedFallback(item, token, silent);
              }
            }
          });
        });
      })
      .catch(() => {
        this.showEmbedFallback(item, token, silent);
      });
  }

  showEmbedFallback(item, token, silent = false) {
    if (token !== this.youtubePlaybackToken) return;
    window.clearTimeout(this.youtubeRevealTimer);
    this.youtubeRevealTimer = null;
    this.setYouTubePlayerVisible(false);
    if (this.youtubePlayer) {
      try { this.youtubePlayer.destroy(); } catch {}
      this.youtubePlayer = null;
    }
    this.ensureYouTubePlayerHost();
    this.showPlayerPlaceholder(
      this.tt('ytlive.player.embedBlockedTitle', 'Open on YouTube'),
      this.tt('ytlive.player.embedBlockedText', 'This video cannot be played inside Gharmonize. Use Open on YouTube or add it to the queue.')
    );
    if (!silent) {
      this.notify(this.tt('ytlive.play.embedBlocked', 'This video is blocked for embedded playback.'), 'info');
    }
  }

  async addItem(rawItem) {
    const item = this.normalizeItem(rawItem);
    if (!item.webpage_url) {
      this.notify(this.tt('ytlive.add.noUrl', 'Eklenebilir bir link bulunamadı.'), 'error');
      return;
    }

    try {
      if (this.isMappedMusicItem(item)) {
        await this.submitMappedMusicJob(item);
        return;
      }

      if (this.isPlaylistLike(item)) {
        try {
          await this.quickAddPlaylist(item);
        } catch (error) {
          if (item.type !== 'album') throw error;
          await this.submitJob(this.buildCollectionPayload(item));
        }
      } else {
        await this.submitJob(this.buildSinglePayload(item));
      }
    } catch (error) {
      this.notify(error.message || this.tt('ytlive.job.addFailed', 'İş eklenemedi.'), 'error');
    }
  }

  async quickAddPlaylist(item) {
    this.notify(
      this.tt('ytlive.playlist.preparing', 'Playlist hazırlanıyor: ilk {count} parça alınacak.', { count: this.quickAddLimit }),
      'info'
    );
    const response = await fetch('/api/playlist/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: item.webpage_url,
        page: 1,
        pageSize: this.quickAddLimit
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data?.error?.message || this.tt('ytlive.playlist.readFailed', 'Playlist okunamadı.'));
    }

    const entries = (Array.isArray(data.items) ? data.items : [])
      .slice(0, this.quickAddLimit)
      .map((entry, idx) => this.normalizePlaylistEntry(entry, idx));

    if (!entries.length) {
      throw new Error(this.tt('ytlive.playlist.noItems', 'Playlist içinde eklenebilir parça bulunamadı.'));
    }

    const selectedIdsRaw = entries.map((entry) => entry.id || null);
    const selectedIds = selectedIdsRaw.every(Boolean) ? selectedIdsRaw : null;
    const selectedIndices = entries.map((entry) => entry.index);

    await this.submitJob({
      ...this.getOutputPayload(),
      url: item.webpage_url,
      isPlaylist: true,
      plTitle: data?.playlist?.title || item.title || this.tt('ytlive.youtubePlaylist', 'YouTube Playlist'),
      selectedIndices,
      selectedIds,
      frozenEntries: entries
    });
  }

  async submitMappedMusicJob(rawItem) {
    const item = this.normalizeItem(rawItem);
    const payload = this.buildMappedMusicPayload(item);
    const submittedPayload = this.clonePayload(payload);
    const response = await fetch('/api/spotify/process/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data?.error?.message || this.tt('ytlive.job.createFailed', 'İş oluşturulamadı.'));
    }

    const jobId = data.jobId || data.id;
    if (!jobId) throw new Error(this.tt('ytlive.job.createFailed', 'İş oluşturulamadı.'));

    const initialJob = {
      id: jobId,
      status: 'queued',
      phase: 'preparing',
      currentPhase: 'preparing',
      format: payload.format,
      bitrate: payload.bitrate,
      sampleRate: payload.sampleRate,
      metadata: {
        source: item.sourceProvider || this.getMappedMusicSource(item.webpage_url || item.url || ''),
        mediaPlatform: item.sourceProvider || this.getMappedMusicSource(item.webpage_url || item.url || ''),
        url: item.webpage_url || item.url || '',
        originalUrl: item.webpage_url || item.url || '',
        spotifyTitle: item.title || null,
        frozenTitle: item.title || null,
        isPlaylist: item.type !== 'track',
        includeLyrics: !!payload.includeLyrics,
        embedLyrics: !!payload.embedLyrics,
        autoCreateZip: !!payload.autoCreateZip,
        volumeGain: payload.volumeGain ?? 1,
        loudnorm: !!payload.loudnorm,
        loudnormMode: payload.loudnorm ? this.normalizeLoudnormMode(payload.loudnormMode) : null
      }
    };

    this.jobs.set(jobId, this.mergeJobState(this.jobs.get(jobId), initialJob));
    this.notify(this.tt('ytlive.job.queued', 'İş kuyruğa eklendi.'), 'success');
    this.persistClassicJobSession(initialJob, submittedPayload);
    this.trackJob(jobId);
    this.renderQueueChip(this.getActiveJobCount());
    this.renderJobs();
    await this.refreshQueueStatus();
    return data;
  }

  applyDownloadListsState(data = {}) {
    this.downloadLists = (Array.isArray(data?.lists) ? data.lists : [])
      .map((list) => ({
        ...list,
        items: Array.isArray(list?.items) ? list.items : []
      }));
  }

  async refreshDownloadLists({ showToast = false } = {}) {
    try {
      const response = await fetch('/api/ytlive/download-lists', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data?.error?.message || this.tt('ytlive.lists.loadFailed', 'İndirme listeleri okunamadı.'));
      }
      this.applyDownloadListsState(data);
      this.renderDownloadLists();
      if (showToast) this.notify(this.tt('ytlive.lists.updated', 'İndirme listeleri güncellendi.'), 'success');
    } catch (error) {
      this.renderDownloadLists({ error: error.message });
      console.warn('Download lists could not be loaded:', error);
    }
  }

  async saveDownloadListsRequest(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data?.error?.message || this.tt('ytlive.lists.saveFailed', 'İndirme listesi kaydedilemedi.'));
    }
    this.applyDownloadListsState(data);
    this.renderDownloadLists();
    return data;
  }

  renderDownloadLists({ error = '' } = {}) {
    const panel = document.getElementById('downloadListsPanel');
    const status = document.getElementById('downloadListsStatus');
    const grid = document.getElementById('downloadListsGrid');
    if (!panel || !status || !grid) return;

    if (error) {
      status.textContent = error;
      grid.innerHTML = `<div class="empty-state">${this.escapeHtml(error)}</div>`;
      requestAnimationFrame(() => this.syncDownloadListArrows(grid));
      return;
    }

    const lists = Array.isArray(this.downloadLists) ? this.downloadLists : [];
    const itemCount = lists.reduce((sum, list) => sum + (Array.isArray(list.items) ? list.items.length : 0), 0);
    status.textContent = lists.length
      ? this.tt('ytlive.lists.status', '{lists} liste, {items} içerik', { lists: lists.length, items: itemCount })
      : this.tt('ytlive.lists.empty', 'Henüz indirme listesi yok.');

    if (!lists.length) {
      grid.innerHTML = `<div class="empty-state">${this.escapeHtml(this.tt('ytlive.lists.emptyHint', 'Yeni + butonundan liste oluşturabilirsin.'))}</div>`;
      requestAnimationFrame(() => this.syncDownloadListArrows(grid));
      return;
    }

    const playLabel = this.escapeHtml(this.tt('ytlive.play', 'Oynat'));
    const downloadLabel = this.escapeHtml(this.tt('ytlive.download.now', 'İndir'));
    const syncLabel = this.escapeHtml(this.tt('ytlive.lists.sync', 'Senkronize'));
    const deleteLabel = this.escapeHtml(this.tt('ytlive.lists.delete', 'Sil'));
    const removeLabel = this.escapeHtml(this.tt('ytlive.lists.removeItem', 'Listeden çıkar'));

    grid.innerHTML = lists.map((list) => {
      const items = Array.isArray(list.items) ? list.items : [];
      const canSync = !!this.getMappedListSourceUrl(items);
      const listId = String(list.id || '');
      const isExpanded = this.expandedDownloadListIds.has(listId);
      const visibleItems = isExpanded ? items : items.slice(0, 8);
      const previewItems = visibleItems.map((item) => {
        const title = this.escapeHtml(item.title || this.tt('ytlive.youtubeContent', 'YouTube içeriği'));
        const uploader = this.escapeHtml(item.uploader || 'YouTube');
        const key = this.escapeHtml(item.key || '');
        return `
          <li class="download-list-item">
            <span>
              <strong>${title}</strong>
              <small>${uploader}</small>
            </span>
            <button class="download-list-item__remove" type="button" data-list-action="remove-item" data-list-id="${this.escapeHtml(list.id)}" data-item-key="${key}" title="${removeLabel}" aria-label="${removeLabel}">×</button>
          </li>
        `;
      }).join('');
      const more = items.length > 8
        ? `<li class="download-list-item download-list-item--more">
            <button class="download-list-more-button" type="button" data-list-action="toggle-items" data-list-id="${this.escapeHtml(list.id)}" aria-expanded="${isExpanded ? 'true' : 'false'}">
              ${this.escapeHtml(isExpanded
                ? this.tt('ytlive.lists.showLess', 'Daha az göster')
                : this.tt('ytlive.lists.moreItems', '+{count} içerik daha', { count: items.length - 8 }))}
            </button>
          </li>`
        : '';

      return `
        <article class="download-list-card">
          <div class="download-list-card__top">
            <div>
              <h3>${this.escapeHtml(list.name || this.tt('ytlive.lists.fallbackName', 'İndirme Listesi'))}</h3>
              <p>${this.escapeHtml(this.tt('ytlive.lists.itemCount', '{count} içerik', { count: items.length }))}</p>
            </div>
            <div class="download-list-card__actions">
              <button class="secondary-button compact-action" type="button" data-list-action="play" data-list-id="${this.escapeHtml(list.id)}" ${items.length ? '' : 'disabled'}>${playLabel}</button>
              <button class="primary-button compact-action" type="button" data-list-action="download" data-list-id="${this.escapeHtml(list.id)}" ${items.length ? '' : 'disabled'}>${downloadLabel}</button>
              <button class="secondary-button compact-action" type="button" data-list-action="sync" data-list-id="${this.escapeHtml(list.id)}" ${canSync ? '' : 'disabled'}>${syncLabel}</button>
              <button class="ghost-button compact-action" type="button" data-list-action="delete" data-list-id="${this.escapeHtml(list.id)}">${deleteLabel}</button>
            </div>
          </div>
          <ul class="download-list-card__items${isExpanded ? ' is-expanded' : ''}">
            ${previewItems || `<li class="download-list-item download-list-item--more">${this.escapeHtml(this.tt('ytlive.lists.emptyList', 'Bu liste boş.'))}</li>`}
            ${more}
          </ul>
        </article>
      `;
    }).join('');
    requestAnimationFrame(() => this.syncDownloadListArrows(grid));
  }

  syncDownloadListArrows(grid) {
    if (!grid) return;
    const shell = grid.closest('.download-lists-grid-shell');
    if (!shell) return;
    const prev = shell.querySelector('[data-download-lists-scroll="-1"]');
    const next = shell.querySelector('[data-download-lists-scroll="1"]');
    const maxScroll = Math.max(0, grid.scrollWidth - grid.clientWidth);
    const atStart = grid.scrollLeft <= 2;
    const atEnd = grid.scrollLeft >= maxScroll - 2;
    shell.classList.toggle('has-overflow', maxScroll > 4);
    if (prev) {
      prev.removeAttribute('aria-disabled');
      prev.dataset.atEdge = atStart ? 'true' : 'false';
    }
    if (next) {
      next.removeAttribute('aria-disabled');
      next.dataset.atEdge = atEnd ? 'true' : 'false';
    }
  }

  scrollDownloadLists(button) {
    const shell = button?.closest?.('.download-lists-grid-shell');
    const grid = shell?.querySelector?.('.download-lists-grid');
    if (!grid) return;
    const direction = Number(button.dataset.downloadListsScroll || 0) < 0 ? -1 : 1;
    const maxScroll = Math.max(0, grid.scrollWidth - grid.clientWidth);
    const atStart = grid.scrollLeft <= 2;
    const atEnd = grid.scrollLeft >= maxScroll - 2;

    if (direction < 0 && atStart) {
      this.bumpMusicShelfEdge(grid, direction);
      return;
    }
    if (direction > 0 && atEnd) {
      this.bumpMusicShelfEdge(grid, direction);
      return;
    }

    const distance = Math.max(320, Math.round(grid.clientWidth * 0.82));
    grid.scrollBy({ left: direction * distance, behavior: 'smooth' });
  }

  handleDownloadListPanelInteraction(event) {
    const scrollButton = event.target.closest('[data-download-lists-scroll]');
    if (scrollButton) {
      event.preventDefault();
      event.stopPropagation();
      this.scrollDownloadLists(scrollButton);
      return;
    }

    const button = event.target.closest('[data-list-action]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();

    const listId = button.dataset.listId || '';
    const action = button.dataset.listAction || '';
    if (action === 'toggle-items') {
      const key = String(listId);
      if (this.expandedDownloadListIds.has(key)) this.expandedDownloadListIds.delete(key);
      else this.expandedDownloadListIds.add(key);
      this.renderDownloadLists();
      return;
    }
    if (action === 'play') {
      this.playSavedList(listId);
      return;
    }
    if (action === 'download') {
      this.downloadSavedList(listId);
      return;
    }
    if (action === 'sync') {
      this.syncDownloadList(listId);
      return;
    }
    if (action === 'delete') {
      this.deleteDownloadList(listId);
      return;
    }
    if (action === 'remove-item') {
      this.removeDownloadListItem(listId, button.dataset.itemKey || '');
    }
  }

  openDownloadListMenu(event, rawItem) {
    event?.preventDefault?.();
    event?.stopPropagation?.();

    const item = this.normalizeItem(rawItem);
    if (!item.webpage_url) {
      this.notify(this.tt('ytlive.add.noUrl', 'Eklenebilir bir link bulunamadı.'), 'error');
      return;
    }

    this.closeDownloadListMenu();

    const anchor = event?.currentTarget || event?.target || null;
    const menu = document.createElement('div');
    menu.className = 'download-list-menu';
    menu.setAttribute('role', 'menu');
    menu.tabIndex = -1;

    const title = document.createElement('div');
    title.className = 'download-list-menu__title';
    title.textContent = this.tt('ytlive.lists.addMenu', 'İndirme listesine ekle');
    menu.appendChild(title);

    const scrollBody = document.createElement('div');
    scrollBody.className = 'download-list-menu__scroll';
    menu.appendChild(scrollBody);

    if (!this.downloadLists.length) {
      const empty = document.createElement('div');
      empty.className = 'download-list-menu__empty';
      empty.textContent = this.tt('ytlive.lists.empty', 'Henüz indirme listesi yok.');
      scrollBody.appendChild(empty);
    } else {
      this.downloadLists.forEach((list) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'download-list-menu__item';
        button.textContent = `${list.name || this.tt('ytlive.lists.fallbackName', 'İndirme Listesi')} (${Array.isArray(list.items) ? list.items.length : 0})`;
        button.addEventListener('click', () => {
          this.closeDownloadListMenu();
          this.addItemToDownloadList(item, list.id);
        });
        scrollBody.appendChild(button);
      });
    }

    const createButton = document.createElement('button');
    createButton.type = 'button';
    createButton.className = 'download-list-menu__create';
    createButton.textContent = this.tt('ytlive.lists.createNew', 'Yeni liste oluştur');
    createButton.addEventListener('click', () => {
      this.closeDownloadListMenu();
      this.createDownloadListWithItem(item);
    });
    menu.appendChild(createButton);

    document.body.appendChild(menu);
    this.positionDownloadListMenu(menu, anchor);
    requestAnimationFrame(() => {
      this.positionDownloadListMenu(menu, anchor);
      menu.classList.add('is-open');
      menu.focus({ preventScroll: true });
    });

    const outsideHandler = (evt) => {
      if (menu.contains(evt.target)) return;
      this.closeDownloadListMenu();
    };
    const keyHandler = (evt) => {
      if (evt.key === 'Escape') this.closeDownloadListMenu();
    };
    const repositionHandler = () => this.positionDownloadListMenu(menu, anchor);

    setTimeout(() => {
      if (this.activeDownloadListMenu?.menu !== menu) return;
      document.addEventListener('mousedown', outsideHandler);
      document.addEventListener('keydown', keyHandler);
      window.addEventListener('resize', repositionHandler, { passive: true });
      window.addEventListener('scroll', repositionHandler, { passive: true });
      window.visualViewport?.addEventListener('resize', repositionHandler, { passive: true });
      window.visualViewport?.addEventListener('scroll', repositionHandler, { passive: true });
    }, 0);
    this.activeDownloadListMenu = { menu, outsideHandler, keyHandler, repositionHandler };
  }

  positionDownloadListMenu(menu, anchor) {
    if (!menu) return;

    const margin = 12;
    const gap = 8;
    const visualViewport = window.visualViewport;
    const viewportLeft = Number.isFinite(visualViewport?.offsetLeft) ? visualViewport.offsetLeft : 0;
    const viewportTop = Number.isFinite(visualViewport?.offsetTop) ? visualViewport.offsetTop : 0;
    const viewportWidth = Math.max(0, visualViewport?.width || window.innerWidth || document.documentElement?.clientWidth || 0);
    const viewportHeight = Math.max(0, visualViewport?.height || window.innerHeight || document.documentElement?.clientHeight || 0);
    const viewportRight = viewportLeft + viewportWidth;
    const viewportBottom = viewportTop + viewportHeight;
    const availableWidth = Math.max(0, viewportWidth - (margin * 2));
    const availableHeight = Math.max(0, viewportHeight - (margin * 2));
    const fallbackRect = {
      left: viewportLeft + margin,
      right: viewportLeft + margin,
      top: viewportTop + margin,
      bottom: viewportTop + margin,
    };
    const rect = anchor?.getBoundingClientRect?.() || fallbackRect;

    menu.style.maxWidth = `${availableWidth}px`;
    menu.style.maxHeight = `${availableHeight}px`;

    // The list itself is the only scrollable region. Reserve guaranteed room
    // for the title and the always-visible "create list" footer.
    const scrollBody = menu.querySelector('.download-list-menu__scroll');
    const title = menu.querySelector('.download-list-menu__title');
    const createButton = menu.querySelector('.download-list-menu__create');
    if (scrollBody) {
      const menuStyle = window.getComputedStyle(menu);
      const paddingTop = Number.parseFloat(menuStyle.paddingTop) || 0;
      const paddingBottom = Number.parseFloat(menuStyle.paddingBottom) || 0;
      const rowGap = Number.parseFloat(menuStyle.rowGap || menuStyle.gap) || 0;
      const titleHeight = title?.getBoundingClientRect?.().height || 0;
      const createHeight = createButton?.getBoundingClientRect?.().height || 0;
      const fixedHeight = paddingTop + paddingBottom + titleHeight + createHeight + (rowGap * 2);
      scrollBody.style.maxHeight = `${Math.max(0, availableHeight - fixedHeight)}px`;
      scrollBody.style.flex = '1 1 auto';
      scrollBody.style.minHeight = '0';
    }

    const menuRect = menu.getBoundingClientRect();
    const menuWidth = Math.min(menuRect.width || availableWidth, availableWidth);
    const menuHeight = Math.min(menuRect.height || availableHeight, availableHeight);
    const minLeft = viewportLeft + margin;
    const minTop = viewportTop + margin;
    const maxLeft = Math.max(minLeft, viewportRight - menuWidth - margin);
    const maxTop = Math.max(minTop, viewportBottom - menuHeight - margin);

    let left = rect.left;
    if (left + menuWidth + margin > viewportRight) {
      left = rect.right - menuWidth;
    }
    left = Math.min(Math.max(minLeft, left), maxLeft);

    const belowTop = rect.bottom + gap;
    const aboveTop = rect.top - menuHeight - gap;
    const spaceBelow = viewportBottom - margin - rect.bottom;
    const spaceAbove = rect.top - (viewportTop + margin);
    const opensAbove = spaceBelow < menuHeight + gap && spaceAbove > spaceBelow;
    const preferredTop = opensAbove ? aboveTop : belowTop;
    const top = Math.min(Math.max(minTop, preferredTop), maxTop);
    const originX = left < rect.left ? 'right' : 'left';
    const originY = opensAbove ? 'bottom' : 'top';

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.setProperty('transform-origin', `${originY} ${originX}`, 'important');
  }

  closeDownloadListMenu() {
    const active = this.activeDownloadListMenu;
    if (!active) return;
    try { document.removeEventListener('mousedown', active.outsideHandler); } catch {}
    try { document.removeEventListener('keydown', active.keyHandler); } catch {}
    try { window.removeEventListener('resize', active.repositionHandler); } catch {}
    try { window.removeEventListener('scroll', active.repositionHandler); } catch {}
    try { window.visualViewport?.removeEventListener('resize', active.repositionHandler); } catch {}
    try { window.visualViewport?.removeEventListener('scroll', active.repositionHandler); } catch {}
    active.menu?.remove?.();
    this.activeDownloadListMenu = null;
  }

  getCustomModalBackdrop() {
    let backdrop = document.getElementById('custom-modal-container');
    if (backdrop) return backdrop;

    backdrop = document.createElement('div');
    backdrop.id = 'custom-modal-container';
    backdrop.className = 'custom-modal-backdrop';
    backdrop.setAttribute('role', 'presentation');
    backdrop.style.display = 'none';
    document.body.appendChild(backdrop);
    return backdrop;
  }

  showDownloadListNameModal(defaultName = '') {
    return new Promise((resolve) => {
      const backdrop = this.getCustomModalBackdrop();
      const modal = document.createElement('div');
      const uid = `ytliveListName-${Date.now()}`;
      modal.className = 'custom-modal custom-modal--info ytlive-list-name-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', `${uid}Title`);
      modal.innerHTML = `
        <form class="ytlive-list-name-form">
          <div class="custom-modal__header">
            <div class="custom-modal__icon">+</div>
            <div class="custom-modal__content">
              <h3 class="custom-modal__title" id="${uid}Title">${this.escapeHtml(this.tt('ytlive.lists.nameTitle', 'Yeni indirme listesi'))}</h3>
              <div class="custom-modal__message">${this.escapeHtml(this.tt('ytlive.lists.nameMessage', 'Bu içerik eklenecek liste için bir ad yaz.'))}</div>
            </div>
          </div>
          <div class="custom-modal__body">
            <label class="ytlive-list-name-form__label" for="${uid}Input">${this.escapeHtml(this.tt('ytlive.lists.namePrompt', 'Liste adı'))}</label>
            <input class="ytlive-list-name-form__input" id="${uid}Input" name="listName" type="text" maxlength="120" autocomplete="off" value="${this.escapeHtml(defaultName)}">
            <div class="ytlive-list-name-form__error" aria-live="polite"></div>
          </div>
          <div class="custom-modal__footer">
            <button class="modal-btn modal-btn-cancel" type="button">${this.escapeHtml(this.tt('btn.cancel', 'İptal'))}</button>
            <button class="modal-btn modal-btn-confirm" type="submit">${this.escapeHtml(this.tt('ytlive.lists.create', 'Oluştur'))}</button>
          </div>
        </form>
      `;

      const form = modal.querySelector('.ytlive-list-name-form');
      const input = modal.querySelector('.ytlive-list-name-form__input');
      const errorEl = modal.querySelector('.ytlive-list-name-form__error');
      const cancelBtn = modal.querySelector('.modal-btn-cancel');

      const cleanup = () => {
        modal.remove();
        if (backdrop.children.length === 0) {
          backdrop.style.display = 'none';
          backdrop.classList.remove('is-open');
        }
        document.removeEventListener('keydown', keyHandler);
        backdrop.removeEventListener('click', backdropHandler);
      };

      const finish = (value) => {
        cleanup();
        resolve(value);
      };

      const submitHandler = (event) => {
        event.preventDefault();
        const value = String(input?.value || '').trim();
        if (!value) {
          if (errorEl) errorEl.textContent = this.tt('ytlive.lists.nameRequired', 'Liste adı boş olamaz.');
          input?.focus?.();
          return;
        }
        finish(value);
      };

      const cancelHandler = () => finish(null);
      const keyHandler = (event) => {
        if (event.key === 'Escape') cancelHandler();
      };
      const backdropHandler = (event) => {
        if (event.target === backdrop) cancelHandler();
      };

      form?.addEventListener('submit', submitHandler);
      cancelBtn?.addEventListener('click', cancelHandler);
      document.addEventListener('keydown', keyHandler);
      backdrop.addEventListener('click', backdropHandler);

      backdrop.style.display = 'flex';
      backdrop.classList.add('is-open');
      backdrop.appendChild(modal);

      requestAnimationFrame(() => {
        input?.focus?.();
        input?.select?.();
      });
    });
  }

  showDownloadListConfirmModal({ title = '', message = '', confirmText = '', cancelText = '' } = {}) {
    return new Promise((resolve) => {
      const backdrop = this.getCustomModalBackdrop();
      const modal = document.createElement('div');
      const uid = `ytliveListConfirm-${Date.now()}`;
      modal.className = 'custom-modal custom-modal--danger ytlive-list-confirm-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', `${uid}Title`);
      modal.innerHTML = `
        <div class="custom-modal__header">
          <div class="custom-modal__icon">!</div>
          <div class="custom-modal__content">
            <h3 class="custom-modal__title" id="${uid}Title">${this.escapeHtml(title)}</h3>
            <div class="custom-modal__message">${this.escapeHtml(message)}</div>
          </div>
        </div>
        <div class="custom-modal__footer">
          <button class="modal-btn modal-btn-cancel" type="button">${this.escapeHtml(cancelText || this.tt('btn.cancel', 'İptal'))}</button>
          <button class="modal-btn modal-btn-confirm" type="button">${this.escapeHtml(confirmText || this.tt('ytlive.lists.delete', 'Sil'))}</button>
        </div>
      `;

      const cancelBtn = modal.querySelector('.modal-btn-cancel');
      const confirmBtn = modal.querySelector('.modal-btn-confirm');

      const cleanup = () => {
        modal.remove();
        if (backdrop.children.length === 0) {
          backdrop.style.display = 'none';
          backdrop.classList.remove('is-open');
        }
        document.removeEventListener('keydown', keyHandler);
        backdrop.removeEventListener('click', backdropHandler);
      };

      const finish = (value) => {
        cleanup();
        resolve(value);
      };

      const cancelHandler = () => finish(false);
      const confirmHandler = () => finish(true);
      const keyHandler = (event) => {
        if (event.key === 'Escape') cancelHandler();
      };
      const backdropHandler = (event) => {
        if (event.target === backdrop) cancelHandler();
      };

      cancelBtn?.addEventListener('click', cancelHandler);
      confirmBtn?.addEventListener('click', confirmHandler);
      document.addEventListener('keydown', keyHandler);
      backdrop.addEventListener('click', backdropHandler);

      backdrop.style.display = 'flex';
      backdrop.classList.add('is-open');
      backdrop.appendChild(modal);

      requestAnimationFrame(() => {
        cancelBtn?.focus?.();
      });
    });
  }

  async createDownloadListWithItem(rawItem) {
    const fallback = this.suggestDownloadListName(rawItem);
    const name = await this.showDownloadListNameModal(fallback);
    if (!name) return;

    try {
      const items = await this.expandItemForDownloadList(rawItem);
      await this.saveDownloadListsRequest('/api/ytlive/download-lists', {
        method: 'POST',
        body: JSON.stringify({ name, items })
      });
      this.notify(this.tt('ytlive.lists.created', 'Liste oluşturuldu.'), 'success');
    } catch (error) {
      this.notify(error.message || this.tt('ytlive.lists.saveFailed', 'İndirme listesi kaydedilemedi.'), 'error');
    }
  }

  async addItemToDownloadList(rawItem, listId) {
    if (!listId) return;
    try {
      const items = await this.expandItemForDownloadList(rawItem);
      await this.saveDownloadListsRequest(`/api/ytlive/download-lists/${encodeURIComponent(listId)}/items`, {
        method: 'POST',
        body: JSON.stringify({ items })
      });
      this.notify(this.tt('ytlive.lists.added', '{count} içerik listeye eklendi.', { count: items.length }), 'success');
    } catch (error) {
      this.notify(error.message || this.tt('ytlive.lists.saveFailed', 'İndirme listesi kaydedilemedi.'), 'error');
    }
  }

  async deleteDownloadList(listId) {
    const list = this.downloadLists.find((entry) => entry.id === listId);
    if (!list) return;
    const ok = await this.showDownloadListConfirmModal({
      title: this.tt('ytlive.lists.deleteTitle', 'Liste silinsin mi?'),
      message: this.tt('ytlive.lists.deleteConfirm', '"{name}" silinsin mi?', { name: list.name || '' }),
      confirmText: this.tt('ytlive.lists.delete', 'Sil'),
      cancelText: this.tt('btn.cancel', 'İptal')
    });
    if (!ok) return;

    try {
      await this.saveDownloadListsRequest(`/api/ytlive/download-lists/${encodeURIComponent(listId)}`, { method: 'DELETE' });
      this.notify(this.tt('ytlive.lists.deleted', 'Liste silindi.'), 'success');
    } catch (error) {
      this.notify(error.message || this.tt('ytlive.lists.deleteFailed', 'Liste silinemedi.'), 'error');
    }
  }

  async removeDownloadListItem(listId, itemKey) {
    if (!listId || !itemKey) return;
    try {
      await this.saveDownloadListsRequest(`/api/ytlive/download-lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemKey)}`, { method: 'DELETE' });
      this.notify(this.tt('ytlive.lists.itemRemoved', 'İçerik listeden çıkarıldı.'), 'success');
    } catch (error) {
      this.notify(error.message || this.tt('ytlive.lists.deleteFailed', 'Liste silinemedi.'), 'error');
    }
  }

  async syncDownloadList(listId) {
    if (!listId) return;
    try {
      this.notify(this.tt('ytlive.lists.syncing', 'Liste senkronize ediliyor...'), 'info');
      const spotifyConcurrency = this.getSpotifyConcurrency();
      const data = await this.saveDownloadListsRequest(`/api/ytlive/download-lists/${encodeURIComponent(listId)}/sync`, {
        method: 'POST',
        body: JSON.stringify({
          market: this.getCurrentRegion(),
          youtubeConcurrency: spotifyConcurrency,
          spotifyConcurrency
        })
      });
      const sync = data?.sync || {};
      this.notify(
        this.tt('ytlive.lists.synced', '{added} yeni içerik eklendi. Toplam {total}.', {
          added: Number(sync.added || 0),
          total: Number(sync.total || 0)
        }),
        'success'
      );
    } catch (error) {
      this.notify(error.message || this.tt('ytlive.lists.syncFailed', 'Liste senkronize edilemedi.'), 'error');
    }
  }

  async expandItemForDownloadList(rawItem) {
    const item = this.normalizeItem(rawItem);
    if (this.isMappedMusicItem(item)) {
      return this.expandMappedMusicItemForDownloadList(item);
    }
    if (!this.isPlaylistLike(item)) {
      return [this.toDownloadListItem(item, 0)];
    }

    this.notify(this.tt('ytlive.lists.expanding', 'Liste içeriği okunuyor...'), 'info');
    const pageSize = 100;
    const maxPages = 200;
    const items = [];
    const seen = new Set();
    let page = 1;
    let total = 0;
    let title = item.title || this.tt('ytlive.youtubePlaylist', 'YouTube Playlist');

    while (page <= maxPages) {
      const response = await fetch('/api/playlist/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: item.webpage_url,
          page,
          pageSize
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data?.error?.message || this.tt('ytlive.playlist.readFailed', 'Playlist okunamadı.'));
      }

      const rawEntries = Array.isArray(data.items) ? data.items : [];
      title = data?.playlist?.title || title;
      total = Number(data?.playlist?.count || total || 0);

      rawEntries
        .map((entry, idx) => this.normalizePlaylistEntry(entry, ((page - 1) * pageSize) + idx))
        .forEach((entry) => {
          const normalized = this.toDownloadListItem(entry, items.length, {
            sourceTitle: title,
            sourceUrl: item.webpage_url
          });
          if (!normalized.webpage_url && !normalized.id) return;
          const key = this.getDownloadListItemKey(normalized);
          if (seen.has(key)) return;
          seen.add(key);
          items.push(normalized);
        });

      if (!rawEntries.length || rawEntries.length < pageSize || (total && items.length >= total)) {
        break;
      }
      page += 1;
    }

    if (!items.length) {
      throw new Error(this.tt('ytlive.playlist.noItems', 'Playlist içinde eklenebilir parça bulunamadı.'));
    }

    return items;
  }

  async expandMappedMusicItemForDownloadList(rawItem) {
    const item = this.normalizeItem(rawItem);
    this.notify(this.tt('ytlive.lists.expanding', 'Liste içeriği okunuyor...'), 'info');

    const pageSize = 100;
    const maxPages = 200;
    const items = [];
    const seen = new Set();
    let page = 1;
    let total = 0;
    let title = item.title || this.getMappedMusicFallbackTitle(item.sourceProvider, item.type);

    while (page <= maxPages) {
      const data = await this.fetchMappedMusicMetadata(item.webpage_url, {
        page,
        pageSize
      });
      const rawEntries = Array.isArray(data.items) ? data.items : [];
      title = data?.playlist?.title || title;
      total = Number(data?.playlist?.count || total || 0);

      rawEntries
        .map((entry, idx) => this.normalizePlaylistEntry(entry, ((page - 1) * pageSize) + idx))
        .forEach((entry) => {
          const normalized = this.toDownloadListItem(entry, items.length, {
            sourceTitle: title,
            sourceUrl: item.webpage_url,
            sourceProvider: item.sourceProvider
          });
          if (!normalized.webpage_url && !normalized.sourceItemUrl) return;
          const key = this.getDownloadListItemKey(normalized);
          if (seen.has(key)) return;
          seen.add(key);
          items.push(normalized);
        });

      if (!rawEntries.length || rawEntries.length < pageSize || (total && items.length >= total)) {
        break;
      }
      page += 1;
    }

    if (!items.length) {
      throw new Error(this.tt('ytlive.playlist.noItems', 'Playlist içinde eklenebilir parça bulunamadı.'));
    }

    return items;
  }

  toDownloadListItem(rawItem, index = 0, extras = {}) {
    const item = this.normalizeItem(rawItem);
    const itemUrl = item.webpage_url || item.url || '';
    const sourceProvider = extras.sourceProvider || item.sourceProvider || this.getMappedMusicSource(itemUrl) || null;
    const sourceItemUrl = extras.sourceItemUrl || item.sourceItemUrl || (this.getMappedMusicSource(itemUrl) ? itemUrl : null);
    const sourceItemId = extras.sourceItemId || item.sourceItemId || item.providerId || null;
    const videoId = sourceProvider ? null : this.getVideoId(itemUrl);
    return {
      type: 'track',
      index: Number(item.index || index + 1) || index + 1,
      id: sourceProvider ? null : (item.id || videoId || null),
      title: item.title || this.tt('ytlive.youtubeContent', 'YouTube içeriği'),
      uploader: item.uploader || item.artist || item.channel || '',
      duration: Number.isFinite(Number(item.duration)) ? Number(item.duration) : null,
      duration_ms: Number.isFinite(Number(item.duration_ms)) ? Number(item.duration_ms) : null,
      duration_string: item.duration_string || null,
      thumbnail: item.thumbnail || item.thumbnails?.[0]?.url || null,
      webpage_url: itemUrl,
      url: itemUrl,
      sourceProvider,
      sourceItemId,
      sourceItemUrl,
      album: item.album || null,
      sourceTitle: extras.sourceTitle || item.sourceTitle || null,
      sourceUrl: extras.sourceUrl || item.sourceUrl || null
    };
  }

  getDownloadListItemKey(item = {}) {
    return this.normalizeResultKey([
      item.type || 'track',
      item.id || '',
      item.webpage_url || item.url || '',
      item.title || '',
      item.uploader || ''
    ].join('|'));
  }

  suggestDownloadListName(rawItem = {}) {
    const item = this.normalizeItem(rawItem);
    return item.title || this.tt('ytlive.lists.fallbackName', 'İndirme Listesi');
  }

  getSavedListDownloadItems(list = {}) {
    return (Array.isArray(list.items) ? list.items : [])
      .map((item, index) => this.toDownloadListItem(item, index, {
        sourceTitle: item.sourceTitle || list.name,
        sourceUrl: item.sourceUrl || '',
        sourceProvider: item.sourceProvider || null,
        sourceItemId: item.sourceItemId || null,
        sourceItemUrl: item.sourceItemUrl || null
      }))
      .filter((item) => item.webpage_url || item.id);
  }

  getMappedListSourceUrl(items = []) {
    const sourceUrls = (Array.isArray(items) ? items : [])
      .map((item) => item.sourceUrl || '')
      .filter((url) => this.isMappedMusicUrl(url));
    const uniqueSourceUrls = Array.from(new Set(sourceUrls));
    if (uniqueSourceUrls.length === 1) return uniqueSourceUrls[0];

    const itemUrls = (Array.isArray(items) ? items : [])
      .map((item) => item.webpage_url || item.url || '')
      .filter((url) => this.isMappedMusicUrl(url));
    const uniqueItemUrls = Array.from(new Set(itemUrls));
    return uniqueItemUrls.length === 1 ? uniqueItemUrls[0] : '';
  }

  getSavedListPlayableItems(list = {}) {
    return this.getSavedListDownloadItems(list)
      .map((item, index) => this.normalizePlaylistEntry({
        ...item,
        index: index + 1,
        webpage_url: item.webpage_url || item.url || ''
      }, index));
  }

  playSavedList(listId) {
    const list = this.downloadLists.find((entry) => entry.id === listId);
    if (!list) return;

    const downloadItems = this.getSavedListDownloadItems(list);
    const mappedSourceUrl = this.getMappedListSourceUrl(downloadItems);
    if (mappedSourceUrl && downloadItems.every((item) => this.isMappedMusicUrl(item.sourceUrl || item.webpage_url || item.url))) {
      this.playResolvedSavedMappedList(listId, list).catch((error) => {
        this.notify(error.message || this.tt('ytlive.playlist.loadFailed', 'Playlist parçaları yüklenemedi.'), 'error');
      });
      return;
    }

    const tracks = this.getSavedListPlayableItems(list);
    if (!tracks.length) {
      this.notify(this.tt('ytlive.lists.emptyList', 'Bu liste boş.'), 'error');
      return;
    }

    const title = list.name || this.tt('ytlive.lists.fallbackName', 'İndirme Listesi');
    const firstTrack = tracks[0] || {};
    const collectionItem = {
      type: 'playlist',
      id: list.id,
      title,
      uploader: this.tt('ytlive.lists.title', 'İndirme Listelerim'),
      webpage_url: firstTrack.webpage_url || firstTrack.url || '',
      url: firstTrack.webpage_url || firstTrack.url || '',
      downloadListId: list.id
    };

    this.playlistTracks = tracks;
    this.activeCollection = {
      item: collectionItem,
      key: `download-list:${list.id}`,
      title,
      total: tracks.length,
      tracks: tracks.slice(),
      currentIndex: -1,
      loading: false
    };
    this.currentItem = collectionItem;
    this.currentPlaybackItem = collectionItem;
    this.renderPlaylistTracks({ title, total: tracks.length });
    this.updateNowPanelForCollection();
    this.playPlaylistTrackAt(0, { silent: false, autoplay: true });
  }

  async resolveSavedMappedList(listId) {
    const spotifyConcurrency = this.getSpotifyConcurrency();
    const response = await fetch(`/api/ytlive/download-lists/${encodeURIComponent(listId)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        market: this.getCurrentRegion(),
        youtubeConcurrency: spotifyConcurrency,
        spotifyConcurrency
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data?.error?.message || this.tt('ytlive.playlist.loadFailed', 'Playlist parçaları yüklenemedi.'));
    }
    return data;
  }

  async startSavedMappedListResolveTask(listId, list = {}) {
    const spotifyConcurrency = this.getSpotifyConcurrency();
    const response = await fetch(`/api/ytlive/download-lists/${encodeURIComponent(listId)}/resolve/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        market: this.getCurrentRegion(),
        youtubeConcurrency: spotifyConcurrency,
        spotifyConcurrency
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data?.error?.message || this.tt('ytlive.playlist.loadFailed', 'Playlist parçaları yüklenemedi.'));
    }
    return {
      mapId: data.mapId,
      title: data.title || list.name || this.tt('ytlive.lists.fallbackName', 'İndirme Listesi'),
      total: Number(data.total || 0),
      source: data.source || ''
    };
  }

  async playResolvedSavedMappedList(listId, list = {}) {
    this.notify(this.tt('ytlive.musicUrl.matching', 'Link eşleştiriliyor...'), 'info');
    const task = await this.startSavedMappedListResolveTask(listId, list);
    const items = this.getSavedListDownloadItems(list);
    const sourceUrl = this.getMappedListSourceUrl(items);
    const sourceProvider = this.getMappedMusicSource(sourceUrl) || task.source || '';
    this.streamMappedMusicCollectionPlayback(task, {
      type: 'playlist',
      id: listId,
      title: task.title || list.name || this.tt('ytlive.lists.fallbackName', 'İndirme Listesi'),
      uploader: this.tt('ytlive.lists.title', 'İndirme Listelerim'),
      sourceProvider,
      webpage_url: sourceUrl,
      url: sourceUrl,
      downloadListId: listId
    }, { autoplayFirst: true, silent: false });
  }

  async downloadSavedList(listId) {
    const list = this.downloadLists.find((entry) => entry.id === listId);
    if (!list) return;
    const items = this.getSavedListDownloadItems(list);

    if (!items.length) {
      this.notify(this.tt('ytlive.lists.emptyList', 'Bu liste boş.'), 'error');
      return;
    }

    const mappedSourceUrl = this.getMappedListSourceUrl(items);
    if (mappedSourceUrl && items.every((item) => this.isMappedMusicUrl(item.sourceUrl || item.webpage_url || item.url))) {
      try {
        this.notify(this.tt('ytlive.musicUrl.matching', 'Link eşleştiriliyor...'), 'info');
        const data = await this.resolveSavedMappedList(listId);
        const resolvedItems = (Array.isArray(data.items) ? data.items : [])
          .map((item, index) => ({
            ...item,
            index: index + 1,
            webpage_url: item.webpage_url || item.url || ''
          }))
          .filter((item) => item.id && item.webpage_url);

        if (!resolvedItems.length) {
          this.notify(this.tt('ytlive.lists.emptyList', 'Bu liste boş.'), 'error');
          return;
        }

        await this.submitJob({
          ...this.getOutputPayload(),
          url: resolvedItems[0].webpage_url,
          isPlaylist: true,
          plTitle: list.name || this.tt('ytlive.lists.fallbackName', 'İndirme Listesi'),
          selectedIndices: resolvedItems.map((entry) => entry.index),
          selectedIds: resolvedItems.map((entry) => entry.id),
          frozenEntries: resolvedItems
        });
      } catch (error) {
        this.notify(error.message || this.tt('ytlive.job.addFailed', 'İş eklenemedi.'), 'error');
      }
      return;
    }

    const selectedIds = items
      .map((item) => item.id || this.getVideoId(item.webpage_url) || item.webpage_url)
      .filter(Boolean);
    if (!selectedIds.length) {
      this.notify(this.tt('ytlive.add.noUrl', 'Eklenebilir bir link bulunamadı.'), 'error');
      return;
    }

    const frozenEntries = items.map((item, index) => ({
      ...item,
      index: index + 1,
      webpage_url: item.webpage_url || item.url || ''
    }));
    const isDownloadSource = (value) => /(?:youtube\.com|youtu\.be|music\.youtube\.com|dailymotion\.com|dai\.ly)/i.test(String(value || ''));
    const sourceUrl =
      items.find((item) => isDownloadSource(item.sourceUrl))?.sourceUrl ||
      items.find((item) => isDownloadSource(item.webpage_url || item.url))?.webpage_url ||
      items[0].webpage_url ||
      items[0].url;

    try {
      await this.submitJob({
        ...this.getOutputPayload(),
        url: sourceUrl,
        isPlaylist: true,
        plTitle: list.name || this.tt('ytlive.lists.fallbackName', 'İndirme Listesi'),
        selectedIndices: frozenEntries.map((entry) => entry.index),
        selectedIds,
        frozenEntries
      });
    } catch (error) {
      this.notify(error.message || this.tt('ytlive.job.addFailed', 'İş eklenemedi.'), 'error');
    }
  }

  buildSinglePayload(item) {
    return {
      ...this.getOutputPayload(),
      url: item.webpage_url,
      isPlaylist: false,
      title: item.title || '',
      uploader: item.uploader || ''
    };
  }

  buildCollectionPayload(item) {
    return {
      ...this.getOutputPayload(),
      url: item.webpage_url,
      isPlaylist: true,
      plTitle: item.title || this.tt('ytlive.youtubePlaylist', 'YouTube Playlist')
    };
  }

  buildMappedMusicPayload(item) {
    const output = this.getOutputPayload();
    return {
      ...output,
      url: item.webpage_url || item.url || '',
      market: this.getCurrentRegion(),
      spotifyConcurrency: output.spotifyConcurrency,
      autoCreateZip: output.autoCreateZip
    };
  }

  getOutputPayload() {
    const format = this.getSelectedFormat();
    const isVideo = this.isVideoFormat(format);
    const spotifyConcurrency = this.getSpotifyConcurrency();
    return {
      format,
      bitrate: document.getElementById('bitrateSelect')?.value || 'auto',
      sampleRate: Number(document.getElementById('sampleRateSelect')?.value || 48000),
      includeLyrics: !isVideo && !!document.getElementById('includeLyrics')?.checked,
      embedLyrics: !isVideo && !!document.getElementById('embedLyrics')?.checked,
      autoCreateZip: !isVideo && !!document.getElementById('autoZip')?.checked,
      volumeGain: Math.max(1, Math.min(5, Number(document.getElementById('volumeGainRange')?.value || 1))),
      loudnorm: !!document.getElementById('loudnormCheckbox')?.checked,
      loudnormMode: this.normalizeLoudnormMode(document.getElementById('loudnormModeSelect')?.value),
      youtubeConcurrency: spotifyConcurrency,
      spotifyConcurrency
    };
  }

  async submitJob(payload) {
    const submittedPayload = this.clonePayload(payload);
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data?.error?.message || this.tt('ytlive.job.createFailed', 'İş oluşturulamadı.'));
    }

    this.notify(this.tt('ytlive.job.queued', 'İş kuyruğa eklendi.'), 'success');
    this.persistClassicJobSession(data, submittedPayload);
    this.trackJob(data.id);
    await this.refreshQueueStatus();
    return data;
  }

  trackJob(jobId) {
    if (!jobId || this.jobStreams.has(jobId)) return;

    const stream = new EventSource(`/api/stream/${encodeURIComponent(jobId)}`);
    this.jobStreams.set(jobId, stream);

    stream.onmessage = (event) => {
      try {
        const incoming = JSON.parse(event.data);
        const id = incoming.id || jobId;
        const job = this.mergeJobState(this.jobs.get(id), incoming);
        this.jobs.set(id, job);
        this.persistClassicJobSession(job);
        this.renderJobs();

        if (this.isTerminalJob(job)) {
          stream.close();
          this.jobStreams.delete(jobId);
          this.refreshQueueStatus();
        }
      } catch (error) {
        console.warn('Job stream parse failed:', error);
      }
    };

    stream.onerror = () => {
      stream.close();
      this.jobStreams.delete(jobId);
      this.refreshQueueStatus();
    };
  }

  async fetchQueueStatus() {
    try {
      const response = await fetch('/api/queue/status', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.warn('Queue status failed:', error);
      return { ok: false, activeCount: 0, activeJobs: [] };
    }
  }

  getJobsPanelToken() {
    try {
      return localStorage.getItem(this.jobsPanelTokenKey) || '';
    } catch {
      return '';
    }
  }

  async fetchJobsPanelSnapshot() {
    const token = this.getJobsPanelToken();
    if (!token) return null;

    try {
      const response = await fetch('/api/jobs?status=all', {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.status === 401 || response.status === 403) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json().catch(() => ({}));
      return Array.isArray(data.items) ? data.items : [];
    } catch (error) {
      console.warn('Jobs panel snapshot failed:', error);
      return null;
    }
  }

  async refreshQueueStatus(showToast = false) {
    const jobsPanelItems = await this.fetchJobsPanelSnapshot();
    if (jobsPanelItems) {
      this.applyJobsPanelSnapshot(jobsPanelItems);
      if (showToast) this.notify(this.tt('ytlive.queue.updated', 'Kuyruk güncellendi.'), 'success');
      return;
    }

    const status = await this.fetchQueueStatus();
    const activeJobs = Array.isArray(status.activeJobs) ? status.activeJobs : [];

    activeJobs.forEach((job) => {
      if (!job?.id) return;
      this.jobs.set(job.id, this.mergeJobState(this.jobs.get(job.id), job));
      if (!this.isTerminalJob(job)) this.trackJob(job.id);
    });

    for (const [id, job] of this.jobs.entries()) {
      if (this.isTerminalJob(job)) continue;
      if (!activeJobs.some((active) => active.id === id) && !this.jobStreams.has(id)) {
        this.jobs.delete(id);
      }
    }

    this.renderQueueChip(status.activeCount || 0);
    this.renderJobs();
    if (showToast) this.notify(this.tt('ytlive.queue.updated', 'Kuyruk güncellendi.'), 'success');
  }

  applyJobsPanelSnapshot(items = []) {
    const serverJobs = Array.isArray(items) ? items.filter((job) => job?.id) : [];
    const seen = new Set();

    serverJobs.forEach((incoming) => {
      const id = incoming.id;
      seen.add(id);
      const job = this.mergeJobState(this.jobs.get(id), incoming);
      this.jobs.set(id, job);
      this.persistClassicJobSession(job);
      if (!this.isTerminalJob(job)) this.trackJob(id);
    });

    for (const [id, job] of this.jobs.entries()) {
      if (seen.has(id) || this.jobStreams.has(id) || this.isTerminalJob(job)) continue;
      this.jobs.delete(id);
    }

    this.renderQueueChip(this.getActiveJobCount());
    this.renderJobs();
  }

  mergeJobState(prev = {}, next = {}) {
    const merged = { ...(prev || {}), ...(next || {}) };
    merged.metadata = { ...(prev?.metadata || {}), ...(next?.metadata || {}) };
    merged.playlist = { ...(prev?.playlist || {}), ...(next?.playlist || {}) };
    merged.counters = { ...(prev?.counters || {}), ...(next?.counters || {}) };
    if (next?.resultPath === undefined) merged.resultPath = prev?.resultPath;
    if (next?.zipPath === undefined) merged.zipPath = prev?.zipPath;
    if (next?.error === undefined) merged.error = prev?.error;
    return merged;
  }

  persistClassicJobSession(job = {}, payload = {}) {
    const id = job?.id;
    if (!id) return;

    try {
      const raw = localStorage.getItem(this.classicJobSessionKey);
      const session = raw ? JSON.parse(raw) : {};
      const jobs = Array.isArray(session.jobs) ? session.jobs.slice() : [];
      const index = jobs.findIndex((item) => item?.id === id);
      const previous = index >= 0 ? jobs[index] : {};
      const sessionJob = this.buildClassicSessionJob(job, payload, previous);
      const mergedJob = this.mergeJobState(previous, sessionJob);

      if (index >= 0) {
        jobs[index] = mergedJob;
      } else {
        jobs.unshift(mergedJob);
      }

      const batches = Array.isArray(session.batches) ? session.batches.slice() : [];
      const jobToBatch = session.jobToBatch && typeof session.jobToBatch === 'object'
        ? { ...session.jobToBatch }
        : {};

      if (job?.clientBatch) {
        const batchId = job.clientBatch;
        jobToBatch[id] = batchId;
        const batchIndex = batches.findIndex((batch) => batch?.id === batchId);
        const batchMeta = {
          format: sessionJob.format,
          bitrate: sessionJob.bitrate,
          source: sessionJob.metadata?.mediaPlatform || sessionJob.metadata?.source || 'youtube'
        };
        if (batchIndex >= 0) {
          const batch = batches[batchIndex] || {};
          const batchJobs = Array.isArray(batch.jobs) ? batch.jobs.slice() : [];
          if (!batchJobs.includes(id)) batchJobs.push(id);
          batches[batchIndex] = {
            ...batch,
            total: Number(job.batchTotal || batch.total || batchJobs.length || 1),
            meta: { ...(batch.meta || {}), ...batchMeta },
            jobs: batchJobs
          };
        } else {
          batches.push({
            id: batchId,
            total: Number(job.batchTotal || 1),
            meta: batchMeta,
            jobs: [id]
          });
        }
      }

      const limitedJobs = this.limitClassicSessionJobs(jobs);
      const validIds = new Set(limitedJobs.map((item) => item.id));
      const limitedBatches = batches
        .map((batch) => ({
          ...batch,
          jobs: (Array.isArray(batch.jobs) ? batch.jobs : []).filter((jobId) => validIds.has(jobId))
        }))
        .filter((batch) => batch.jobs.length);
      const limitedJobToBatch = {};
      Object.entries(jobToBatch).forEach(([jobId, batchId]) => {
        if (validIds.has(jobId)) limitedJobToBatch[jobId] = batchId;
      });

      localStorage.setItem(this.classicJobSessionKey, JSON.stringify({
        jobs: limitedJobs,
        batches: limitedBatches,
        jobToBatch: limitedJobToBatch,
        savedAt: Date.now(),
        version: 1
      }));
    } catch (error) {
      console.warn('Classic job session bridge failed:', error);
    }
  }

  buildClassicSessionJob(job = {}, payload = {}, previous = {}) {
    const now = Date.now();
    const metadata = this.buildClassicJobMetadata(job, payload, previous?.metadata || {});
    const status = this.normalizeJobStatus(job.status || previous.status || 'queued');
    const phase = this.normalizeJobStatus(job.currentPhase || job.phase || previous.currentPhase || previous.phase || status || 'queued');

    return {
      ...previous,
      ...job,
      id: job.id || previous.id,
      status,
      progress: this.safeProgress(job.progress, previous.progress, status === 'completed' ? 100 : 0),
      downloadProgress: this.safeProgress(job.downloadProgress, previous.downloadProgress, 0),
      convertProgress: this.safeProgress(job.convertProgress, previous.convertProgress, 0),
      currentPhase: phase,
      phase,
      format: job.format || payload.format || previous.format || 'mp3',
      bitrate: job.bitrate || payload.bitrate || previous.bitrate || 'auto',
      sampleRate: Number(job.sampleRate || payload.sampleRate || previous.sampleRate || 48000),
      createdAt: job.createdAt || previous.createdAt || now,
      completedAt: job.completedAt || previous.completedAt || (status === 'completed' ? now : null),
      resultPath: job.resultPath !== undefined ? job.resultPath : (previous.resultPath ?? null),
      zipPath: job.zipPath !== undefined ? job.zipPath : (previous.zipPath ?? null),
      playlist: job.playlist !== undefined ? job.playlist : (previous.playlist ?? null),
      counters: {
        ...(previous.counters || {}),
        ...(job.counters || {}),
        ...(job.metadata?.counters || {})
      },
      metadata
    };
  }

  buildClassicJobMetadata(job = {}, payload = {}, previous = {}) {
    const serverMeta = job.metadata || {};
    const rawUrl =
      payload.url ||
      serverMeta.url ||
      serverMeta.originalUrl ||
      serverMeta.extracted?.webpage_url ||
      previous.url ||
      previous.originalUrl ||
      '';
    const currentTitle = this.currentItem?.title || '';
    const title =
      serverMeta.frozenTitle ||
      payload.plTitle ||
      payload.playlistTitle ||
      payload.title ||
      currentTitle ||
      previous.frozenTitle ||
      serverMeta.extracted?.title ||
      previous.extracted?.title ||
      '';
    const frozenEntries = Array.isArray(payload.frozenEntries)
      ? payload.frozenEntries
      : (Array.isArray(serverMeta.frozenEntries) ? serverMeta.frozenEntries : previous.frozenEntries);
    const isPlaylist = Boolean(
      serverMeta.isPlaylist ||
      job.isPlaylist ||
      payload.isPlaylist ||
      (Array.isArray(frozenEntries) && frozenEntries.length > 1) ||
      this.isPlaylistUrl(rawUrl)
    );
    const mediaPlatform = serverMeta.mediaPlatform || job.mediaPlatform || previous.mediaPlatform || this.detectMediaPlatform(rawUrl);
    const mappedSource = this.getMappedMusicSource(rawUrl);
    const source =
      serverMeta.source ||
      job.source ||
      previous.source ||
      mappedSource ||
      (mediaPlatform === 'youtube' || mediaPlatform === 'dailymotion' ? 'youtube' : (rawUrl ? 'direct_url' : 'youtube'));

    return {
      ...previous,
      ...serverMeta,
      source,
      mediaPlatform,
      url: serverMeta.url || rawUrl || previous.url || '',
      originalUrl: serverMeta.originalUrl || rawUrl || previous.originalUrl || '',
      isPlaylist,
      isAutomix: Boolean(serverMeta.isAutomix || job.isAutomix || previous.isAutomix),
      frozenTitle: title || null,
      extracted: serverMeta.extracted || previous.extracted || {
        title: title || null,
        uploader: payload.uploader || previous.extracted?.uploader || null,
        webpage_url: rawUrl || null
      },
      originalName: serverMeta.originalName || previous.originalName || title || null,
      selectedIndices: payload.selectedIndices ?? serverMeta.selectedIndices ?? job.selectedIndices ?? previous.selectedIndices ?? (isPlaylist ? 'all' : null),
      selectedIds: payload.selectedIds ?? serverMeta.selectedIds ?? job.selectedIds ?? previous.selectedIds ?? null,
      frozenEntries: Array.isArray(frozenEntries) ? frozenEntries : null,
      includeLyrics: Boolean(payload.includeLyrics ?? serverMeta.includeLyrics ?? previous.includeLyrics),
      embedLyrics: Boolean(payload.embedLyrics ?? serverMeta.embedLyrics ?? previous.embedLyrics),
      autoCreateZip: Boolean(payload.autoCreateZip ?? serverMeta.autoCreateZip ?? previous.autoCreateZip),
      volumeGain: Number(payload.volumeGain ?? serverMeta.volumeGain ?? previous.volumeGain ?? 1),
      loudnorm: Boolean(payload.loudnorm ?? serverMeta.loudnorm ?? previous.loudnorm),
      loudnormMode: this.normalizeLoudnormMode(payload.loudnormMode ?? serverMeta.loudnormMode ?? previous.loudnormMode)
    };
  }

  limitClassicSessionJobs(jobs = []) {
    const byId = new Map();
    jobs.forEach((job) => {
      if (!job?.id) return;
      byId.set(job.id, this.mergeJobState(byId.get(job.id), job));
    });

    const persistable = Array.from(byId.values())
      .filter((job) => !['error', 'canceled'].includes(this.normalizeJobStatus(job.status)));
    const active = persistable.filter((job) => this.normalizeJobStatus(job.status) !== 'completed');
    const completed = persistable
      .filter((job) => this.normalizeJobStatus(job.status) === 'completed')
      .sort((a, b) => Number(b.completedAt || 0) - Number(a.completedAt || 0))
      .slice(0, 15);

    return [...active, ...completed];
  }

  normalizeJobStatus(status) {
    const value = String(status || '').toLowerCase();
    return value === 'cancelled' ? 'canceled' : value;
  }

  safeProgress(...values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number)) return Math.max(0, Math.min(100, Math.round(number)));
    }
    return 0;
  }

  clonePayload(payload = {}) {
    try {
      return JSON.parse(JSON.stringify(payload || {}));
    } catch {
      return { ...(payload || {}) };
    }
  }

  detectMediaPlatform(rawUrl = '') {
    const url = String(rawUrl || '');
    const mappedSource = this.getMappedMusicSource(url);
    if (mappedSource) return mappedSource;
    if (/dailymotion\.com|dai\.ly/i.test(url)) return 'dailymotion';
    if (this.isYouTubeUrl(url)) return 'youtube';
    return null;
  }

  scheduleQueuePoll() {
    clearInterval(this.queuePollTimer);
    this.queuePollTimer = setInterval(() => this.refreshQueueStatus(), 5000);
  }

  renderQueueChip(activeCount) {
    const chip = document.getElementById('queueChip');
    if (!chip) return;
    chip.textContent = activeCount > 0
      ? this.tt('ytlive.queue.activeCount', '{count} aktif iş', { count: activeCount })
      : this.tt('ytlive.queue.empty', 'Kuyruk boş');
    chip.classList.toggle('is-busy', activeCount > 0);
  }

  renderJobs() {
    const list = document.getElementById('jobList');
    if (!list) return;

    const jobs = Array.from(this.jobs.values())
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    if (!jobs.length) {
      list.innerHTML = `<div class="empty-state">${this.escapeHtml(this.tt('ytlive.jobs.empty', 'Aktif iş yok.'))}</div>`;
      return;
    }

    list.innerHTML = jobs.map((job) => {
      const title = this.escapeHtml(this.getJobTitle(job));
      const status = this.escapeHtml(this.getJobStatusLabel(job));
      const progress = this.getJobProgress(job);
      const links = this.getJobLinks(job);

      return `
        <article class="job-card">
          <div class="job-card__top">
            <h3>${title}</h3>
            <span>${status}</span>
          </div>
          <div class="progress-bar" aria-label="İlerleme">
            <span style="width:${progress}%"></span>
          </div>
          <div class="job-card__meta">${progress}%</div>
          ${links}
        </article>
      `;
    }).join('');
  }

  getJobLinks(job) {
    if (job?.zipPath) {
      return `<a class="job-link" href="${this.escapeHtml(this.toRelative(job.zipPath))}" download>${this.escapeHtml(this.tt('ytlive.download.zip', 'ZIP indir'))}</a>`;
    }

    if (typeof job?.resultPath === 'string') {
      return `<a class="job-link" href="${this.escapeHtml(this.toRelative(job.resultPath))}" download>${this.escapeHtml(this.tt('ytlive.download.file', 'Dosyayı indir'))}</a>`;
    }

    if (Array.isArray(job?.resultPath) && job.resultPath.length) {
      const first = job.resultPath[0];
      const href = typeof first === 'string' ? first : (first.outputPath || first.path || '');
      if (href) {
        return `<a class="job-link" href="${this.escapeHtml(this.toRelative(href))}" download>${this.escapeHtml(this.tt('ytlive.download.firstFile', 'İlk dosyayı indir'))}</a>`;
      }
    }

    return '';
  }

  getJobProgress(job) {
    const status = String(job?.status || '').toLowerCase();
    if (status === 'completed') return 100;
    const progress = Number(job?.progress);
    if (Number.isFinite(progress)) return Math.max(0, Math.min(100, Math.round(progress)));
    const dl = Number(job?.downloadProgress || 0);
    const cv = Number(job?.convertProgress || 0);
    return Math.max(0, Math.min(100, Math.round((dl + cv) / 2)));
  }

  getJobTitle(job) {
    return (
      job?.metadata?.frozenTitle ||
      job?.metadata?.extracted?.title ||
      job?.metadata?.spotifyTitle ||
      job?.metadata?.originalName ||
      job?.title ||
      job?.id ||
      this.tt('ytlive.job.fallbackTitle', 'İş')
    );
  }

  getJobStatusLabel(job) {
    const phase = String(job?.currentPhase || job?.phase || job?.status || 'queued').toLowerCase();
    const labels = {
      queued: this.tt('ytlive.phase.queued', 'Sırada'),
      preparing: this.tt('ytlive.phase.preparing', 'Hazırlanıyor'),
      processing: this.tt('ytlive.phase.processing', 'İşleniyor'),
      downloading: this.tt('ytlive.phase.downloading', 'İndiriliyor'),
      converting: this.tt('ytlive.phase.converting', 'Dönüştürülüyor'),
      completed: this.tt('ytlive.phase.completed', 'Tamamlandı'),
      error: this.tt('ytlive.phase.error', 'Hata'),
      canceled: this.tt('ytlive.phase.canceled', 'İptal')
    };
    return labels[phase] || phase;
  }

  renderThumbnailImage(source = {}, options = {}) {
    const info = this.getThumbnailRenderInfo(source);
    if (!info.url) return '';

    const classes = ['ytlive-thumb-img', options.className].filter(Boolean).join(' ');
    const srcset = info.srcset ? ` srcset="${this.escapeHtml(info.srcset)}"` : '';
    const sizes = options.sizes ? ` sizes="${this.escapeHtml(options.sizes)}"` : '';
    const fallback = info.fallback && info.fallback !== info.url
      ? ` data-fallback-src="${this.escapeHtml(info.fallback)}"`
      : '';
    const loading = options.loading === 'eager' ? 'eager' : 'lazy';
    const priority = options.priority ? ' fetchpriority="high"' : '';

    return `<img class="${this.escapeHtml(classes)}" src="${this.escapeHtml(info.url)}"${srcset}${sizes}${fallback} alt="" loading="${loading}" decoding="async" draggable="false"${priority}>`;
  }

  getThumbnailRenderInfo(source = {}) {
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      const url = this.normalizeThumbnailUrl(source.thumbnail);
      if (url) {
        return {
          url,
          fallback: this.normalizeThumbnailUrl(source.thumbnailFallback) || url,
          srcset: source.thumbnailSrcset || this.buildThumbnailSrcset(url)
        };
      }
    }
    return this.resolveThumbnailInfo(source);
  }

  resolveThumbnailInfo(source = {}) {
    const fallback = this.pickThumbnailUrl(source);
    if (!fallback) return { url: null, fallback: null, srcset: '' };

    const variants = this.getThumbnailVariants(fallback);
    return {
      url: variants[0]?.url || fallback,
      fallback,
      srcset: this.buildThumbnailSrcset(variants)
    };
  }

  pickThumbnailUrl(source = {}) {
    if (typeof source === 'string') return this.normalizeThumbnailUrl(source);

    const candidates = [];
    const addCandidate = (value) => {
      if (!value) return;
      if (typeof value === 'string') {
        const url = this.normalizeThumbnailUrl(value);
        if (!url) return;
        const dimensions = this.getThumbnailDimensionsFromUrl(url);
        candidates.push({
          url,
          width: dimensions.width,
          height: dimensions.height,
          order: candidates.length
        });
        return;
      }
      if (typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach((entry) => addCandidate(entry));
        return;
      }
      if (Array.isArray(value.thumbnails)) {
        addCandidate(value.thumbnails);
      }
      const url = this.normalizeThumbnailUrl(value.url || value.src);
      if (!url) return;
      const dimensions = this.getThumbnailDimensionsFromUrl(url);
      candidates.push({
        url,
        width: Number(value.width || value.w || dimensions.width || 0),
        height: Number(value.height || value.h || dimensions.height || 0),
        order: candidates.length
      });
    };

    addCandidate(source.thumbnails);
    addCandidate(source.thumbnail);
    addCandidate(source.coverUrl);
    addCandidate(source.thumbnailUrl);
    addCandidate(source.imageUrl);
    addCandidate(source.sourceCoverUrl);

    const unique = [];
    const seen = new Set();
    candidates.forEach((candidate) => {
      if (!candidate.url || seen.has(candidate.url)) return;
      seen.add(candidate.url);
      unique.push(candidate);
    });

    unique.sort((a, b) => {
      const areaA = Number(a.width || 0) * Number(a.height || 0);
      const areaB = Number(b.width || 0) * Number(b.height || 0);
      return (areaB - areaA) || (b.order - a.order);
    });

    return unique[0]?.url || null;
  }

  getThumbnailVariants(rawUrl = '') {
    const source = this.normalizeThumbnailUrl(rawUrl);
    if (!source) return [];

    const variants = [];
    const addVariant = (url, width = 0) => {
      const normalized = this.normalizeThumbnailUrl(url);
      if (!normalized || variants.some((item) => item.url === normalized)) return;
      const dimensions = this.getThumbnailDimensionsFromUrl(normalized);
      variants.push({
        url: normalized,
        width: Number(width || dimensions.width || 0) || 320
      });
    };

    const yt = this.getYouTubeThumbnailParts(source);
    if (yt) {
      const ext = yt.ext === 'webp' ? 'webp' : 'jpg';
      const base = `${yt.origin}/${yt.kind}/${encodeURIComponent(yt.videoId)}`;
      addVariant(`${base}/maxresdefault.${ext}`, 1280);
      addVariant(`${base}/sddefault.${ext}`, 640);
      addVariant(`${base}/hqdefault.${ext}`, 480);
      addVariant(source);
      return variants;
    }

    if (this.isGoogleImageHost(source)) {
      addVariant(this.withGoogleImageSize(source, 1200), 1200);
      addVariant(this.withGoogleImageSize(source, 800), 800);
      addVariant(source);
      return variants;
    }

    addVariant(source);
    return variants;
  }

  buildThumbnailSrcset(input = '') {
    const variants = Array.isArray(input) ? input : this.getThumbnailVariants(input);
    const seenWidths = new Set();
    return variants
      .map((variant) => ({
        url: this.normalizeThumbnailUrl(variant?.url),
        width: Math.max(1, Math.round(Number(variant?.width || 0) || 320))
      }))
      .filter((variant) => {
        if (!variant.url || seenWidths.has(variant.width)) return false;
        seenWidths.add(variant.width);
        return true;
      })
      .map((variant) => `${variant.url} ${variant.width}w`)
      .join(', ');
  }

  normalizeThumbnailUrl(url = '') {
    const source = String(url || '').trim();
    if (!source) return '';
    if (source.startsWith('//')) return `https:${source}`;
    try {
      const parsed = new URL(source);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    } catch {}
    return source;
  }

  getYouTubeThumbnailParts(rawUrl = '') {
    try {
      const url = new URL(rawUrl, window.location.origin);
      const host = url.hostname.toLowerCase();
      if (!/(^|\.)ytimg\.com$/.test(host) && host !== 'img.youtube.com') return null;
      const parts = url.pathname.split('/').filter(Boolean);
      const kindIndex = parts.findIndex((part) => part === 'vi' || part === 'vi_webp');
      if (kindIndex < 0 || !parts[kindIndex + 1]) return null;
      const file = parts[kindIndex + 2] || '';
      const ext = (file.split('.').pop() || '').toLowerCase();
      return {
        origin: url.origin,
        kind: parts[kindIndex],
        videoId: parts[kindIndex + 1],
        ext
      };
    } catch {
      return null;
    }
  }

  isGoogleImageHost(rawUrl = '') {
    try {
      const host = new URL(rawUrl, window.location.origin).hostname.toLowerCase();
      return isHostOrSubdomain(host, 'googleusercontent.com') || isHostOrSubdomain(host, 'ggpht.com');
    } catch {
      return false;
    }
  }

  withGoogleImageSize(rawUrl = '', size = 800) {
    const source = this.normalizeThumbnailUrl(rawUrl);
    const safeSize = Math.max(120, Math.min(1600, Math.round(Number(size) || 800)));
    const match = source.match(/^([^?#]*)([?#].*)?$/);
    if (!match) return source;

    let path = match[1];
    const suffix = match[2] || '';
    const eqIndex = path.lastIndexOf('=');
    const imageParams = eqIndex >= 0 ? path.slice(eqIndex + 1) : '';
    const parts = imageParams.split('-').filter(Boolean);
    const hasWidthHeight = /^w\d+$/i.test(parts[0] || '') && /^h\d+$/i.test(parts[1] || '');
    const hasSquare = /^s\d+$/i.test(parts[0] || '');
    if (eqIndex >= 0 && hasWidthHeight) {
      path = `${path.slice(0, eqIndex)}=w${safeSize}-h${safeSize}-l90-rj`;
    } else if (eqIndex >= 0 && hasSquare) {
      const tail = parts.slice(1).map((part) => part.replace(/[^A-Za-z0-9_]/g, '')).filter(Boolean);
      path = `${path.slice(0, eqIndex)}=s${safeSize}${tail.length ? `-${tail.join('-')}` : ''}`;
    } else {
      path = `${path}=w${safeSize}-h${safeSize}-l90-rj`;
    }
    return `${path}${suffix}`;
  }

  getThumbnailDimensionsFromUrl(rawUrl = '') {
    const source = String(rawUrl || '');
    const widthHeight = source.match(/[=/]w(\d+)-h(\d+)/i);
    if (widthHeight) {
      return {
        width: Number(widthHeight[1]) || 0,
        height: Number(widthHeight[2]) || 0
      };
    }

    const square = source.match(/[=/]s(\d+)(?:[-/?#]|$)/i);
    if (square) {
      const size = Number(square[1]) || 0;
      return { width: size, height: size };
    }

    if (/maxresdefault|hq720/i.test(source)) return { width: 1280, height: 720 };
    if (/sddefault/i.test(source)) return { width: 640, height: 480 };
    if (/hqdefault/i.test(source)) return { width: 480, height: 360 };
    if (/mqdefault/i.test(source)) return { width: 320, height: 180 };
    if (/(^|\/)default\./i.test(source)) return { width: 120, height: 90 };
    return { width: 0, height: 0 };
  }

  handleThumbnailError(event) {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('ytlive-thumb-img')) return;

    const fallback = img.dataset.fallbackSrc || '';
    if (fallback && img.dataset.fallbackApplied !== 'true') {
      img.dataset.fallbackApplied = 'true';
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.src = fallback;
      return;
    }

    img.hidden = true;
    img.closest('.card-thumb,.spotlight-art,.music-home-card__thumb,.mini-result__thumb,.playlist-track__thumb')
      ?.classList.add('ytlive-thumb-missing');
  }

  normalizeItem(item = {}) {
    let url = String(item.webpage_url || item.url || '').trim();
    const sourceProvider = item.sourceProvider || this.getMappedMusicSource(url);
    const type = item.type || (sourceProvider ? this.getMappedMusicUrlType(url) : (this.isPlaylistUrl(url) ? 'playlist' : 'track'));
    if (type === 'track' && !sourceProvider) url = this.toSingleTrackUrl(url, item.id);
    const fallbackTitle = sourceProvider
      ? this.getMappedMusicFallbackTitle(sourceProvider, type)
      : (type === 'playlist' ? this.tt('ytlive.youtubePlaylist', 'YouTube Playlist') : this.tt('ytlive.youtubeVideo', 'YouTube Video'));
    const thumbnail = this.resolveThumbnailInfo(item);
    return {
      ...item,
      sourceProvider: sourceProvider || item.sourceProvider || null,
      type,
      title: item.title || fallbackTitle,
      uploader: item.uploader || item.artist || (sourceProvider ? this.getMappedMusicLabel(sourceProvider) : item.uploader),
      thumbnail: thumbnail.url,
      thumbnailFallback: thumbnail.fallback,
      thumbnailSrcset: thumbnail.srcset,
      webpage_url: url,
      url
    };
  }

  normalizePlaylistEntry(entry = {}, offset = 0) {
    entry = entry || {};
    const index = Number(entry.index || entry.playlist_index || (offset + 1));
    const rawUrl = entry.webpage_url || entry.url || entry.sourceItemUrl || '';
    const sourceProvider = entry.sourceProvider || this.getMappedMusicSource(rawUrl) || null;
    const durationMs = Number(entry.duration_ms || 0);
    const duration = Number.isFinite(Number(entry.duration))
      ? Number(entry.duration)
      : (Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs / 1000) : null);
    const thumbnail = this.resolveThumbnailInfo(entry);
    return {
      index,
      id: sourceProvider ? null : (entry.id || null),
      type: 'track',
      title: entry.title || entry.id || '',
      uploader: entry.uploader || entry.artist || entry.channel || '',
      artist: entry.artist || entry.uploader || entry.channel || '',
      album: entry.album || '',
      album_artist: entry.album_artist || entry.albumArtist || '',
      release_year: entry.release_year || (entry.release_date ? String(entry.release_date).slice(0, 4) : ''),
      upload_year: entry.upload_year || (entry.upload_date ? String(entry.upload_date).slice(0, 4) : ''),
      track_number: Number.isFinite(Number(entry.track_number)) && Number(entry.track_number) > 0 ? Number(entry.track_number) : null,
      track_total: Number.isFinite(Number(entry.track_total)) && Number(entry.track_total) > 0 ? Number(entry.track_total) : null,
      disc_number: Number.isFinite(Number(entry.disc_number)) && Number(entry.disc_number) > 0 ? Number(entry.disc_number) : null,
      disc_total: Number.isFinite(Number(entry.disc_total)) && Number(entry.disc_total) > 0 ? Number(entry.disc_total) : null,
      genre: entry.genre || (Array.isArray(entry.categories) ? entry.categories[0] || '' : ''),
      isrc: entry.isrc || '',
      channel_id: entry.channel_id || '',
      view_count: Number.isFinite(Number(entry.view_count)) ? Number(entry.view_count) : null,
      duration,
      duration_ms: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null,
      duration_string: entry.duration_string || null,
      thumbnail: thumbnail.url,
      thumbnailFallback: thumbnail.fallback,
      thumbnailSrcset: thumbnail.srcset,
      sourceProvider,
      sourceUrl: entry.sourceUrl || null,
      sourceItemId: entry.sourceItemId || entry.providerId || null,
      sourceItemUrl: entry.sourceItemUrl || (sourceProvider ? rawUrl : null),
      webpage_url: sourceProvider ? rawUrl : this.normalizePlayableUrl(rawUrl, entry.id),
      url: sourceProvider ? rawUrl : this.normalizePlayableUrl(rawUrl, entry.id)
    };
  }

  itemFromUrl(rawUrl) {
    const url = this.normalizePlayableUrl(rawUrl);
    const sourceProvider = this.getMappedMusicSource(url);
    if (sourceProvider) {
      const type = this.getMappedMusicUrlType(url);
      return {
        type,
        id: this.getMappedMusicEntityId(url) || null,
        title: this.getMappedMusicFallbackTitle(sourceProvider, type),
        uploader: this.getMappedMusicLabel(sourceProvider),
        sourceProvider,
        webpage_url: url,
        url
      };
    }

    if (!url || !this.isYouTubeUrl(url)) return null;
    const playlistId = this.getPlaylistId(url);
    const videoId = this.getVideoId(url);
    const albumId = this.getAlbumBrowseId(url);
    const type = albumId ? 'album' : (playlistId && !videoId ? 'playlist' : (playlistId ? 'playlist' : 'track'));
    return {
      type,
      id: videoId || playlistId || albumId || null,
      title: type === 'album'
        ? this.tt('ytlive.type.album', 'Albüm')
        : (type === 'playlist' ? this.tt('ytlive.youtubePlaylist', 'YouTube Playlist') : this.tt('ytlive.youtubeVideo', 'YouTube Video')),
      uploader: 'YouTube',
      webpage_url: url,
      url
    };
  }

  async fetchMappedMusicPreview(rawUrl, { page = 1, pageSize = 25, match = true } = {}) {
    const response = await fetch('/api/playlist/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: rawUrl,
        page,
        pageSize,
        match,
        youtubeConcurrency: this.getSpotifyConcurrency(),
        spotifyConcurrency: this.getSpotifyConcurrency(),
        market: this.getCurrentRegion()
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data?.error?.message || this.tt('ytlive.playlist.readFailed', 'Playlist okunamadı.'));
    }
    return data;
  }

  fetchMappedMusicMetadata(rawUrl, { page = 1, pageSize = 25 } = {}) {
    return this.fetchMappedMusicPreview(rawUrl, {
      page,
      pageSize,
      match: false
    });
  }

  getMappedMusicPlaybackType(item = {}, total = 0) {
    const type = String(item.type || this.getMappedMusicUrlType(item.webpage_url || item.url || '') || '').toLowerCase();
    if (type === 'album') return 'album';
    if (type === 'playlist') return 'playlist';
    return Number(total) > 1 ? 'playlist' : 'track';
  }

  isMappedMusicItem(item = {}) {
    return !!this.getMappedMusicSource(item?.webpage_url || item?.url || '');
  }

  isMappedMusicUrl(rawUrl = '') {
    return !!this.getMappedMusicSource(rawUrl);
  }

  getMappedMusicSource(rawUrl = '') {
    const value = String(rawUrl || '').trim();
    if (!value) return null;
    if (/^spotify:(track|album|playlist):[A-Za-z0-9]+$/i.test(value) || /^https?:\/\/open\.spotify\.com\//i.test(value)) {
      return 'spotify';
    }
    if (/^deezer:(track|album|playlist):\d+$/i.test(value) || /^https?:\/\/(?:[^/]+\.)?deezer\.com\//i.test(value) || /^https?:\/\/(?:[^/]+\.)?deezer\.page\.link\//i.test(value)) {
      return 'deezer';
    }
    if (/^https?:\/\/(?:embed\.)?music\.apple\.com\//i.test(value)) {
      return 'apple_music';
    }
    if (/^https?:\/\/(?:www\.|listen\.)?tidal\.com\//i.test(value)) {
      return 'tidal';
    }
    if (/^https?:\/\/(?:www\.|m\.)?soundcloud\.com\//i.test(value)) {
      try {
        const parsed = new URL(value);
        const parts = parsed.pathname.split('/').filter(Boolean);
        const first = String(parts[0] || '').toLowerCase();
        const second = String(parts[1] || '').toLowerCase();
        const supportedSpecial =
          ((first === 'discover' || first === 'buzzing-playlists') && second === 'sets' && !!parts[2]) ||
          (first === 'stations' && second === 'track' && !!parts[2]);
        if (supportedSpecial) return 'soundcloud';
        if (['discover', 'charts', 'buzzing-playlists', 'stations'].includes(first)) return null;
        if (second === 'sets' && parts[2]) return 'soundcloud';
        if (['tracks', 'likes', 'reposts', 'sets', 'albums', 'popular-tracks', 'spotlight'].includes(second)) return 'soundcloud';
        if (parts.length === 1 || parts.length >= 2) return 'soundcloud';
      } catch {}
      return null;
    }
    return null;
  }

  getMappedMusicLabel(source = '') {
    const value = String(source || '').toLowerCase();
    if (value === 'apple_music') return 'Apple Music';
    if (value === 'deezer') return 'Deezer';
    if (value === 'tidal') return 'TIDAL';
    if (value === 'soundcloud') return 'SoundCloud';
    return 'Spotify';
  }

  getMappedMusicFallbackTitle(source = '', type = '') {
    const label = this.getMappedMusicLabel(source);
    const kind = String(type || '').toLowerCase();
    if (kind === 'track') return `${label} ${this.tt('ytlive.type.track', 'Tek parça')}`;
    if (kind === 'album') return `${label} ${this.tt('ytlive.type.album', 'Albüm')}`;
    return `${label} ${this.tt('ytlive.type.playlist', 'Çalma listesi')}`;
  }

  getMappedMusicUrlType(rawUrl = '') {
    const value = String(rawUrl || '').trim();
    let match = value.match(/^spotify:(track|album|playlist):[A-Za-z0-9]+$/i) ||
      value.match(/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(track|album|playlist)\//i) ||
      value.match(/^deezer:(track|album|playlist):\d+$/i);
    if (match) return match[1].toLowerCase();

    try {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase();
      const parts = parsed.pathname.split('/').filter(Boolean).map((part) => part.toLowerCase());

      if (isHostOrSubdomain(host, 'deezer.com')) {
        const type = parts.find((part) => ['track', 'album', 'playlist'].includes(part));
        if (type) return type;
      }

      if (host === 'music.apple.com' || host === 'embed.music.apple.com') {
        const appleType = parts[1] || '';
        if (appleType === 'song' || parsed.searchParams.has('i')) return 'track';
        if (appleType === 'album') return 'album';
        if (appleType === 'playlist') return 'playlist';
      }

      if (host === 'tidal.com' || host === 'www.tidal.com' || host === 'listen.tidal.com') {
        if (parts[0] === 'playlist' && parts[1]) return 'playlist';
        if (parts[0] === 'album' && parts[1]) return parts[2] === 'track' && parts[3] ? 'track' : 'album';
      }

      if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) {
        const first = parts[0] || '';
        const second = parts[1] || '';
        if (first === 'discover' && second === 'sets' && parts[2]) return 'playlist';
        if (first === 'buzzing-playlists' && second === 'sets' && parts[2]) return 'playlist';
        if (first === 'stations' && second === 'track' && parts[2]) return 'playlist';
        if (['discover', 'charts', 'buzzing-playlists', 'stations'].includes(first)) return 'playlist';
        if (second === 'sets' && parts[2]) return 'playlist';
        if (['tracks', 'likes', 'reposts', 'sets', 'albums', 'popular-tracks', 'spotlight'].includes(second) || parts.length === 1) return 'playlist';
        if (parts.length >= 2) return 'track';
      }
    } catch {}

    return 'playlist';
  }

  getMappedMusicEntityId(rawUrl = '') {
    const value = String(rawUrl || '').trim();
    const uriMatch = value.match(/^(?:spotify|deezer):(track|album|playlist):([A-Za-z0-9]+)$/i);
    if (uriMatch) return uriMatch[2];

    try {
      const parsed = new URL(value);
      const parts = parsed.pathname.split('/').filter(Boolean);
      const type = this.getMappedMusicUrlType(value);
      if (type === 'track' && isHostOrSubdomain(parsed.hostname, 'apple.com')) {
        return parsed.searchParams.get('i') || parts[parts.length - 1] || '';
      }
      if (type === 'track' && (parsed.hostname === 'tidal.com' || parsed.hostname === 'www.tidal.com' || parsed.hostname === 'listen.tidal.com')) {
        const trackIndex = parts.findIndex((part) => String(part).toLowerCase() === 'track');
        return trackIndex >= 0 ? (parts[trackIndex + 1] || '') : '';
      }
      const typeIndex = parts.findIndex((part) => ['track', 'album', 'playlist'].includes(String(part).toLowerCase()));
      return typeIndex >= 0 ? (parts[typeIndex + 1] || '') : (parts[parts.length - 1] || '');
    } catch {
      return '';
    }
  }

  normalizePlayableUrl(rawUrl, fallbackId = '') {
    const source = String(rawUrl || '').trim();
    try {
      const parsed = new URL(source);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    } catch {}
    const id = String(fallbackId || source || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(id)) {
      return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    }
    return source;
  }

  toSingleTrackUrl(rawUrl, fallbackId = '') {
    const source = String(rawUrl || '').trim();
    const id = this.getVideoId(source) || (String(fallbackId || '').match(/^[A-Za-z0-9_-]{11}$/) ? fallbackId : '');
    if (!id) return source;
    try {
      const url = new URL(source, window.location.origin);
      const host = isHostOrSubdomain(url.hostname, 'music.youtube.com') ? 'https://music.youtube.com' : 'https://www.youtube.com';
      return `${host}/watch?v=${encodeURIComponent(id)}`;
    } catch {
      return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    }
  }

  getEmbedUrl(item, { autoplay = false } = {}) {
    const url = item?.webpage_url || item?.url || '';
    const playlistId = this.getPlaylistId(url);
    const videoId = this.getVideoId(url) || (String(item?.id || '').match(/^[A-Za-z0-9_-]{11}$/) ? item.id : '');

    if (this.isPlaylistLike(item) && playlistId) {
      return this.withEmbedParams('https://www.youtube.com/embed/videoseries', {
        list: playlistId,
        autoplay
      });
    }
    if (videoId) {
      return this.withEmbedParams(`https://www.youtube.com/embed/${encodeURIComponent(videoId)}`, {
        autoplay
      });
    }
    return '';
  }

  withEmbedParams(baseUrl, { autoplay = false, list = '' } = {}) {
    try {
      const url = new URL(baseUrl);
      if (list) url.searchParams.set('list', list);
      url.searchParams.set('playsinline', '1');
      url.searchParams.set('rel', '0');
      url.searchParams.set('enablejsapi', '1');
      url.searchParams.set('origin', window.location.origin);
      if (autoplay) url.searchParams.set('autoplay', '1');
      return url.toString();
    } catch {
      const params = new URLSearchParams();
      if (list) params.set('list', list);
      params.set('playsinline', '1');
      params.set('rel', '0');
      params.set('enablejsapi', '1');
      params.set('origin', window.location.origin);
      if (autoplay) params.set('autoplay', '1');
      return `${baseUrl}?${params.toString()}`;
    }
  }

  getVideoId(rawUrl) {
    const source = String(rawUrl || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(source)) return source;
    try {
      const url = new URL(source, window.location.origin);
      if (url.hostname === 'youtu.be') return url.pathname.replace(/^\/+/, '').slice(0, 11);
      if (/\/shorts\//i.test(url.pathname)) return url.pathname.split('/').filter(Boolean).pop() || '';
      return url.searchParams.get('v') || '';
    } catch {
      const match = source.match(/[?&]v=([A-Za-z0-9_-]{11})/) || source.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
      return match?.[1] || '';
    }
  }

  getPlaylistId(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''), window.location.origin);
      return url.searchParams.get('list') || '';
    } catch {
      const match = String(rawUrl || '').match(/[?&]list=([^&#]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    }
  }

  getAlbumBrowseId(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''), window.location.origin);
      const parts = url.pathname.split('/').filter(Boolean);
      const browseId = parts[0] === 'browse' ? parts[1] || '' : '';
      return /^MPRE/i.test(browseId) ? browseId : '';
    } catch {
      const match = String(rawUrl || '').match(/\/browse\/(MPRE[A-Za-z0-9_-]+)/i);
      return match?.[1] || '';
    }
  }

  isYouTubeUrl(url) {
    return /(?:youtube\.com|youtu\.be|music\.youtube\.com)/i.test(String(url || ''));
  }

  isPlaylistUrl(url) {
    const value = String(url || '');
    return /(?:\/playlist|[?&]list=)/i.test(value);
  }

  isPlaylistLike(item) {
    if (item?.type === 'track') return false;
    return item?.type === 'playlist' || item?.type === 'album' || this.isPlaylistUrl(item?.webpage_url || item?.url || '');
  }

  getItemTypeLabel(item) {
    if (item?.type === 'album') return this.tt('ytlive.type.album', 'Albüm');
    if (this.isPlaylistLike(item)) return this.tt('ytlive.type.playlist', 'Çalma listesi');
    return this.tt('ytlive.type.track', 'Tek parça');
  }

  getSourceLabel(item) {
    const provider = item?.sourceProvider || this.getMappedMusicSource(item?.webpage_url || item?.url || '');
    if (provider) return this.getMappedMusicLabel(provider);
    if (this.isPlaylistLike(item)) return this.tt('ytlive.source.collection', 'Koleksiyon');
    if (urlHasHost(item?.webpage_url || item?.url || '', 'music.youtube.com')) return 'YouTube Music';
    return 'YouTube';
  }

  getContentTags(item, index = 0) {
    const tags = [];
    if (index < 3) tags.push(this.tt('ytlive.content.featured', 'Öne çıkan'));
    if (this.isPlaylistLike(item)) tags.push(this.tt('ytlive.type.playlist', 'Çalma listesi'));
    if (this.activePreset && this.isDiscoverPreset(this.activePreset)) {
      tags.push(this.getPresetDisplayLabel(this.activePreset));
    }
    if (item?.duration && Number(item.duration) > 600) tags.push(this.tt('ytlive.content.longMix', 'Uzun mix'));
    return Array.from(new Set(tags)).slice(0, 3);
  }

  getTitleInitials(value) {
    const words = String(value || 'YT')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    const initials = words.map((word) => word[0]).join('').toUpperCase();
    return initials || 'YT';
  }

  formatResultDuration(items = []) {
    const seconds = (Array.isArray(items) ? items : [])
      .slice(0, 24)
      .reduce((sum, item) => sum + (Number.isFinite(Number(item?.duration)) ? Number(item.duration) : 0), 0);
    if (!seconds) return this.tt('ytlive.content.mixed', 'karma');
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    if (hours) return `${hours}s ${String(minutes).padStart(2, '0')}dk`;
    return `${Math.max(1, minutes)}dk`;
  }

  getSelectedFormat() {
    return document.getElementById('formatSelect')?.value || 'mp3';
  }

  isVideoFormat(format) {
    return ['mp4', 'mkv', 'webm'].includes(String(format || '').toLowerCase());
  }

  isTerminalJob(job) {
    return ['completed', 'error', 'canceled'].includes(String(job?.status || '').toLowerCase());
  }

  getActiveJobCount() {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (!this.isTerminalJob(job)) count += 1;
    }
    return count;
  }

  applyLocalizedUi() {
    window.i18n?.apply?.(document.body);
    this.updatePresetQueries();
    const queuePanel = document.getElementById('queuePanel');
    if (queuePanel) queuePanel.dataset.collapsedLabel = this.tt('ytlive.queue.title', 'Kuyruk');

    const subtitle = document.getElementById('nowSubtitle');
    if (this.activeCollection) {
      this.updateNowPanelForCollection();
    } else if (this.currentItem) {
      document.getElementById('nowType').textContent = this.getItemTypeLabel(this.currentItem);
      if (subtitle) subtitle.textContent = this.currentItem.uploader || this.currentItem.webpage_url || '';
    } else {
      const title = document.getElementById('nowTitle');
      if (title) title.textContent = this.getConfiguredNowTitle();
      if (subtitle) subtitle.textContent = this.getConfiguredNowSubtitle();
    }
  }

  updatePresetQueries() {
    document.querySelectorAll('[data-preset]').forEach((button) => {
      button.dataset.query = '';
    });
  }

  isDiscoverPreset(preset) {
    return this.discoverPresets.includes(String(preset || '').trim().toLowerCase());
  }

  getPresetQuery(preset, { advance = false } = {}) {
    const base = this.getPresetBaseQuery(preset);
    const variants = this.getPresetQueryVariants(preset, base);
    const index = this.getPresetVariantIndex(preset, variants.length, advance);
    return variants[index] || base;
  }

  getPresetBaseQuery(preset) {
    const key = `ytlive.preset.${preset}.query`;
    const fallback = {
      energizing: 'energetic music',
      workout: 'workout music',
      'feel-good': 'feel good music',
      relax: 'relaxing music',
      sad: 'sad music',
      romance: 'romantic music',
      commute: 'commute music',
      party: 'party music',
      focus: 'focus music',
      sleep: 'sleep music'
    }[preset] || 'energetic music';
    return this.tt(key, fallback);
  }

  getPresetSearchOptions(preset) {
    if (preset === 'new') return { sort: 'date' };
    return {};
  }

  getPresetDisplayLabel(preset) {
    if (!preset) return this.tt('ytlive.content.title', 'İçerikler');
    const fallback = {
      energizing: 'Enerjik',
      workout: 'Antrenman',
      'feel-good': 'Keyifli',
      relax: 'Rahatlama',
      sad: 'Hüzünlü',
      romance: 'Romantik',
      commute: 'İşe gidip gelme',
      party: 'Parti',
      focus: 'Odaklanma',
      sleep: 'Uyku'
    }[preset] || this.tt('ytlive.content.title', 'İçerikler');
    return this.tt(`ytlive.preset.${preset}`, fallback);
  }

  getPresetPageQuery(preset, page = 1) {
    const base = this.getPresetBaseQuery(preset);
    const variants = this.getPresetQueryVariants(preset, base);
    const safeVariants = variants.length ? variants : [base];
    const modifiers = this.getPresetPageModifiers(preset);
    const variant = safeVariants[(page - 1) % safeVariants.length];
    const modifier = modifiers[Math.floor((page - 1) / safeVariants.length) % modifiers.length] || '';
    return [variant, modifier].join(' ').replace(/\s+/g, ' ').trim();
  }

  getSearchPageQuery(baseQuery, page = 1) {
    const base = String(baseQuery || '').trim();
    const modifiers = this.getSearchPageModifiers();
    const modifier = modifiers[(page - 1) % modifiers.length] || '';
    const cycle = Math.floor((page - 1) / modifiers.length);
    const cycleSuffix = cycle ? String(2026 - (cycle % 8)) : '';
    return [base, modifier, cycleSuffix].join(' ').replace(/\s+/g, ' ').trim();
  }

  getSearchPageModifiers() {
    const lang = this.getCurrentLang();
    const modifiers = {
      tr: [
        'şarkıları',
        'en iyi şarkıları',
        'albüm',
        'konser',
        'canlı',
        'akustik',
        'klip',
        'resmi audio',
        'playlist',
        'dinle',
        'remix',
        'full albüm',
        'türküler',
        'duygusal şarkılar'
      ],
      en: [
        'songs',
        'best songs',
        'album',
        'concert',
        'live',
        'acoustic',
        'video',
        'official audio',
        'playlist',
        'listen',
        'remix',
        'full album',
        'top tracks',
        'greatest hits'
      ],
      de: [
        'songs',
        'beste songs',
        'album',
        'konzert',
        'live',
        'akustisch',
        'video',
        'offizielles audio',
        'playlist',
        'anhören',
        'remix',
        'ganzes album',
        'top titel',
        'größte hits'
      ],
      fr: [
        'chansons',
        'meilleures chansons',
        'album',
        'concert',
        'live',
        'acoustique',
        'clip',
        'audio officiel',
        'playlist',
        'écouter',
        'remix',
        'album complet',
        'meilleurs titres',
        'grands succès'
      ],
      es: [
        'canciones',
        'mejores canciones',
        'álbum',
        'concierto',
        'en vivo',
        'acústico',
        'video',
        'audio oficial',
        'playlist',
        'escuchar',
        'remix',
        'álbum completo',
        'top canciones',
        'grandes éxitos'
      ]
    };
    return modifiers[lang] || modifiers.en;
  }

  getPresetPageModifiers(preset) {
    const lang = this.getCurrentLang();
    const common = {
      tr: ['', 'resmi klip', 'resmi audio', '2026', 'bu hafta', 'top 50'],
      en: ['', 'official video', 'official audio', '2026', 'this week', 'top 50'],
      de: ['', 'offizielles video', 'offizielles audio', '2026', 'diese woche', 'top 50'],
      fr: ['', 'clip officiel', 'audio officiel', '2026', 'cette semaine', 'top 50'],
      es: ['', 'video oficial', 'audio oficial', '2026', 'esta semana', 'top 50']
    };
    const playlist = {
      tr: ['', '2026 top 50', 'yeni şarkılar', 'hit şarkılar', 'türkçe pop'],
      en: ['', '2026 top 50', 'new songs', 'hit songs', 'pop'],
      de: ['', '2026 top 50', 'neue songs', 'hit songs', 'pop'],
      fr: ['', '2026 top 50', 'nouveaux titres', 'tubes', 'pop'],
      es: ['', '2026 top 50', 'canciones nuevas', 'hits', 'pop']
    };
    const fresh = {
      tr: ['', 'bugün', 'bu hafta', 'yeni çıkan', 'resmi audio', 'resmi klip'],
      en: ['', 'today', 'this week', 'new release', 'official audio', 'official video'],
      de: ['', 'heute', 'diese woche', 'neuerscheinung', 'offizielles audio', 'offizielles video'],
      fr: ['', "aujourd'hui", 'cette semaine', 'nouveauté', 'audio officiel', 'clip officiel'],
      es: ['', 'hoy', 'esta semana', 'nuevo lanzamiento', 'audio oficial', 'video oficial']
    };
    if (preset === 'playlist') return playlist[lang] || playlist.en;
    if (preset === 'new') return fresh[lang] || fresh.en;
    return common[lang] || common.en;
  }

  getPresetVariantIndex(preset, length, advance = false) {
    if (!length) return 0;
    const current = Number(this.presetCounters.get(preset) || 0);
    const next = advance ? current + 1 : current;
    if (advance) this.presetCounters.set(preset, next);
    return next % length;
  }

  getPresetQueryVariants(preset, base) {
    const lang = this.getCurrentLang();
    const variants = {
      tr: {
        energizing: ['enerjik müzik', 'hareketli şarkılar', 'motivasyon müzikleri'],
        workout: ['antrenman müzikleri', 'spor müzikleri', 'fitness şarkıları'],
        'feel-good': ['keyifli şarkılar', 'iyi hissettiren müzikler', 'neşeli şarkılar'],
        relax: ['rahatlama müziği', 'sakin müzik', 'chill müzik'],
        sad: ['hüzünlü şarkılar', 'duygusal müzik', 'melankolik şarkılar'],
        romance: ['romantik şarkılar', 'aşk şarkıları', 'romantik müzik'],
        commute: ['işe giderken müzik', 'yol müzikleri', 'araba müzikleri'],
        party: ['parti müzikleri', 'dans şarkıları', 'eğlence müzikleri'],
        focus: ['odaklanma müziği', 'çalışma müziği', 'konsantrasyon müziği'],
        sleep: ['uyku müziği', 'rahat uyku müzikleri', 'sakin uyku müziği']
      },
      en: {
        energizing: ['energetic music', 'upbeat songs', 'motivation music'],
        workout: ['workout music', 'gym music', 'fitness songs'],
        'feel-good': ['feel good music', 'happy songs', 'mood booster music'],
        relax: ['relaxing music', 'chill music', 'calm songs'],
        sad: ['sad music', 'sad songs', 'melancholy music'],
        romance: ['romantic music', 'love songs', 'romance songs'],
        commute: ['commute music', 'driving music', 'road trip songs'],
        party: ['party music', 'dance songs', 'party playlist'],
        focus: ['focus music', 'study music', 'concentration music'],
        sleep: ['sleep music', 'sleep songs', 'calm sleep music']
      },
      de: {
        energizing: ['power musik', 'power playlist', 'energie musik'],
        workout: ['workout musik', 'fitness musik', 'training musik'],
        'feel-good': ['gute laune musik', 'frohe songs', 'feel good musik'],
        relax: ['entspannung musik', 'ruhige musik', 'chill musik'],
        sad: ['traurig musik', 'melancholische musik', 'traurige songs'],
        romance: ['romantik musik', 'liebeslieder', 'romantische songs'],
        commute: ['arbeitsweg musik', 'musik zum pendeln', 'fahrmusik'],
        party: ['partymusik', 'tanzmusik', 'party songs'],
        focus: ['konzentration musik', 'fokus musik', 'musik zum arbeiten'],
        sleep: ['einschlafen musik', 'schlafmusik', 'ruhige schlafmusik']
      },
      fr: {
        energizing: ['energie musique', 'musique energique', 'musique dynamique'],
        workout: ['sport musique', 'musique sport', 'chansons fitness'],
        'feel-good': ['musique bonne humeur', 'chansons joyeuses', 'musique feel good'],
        relax: ['musique detente', 'musique relaxante', 'musique calme'],
        sad: ['chansons tristes', 'musique melancolique', 'musique triste'],
        romance: ['romance musique', 'musique romantique', 'chansons amour'],
        commute: ['pour la route musique', 'musique route', 'musique voiture'],
        party: ['musique fete', 'chansons danse', 'musique soiree'],
        focus: ['musique concentration', 'musique travail', 'musique focus'],
        sleep: ['musique sommeil', 'musique pour dormir', 'musique calme sommeil']
      },
      es: {
        energizing: ['musica energica', 'canciones motivadoras', 'musica con energia'],
        workout: ['musica entrenamiento', 'musica gimnasio', 'canciones fitness'],
        'feel-good': ['musica sentirse bien', 'musica buen rollo', 'canciones alegres'],
        relax: ['musica relax', 'musica relajante', 'musica tranquila'],
        sad: ['canciones tristes', 'musica melancolica', 'musica triste'],
        romance: ['musica amor', 'canciones de amor', 'musica romantica'],
        commute: ['musica desplazamientos diarios', 'musica para conducir', 'canciones de viaje'],
        party: ['musica de fiesta', 'canciones para bailar', 'musica party'],
        focus: ['musica concentracion', 'musica para estudiar', 'musica para trabajar'],
        sleep: ['musica dormir', 'musica para dormir', 'musica tranquila para dormir']
      }
    };

    const list = variants[lang]?.[preset] || variants.en[preset] || [base];
    const normalized = [base, ...list].map((value) => String(value || '').trim()).filter(Boolean);
    return Array.from(new Set(normalized));
  }

  getLocaleDefaultMusicQuery() {
    const lang = this.getCurrentLang();
    const map = {
      tr: 'türkçe pop 2026 resmi klip',
      de: 'deutsche pop songs 2026 offizielles video',
      fr: 'pop francaise 2026 clip officiel',
      es: 'pop latino 2026 video oficial',
      en: 'pop songs 2026 official audio'
    };
    return map[lang] || 'pop music';
  }

  getCurrentLang() {
    const supported = new Set(['en', 'tr', 'de', 'fr', 'es']);
    const lang =
      window.i18n?.getCurrentLang?.() ||
      window.i18n?.lang ||
      localStorage.getItem('lang') ||
      navigator.language ||
      'en';
    const normalized = String(lang || 'en').toLowerCase().slice(0, 2);
    return supported.has(normalized) ? normalized : 'en';
  }

  getCurrentRegion() {
    const lang = this.getCurrentLang();
    const defaults = {
      tr: 'TR',
      de: 'DE',
      fr: 'FR',
      es: 'ES',
      en: 'US'
    };
    const candidates = [
      window.i18n?.region,
      localStorage.getItem('region')
    ];

    for (const candidate of candidates) {
      const source = String(candidate || '').trim();
      const match = source.match(/[-_]([A-Za-z]{2})\b/);
      if (match) return match[1].toUpperCase();
      if (/^[A-Za-z]{2}$/.test(source)) return source.toUpperCase();
    }

    return defaults[lang] || 'US';
  }

  handleLocaleChanged() {
    this.loadMusicHomeShelves();
    if (this.activePreset && this.isDiscoverPreset(this.activePreset)) {
      this.search('', { preset: this.activePreset });
    }
  }

  setActivePreset(preset) {
    document.querySelectorAll('[data-preset]').forEach((button) => {
      button.classList.toggle('is-active', !!preset && button.dataset.preset === preset);
    });
  }

  setResultsStatus(message) {
    const el = document.getElementById('resultsStatus');
    if (el) el.textContent = message;
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
  }

  notify(message, type = 'info') {
    const root = document.getElementById('toastRoot');
    if (!root) return;
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = String(message || '');
    root.appendChild(toast);
    setTimeout(() => toast.classList.add('is-visible'), 10);
    setTimeout(() => {
      toast.classList.remove('is-visible');
      setTimeout(() => toast.remove(), 250);
    }, 3200);
  }

  formatSeconds(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h
      ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  toRelative(url) {
    if (!url) return url;
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.origin === window.location.origin
        ? parsed.pathname + parsed.search + parsed.hash
        : url;
    } catch {
      return String(url).replace(/^https?:\/\/[^/]+/i, '');
    }
  }

  escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"'`=\/]/g, (char) => this.escapeMap[char] || char);
  }

  t(key, vars) {
    return window.i18n?.t?.(key, vars) ?? key;
  }

  tt(key, fallback = '', vars = {}) {
    const value = this.t(key, vars);
    if (!value || value === key) {
      let out = fallback || key;
      for (const [name, replacement] of Object.entries(vars || {})) {
        out = out.replace(new RegExp(`\\{${name}\\}`, 'g'), String(replacement));
      }
      return out;
    }
    return value;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new YTLiveMusicApp();
  app.initialize().catch((error) => {
    console.error('YTLive UI initialization failed:', error);
  });
});
