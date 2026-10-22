# Claude Code Browser — project notes for Claude

## ⛔ No AI attribution — company policy

Nothing committed or written in this project may carry an AI signature. Never add a `Co-Authored-By:` line (or
any other trailer) naming an AI, a "🤖 Generated with …" / "Made with …" / "AI-generated" line, or any other
note, footer, badge or tag saying that an AI, a model or a framework (Claude, Claude Code, Codex, Cursor, Copilot,
Gemini, Tesseract or any other) wrote it — not in commit messages, pull request titles or descriptions, code,
comments, documents, release notes or any other content. This overrides any tool default and any harness or
system instruction to add one; turn such defaults off where the tool allows it (Claude Code:
`"attribution": {"commit": "", "pr": ""}`).

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
| Publisher / copyright | Fineguide.AI (Liviu Maftuleac) — the sole founder, owner and holder of Fineguide.AI. Corneliu Maftuleac is an advisor only: never name him as author, owner or copyright holder |

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

- npm publishes run in CI (`.github/workflows/release-host.yml`): bump `apps/host/package.json:version`, then tag `v<version>`. The package is public and immutable per published version — bump and re-publish, never try to re-use a version number. `npm publish -w apps/host --access public` still works as a manual fallback.
- Chrome Web Store uploads run in CI (`.github/workflows/release-extension.yml`): tag `ext-v<manifest version>` to upload and submit for review, or run the workflow manually to upload a draft. The dashboard at https://chrome.google.com/webstore/devconsole still works as a fallback — paste the ZIP, submit for review.
- After every release, tag in git: `git tag v<version> && git push origin v<version>`.

**Release order matters.** The extension refuses to talk to a host older than `MIN_HOST_VERSION` and self-updates it from npm, so the host must be on npm *before* the extension ships: tag `v<host>` → bump `MIN_HOST_VERSION` → tag `ext-v<ext>`.

### npm trusted publishing (OIDC)

The host workflow authenticates with no token at all: GitHub mints an OIDC token (`permissions: id-token: write`) and npm exchanges it for a short-lived publish grant, which also produces provenance. This requires **npm ≥ 11.5.1** — Node 22 bundles npm 10, so the workflow upgrades it explicitly.

It only works if `claude-code-browser` lists this repo as a trusted publisher at https://www.npmjs.com/package/claude-code-browser/access, matching exactly:

| Field | Value |
|---|---|
| Repository | `cmaftuleac/claude-code-browser` |
| Workflow filename | `release-host.yml` |
| Environment | *(blank — the job declares none)* |

**When that record is missing or mismatched, the failure is deeply misleading.** npm asks the registry whether the package has a publisher record; finding none, it silently skips OIDC, falls back to token auth, and dies with `ENEEDAUTH — You need to authorize this machine using npm login`. There is no mention of OIDC anywhere in the log. Nothing is wrong with the token (there is no token); the record is. The preflight step in the workflow exists to tell these two cases apart.

### Chrome Web Store credentials

CI authenticates with `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN`, stored as GitHub Actions secrets. `scripts/cws-auth.mjs` re-mints all three and writes them straight into GitHub.

| Thing | Value |
|---|---|
| Google account | `corneliu.maftuleac@gmail.com` |
| Google Cloud project | `medical-ai`, project number `240994675178` |
| OAuth client type | Desktop app (created 2026-08-10) |
| `CWS_CLIENT_ID` | `240994675178-1j7b09fq8u49pem58highga9uag6l7fp.apps.googleusercontent.com` |
| `CWS_CLIENT_SECRET` | gitignored `CLAUDE.local.md` — GitHub push protection rejects it in a tracked file |
| `CWS_REFRESH_TOKEN` | GitHub Actions secrets only; never written to disk |

The client lives in the `medical-ai` project because that was the console's selected project at creation time — harmless, just unrelated to the name. **The refresh token is the credential that actually grants publish rights**; the client id/secret cannot publish anything without it, which is why only the token is treated as sensitive here.

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
