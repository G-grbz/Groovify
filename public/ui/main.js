import { MediaConverterApp } from './MediaConverterApp.js';
import { settingsManager } from './SettingsManager.js';
import { jobsPanelManager } from './JobsPanelManager.js';
import { initDiscRipperPanel } from './discRipperPanel.js';
import { modalManager } from './ModalManager.js';
import { versionManager } from './VersionManager.js';
import { TrackExtractorManager } from './TrackExtractorManager.js';
import { accessManager } from './AccessManager.js';

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


if (typeof window !== 'undefined' && window.electronAPI?.updateLanguage) {
  document.addEventListener('i18n:applied', (event) => {
    const lang = event?.detail?.lang;
    if (lang) window.electronAPI.updateLanguage(lang).catch?.(() => {});
  });
}

window.focusUrlInput = function() {
    const urlInput = document.getElementById('urlInput');
    if (urlInput) {
        urlInput.focus();
        urlInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
};

window.focusFileInput = function() {
    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
        fileInput.click();
        fileInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
};

window.focusUrlInputAndClose = function() {
    focusUrlInput();
    jobsPanelManager.close();
};

window.focusFileInputAndClose = function() {
    focusFileInput();
    jobsPanelManager.close();
};

document.addEventListener('DOMContentLoaded', async () => {
    // This overlay is exclusively for runtime binary preparation. Start its
    // check immediately and remove it as soon as the tools are usable instead
    // of keeping it over unrelated application startup work.
    const runtimeBinariesReady = waitForRuntimeBinariesReady();
    runtimeBinariesReady.then(hideRuntimeBinariesOverlay);

    try {
        await window.i18nInit();
    } catch (error) {
        console.error('i18n initialization failed:', error);
    }

    if (window.i18n?.apply) {
        window.i18n.apply(document.body);
    }

    await accessManager.ensureAccess();

    const loadingScreen = document.getElementById('loading-screen');
    const mainContent = document.querySelector('.main-content');
    if (loadingScreen) loadingScreen.style.display = 'none';
    if (mainContent) mainContent.style.display = 'block';

    await runtimeBinariesReady;

    document.getElementById('jobsEmptyUrlAction')?.addEventListener('click', () => window.focusUrlInput());
    document.getElementById('jobsEmptyFileAction')?.addEventListener('click', () => window.focusFileInput());
    document.addEventListener('click', (event) => {
        const action = event.target?.closest?.('[data-action]')?.dataset?.action;
        if (action === 'focus-url-close') window.focusUrlInputAndClose();
        if (action === 'focus-file-close') window.focusFileInputAndClose();
    });

    await settingsManager.initialize();
    await versionManager.initialize();

    jobsPanelManager.initialize();

    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) {
        const labelEl = settingsBtn.querySelector('.settings-btn__label');

        // Updates settings button for the browser UI layer.
        const updateSettingsButton = (loggedIn) => {
            const key = loggedIn ? 'settings.title' : 'btn.login';
            const fallback = loggedIn ? 'Ayarlar' : 'Giriş';
            settingsBtn.dataset.mode = loggedIn ? 'settings' : 'login';
            settingsBtn.setAttribute('data-i18n-title', key);
            const label = window.i18n?.t(key) || fallback;
            if (labelEl) {
                labelEl.textContent = label;
                labelEl.setAttribute('data-i18n', key);
            }
            settingsBtn.title = label;
        };

        const initialLoggedIn = !!localStorage.getItem(settingsManager.tokenKey);
        updateSettingsButton(initialLoggedIn);

        window.addEventListener('gharmonize:auth', (ev) => {
            const loggedIn = !!ev?.detail?.loggedIn;
            updateSettingsButton(loggedIn);
        });

        settingsBtn.addEventListener('click', () => {
            const mode = settingsBtn.dataset.mode;
            if (mode === 'login') {
                settingsManager.openLoginOnly();
            } else {
                settingsManager.open();
            }
        });
    }

    const app = new MediaConverterApp();
    await app.initialize();
    const trackExtractorManager = new TrackExtractorManager(app);
    await trackExtractorManager.initialize();
    window.trackExtractorManager = trackExtractorManager;
    setupCollapsibleSections();
    setupTitlePositioning();
    initDiscRipperPanel();
    });

window.versionManager = versionManager;

// Updates collapsible sections used for the browser UI layer.
function setupCollapsibleSections() {
    // Updates collapsible used for the browser UI layer.
    function setupCollapsible(headerId, contentId) {
        const header = document.getElementById(headerId);
        const content = document.getElementById(contentId);

        if (header && content) {
            header.addEventListener('click', function() {
                header.classList.toggle('collapsed');
                content.classList.toggle('collapsed');
            });
        }
    }

    setupCollapsible('spotifyPreviewHeader', 'spotifyPreviewContent');
    setupCollapsible('playlistPreviewHeader', 'playlistPreviewContent');
    setupCollapsible('jobsHeader', 'jobsContent');
    setupCollapsible('discRipperHeader', 'discRipperContent');
    const jobsHeader = document.getElementById('jobsHeader');
    const jobsContent = document.getElementById('jobsContent');
    if (jobsHeader && jobsContent) {
        jobsHeader.classList.remove('collapsed');
        jobsContent.classList.remove('collapsed');
    }
}

// Updates title positioning used for the browser UI layer.
function setupTitlePositioning() {
  const title = document.querySelector('.title-section');
  const container = document.querySelector('.container');
  const firstCard = document.querySelector('.card-grid .card:first-child');
  const logoImg = document.querySelector('.app-logo-large');

  if (!title || !container || !firstCard) return;

  const GAP = 8;

  // Checks whether measure is allowed for the browser UI layer.
  function canMeasure() {
    const cont = container.getBoundingClientRect();
    const card = firstCard.getBoundingClientRect();
    const titleH = title.offsetHeight;
    return cont.width > 0 && card.width > 0 && titleH > 0;
  }

  // Handles place title in the browser UI layer.
  function placeTitle() {
    const cont = container.getBoundingClientRect();
    const card = firstCard.getBoundingClientRect();
    if (!(cont.width > 0 && card.width > 0)) return;

    title.style.visibility = 'hidden';
    title.style.left = '0px';
    title.style.top = '0px';

    const titleH = title.offsetHeight;
    const left = card.left - cont.left;
    const top = card.top - cont.top - titleH - GAP;

    title.style.left = left + 'px';
    title.style.top = top + 'px';
    title.style.visibility = 'visible';
  }

  // Handles wait and place in the browser UI layer.
  async function waitAndPlace() {
    try { await document.fonts.ready; } catch(e) {}
    if (logoImg && logoImg.decode) {
      try { await logoImg.decode(); } catch(e) {}
    }
    let tries = 0;
    while (!canMeasure() && tries < 10) {
      await new Promise(r => requestAnimationFrame(r));
      tries++;
    }
    placeTitle();
  }

  waitAndPlace();

  window.addEventListener('resize', placeTitle, { passive: true });
  window.addEventListener('scroll', placeTitle, { passive: true });

  const ro = new ResizeObserver(() => placeTitle());
  ro.observe(document.documentElement);
}
