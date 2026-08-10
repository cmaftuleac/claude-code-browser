# Claude Code Browser — project notes for Claude

The **Chrome extension + npm `claude-code-browser` host bridge**. This is a standalone, independent project: the extension, the host, and the types they share. Nothing else belongs here.

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
- `packages/shared` — shared TypeScript types (`ws-protocol`, `settings`) used by both. Private. Keep it to what the extension and host actually import; it is not a dumping ground for types from other projects.

The npm package is *not* a standalone Claude Code — it requires the user's Claude Code CLI installed and authenticated; the installer auto-installs it if missing.

## Common operations

- Build extension: `npm run build -w apps/extension`
- Build host: `npm run build -w apps/host`
- Build everything: `npm run build` (turbo)
- Reload extension in Chrome: `chrome://extensions` → ↻ on the Claude Code Browser tile
- Open side panel for inspection: right-click *inside* the side panel → Inspect (NOT the page console — `chrome.storage` is undefined there)

## Releases

- npm publishes are manual: `npm publish -w apps/host --access public` after bumping `apps/host/package.json:version`. The package is public and immutable per published version — bump and re-publish, never try to re-use a version number.
- Chrome Web Store uploads run in CI (`.github/workflows/release-extension.yml`): tag `ext-v<manifest version>` to upload and submit for review, or run the workflow manually to upload a draft. The dashboard at https://chrome.google.com/webstore/devconsole still works as a fallback — paste the ZIP, submit for review.
- After every release, tag in git: `git tag v<version> && git push origin v<version>`.

**Release order matters.** The extension refuses to talk to a host older than `MIN_HOST_VERSION` and self-updates it from npm, so the host must be on npm *before* the extension ships: tag `v<host>` → bump `MIN_HOST_VERSION` → tag `ext-v<ext>`.

### Chrome Web Store credentials

CI authenticates with `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN`, stored as GitHub Actions secrets. They come from a Google Cloud project owned by the same account that owns the store listing. **This repo is public — the project number, the account, and the secret values all live in the gitignored `CLAUDE.local.md`, never here.** `scripts/cws-auth.mjs` re-mints the refresh token and writes all three straight into GitHub.

Four things this setup gets wrong on the first try, in the order they bite:

1. **The OAuth client must be type "Desktop app"**, not "Chrome Extension". The Chrome Extension type issues no client secret at all (an extension can't hold one), and Desktop app is what implicitly permits the `http://127.0.0.1:8818` loopback the script listens on.
2. **Enable the Chrome Web Store API** in the project. Consent and token exchange both succeed without it; the upload is what fails, with a 403 `SERVICE_DISABLED`.
3. **Publish the OAuth consent screen** (Google Auth Platform → Audience). Refresh tokens issued while the project is in *Testing* expire after **7 days**, and publishing later does not rescue an already-issued one — CI works for a week, then dies with `invalid_grant`. The "Google hasn't verified this app" warning during consent is expected and harmless; Branding needs nothing filled in, and uploading a logo there would force a verification review.
4. **The approving account needs publish rights on the listing**, not just ownership of the Cloud project — otherwise everything authorises cleanly and the upload 404s.

## Things that have bitten this project before

- **Pasting npm tokens into chat.** Treat any token shared in a transcript as compromised; rotate immediately at https://www.npmjs.com/settings/~/tokens.
- **classic publish token hits EOTP (2FA).** Use a granular/automation token or `--otp`.
- **macOS auto-update quarantine.** Host auto-update via npm-from-Chrome quarantines binaries → Gatekeeper blocks ripgrep; the installer clears the quarantine flag.
- **Hardcoded paths.** Avoid them — use relative or runtime-resolved paths. The extension and host both run on multiple platforms (macOS, Linux, Windows).
- **Service worker vs page console confusion.** `chrome.storage`, `chrome.tabs`, etc. are only available in extension contexts. The regular page console (F12 on a normal tab) cannot access them.
