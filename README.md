# opencode-antigravity-auth

Antigravity auth and runtime plugin for OpenCode.

This repo contains the current local implementation for:

- Google OAuth login against Antigravity-compatible flows
- multi-account persistence and rotation
- Cloud Code endpoint routing
- runtime Antigravity metadata extraction from the local app
- runtime model discovery with safe fallback behavior

## Overview

The plugin is designed to make OpenCode behave more like the local Antigravity IDE integration.

Current focus areas:

- `google-auth-library` OAuth flow instead of a hand-rolled exchange path
- dynamic localhost OAuth callback port
- support for both the standard and GCP ToS OAuth client pairs
- local app metadata extraction from the installed Antigravity app before falling back to baked-in defaults
- Antigravity runtime model discovery without breaking when discovery is denied

## Install

### 1. Clone the repo

```powershell
git clone https://github.com/vibheksoni/opencode-antigravity-auth.git
cd opencode-antigravity-auth
```

### 2. Install dependencies

```powershell
$env:NODE_ENV=''
npm install --include=dev
```

### 3. Build the plugin

```powershell
bun run build
```

## Setup In OpenCode

### 1. Add the plugin to your OpenCode config

Add the local plugin path to your OpenCode config.

Example:

```json
{
  "plugin": [
    "path/to/opencode-antigravity-auth"
  ]
}
```

### 2. Start OpenCode

```powershell
opencode
```

### 3. Authenticate

Inside OpenCode:

```powershell
opencode auth login
```

Choose:

1. Provider: `google`
2. Method: `OAuth with Google (Antigravity)`
3. OAuth client: `Standard` or `GCP ToS`

### 4. Verify the provider registry

```powershell
opencode models google
```

## Standalone Account Helper

If you want a direct account flow outside the OpenCode auth menu, use the helper CLI after building.

Examples:

```powershell
bun run account
bun run account -- --no-browser
bun run account -- --gcp-tos
```

Available commands:

```powershell
bun run account -- help
bun run account -- list
bun run account -- clear
```

## Current Behavior

### OAuth

The plugin now uses `google-auth-library` for:

- auth URL generation
- authorization code exchange
- token refresh

It also supports:

- dynamic localhost callback ports
- standard Antigravity OAuth client pair
- GCP ToS OAuth client pair

### Local App Metadata Extraction

At startup the plugin tries to discover live Antigravity runtime metadata from the local app.

Sources checked:

- installed Antigravity app
- local formatted app copy
- explicit override via `OPENCODE_ANTIGRAVITY_APP_DIR`

It extracts:

- `product.json` `ideVersion`
- OAuth client IDs and secrets from `out/main.js`

Fallback order:

1. local app metadata
2. explicit environment variables
3. remote version fetch for version only
4. current baked-in non-sensitive defaults

Supported environment overrides:

- `OPENCODE_ANTIGRAVITY_APP_DIR`
- `OPENCODE_ANTIGRAVITY_CLIENT_ID`
- `OPENCODE_ANTIGRAVITY_CLIENT_SECRET`
- `OPENCODE_ANTIGRAVITY_GCP_TOS_CLIENT_ID`
- `OPENCODE_ANTIGRAVITY_GCP_TOS_CLIENT_SECRET`

### Model Handling

The plugin uses two model sources:

- static fallback provider models already present in the Google provider config
- runtime-discovered Antigravity models from `fetchAvailableModels`

Important behavior:

- runtime-discovered models are merged into the provider registry
- if discovery fails or returns `403`, the static fallback catalog is kept
- runtime-discovered entries are converted into full OpenCode provider model objects

## Important Files

| File | Purpose |
| --- | --- |
| `src/plugin.ts` | Main plugin auth/provider/runtime flow |
| `src/antigravity/oauth.ts` | OAuth URL generation and token exchange |
| `src/plugin/token.ts` | Refresh flow |
| `src/plugin/project.ts` | Project bootstrap and `loadCodeAssist` handling |
| `src/plugin/cloud-code.ts` | Cloud Code endpoint selection |
| `src/plugin/runtime-metadata.ts` | Local app metadata extraction |
| `src/plugin/model-catalog.ts` | Runtime model discovery |
| `src/plugin/account-persistence.ts` | Shared account save and dedupe logic |
| `src/cli/account.ts` | Standalone account helper |

## Build And Test

Build:

```powershell
$env:NODE_ENV=''
bun run build
```

Full test run:

```powershell
bun test
```

Targeted test run:

```powershell
bun test src/plugin/auth.test.ts
bun test src/plugin/model-catalog.test.ts
bun test src/plugin/request.test.ts
```

## Current Limitations

This plugin is closer to the local Antigravity app than older versions, but it is still not a byte-for-byte recreation.

Known remaining gaps:

- enterprise admin-controls UX is not fully mirrored
- project-picker UX is not fully recreated
- some Antigravity UI and state-sync behavior is still app-specific

## Safety

This is unofficial integration code.

- upstream app behavior can change
- local app metadata extraction is best-effort
- fallback paths are intentionally kept so the plugin still works when extraction fails

## Acknowledgements

Credit to the original work at [NoeFabris/opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth).

That repo is outdated relative to this codebase. This version has diverged significantly and adds substantial fixes and improvements, including the newer OAuth flow, local app metadata extraction, runtime model handling, Windows-focused workflow support, and continued local maintenance.
