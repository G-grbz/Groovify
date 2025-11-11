export class SettingsManager {
    constructor() {
        this.tokenKey = "gharmonize_admin_token";
        this.modal = null;
        this.isInitialized = false;
    }

    async initialize() {
        if (this.isInitialized) return;

        this.createModal();
        this.setupEventListeners();
        this.isInitialized = true;
    }

    createModal() {
        if (document.getElementById('settingsModal')) return;

        const modal = document.createElement('div');
        modal.id = 'settingsModal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;align-items:center;justify-content:center;z-index:9999;';
        modal.innerHTML = this.getModalHTML();
        document.body.appendChild(modal);
        if (window.i18n?.apply) window.i18n.apply(modal);
        this.modal = modal;
    }

    getModalHTML() {
        return `
            <div class="settings-dialog">
                <div class="settings-dialog__header">
                    <h3 data-i18n="settings.title">Ayarlar</h3>
                    <button id="settingsClose" class="btn-outline">✖</button>
                </div>
                <div id="settingsBody" class="settings-dialog__body">
                    ${this.getLoginViewHTML()}
                    ${this.getFormViewHTML()}
                </div>
            </div>
        `;
    }

    getLoginViewHTML() {
        return `
            <div id="loginView">
                <label for="adminPass" class="settings-field-label" data-i18n="settings.adminPassword">Yönetici Şifresi</label>
                <input id="adminPass" type="password" class="settings-input" autofocus />
                <div id="adminError" class="settings-error" aria-live="polite" style="display:none"></div>
                <div class="settings-actions settings-actions--end">
                    <button id="loginBtn" class="btn-primary" data-i18n="btn.login">Giriş yap</button>
                </div>
            </div>
        `;
    }

    getFormViewHTML() {
        return `
            <div id="formView" style="display:none">
                <div class="form-group">
                    <label for="f_SPOTIFY_CLIENT_ID" data-i18n="settings.spotifyClientId">SPOTIFY_CLIENT_ID</label>
                    <input id="f_SPOTIFY_CLIENT_ID" type="text" >
                </div>
                <div class="form-group">
                    <label for="f_SPOTIFY_CLIENT_SECRET" data-i18n="settings.spotifyClientSecret">SPOTIFY_CLIENT_SECRET</label>
                    <input id="f_SPOTIFY_CLIENT_SECRET" type="password" placeholder="••••••••" data-i18n-ph="ph.spotifyClientSecret" >
                </div>
                <div class="form-group">
                    <label for="f_SPOTIFY_MARKET" data-i18n="settings.spotifyMarket">SPOTIFY_MARKET</label>
                    <input id="f_SPOTIFY_MARKET" type="text" placeholder="TR, US, GB vb." data-i18n-ph="ph.spotifyMarket" >
                </div>
                <div class="form-group">
                    <label for="f_SPOTIFY_FALLBACK_MARKETS" data-i18n="settings.spotifyFallbackMarkets">SPOTIFY_FALLBACK_MARKETS</label>
                    <input id="f_SPOTIFY_FALLBACK_MARKETS" type="text" placeholder="US,GB,DE,FR" data-i18n-ph="ph.spotifyFallbackMarkets" >
                </div>
                <div class="form-group">
                    <label for="f_YT_USE_MUSIC" data-i18n="settings.ytUseMusic">YT_USE_MUSIC</label>
                    <select id="f_YT_USE_MUSIC">
                        <option value="1">1</option>
                        <option value="0">0</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="f_PREFER_SPOTIFY_TAGS" data-i18n="settings.preferSpotifyTags">PREFER_SPOTIFY_TAGS</label>
                    <select id="f_PREFER_SPOTIFY_TAGS">
                        <option value="1">1</option>
                        <option value="0">0</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="f_TITLE_CLEAN_PIPE" data-i18n="settings.titleCleanPipe">TITLE_CLEAN_PIPE</label>
                    <select id="f_TITLE_CLEAN_PIPE">
                        <option value="1">1</option>
                        <option value="0">0</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="f_YTDLP_BIN" data-i18n="settings.ytdlpBin">YTDLP_BIN</label>
                    <input id="f_YTDLP_BIN" type="text" placeholder="'C:/tools/yt-dlp.exe'" data-i18n-ph="ph.ytdlpBin">
                </div>
                <div class="form-group">
                    <label for="f_YT_DEFAULT_REGION" data-i18n="settings.ytDefaultRegion">YT_DEFAULT_REGION</label>
                    <input id="f_YT_DEFAULT_REGION" type="text" placeholder="ör: TR, US (boş = kapalı)" data-i18n-ph="ph.ytDefaultRegion" >
                </div>
                <div class="form-group">
                    <label for="f_YT_LANG" data-i18n="settings.ytLang">YT_LANG</label>
                    <input id="f_YT_LANG" type="text" placeholder="en-US, tr-TR ..." data-i18n-ph="ph.ytLang" >
                </div>
                <div class="form-group">
                    <label for="f_YT_ACCEPT_LANGUAGE" data-i18n="settings.ytAcceptLang">YT_ACCEPT_LANGUAGE</label>
                    <input id="f_YT_ACCEPT_LANGUAGE" type="text" placeholder="en-US,en;q=0.8 (opsiyonel)" data-i18n-ph="ph.ytAcceptLang" >
                </div>
                <div class="form-group">
                    <label for="f_YT_FORCE_IPV4" data-i18n="settings.ytForceIpv4">YT_FORCE_IPV4</label>
                    <select id="f_YT_FORCE_IPV4">
                        <option value="1">1</option>
                        <option value="0">0</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="f_ENRICH_SPOTIFY_FOR_YT" data-i18n="settings.enrichSpforYy">ENRICH_SPOTIFY_FOR_YT</label>
                    <select id="f_ENRICH_SPOTIFY_FOR_YT">
                        <option value="1">1</option>
                        <option value="0">0</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="f_MEDIA_COMMENT" data-i18n="settings.mediaComment">MEDIA_COMMENT</label>
                    <input id="f_MEDIA_COMMENT" type="text" placeholder="Gharmonize" data-i18n-ph="ph.mediaComment">
                </div>
                <div class="form-group">
                    <label for="f_FFMPEG_BIN" data-i18n="settings.ffmpegBin">FFMPEG_BIN</label>
                    <input id="f_FFMPEG_BIN" type="text" placeholder='' data-i18n-ph="ph.ffmpegBin">
                </div>
                <div class="form-group">
                    <label for="f_YT_403_WORKAROUNDS" data-i18n="settings.workarounds">YT_403_WORKAROUNDS</label>
                    <select id="f_YT_403_WORKAROUNDS">
                        <option value="1">1</option>
                        <option value="0">0</option>
                    </select>
                </div>
                <div class="form-group">
                   <label for="f_YTDLP_UA" data-i18n="settings.ytdlpUA">YTDLP_UA</label>
                    <input id="f_YTDLP_UA" type="text" placeholder="User-Agent (opsiyonel)" data-i18n-ph="ph.ytdlpUA" >
                </div>
                <div class="form-group">
                    <label for="f_YTDLP_COOKIES" data-i18n="settings.ytdlpCookies">YTDLP_COOKIES</label>
                    <input id="f_YTDLP_COOKIES" type="text" placeholder="/path/to/cookies.txt (opsiyonel)" data-i18n-ph="ph.ytdlpCookies" >
                </div>
                <div class="form-group">
                    <label for="f_YTDLP_COOKIES_FROM_BROWSER" data-i18n="settings.ytdlpBrowser">YTDLP_COOKIES_FROM_BROWSER</label>
                    <select id="f_YTDLP_COOKIES_FROM_BROWSER">
                        <option value="">(kapalı)</option>
                        <option value="chrome">chrome</option>
                        <option value="chromium">chromium</option>
                        <option value="firefox">firefox</option>
                        <option value="edge">edge</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="f_YTDLP_EXTRA" data-i18n="settings.ytdlpExtra">YTDLP_EXTRA</label>
                    <input id="f_YTDLP_EXTRA" type="text" placeholder="Ek argümanlar, ör: --http-chunk-size 10M" data-i18n-ph="ph.ytdlpExtra" >
                </div>
                <div class="form-group">
                    <label for="f_YT_STRIP_COOKIES" data-i18n="settings.ytdlpSCookies">YT_STRIP_COOKIES</label>
                    <select id="f_YT_STRIP_COOKIES">
                        <option value="0">0</option>
                        <option value="1">1</option>
                    </select>
                </div>
                <h4 class="settings-section-title" data-i18n="settings.adminPassword">Yönetici Şifresi</h4>
                <div class="form-group">
                    <label for="f_ADMIN_OLD" class="settings-field-label" data-i18n="settings.currentPassword">Eski Şifre</label>
                    <input id="f_ADMIN_OLD" type="password" placeholder="••••••••" data-i18n-ph="settings.currentPassword" />
                </div>
                <div class="form-group">
                    <label for="f_ADMIN_NEW" class="settings-field-label" data-i18n="settings.newPassword">Yeni Şifre</label>
                    <input id="f_ADMIN_NEW" type="password" placeholder="En az 6 karakter" data-i18n-ph="settings.newPassword" />
                </div>
                <div class="form-group">
                    <label for="f_ADMIN_NEW2" class="settings-field-label" data-i18n="settings.newPassword2">Yeni Şifre (Tekrar)</label>
                    <input id="f_ADMIN_NEW2" type="password" placeholder="Yeni Şifre (Tekrar)" data-i18n-ph="settings.newPassword2" />
                </div>
                <div class="settings-actions settings-actions--end">
                    <button id="changePassBtn" class="btn-primary" data-i18n="btn.changePassword">Şifreyi Güncelle</button>
                </div>
                <div class="settings-actions settings-actions--between">
                    <button id="logoutBtn" class="btn-outline" data-i18n="btn.logout">Çıkış</button>
                    <div class="settings-actions__right">
                        <button id="reloadBtn" class="btn-outline" data-i18n="btn.reload">Yenile</button>
                        <button id="saveBtn" class="btn-primary" data-i18n="btn.save">Kaydet</button>
                    </div>
                </div>
            </div>
        `;
    }

    setupEventListeners() {
        document.getElementById('settingsClose').onclick = () => this.close();
        document.getElementById('loginBtn').onclick = () => this.doLogin();
        document.getElementById('logoutBtn').onclick = () => this.doLogout();
        document.getElementById('reloadBtn').onclick = () => this.loadSettings();
        document.getElementById('saveBtn').onclick = () => this.saveSettings();
        document.getElementById('changePassBtn').onclick = () => this.changePassword();
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && this.modal.style.display === 'flex') {
                const loginView = document.getElementById('loginView');
                if (loginView && loginView.style.display !== 'none') {
                    e.preventDefault();
                    this.doLogin();
                }
            }
        });
    }

    open() {
        if (!this.isInitialized) this.initialize();

        this.modal.style.display = 'flex';
        const token = localStorage.getItem(this.tokenKey);

        if (token) {
            this.showForm();
            this.loadSettings();
        } else {
            this.showLogin();
            requestAnimationFrame(() => document.getElementById('adminPass')?.focus());
        }
    }

    close() {
        if (this.modal) {
            this.modal.style.display = 'none';
        }
    }

    showLogin() {
        document.getElementById('loginView').style.display = 'flex';
        document.getElementById('formView').style.display = 'none';
        document.getElementById('adminPass').value = '';
        document.getElementById('adminError').style.display = 'none';
    }

    showForm() {
        document.getElementById('loginView').style.display = 'none';
        document.getElementById('formView').style.display = 'block';
    }

    async doLogin() {
        const password = document.getElementById('adminPass').value;
        const errEl = document.getElementById('adminError');
        const btn = document.getElementById('loginBtn');
        const passEl = document.getElementById('adminPass');

        if (errEl) {
            errEl.style.display = 'none';
            errEl.textContent = '';
        }

        if (!password) {
            if (errEl) {
                errEl.textContent = this.t('errors.emptyPassword') || 'Lütfen şifreyi girin.';
                errEl.style.display = 'block';
            }
            passEl?.focus();
            return;
        }

        try {
            btn?.classList.add('btn-loading');
            btn && (btn.disabled = true);

            const r = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });

            if (!r.ok) {
                const e = await r.json().catch(() => ({}));
                const code = e?.error?.code;
                let msg =
                    (code === 'BAD_PASSWORD') ? (this.t('errors.BAD_PASSWORD') || 'Hatalı şifre.') :
                    (code === 'NO_ADMIN_PASSWORD') ? (this.t('errors.NO_ADMIN_PASSWORD') || 'Sunucuda ADMIN_PASSWORD tanımlı değil.') :
                    (e?.error?.message || this.t('errors.loginFailed') || 'Giriş yapılamadı.');
                throw new Error(msg);
            }

            const data = await r.json();
            localStorage.setItem(this.tokenKey, data.token);
            window.dispatchEvent(new CustomEvent('gharmonize:auth', { detail: { loggedIn: true } }));
            this.showForm();
            await this.loadSettings();

        } catch (e) {
            if (errEl) {
                errEl.textContent = String(e.message || 'Giriş hatası');
                errEl.style.display = 'block';
            }
            passEl?.classList.add('shake');
            setTimeout(() => passEl?.classList.remove('shake'), 350);
            passEl?.focus();
        } finally {
            btn?.classList.remove('btn-loading');
            btn && (btn.disabled = false);
        }
    }

    async doLogout() {
        localStorage.removeItem(this.tokenKey);
        window.dispatchEvent(new CustomEvent('gharmonize:auth', { detail: { loggedIn: false } }));
        this.showLogin();
        requestAnimationFrame(() => document.getElementById('adminPass')?.focus());
    }

    async loadSettings() {
        const token = localStorage.getItem(this.tokenKey) || "";
        try {
            const r = await fetch('/api/settings', {
                headers: { 'Authorization': 'Bearer ' + token }
            });

            if (r.status === 401) {
                this.showLogin();
                return;
            }

            const data = await r.json();
            const s = data.settings || {};

            document.getElementById('f_SPOTIFY_CLIENT_ID').value = s.SPOTIFY_CLIENT_ID || '';
            document.getElementById('f_SPOTIFY_CLIENT_SECRET').value = '';
            document.getElementById('f_SPOTIFY_MARKET').value = s.SPOTIFY_MARKET || '';
            document.getElementById('f_SPOTIFY_FALLBACK_MARKETS').value = s.SPOTIFY_FALLBACK_MARKETS || '';
            document.getElementById('f_YT_USE_MUSIC').value = s.YT_USE_MUSIC || '1';
            document.getElementById('f_PREFER_SPOTIFY_TAGS').value = s.PREFER_SPOTIFY_TAGS || '1';
            document.getElementById('f_TITLE_CLEAN_PIPE').value = s.TITLE_CLEAN_PIPE || '1';
            document.getElementById('f_YTDLP_UA').value = s.YTDLP_UA || '';
            document.getElementById('f_YTDLP_COOKIES').value = s.YTDLP_COOKIES || '';
            document.getElementById('f_YTDLP_COOKIES_FROM_BROWSER').value = s.YTDLP_COOKIES_FROM_BROWSER || '';
            document.getElementById('f_YTDLP_EXTRA').value = s.YTDLP_EXTRA || '';
            document.getElementById('f_YT_STRIP_COOKIES').value = (typeof s.YT_STRIP_COOKIES !== 'undefined' && s.YT_STRIP_COOKIES !== null)
                ? String(s.YT_STRIP_COOKIES)
                : '0';
            document.getElementById('f_YT_DEFAULT_REGION').value = s.YT_DEFAULT_REGION || '';
            document.getElementById('f_YT_LANG').value = s.YT_LANG || 'en-US';
            document.getElementById('f_YT_ACCEPT_LANGUAGE').value = s.YT_ACCEPT_LANGUAGE || '';
            document.getElementById('f_YT_FORCE_IPV4').value = (typeof s.YT_FORCE_IPV4 !== 'undefined' && s.YT_FORCE_IPV4 !== null) ? String(s.YT_FORCE_IPV4) : '1';
            document.getElementById('f_YT_403_WORKAROUNDS').value = (typeof s.YT_403_WORKAROUNDS !== 'undefined' && s.YT_403_WORKAROUNDS !== null) ? String(s.YT_403_WORKAROUNDS) : '1';
            document.getElementById('f_ENRICH_SPOTIFY_FOR_YT').value = s.ENRICH_SPOTIFY_FOR_YT || '1';
            document.getElementById('f_MEDIA_COMMENT').value = s.MEDIA_COMMENT || 'Gharmonize';
            document.getElementById('f_FFMPEG_BIN').value = s.FFMPEG_BIN || '';
            document.getElementById('f_YTDLP_BIN').value = s.YTDLP_BIN || '';

        } catch (e) {
            alert(this.t('settings.errorLoading') + ': ' + e.message);
        }
    }

    async saveSettings() {
        const token = localStorage.getItem(this.tokenKey) || "";
        const payload = {
            settings: {
                SPOTIFY_CLIENT_ID: document.getElementById('f_SPOTIFY_CLIENT_ID').value.trim(),
                SPOTIFY_CLIENT_SECRET: document.getElementById('f_SPOTIFY_CLIENT_SECRET').value.trim(),
                SPOTIFY_MARKET: document.getElementById('f_SPOTIFY_MARKET').value.trim(),
                SPOTIFY_FALLBACK_MARKETS: document.getElementById('f_SPOTIFY_FALLBACK_MARKETS').value.trim(),
                YT_USE_MUSIC: document.getElementById('f_YT_USE_MUSIC').value,
                PREFER_SPOTIFY_TAGS: document.getElementById('f_PREFER_SPOTIFY_TAGS').value,
                TITLE_CLEAN_PIPE: document.getElementById('f_TITLE_CLEAN_PIPE').value,
                YTDLP_UA: document.getElementById('f_YTDLP_UA').value,
                YTDLP_COOKIES: document.getElementById('f_YTDLP_COOKIES').value,
                YTDLP_COOKIES_FROM_BROWSER: document.getElementById('f_YTDLP_COOKIES_FROM_BROWSER').value,
                YTDLP_EXTRA: document.getElementById('f_YTDLP_EXTRA').value,
                YT_STRIP_COOKIES: document.getElementById('f_YT_STRIP_COOKIES').value,
                YT_DEFAULT_REGION: document.getElementById('f_YT_DEFAULT_REGION').value.trim(),
                YT_LANG: document.getElementById('f_YT_LANG').value.trim(),
                YT_ACCEPT_LANGUAGE: document.getElementById('f_YT_ACCEPT_LANGUAGE').value.trim(),
                YT_FORCE_IPV4: document.getElementById('f_YT_FORCE_IPV4').value,
                YT_403_WORKAROUNDS: document.getElementById('f_YT_403_WORKAROUNDS').value,
                ENRICH_SPOTIFY_FOR_YT: document.getElementById('f_ENRICH_SPOTIFY_FOR_YT').value,
                MEDIA_COMMENT: document.getElementById('f_MEDIA_COMMENT').value.trim(),
                YTDLP_BIN: document.getElementById('f_YTDLP_BIN').value.trim(),
                FFMPEG_BIN: document.getElementById('f_FFMPEG_BIN').value.trim()
            }
        };

        try {
            const r = await fetch('/api/settings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify(payload)
            });

            if (r.status === 401) {
                this.showLogin();
                return;
            }

            if (!r.ok) {
                const e = await r.json().catch(() => ({}));
                throw new Error(e?.error?.message || this.t('errors.saveFailed'));
            }

            alert(this.t('settings.saved') || 'Ayarlar kaydedildi.');
        } catch (e) {
            alert(this.t('settings.errorSaving') + ': ' + e.message);
        }
    }

    async changePassword() {
        const token = localStorage.getItem(this.tokenKey) || "";
        const oldPassword = document.getElementById('f_ADMIN_OLD').value;
        const newPassword = document.getElementById('f_ADMIN_NEW').value;
        const newPassword2 = document.getElementById('f_ADMIN_NEW2').value;

        if (!oldPassword || !newPassword || !newPassword2) {
            alert(this.t('settings.errors.fieldsRequired') || 'Tüm alanlar zorunludur.');
            return;
        }

        if (newPassword !== newPassword2) {
            alert(this.t('settings.errors.passwordMismatch') || 'Yeni şifreler eşleşmiyor.');
            return;
        }

        if (String(newPassword).length < 6) {
            alert(this.t('settings.errors.passwordTooShort') || 'Yeni şifre en az 6 karakter olmalıdır.');
            return;
        }

        try {
            const r = await fetch('/api/auth/change-password', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ oldPassword, newPassword, newPassword2 })
            });

            if (!r.ok) {
                const e = await r.json().catch(() => ({}));
                const code = e?.error?.code;
                const map = {
                    BAD_PASSWORD: 'errors.BAD_PASSWORD2',
                    PASSWORD_MISMATCH: 'errors.PASSWORD_MISMATCH',
                    PASSWORD_TOO_SHORT: 'errors.PASSWORD_TOO_SHORT',
                    FIELDS_REQUIRED: 'errors.FIELDS_REQUIRED',
                    PASSWORD_SAVE_FAILED: 'errors.PASSWORD_SAVE_FAILED',
                    UNAUTHORIZED: 'errors.UNAUTHORIZED'
                };
                const key = map[code] || 'errors.changePasswordFailed';
                const msg = this.t(key) || (e?.error?.message || 'Şifre değiştirilemedi.');
                throw new Error(msg);
            }

            const data = await r.json();
            alert(this.t('settings.passwordChanged') || 'Şifre güncellendi. Lütfen yeniden giriş yapın.');

            if (data.logout) {
                localStorage.removeItem(this.tokenKey);
                window.dispatchEvent(new CustomEvent('gharmonize:auth', { detail: { loggedIn: false } }));
                document.getElementById('f_ADMIN_OLD').value = '';
                document.getElementById('f_ADMIN_NEW').value = '';
                document.getElementById('f_ADMIN_NEW2').value = '';
                this.showLogin();
            }
        } catch (e) {
            alert(String(e.message || 'Şifre değiştirilemedi.'));
        }
    }

    t(key, vars) {
        return (window.i18n?.t?.(key, vars)) ?? key;
    }
}

export const settingsManager = new SettingsManager();
