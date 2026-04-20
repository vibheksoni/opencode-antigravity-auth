# opencode-antigravity-auth

Antigravity auth, account management, quota inspection, runtime metadata extraction, and bridge support for OpenCode.

This is one of the best-maintained Antigravity plugins for OpenCode. The focus is simple: stay as close as possible to the real installed Antigravity app instead of hardcoding brittle request behavior.

> [!TIP]
> **Sponsor**
> OpenAI account subscription upgrades @ discounted rates.
>
> **Gemini Ultra Accounts @ $20 each**
> Instant delivery: https://upgrades.astck.com/
> Use code `repodiscount` for $5 off

> [!IMPORTANT]
> The Antigravity language server and headless bridge path is the most stable way to use Antigravity from OpenCode.
> If you want the behavior closest to the IDE, use the installed Antigravity app and let this plugin read its runtime metadata and language server binaries.
> Looser request-only paths drift faster, hit rate limits sooner, and are more likely to cause account-state problems or bans.

## What This Plugin Does

- Google OAuth login for Antigravity-compatible accounts
- Multi-account storage, rotation, quota inspection, and verification
- Runtime metadata extraction from the installed Antigravity app
- Bridge support for the Antigravity language server and headless flows
- Runtime model discovery with safe fallback catalogs
- `/ag-accounts` TUI for account management inside OpenCode

## Requirements

- Windows is the primary supported path for the Antigravity bridge and local app discovery
- Node.js 20+
- Bun available if you want to run the local helper commands exactly as documented below
- An installed Antigravity app if you want runtime metadata extraction and the most stable bridge behavior

Default installed Antigravity app root on Windows:

```text
C:\Users\<you>\AppData\Local\Programs\Antigravity\resources\app
```

## Quick Start

### 1. Clone and install

```powershell
git clone https://github.com/vibheksoni/opencode-antigravity-auth.git
cd opencode-antigravity-auth
npm install
npm run build
```

### 2. Add the plugin to OpenCode

Use the active `opencode.json` or `opencode.jsonc`.

Common locations:

- project-local: `<workspace>\.opencode\opencode.json`
- custom config dir: `%OPENCODE_CONFIG_DIR%\opencode.json`
- default user config: `%USERPROFILE%\.config\opencode\opencode.json`

Local development example:

```json
{
  "plugin": [
    [
      "C:\\absolute\\path\\to\\opencode-antigravity-auth",
      {
        "force_headless": true,
        "cleanup_on_exit": true,
        "debug": true
      }
    ]
  ]
}
```

Published plugin example:

```json
{
  "plugin": [
    [
      "opencode-antigravity-auth@latest",
      {
        "force_headless": true,
        "cleanup_on_exit": true
      }
    ]
  ]
}
```

Default tuple plugin behavior when these values are omitted:

- `force_headless: true`
- `cleanup_on_exit: true`
- `debug: false`
- `single_headless: false`
- `app_dir: auto-detect from the installed Antigravity app`

### 3. Add the TUI plugin on newer OpenCode versions

Newer OpenCode builds load the server plugin and the TUI plugin separately.

That means:

- `opencode-antigravity-auth` handles the server/auth/runtime side
- `opencode-antigravity-auth/tui` handles slash commands and the account manager UI

If `bun run account -- list` works but `/ag-accounts` does not appear, the usual cause is that the TUI plugin was never added.

Use the active `tui.json`.

Common locations:

- project-local: `<workspace>\.opencode\tui.json`
- custom config dir: `%OPENCODE_CONFIG_DIR%\tui.json`
- default user config: `%USERPROFILE%\.config\opencode\tui.json`

Installed plugin example:

```json
{
  "plugin": [
    "opencode-antigravity-auth/tui"
  ]
}
```

Local path example:

```json
{
  "plugin": [
    "C:\\absolute\\path\\to\\opencode-antigravity-auth\\tui"
  ]
}
```

If your local setup expects the path-style spec exactly as a filesystem string, this form also works:

```json
{
  "plugin": [
    "C:\\absolute\\path\\to\\opencode-antigravity-auth/tui"
  ]
}
```

After adding the TUI entry, restart OpenCode and then use:

- `/ag-accounts`
- `/ag`

### 4. Optional runtime config

This plugin also reads its own config file:

- project-local: `<workspace>\.opencode\antigravity.json`
- user-level: `%OPENCODE_CONFIG_DIR%\antigravity.json` or `%USERPROFILE%\.config\opencode\antigravity.json`

Example:

```json
{
  "debug": true,
  "debug_tui": false,
  "keep_thinking": false,
  "session_recovery": true,
  "auto_resume": false,
  "account_selection_strategy": "hybrid",
  "scheduling_mode": "cache_first",
  "quota_refresh_interval_minutes": 15
}
```

### 5. Start OpenCode and authenticate

```powershell
opencode
opencode auth login
```

Choose:

1. Provider: `google`
2. Method: `OAuth with Google (Antigravity)`
3. OAuth client: `Standard` or `GCP ToS`

### 6. Open the account manager

Inside OpenCode use:

- `/ag-accounts`
- `/ag`

From there you can:

- add accounts
- verify accounts
- check quotas
- inspect per-account details
- write model definitions into `opencode.json`
- tune load balancer settings

## TUI Setup Notes

For current OpenCode releases, the separate TUI entry is important:

- server plugin spec: `opencode-antigravity-auth`
- TUI plugin spec: `opencode-antigravity-auth/tui`

For local path installs:

- server plugin path: `C:\path\to\opencode-antigravity-auth`
- TUI plugin path: `C:\path\to\opencode-antigravity-auth\tui`

Without the TUI plugin entry:

- the standalone helper can still work
- auth/runtime behavior may still exist
- but `/ag-accounts` and other TUI-side commands will not load

## Recommended Windows Setup

If Antigravity is installed in the default Windows location, this is usually enough:

```json
{
  "plugin": [
    [
      "opencode-antigravity-auth@latest"
    ]
  ]
}
```

If your Antigravity install lives elsewhere, add `app_dir`:

```json
{
  "plugin": [
    [
      "opencode-antigravity-auth@latest",
      {
        "app_dir": "C:\\Users\\<you>\\AppData\\Local\\Programs\\Antigravity\\resources\\app",
        "force_headless": true,
        "cleanup_on_exit": true,
        "debug": true
      }
    ]
  ]
}
```

## Config Sources

There are two separate config layers:

### OpenCode tuple plugin options

These live in `opencode.json` or `opencode.jsonc` and control plugin registration plus bridge-oriented runtime options.

Useful tuple options:

- `app_dir`
- `debug`
- `log_dir`
- `force_headless`
- `single_headless`
- `cleanup_on_exit`
- `bridge.force_headless`
- `bridge.single_headless`
- `bridge.cleanup_on_exit`
- `bridge.debug`
- `bridge.log_dir`
- `bridge.app_dir`

If you do not set them, the bridge defaults are:

- `force_headless: true`
- `cleanup_on_exit: true`
- `debug: false`
- `single_headless: false`

### `antigravity.json`

This is the plugin's own runtime config file and controls behavior such as:

- `keep_thinking`
- `session_recovery`
- `auto_resume`
- `resume_text`
- `account_selection_strategy`
- `scheduling_mode`
- `quota_refresh_interval_minutes`
- `soft_quota_threshold_percent`
- `cli_first`
- `auto_update`

## Bridge and LS Server Behavior

Bridge mode uses the installed Antigravity app to discover:

- runtime version
- OAuth client IDs and secrets
- language server binaries

Windows language server binaries are expected under:

```text
<app_dir>\extensions\antigravity\bin
```

If the standard app install exists, you usually do not need to configure anything else.

If you want the bridge to prefer a specific installed client or binary:

- set tuple option `app_dir`
- or set `OPENCODE_ANTIGRAVITY_APP_DIR`
- or set `CODEIUM_LANGUAGE_SERVER_BIN` to a specific language server binary

## Standalone Account Helper

After building, you can use the standalone helper:

```powershell
bun run account
bun run account -- add
bun run account -- add --no-browser
bun run account -- add --gcp-tos
bun run account -- list
bun run account -- clear
```

## Environment Variables Actually Read by Runtime

These are the environment variables the code actually reads today.

### Core plugin runtime

- `OPENCODE_ANTIGRAVITY_APP_DIR`
- `OPENCODE_ANTIGRAVITY_CLIENT_ID`
- `OPENCODE_ANTIGRAVITY_CLIENT_SECRET`
- `OPENCODE_ANTIGRAVITY_GCP_TOS_CLIENT_ID`
- `OPENCODE_ANTIGRAVITY_GCP_TOS_CLIENT_SECRET`
- `OPENCODE_ANTIGRAVITY_GCP_TOS`
- `OPENCODE_ANTIGRAVITY_OAUTH_BIND`
- `OPENCODE_ANTIGRAVITY_DEBUG`
- `OPENCODE_ANTIGRAVITY_DEBUG_TUI`
- `OPENCODE_ANTIGRAVITY_CONSOLE_LOG`

### Bridge and headless runtime

- `OPENCODE_ANTIGRAVITY_BRIDGE_FORCE_HEADLESS`
- `OPENCODE_ANTIGRAVITY_BRIDGE_DEBUG`
- `OPENCODE_ANTIGRAVITY_BRIDGE_DEBUG_HEADLESS`
- `OPENCODE_ANTIGRAVITY_BRIDGE_BASE_URL`
- `CODEIUM_LANGUAGE_SERVER_BIN`

### OpenCode pathing and auth storage

- `OPENCODE_CONFIG_DIR`
- `OPENCODE_GLOBAL_DATA_DIR`

### Other runtime knobs

- `OPENCODE_IMAGE_ASPECT_RATIO`

Important nuance:

- `quiet_mode`, `toast_scope`, `log_dir`, `account_selection_strategy`, `scheduling_mode`, and similar knobs are runtime config keys
- some source comments still mention env overrides for those keys
- the list above is the set of env vars actually read directly by runtime code today

## Debug Logs

Debug files go under:

- `%OPENCODE_CONFIG_DIR%\antigravity-logs` when `OPENCODE_CONFIG_DIR` is set
- otherwise `%USERPROFILE%\.config\opencode\antigravity-logs`

The TUI config writer and `/ag-accounts` actions now also respect `OPENCODE_CONFIG_DIR`, so source-mode and wrapper launches update the same config root the runtime is using.

Useful markers in the debug logs:

- `tui-init`
- `tui-quota-open`
- `tui-quota-results`
- `token-refresh-start`
- `token-refresh-success`
- `token-refresh-interop-fallback`
- `quota-check-error`
- `bridge-headless-started`
- `bridge-account-selected`
- `bridge-chat-success`

## Configure Models from the TUI

`/ag-accounts -> Configure models` writes plugin model definitions into the active OpenCode config file.

That action now respects:

1. `OPENCODE_CONFIG_DIR`
2. existing `opencode.jsonc`
3. existing `opencode.json`

It will not silently write to the wrong config root when you are launching OpenCode from a custom wrapper or source checkout.

## Build and Test

Build:

```powershell
npm run build
```

Regenerate schema:

```powershell
npm run build:schema
```

Run tests:

```powershell
npm test
```

Run targeted tests:

```powershell
npm test -- --run src/plugin/token.test.ts src/plugin/quota.test.ts src/plugin/logger.test.ts src/plugin/debug.test.ts
npm test -- --run src/plugin/config/schema.test.ts src/plugin/config/updater.test.ts src/bridge/options.test.ts
```

## Current Notes

- The plugin tries to extract runtime metadata from the local app first, then falls back cleanly
- Model discovery can fail with live `403` responses on some accounts, so static fallback models remain important
- Quota inspection merges Antigravity buckets with Gemini CLI quota reporting
- The bridge keeps a headless fallback path because it matches the IDE more closely than direct request emulation

## Acknowledgements

Credit to the original work at [NoeFabris/opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth).

This repo has diverged significantly from that older implementation and continues to be maintained around the current Antigravity app behavior, Windows bridge support, runtime metadata extraction, quota tooling, and OpenCode integration.
