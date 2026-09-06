export class VersionManager {
    // Initializes class state and defaults for the browser UI layer.
    constructor() {
        // Reads cached browser values before initializing live state.
        const cached = (() => {
            try {
                return localStorage.getItem('gharmonize_current_version');
            } catch {
                return null;
            }
        })();

        this.currentVersion = cached || '1.0.7';
        this.githubRepo = 'G-grbz/Gharmonize';
        this.checkInterval = 24 * 60 * 60 * 1000;
        this.lastCheckKey = 'gharmonize_last_version_check';
        this.latestVersionKey = 'gharmonize_latest_version';
        this.latestReleaseUrlKey = 'gharmonize_latest_release_url';
        this.updateShownKey = 'gharmonize_update_shown_';

        this.isChecking = false;
        this.isManualCheck = false;
    }

    // Initializes startup state for the browser UI layer.
    async initialize() {
    try {
        const response = await fetch('/api/version');
        if (response.ok) {
            const data = await response.json();
            this.currentVersion = data.version || '1.0.7';
            try {
                localStorage.setItem('gharmonize_current_version', this.currentVersion);
            } catch (e) {
                console.warn('gharmonize_current_version could not be saved:', e);
            }

            console.log(`🔍 ${this.t('version.current')}: v${this.currentVersion}`);
        }
    } catch (error) {
        console.warn(this.t('version.fetchError'), error);
    }

    if (this.shouldCheck()) {
        await this.checkForUpdates();
    }
}

    // Determines whether check should run for the browser UI layer.
    shouldCheck() {
        if (this.isManualCheck) return true;

        const lastCheck = localStorage.getItem(this.lastCheckKey);
        if (!lastCheck) return true;

        const lastCheckTime = parseInt(lastCheck, 10);
        return Date.now() - lastCheckTime > this.checkInterval;
    }

    // Handles check for updates in the browser UI layer.
    async checkForUpdates() {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
        console.log(this.t('version.checking'));
        const response = await fetch(
            `https://api.github.com/repos/${this.githubRepo}/releases/latest`
        );
        if (!response.ok) throw new Error(this.t('version.apiError'));

        const data = await response.json();
        const latestVersion = (data.tag_name || '').replace(/^v/, '');
        const releaseUrl =
            data.html_url ||
            `https://github.com/${this.githubRepo}/releases/tag/v${latestVersion}`;

        console.log(
            `${this.t('version.latest')}: v${latestVersion}, ` +
            `${this.t('version.current')}: v${this.currentVersion}`
        );

        if (!this.isManualCheck) {
            localStorage.setItem(this.lastCheckKey, Date.now().toString());
        }
        localStorage.setItem(this.latestVersionKey, latestVersion);
        localStorage.setItem(this.latestReleaseUrlKey, releaseUrl);

        if (this.isNewerVersion(latestVersion, this.currentVersion)) {
            console.log(this.t('version.updateFound'));
            await this.notifyNewVersion(latestVersion, data);
        } else {
            console.log(this.t('version.upToDate'));
            if (this.isManualCheck) {
                this.showUpToDateNotification();
            }
        }
    } catch (error) {
        console.warn(this.t('version.checkFailed'), error);
        if (this.isManualCheck) {
            this.showErrorNotification(error);
        }
    } finally {
        this.isChecking = false;
        this.isManualCheck = false;
    }
}


    // Checks whether newer version metadata is valid for the browser UI layer.
    isNewerVersion(latest, current) {
        if (!latest) return false;

        const latestParts = String(latest).split('.').map(Number);
        const currentParts = String(current).split('.').map(Number);

        for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
            const lp = latestParts[i] || 0;
            const cp = currentParts[i] || 0;
            if (lp > cp) return true;
            if (lp < cp) return false;
        }
        return false;
    }

    // Sends new version metadata notifications in the browser UI layer.
    async notifyNewVersion(latestVersion, releaseData) {
        const updateShown = localStorage.getItem(this.updateShownKey + latestVersion);
        const releaseNotes = releaseData.body || '';
        const releaseUrl = releaseData.html_url;
        this.showJobsPanelNotification(latestVersion, releaseUrl);
        if (!this.isManualCheck && updateShown) {
            console.log(this.t('version.alreadyShown', { version: latestVersion }));
            return;
        }

        await this.showMainNotification(latestVersion, releaseNotes, releaseUrl);

        if (!this.isManualCheck) {
            localStorage.setItem(this.updateShownKey + latestVersion, 'true');
        }
    }

    // Shows job state panel notification in the browser UI layer.
    showJobsPanelNotification(latestVersion, releaseUrl) {
        if (window.jobsPanelManager) {
            const jobsPanelManager = window.jobsPanelManager;
            jobsPanelManager.state.hasUpdate = true;
            jobsPanelManager.state.latestVersion = latestVersion;
            jobsPanelManager.state.releaseUrl = releaseUrl;
            jobsPanelManager.render();

            console.log(this.t('version.jobsPanelAdded'));
        }
    }

    // Shows main notification in the browser UI layer.
    async showMainNotification(latestVersion, releaseNotes, releaseUrl) {
        if (!window.modalManager) {
            const msg = `${this.t('version.newVersionAvailable')}: v${latestVersion}`;
            this.showSimpleNotification(msg, 'success');
            return;
        }

        const notesHtml = this.formatReleaseNotes(releaseNotes);

        const html = `
            <div class="release-notes">
                <p><strong>${this.t('version.currentVersion')}:</strong> v${this.currentVersion}</p>
                <p><strong>${this.t('version.newVersion')}:</strong> v${latestVersion}</p>

                ${notesHtml
                    ? `
                    <h3 style="margin-top:12px;">${this.t('version.changes')}</h3>
                    <div class="release-notes-body">
                        ${notesHtml}
                    </div>
                `
                    : ''
                }

                <p class="release-hint" style="font-size:13px;margin-top:12px;">
                    ${this.t('version.downloadHint')}
                </p>
            </div>
        `;

        return new Promise((resolve) => {
            window.modalManager.showAlert({
                title: this.t('version.modalTitle'),
                message: html,
                buttonText: this.t('version.viewOnGitHub'),
                type: 'success',
                allowHtml: true
            }).then((confirmed) => {

                if (confirmed === true && releaseUrl) {
                    window.open(releaseUrl, '_blank');
                }

                resolve(confirmed);
            });
        });
    }

    // Handles check now in the browser UI layer.
    async checkNow() {
        this.isManualCheck = true;
        await this.checkForUpdates();
    }

    // Shows up to date notification in the browser UI layer.
    showUpToDateNotification() {
        if (window.modalManager) {
            const html = `
                <div style="text-align:left;line-height:1.5;">
                    <p><strong>${this.t('version.currentVersion')}:</strong> v${this.currentVersion}</p>
                    <p>${this.t('version.usingLatest')}</p>
                </div>
            `;

            window.modalManager.showAlert({
                title: this.t('version.upToDateTitle'),
                message: html,
                buttonText: this.t('btn.ok'),
                type: 'success',
                allowHtml: true
            });
        } else {
            this.showSimpleNotification(this.t('version.usingLatest'), 'success');
        }
    }

    // Shows error notification in the browser UI layer.
    showErrorNotification(error) {
        if (window.modalManager) {
            const html = `
                <div style="text-align:left;line-height:1.5;">
                    <p>${this.t('version.checkErrorOccurred')}</p>
                    <p style="color:var(--error);font-size:14px;">${this.escapeHtml(
                        error.message || String(error)
                    )}</p>
                </div>
            `;

            window.modalManager.showAlert({
                title: this.t('version.checkFailedTitle'),
                message: html,
                buttonText: this.t('btn.ok'),
                type: 'danger',
                allowHtml: true
            });
        } else {
            this.showSimpleNotification(
                `${this.t('version.checkFailed')}: ${error.message}`,
                'error'
            );
        }
    }

    // Shows simple notification in the browser UI layer.
    showSimpleNotification(message, type = 'info') {
        console.log(`[${type.toUpperCase()}] ${message}`);

        if (window.app?.showNotification) {
            window.app.showNotification(message, type);
            return;
        }

        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${
                type === 'success'
                    ? 'var(--success)'
                    : type === 'error'
                        ? 'var(--error)'
                        : 'var(--accent)'
            };
            color: white;
            padding: 12px 16px;
            border-radius: 8px;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        `;
        toast.textContent = message;

        document.body.appendChild(toast);

        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 3000);
    }

    // Formats release notes for the browser UI layer.
    formatReleaseNotes(notes) {
        const text = String(notes || '').replace(/\r\n?/g, '\n');

        const formatInline = (value) => {
            const placeholders = [];
            const stash = (html) => {
                const index = placeholders.push(html) - 1;
                return `\uE000${index}\uE001`;
            };
            const withProtectedTokens = String(value)
                .replace(/`([^`\n]+)`/g, (_match, code) => stash(`<code>${this.escapeHtml(code)}</code>`))
                .replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g,
                (_match, label, href) => {
                    try {
                        const url = new URL(href);
                        if (url.protocol !== 'https:' && url.protocol !== 'http:') return this.escapeHtml(label);
                        return stash(`<a href="${this.escapeHtml(url.toString())}" target="_blank" rel="noopener noreferrer">${this.escapeHtml(label)}</a>`);
                    } catch {
                        return this.escapeHtml(label);
                    }
                }
            );

            return this.escapeHtml(withProtectedTokens)
                .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
                .replace(/(^|[^*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
                .replace(/(^|[^_])_(?=\S)([^_\n]*?\S)_(?!_)/g, '$1<em>$2</em>')
                .replace(/\uE000(\d+)\uE001/g, (_match, index) => placeholders[Number(index)] || '');
        };

        const lines = text.split('\n');
        const blocks = [];
        let paragraph = [];
        let list = null;

        const flushParagraph = () => {
            if (!paragraph.length) return;
            blocks.push(`<p>${paragraph.map(formatInline).join('<br>')}</p>`);
            paragraph = [];
        };
        const flushList = () => {
            if (!list?.items.length) return;
            blocks.push(`<${list.type}>${list.items.map((item) => `<li>${formatInline(item)}</li>`).join('')}</${list.type}>`);
            list = null;
        };

        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            const fence = line.match(/^```\s*([\w-]+)?\s*$/);
            if (fence) {
                flushParagraph();
                flushList();
                const codeLines = [];
                index += 1;
                while (index < lines.length && !/^```\s*$/.test(lines[index])) {
                    codeLines.push(lines[index]);
                    index += 1;
                }
                const language = String(fence[1] || '').replace(/[^a-z0-9_-]/gi, '');
                const className = language ? ` class="language-${language}"` : '';
                blocks.push(`<pre><code${className}>${this.escapeHtml(codeLines.join('\n'))}</code></pre>`);
                continue;
            }

            const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
            if (heading) {
                flushParagraph();
                flushList();
                const level = Math.min(6, heading[1].length + 1);
                blocks.push(`<h${level}>${formatInline(heading[2])}</h${level}>`);
                continue;
            }

            const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
            const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
            if (unordered || ordered) {
                flushParagraph();
                const type = ordered ? 'ol' : 'ul';
                if (list && list.type !== type) flushList();
                if (!list) list = { type, items: [] };
                list.items.push((unordered || ordered)[1]);
                continue;
            }

            if (!line.trim()) {
                flushParagraph();
                flushList();
                continue;
            }

            flushList();
            paragraph.push(line);
        }

        flushParagraph();
        flushList();
        return blocks.join('');
    }

    // Handles dismiss update in the browser UI layer.
    dismissUpdate() {
        if (window.jobsPanelManager) {
            window.jobsPanelManager.state.hasUpdate = false;
            window.jobsPanelManager.render();
            console.log(this.t('version.notificationDismissed'));
        }
    }

    // Handles view release in the browser UI layer.
    viewRelease() {
        if (window.jobsPanelManager?.state?.releaseUrl) {
            window.open(window.jobsPanelManager.state.releaseUrl, '_blank');
        }
    }

    // Handles escape html in the browser UI layer.
    escapeHtml(str) {
        if (str == null) return '';
        const escapeMap = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
            '`': '&#96;',
            '=': '&#61;',
            '/': '&#47;'
        };
        return String(str).replace(/[&<>"'`=\/]/g, s => escapeMap[s] || s);
    }

    // Handles t in the browser UI layer.
    t(key, vars) {
        return (window.i18n?.t?.(key, vars)) ?? key;
    }
}

export const versionManager = new VersionManager();

if (typeof window !== 'undefined') {
    window.versionManager = versionManager;
}
