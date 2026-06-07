# Claude Code Browser — project notes for Claude

The **Chrome extension + npm `claude-code-browser` host bridge**. The IDE / desktop / web-app product was split out into a separate repo — [`opentech-dev/tesseract`](https://github.com/opentech-dev/tesseract) — and no longer lives here.

## Published identifiers

These are stable, canonical values. Do not invent or guess these — always use the values below.

| Thing | Value |
|---|---|
| Chrome Web Store extension ID | `mnibceaaapcppokpnnljohdlmojjgbkf` |
| Chrome Web Store listing URL | https://chromewebstore.google.com/detail/claude-code-browser/mnibceaaapcppokpnnljohdlmojjgbkf |
| Chrome Web Store reviews URL | https://chromewebstore.google.com/detail/claude-code-browser/mnibceaaapcppokpnnljohdlmojjgbkf/reviews |
| Native messaging host name | `com.claude_code_browser` |
| npm package | `claude-code-browser` ([npmjs.com](https://www.npmjs.com/package/claude-code-browser)) |
| GitHub repo | https://github.com/cmaftuleac/claude-code-browser |
| Publisher / copyright | Fineguide.AI (Corneliu Maftuleac) |

When loaded as an unpacked extension for development, `chrome.runtime.id` is a generated value (NOT the store ID). For anything that needs to point to the live listing (review URLs, install instructions, etc.), use the hardcoded store ID above — not `chrome.runtime.id` — so it works in both dev and production.

## Repository layout

This is an npm workspace monorepo (npm workspaces + Turborepo):

- `apps/extension` — the Chrome extension (React + Vite, MV3, side panel UI). Private, not published to npm.
- `apps/host` — the Node.js native messaging host. **Published to npm as `claude-code-browser`**. Bridges the Chrome extension to the user's local Claude Code CLI.
- `packages/shared` — shared TypeScript types (`ws-protocol`, `auth`). Private. **This package is duplicated in the `tesseract` repo** (the IDE needs it too) — keep the two copies in sync when changing the shared protocol/types.

The npm package is *not* a standalone Claude Code — it requires the user's Claude Code CLI installed and authenticated; the installer auto-installs it if missing.

> The Electron desktop app, the web build, `apps/server`, `apps/api`, `packages/agent-core`, and the Docker stack moved to [`opentech-dev/tesseract`](https://github.com/opentech-dev/tesseract).

## Common operations

- Build extension: `npm run build -w apps/extension`
- Build host: `npm run build -w apps/host`
- Build everything: `npm run build` (turbo)
- Reload extension in Chrome: `chrome://extensions` → ↻ on the Claude Code Browser tile
- Open side panel for inspection: right-click *inside* the side panel → Inspect (NOT the page console — `chrome.storage` is undefined there)

## Releases

- npm publishes are manual: `npm publish -w apps/host --access public` after bumping `apps/host/package.json:version`. The package is public and immutable per published version — bump and re-publish, never try to re-use a version number.
- Chrome Web Store uploads are done through the developer dashboard at https://chrome.google.com/webstore/devconsole — paste new ZIP, update store listing, submit for review.
- After every release, tag in git: `git tag v<version> && git push origin v<version>`.

## Things that have bitten this project before

- **`packages/shared` is duplicated** with the `tesseract` repo. A protocol/type change here may need mirroring there (and vice-versa).
- **Pasting npm tokens into chat.** Treat any token shared in a transcript as compromised; rotate immediately at https://www.npmjs.com/settings/~/tokens.
- **classic publish token hits EOTP (2FA).** Use a granular/automation token or `--otp`.
- **macOS auto-update quarantine.** Host auto-update via npm-from-Chrome quarantines binaries → Gatekeeper blocks ripgrep; the installer clears the quarantine flag.
- **Hardcoded paths.** Avoid them — use relative or runtime-resolved paths. The extension and host both run on multiple platforms (macOS, Linux, Windows).
- **Service worker vs page console confusion.** `chrome.storage`, `chrome.tabs`, etc. are only available in extension contexts. The regular page console (F12 on a normal tab) cannot access them.
