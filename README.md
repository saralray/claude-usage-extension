# Claude Code usage extension

![GNOME Shell 46+](https://img.shields.io/badge/GNOME%20Shell-46%2B-blue)

A GNOME Shell extension that displays your Claude Code API usage percentage in the top panel.

## Features

- **Real-time usage monitoring** — view your 5-hour and 7-day Claude Code usage with color-coded progress bars
- **Configurable panel display** — show usage as a text percentage, a progress bar, or both, with a color or monochrome icon
- **Discord notifications** — send a message to a Discord webhook when usage crosses a configurable threshold
- **Token refresh alerts** — a desktop notification with the current usage and reset time when Claude Code refreshes its OAuth token
- **Proxy support** — route API requests through an HTTP proxy

## Requirements

- GNOME Shell 46 or later
- Claude Code installed and authenticated (`~/.claude/.credentials.json`, or `$CLAUDE_CONFIG_DIR/.credentials.json`)

## Installation

### Automatic

The extension is distributed on *extensions.gnome.org*: [Claude Code Usage](https://extensions.gnome.org/extension/9231/claude-code-usage/)

### Manual

```bash
git clone https://github.com/saralray/claude-usage-extension
cp -r claude-usage-extension ~/.local/share/gnome-shell/extensions/claude-code-usage@saralray
cd ~/.local/share/gnome-shell/extensions/claude-code-usage@saralray/schemas
glib-compile-schemas .
## Restart GNOME Shell: Alt + F2, type r (X11) or log out and back in (Wayland)
## Then enable the extension
```

## Settings

Open the settings from the extension's dropdown menu or via the Extensions app:

| Setting | Description | Default |
|---|---|---|
| Refresh Interval | How often usage data is fetched (10–600 seconds) | 300 |
| Display Mode | Panel shows text percentage, progress bar, or both | Text |
| Icon Style | Color or monochrome Claude icon | Color |
| Show Icon | Toggle the panel icon | On |
| Proxy URL | HTTP proxy for API requests (empty = no proxy) | Empty |
| Discord Webhook URL | Webhook to notify when usage crosses the threshold (empty = disabled) | Empty |
| Notification Threshold | Usage percentage that triggers a Discord notification | 90 |

### Discord notifications

Create a webhook in your Discord server (**Server Settings → Integrations → Webhooks**), paste its URL into the extension settings, and pick a threshold. When the 5-hour or 7-day usage reaches the threshold, a warning message is posted. Each window notifies once per limit period — the alert re-arms after the usage window resets.

## Disclaimer

This extension uses anthropic.com services but is not affiliated, funded, or in any way associated with Anthropic.
