import { MediaConverterApp } from './MediaConverterApp.js';
import { settingsManager } from './SettingsManager.js';
import { jobsPanelManager } from './JobsPanelManager.js';

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
    try {
        await window.i18nInit();
    } catch (error) {
        console.error('i18n initialization failed:', error);
    }
    if (window.i18n?.apply) window.i18n.apply(document.body);

    settingsManager.initialize();
    jobsPanelManager.initialize();
    document.getElementById('settingsBtn').addEventListener('click', () => {
        settingsManager.open();
    });

    new MediaConverterApp();
    setupCollapsibleSections();
    setupTitlePositioning();
});

function setupCollapsibleSections() {
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
    const jobsHeader = document.getElementById('jobsHeader');
    const jobsContent = document.getElementById('jobsContent');
    if (jobsHeader && jobsContent) {
        jobsHeader.classList.remove('collapsed');
        jobsContent.classList.remove('collapsed');
    }
}

function setupTitlePositioning() {
  const title = document.querySelector('.title-section');
  const container = document.querySelector('.container');
  const firstCard = document.querySelector('.card-grid .card:first-child');
  const logoImg = document.querySelector('.app-logo-large');

  if (!title || !container || !firstCard) return;

  const GAP = 8;

  function canMeasure() {
    const cont = container.getBoundingClientRect();
    const card = firstCard.getBoundingClientRect();
    const titleH = title.offsetHeight;
    return cont.width > 0 && card.width > 0 && titleH > 0;
  }

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
