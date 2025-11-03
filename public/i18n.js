(function () {
  const SUPPORTED = ['en', 'tr', 'de', 'fr'];
  const ATTR_MAP = [
    ['data-i18n', 'textContent'],
    ['data-i18n-title', 'title'],
    ['data-i18n-ph', 'placeholder'],
    ['data-i18n-aria', 'aria-label'],
  ];

  async function loadDict(lang) {
    const res = await fetch(`/lang/${lang}.json`);
    if (!res.ok) throw new Error('dict fetch failed');
    return res.json();
  }

  function detectLang() {
  try {
    const u = new URL(window.location.href);
    const q = (u.searchParams.get('lang') || '').toLowerCase();
    if (SUPPORTED.includes(q)) {
      localStorage.setItem('lang', q);
      return q;
    }
  } catch {}

  const fromLs = (localStorage.getItem('lang') || '').toLowerCase();
  if (SUPPORTED.includes(fromLs)) return fromLs;

  const nav = (navigator.language || navigator.userLanguage || '').toLowerCase().slice(0,2);
  if (SUPPORTED.includes(nav)) return nav;

  const htmlLang = (document.documentElement.getAttribute('lang') || '').toLowerCase().slice(0,2);
  if (SUPPORTED.includes(htmlLang)) return htmlLang;

  return 'en';
}

  function applyDict(dict, root = document) {
    ATTR_MAP.forEach(([attr, target]) => {
      root.querySelectorAll(`[${attr}]`).forEach(el => {
        const key = el.getAttribute(attr);
        const val = dict[key];
        if (val != null) {
          if (target === 'textContent') el.textContent = val;
          else if (target === 'ariaLabel') el.setAttribute('aria-label', val);
          else el.setAttribute(target, val);
        }
      });
    });
  }

  function createT(dict, fallback) {
    return function t(key, vars = {}) {
      let str = (dict[key] ?? fallback[key] ?? key);
      for (const [k, v] of Object.entries(vars)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
      }
      return str;
    };
  }

  async function init() {
    const html = document.documentElement;
    const prevVis = html.style.visibility;
    html.style.visibility = 'hidden';

    const safety = setTimeout(() => {
      if (html.style.visibility === 'hidden')
        html.style.visibility = prevVis || '';
    }, 1500);

    try {
      const lang = detectLang();
      let dict, fallback;

      try { dict = await loadDict(lang); } catch {}
      if (!dict) dict = await loadDict('en');

      try { fallback = (lang === 'en') ? dict : await loadDict('en'); } catch {}

      applyDict(dict);
      html.lang = lang;

      const api = {
        lang,
        dict,
        t: createT(dict, fallback),
        apply(root) { applyDict(api.dict, root || document); },
        async setLang(next) {
          if (!SUPPORTED.includes(next)) return;
          localStorage.setItem('lang', next);
          const newDict = await loadDict(next);
          applyDict(newDict);
          api.lang = next;
          api.dict = newDict;
          api.t = createT(newDict, fallback);
          html.lang = next;
          document.dispatchEvent(new CustomEvent('i18n:applied', { detail: { lang: next } }));
        }
      };
      window.i18n = api;
      return api;
    } finally {
      clearTimeout(safety);
      html.style.visibility = prevVis || '';
    }
  }

  window.i18nInit = init;
})();
