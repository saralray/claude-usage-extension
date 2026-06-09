# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A GNOME Shell extension (GJS/ESM, GNOME Shell 46+) that displays Claude Code usage percentages in the top panel. It reads the OAuth token from `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`) and polls `https://api.anthropic.com/api/oauth/usage` for 5-hour and 7-day utilization.

There is no build system, package manager, linter, or test suite — the extension is plain GJS installed by copying files.

## Commands

Install/update the extension locally (copies repo to the extensions dir, compiles schemas, then logs out the session):

```bash
./update
```

Manual equivalent without logging out:

```bash
cp -r . ~/.local/share/gnome-shell/extensions/claude-code-usage@saralray
glib-compile-schemas ~/.local/share/gnome-shell/extensions/claude-code-usage@saralray/schemas
```

After editing schema XML, `glib-compile-schemas schemas/` must be re-run. GNOME Shell must be restarted to pick up extension.js changes (Alt+F2 → `r` on X11, or log out on Wayland). View runtime logs with `journalctl -f -o cat /usr/bin/gnome-shell`.

## Architecture

- **extension.js** — everything at runtime. `ClaudeUsageExtension` (enable/disable lifecycle) creates a single `ClaudeUsageIndicator` (a `PanelMenu.Button`). The indicator owns the panel widgets (icon, mini progress bar, percentage label), the dropdown menu (5-hour and 7-day sections with progress bars and reset times), a `Soup.Session` for HTTP (with optional proxy via `Gio.SimpleProxyResolver`), and a `GLib.timeout_add_seconds` refresh timer. All I/O is async (`load_contents_async`, `send_and_read_async`).
- **prefs.js** — separate Adw/Gtk preferences window (runs in its own process, cannot share state with extension.js). Settings flow only through GSettings.
- **schemas/org.gnome.shell.extensions.claude-code-usage.gschema.xml** — the GSettings keys: `refresh-interval`, `display-mode` (`text`/`bar`/`both`), `icon-style` (`color`/`monochrome`), `show-icon`, `proxy-url`. The indicator reacts to changes live via a `settings.connect('changed')` handler in `_init` — new settings keys need a case added there plus a row in prefs.js.
- **stylesheet.css** — style classes referenced from extension.js; usage thresholds map to `usage-low/medium/high/critical` classes (<40/70/90/≥90%) in `_updateProgressBar`.

## Conventions

- `metadata.json` `version` must be bumped for releases to extensions.gnome.org, and `shell-version` lists supported GNOME versions.
- The API requires the `anthropic-beta: oauth-2025-04-20` header alongside the Bearer token.
- `destroy()` must clean up everything created in `_init` (timer, Soup session, settings signal handler) — extensions.gnome.org review rejects leaks.
