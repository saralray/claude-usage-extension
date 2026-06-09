import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const API_URL = 'https://api.anthropic.com/api/oauth/usage';

// Set to true to surface diagnostics in `journalctl -f -o cat /usr/bin/gnome-shell`.
const DEBUG = false;

function logError(...args) {
    if (DEBUG)
        console.error('Claude Usage:', ...args);
}

const ClaudeUsageIndicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences) {
        super._init(0.0, 'Claude Usage Indicator');

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._session = this._createSession();
        this._cancellable = new Gio.Cancellable();
        this._fiveHourNotified = false;
        this._sevenDayNotified = false;
        this._hasData = false;
        this._retryTimerId = null;
        this._lastToken = null;
        this._tokenRefreshed = false;
        this._fetchFailures = 0;

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        const iconPath = GLib.build_filenamev([this._extensionPath, 'claude-icon-22.png']);
        const gicon = Gio.icon_new_for_string(iconPath);
        this._icon = new St.Icon({
            gicon: gicon,
            style_class: 'claude-icon',
            icon_size: 16,
        });
        this._box.add_child(this._icon);

        this._panelProgressBg = new St.Widget({
            style_class: 'claude-panel-progress-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelProgressBar = new St.Widget({
            style_class: 'claude-panel-progress-bar',
        });
        this._panelProgressBg.add_child(this._panelProgressBar);
        this._box.add_child(this._panelProgressBg);

        this._label = new St.Label({
            text: '...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-label',
        });
        this._box.add_child(this._label);

        this.add_child(this._box);

        this._createMenu();

        this._updateDisplayMode();
        this._updateIconVisibility();
        this._updateIconStyle();

        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else if (key === 'display-mode') {
                this._updateDisplayMode();
            } else if (key === 'show-icon') {
                this._updateIconVisibility();
            } else if (key === 'proxy-url') {
                this._recreateSession();
            } else if (key === 'icon-style') {
                this._updateIconStyle();
            } else if (key === 'discord-webhook-url' || key === 'discord-threshold') {
                this._fiveHourNotified = false;
                this._sevenDayNotified = false;
            }
        });

        this._refreshUsage();
        this._startTimer();
    }

    _updateDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        if (mode === 'bar') {
            this._panelProgressBg.show();
            this._label.hide();
            this._label.set_style('margin-left: 0;');
        } else if (mode === 'both') {
            this._panelProgressBg.show();
            this._label.show();
            this._label.set_style('margin-left: 6px;');
        } else {
            this._panelProgressBg.hide();
            this._label.show();
            this._label.set_style('margin-left: 0;');
        }
    }

    _updateIconVisibility() {
        const showIcon = this._settings.get_boolean('show-icon');
        if (showIcon) {
            this._icon.show();
        } else {
            this._icon.hide();
        }
    }

    _createSession() {
        const session = new Soup.Session({timeout: 15});
        const proxyUrl = this._settings.get_string('proxy-url');

        if (proxyUrl && proxyUrl.trim() !== '') {
            const proxyResolver = Gio.SimpleProxyResolver.new(proxyUrl.trim(), null);
            session.set_proxy_resolver(proxyResolver);
        }

        return session;
    }

    _recreateSession() {
        if (this._session) {
            this._session.abort();
        }
        this._session = this._createSession();
        this._refreshUsage();
    }

    _updateIconStyle() {
        const style = this._settings.get_string('icon-style');
        const desatName = 'monochrome-desaturate';
        const brightName = 'monochrome-brightness';
        const hasEffect = this._icon.get_effect(desatName) !== null;

        if (style === 'monochrome' && !hasEffect) {
            this._icon.add_effect(new Clutter.DesaturateEffect({factor: 1.0, name: desatName}));
            const brightnessEffect = new Clutter.BrightnessContrastEffect({name: brightName});
            brightnessEffect.set_brightness_full(1, 1, 1);
            this._icon.add_effect(brightnessEffect);
        } else if (style !== 'monochrome' && hasEffect) {
            this._icon.remove_effect_by_name(desatName);
            this._icon.remove_effect_by_name(brightName);
        }
    }

    _createMenu() {
        const fiveHourBox = new St.BoxLayout({
            style_class: 'claude-usage-section',
            vertical: true,
        });
        const fiveHourHeader = new St.BoxLayout({ vertical: false });
        const fiveHourLabel = new St.Label({
            text: '5-Hour Usage',
            style_class: 'claude-section-title',
        });
        fiveHourHeader.add_child(fiveHourLabel);
        this._fiveHourPercent = new St.Label({
            text: '...',
            style_class: 'claude-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        fiveHourHeader.add_child(this._fiveHourPercent);
        fiveHourBox.add_child(fiveHourHeader);

        const fiveHourProgressBg = new St.Widget({
            style_class: 'claude-progress-bg',
        });
        this._fiveHourProgressBar = new St.Widget({
            style_class: 'claude-progress-bar usage-low',
        });
        fiveHourProgressBg.add_child(this._fiveHourProgressBar);
        fiveHourBox.add_child(fiveHourProgressBg);

        this._fiveHourResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'claude-reset-label',
        });
        fiveHourBox.add_child(this._fiveHourResetLabel);

        const fiveHourItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        fiveHourItem.add_child(fiveHourBox);
        this.menu.addMenuItem(fiveHourItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const sevenDayBox = new St.BoxLayout({
            style_class: 'claude-usage-section',
            vertical: true,
        });
        const sevenDayHeader = new St.BoxLayout({ vertical: false });
        const sevenDayLabel = new St.Label({
            text: '7-Day Usage',
            style_class: 'claude-section-title',
        });
        sevenDayHeader.add_child(sevenDayLabel);
        this._sevenDayPercent = new St.Label({
            text: '...',
            style_class: 'claude-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        sevenDayHeader.add_child(this._sevenDayPercent);
        sevenDayBox.add_child(sevenDayHeader);

        const sevenDayProgressBg = new St.Widget({
            style_class: 'claude-progress-bg',
        });
        this._sevenDayProgressBar = new St.Widget({
            style_class: 'claude-progress-bar usage-low',
        });
        sevenDayProgressBg.add_child(this._sevenDayProgressBar);
        sevenDayBox.add_child(sevenDayProgressBg);

        this._sevenDayResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'claude-reset-label',
        });
        sevenDayBox.add_child(this._sevenDayResetLabel);

        const sevenDayItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        sevenDayItem.add_child(sevenDayBox);
        this.menu.addMenuItem(sevenDayItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            this._openPreferences();
        });
        this.menu.addMenuItem(settingsItem);
    }

    _startTimer() {
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._refreshUsage();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    _refreshUsage() {
        const configDir = GLib.getenv('CLAUDE_CONFIG_DIR') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        const credentialsPath = GLib.build_filenamev([
            configDir,
            '.credentials.json',
        ]);

        const file = Gio.File.new_for_path(credentialsPath);
        file.load_contents_async(this._cancellable, (file, result) => {
            if (this._cancellable.is_cancelled())
                return;
            try {
                const [, contents] = file.load_contents_finish(result);
                const decoder = new TextDecoder('utf-8');
                const json = JSON.parse(decoder.decode(contents));
                const token = json.claudeAiOauth?.accessToken;

                if (!token) {
                    this._onCredentialsError();
                    return;
                }

                if (this._lastToken !== null && token !== this._lastToken) {
                    this._tokenRefreshed = true;
                }
                this._lastToken = token;

                this._fetchUsage(token);
            } catch (e) {
                logError('Failed to read credentials:', e.message);
                this._onCredentialsError();
            }
        });
    }

    _fetchUsage(token) {
        const message = Soup.Message.new('GET', API_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (session, result) => {
                if (this._cancellable.is_cancelled())
                    return;
                try {
                    const bytes = session.send_and_read_finish(result);

                    if (message.status_code !== 200) {
                        logError(`API returned HTTP ${message.status_code}`);
                        this._onFetchError(`HTTP ${message.status_code}`);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));

                    this._updateDisplay(data);
                } catch (e) {
                    logError('Failed to fetch usage:', e.message);
                    this._onFetchError('Error');
                }
            }
        );
    }

    _onCredentialsError() {
        this._scheduleRetry();

        if (this._hasData)
            return;

        this._label.set_text('No token');
        this._fiveHourPercent.set_text('No credentials');
        this._sevenDayPercent.set_text('—');
    }

    _onFetchError(detail) {
        this._scheduleRetry();

        if (this._hasData)
            return;

        // Tolerate transient first-request hiccups (e.g. a single in-shell
        // socket timeout right after enable): keep the loading state and only
        // surface an error once a few consecutive attempts have failed.
        this._fetchFailures += 1;
        if (this._fetchFailures < 3)
            return;

        this._label.set_text('Error');
        this._fiveHourPercent.set_text(detail);
    }

    _scheduleRetry() {
        if (this._retryTimerId)
            return;
        this._retryTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            30,
            () => {
                this._retryTimerId = null;
                this._refreshUsage();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _clearRetry() {
        if (this._retryTimerId) {
            GLib.source_remove(this._retryTimerId);
            this._retryTimerId = null;
        }
    }

    _updateDisplay(data) {
        this._hasData = true;
        this._fetchFailures = 0;
        this._clearRetry();

        const fiveHour = data.five_hour?.utilization ?? 0;
        const sevenDay = data.seven_day?.utilization ?? 0;

        this._label.set_text(`${Math.round(fiveHour)}%`);

        this._updateProgressBar(this._panelProgressBar, fiveHour, 50);

        this._fiveHourPercent.set_text(`${fiveHour.toFixed(1)}%`);
        this._updateProgressBar(this._fiveHourProgressBar, fiveHour);

        this._sevenDayPercent.set_text(`${sevenDay.toFixed(1)}%`);
        this._updateProgressBar(this._sevenDayProgressBar, sevenDay);

        this._maybeNotifyDiscord(fiveHour, sevenDay, data);

        if (data.five_hour?.resets_at) {
            this._fiveHourResetLabel.set_text(
                `Resets in ${this._formatResetTime(data.five_hour.resets_at)}`
            );
        }

        if (this._tokenRefreshed) {
            this._tokenRefreshed = false;
            const resetIn = data.five_hour?.resets_at
                ? this._formatResetTime(data.five_hour.resets_at)
                : 'unknown';
            Main.notify(
                'Claude Usage',
                `Claude Code token usage is at ${fiveHour.toFixed(1)}%, refresh in ${resetIn}`
            );
        }

        if (data.seven_day?.resets_at) {
            this._sevenDayResetLabel.set_text(
                `Resets in ${this._formatResetTime(data.seven_day.resets_at)}`
            );
        }
    }

    _updateProgressBar(progressBar, usage, maxWidth = 200) {
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        progressBar.set_width(width);

        progressBar.remove_style_class_name('usage-low');
        progressBar.remove_style_class_name('usage-medium');
        progressBar.remove_style_class_name('usage-high');
        progressBar.remove_style_class_name('usage-critical');

        if (usage >= 90) {
            progressBar.add_style_class_name('usage-critical');
        } else if (usage >= 70) {
            progressBar.add_style_class_name('usage-high');
        } else if (usage >= 40) {
            progressBar.add_style_class_name('usage-medium');
        } else {
            progressBar.add_style_class_name('usage-low');
        }
    }

    _maybeNotifyDiscord(fiveHour, sevenDay, data) {
        const webhookUrl = this._settings.get_string('discord-webhook-url').trim();
        if (!webhookUrl) {
            return;
        }

        const threshold = this._settings.get_int('discord-threshold');
        const fiveHourReset = data.five_hour?.resets_at
            ? this._formatResetTime(data.five_hour.resets_at)
            : 'unknown';
        const sevenDayReset = data.seven_day?.resets_at
            ? this._formatResetTime(data.seven_day.resets_at)
            : 'unknown';
        this._fiveHourNotified = this._notifyIfAboveThreshold(
            webhookUrl, threshold, fiveHour, this._fiveHourNotified, fiveHourReset);
        this._sevenDayNotified = this._notifyIfAboveThreshold(
            webhookUrl, threshold, sevenDay, this._sevenDayNotified, sevenDayReset);
    }

    _notifyIfAboveThreshold(webhookUrl, threshold, usage, alreadyNotified, resetIn) {
        if (usage < threshold) {
            return false;
        }
        if (alreadyNotified) {
            return true;
        }

        this._sendDiscordMessage(
            webhookUrl,
            `Claude Code usage is at ${usage.toFixed(1)}%, token refresh at ${resetIn}`
        );
        return true;
    }

    _sendDiscordMessage(webhookUrl, content) {
        const message = Soup.Message.new('POST', webhookUrl);
        if (!message) {
            logError('Invalid Discord webhook URL');
            return;
        }

        const body = new TextEncoder().encode(JSON.stringify({content}));
        message.set_request_body_from_bytes('application/json', new GLib.Bytes(body));

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (session, result) => {
                try {
                    session.send_and_read_finish(result);
                    if (message.status_code < 200 || message.status_code >= 300) {
                        logError(`Discord webhook returned HTTP ${message.status_code}`);
                    }
                } catch (e) {
                    if (!this._cancellable.is_cancelled()) {
                        logError('Failed to send Discord notification:', e.message);
                    }
                }
            }
        );
    }

    _formatResetTime(isoString) {
        try {
            const resetDate = new Date(isoString);
            const now = new Date();
            const diffMs = resetDate - now;

            if (diffMs < 0) {
                return 'now';
            }

            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMins / 60);
            const diffDays = Math.floor(diffHours / 24);

            if (diffDays > 0) {
                return `${diffDays}d ${diffHours % 24}h`;
            } else if (diffHours > 0) {
                return `${diffHours}h ${diffMins % 60}m`;
            } else {
                return `${diffMins}m`;
            }
        } catch (e) {
            return '—';
        }
    }

    destroy() {
        this._stopTimer();
        this._clearRetry();
        this._cancellable.cancel();
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new ClaudeUsageIndicator(
            this.path,
            this._settings,
            () => this.openPreferences()
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
