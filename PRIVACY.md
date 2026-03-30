# Privacy Policy — Claude Code Browser

**Last updated:** March 30, 2026

## Overview

Claude Code Browser is an open-source Chrome extension that connects your browser to Claude Code for visual web debugging. This privacy policy explains what data the extension accesses and how it is handled.

## Data Collection

**Claude Code Browser does not collect, store, or transmit any personal data to external servers.**

## What the Extension Accesses

The extension requires certain browser permissions to function:

### Page Content (activeTab, scripting)
- The extension reads DOM structure and element properties when you use the element picker or DOM tree panel
- This data stays local in your browser and is only sent to Claude Code running on **your own machine** via Chrome's Native Messaging API

### Browser Debugging (debugger)
- When Claude Code needs to interact with a page (take screenshots, click elements, evaluate JavaScript), the extension uses Chrome's debugger API
- Chrome displays a yellow banner ("extension is debugging this browser") when this is active
- No debugging data leaves your machine

### Storage (storage)
- Source directory paths are stored locally in `chrome.storage.local`, keyed by domain
- Collapsed/expanded panel states are stored locally
- No data is synced to any cloud service

### Native Messaging (nativeMessaging)
- The extension communicates with a local Node.js process on your machine via Chrome's Native Messaging API
- This process runs the Claude Agent SDK which connects to the Anthropic API using **your own API key or OAuth session**
- The extension itself never contacts Anthropic's servers directly

## Data Flow

```
Your Browser (extension) → Local Node.js Host → Claude Code CLI → Anthropic API
```

All communication between the extension and Claude Code happens **locally on your machine** via Chrome's Native Messaging protocol (stdin/stdout). The only external network requests are made by Claude Code CLI to the Anthropic API, using your own authentication.

## What We Do NOT Do

- We do not collect analytics or telemetry
- We do not track browsing history
- We do not store or transmit passwords, cookies, or session tokens
- We do not inject ads or affiliate links
- We do not sell or share any data
- We do not use third-party tracking scripts

## Third-Party Services

- **Anthropic API** — Claude Code connects to Anthropic's API using your credentials. See [Anthropic's Privacy Policy](https://www.anthropic.com/privacy) for how they handle API requests.

## Open Source

This extension is fully open source under the MIT license. You can inspect the complete source code at:

https://github.com/cmaftuleac/claude-code-browser

## Contact

For questions about this privacy policy, open an issue on GitHub or contact:

**Corneliu Maftuleac** — https://x.com/cmaftuleac

## Chrome Web Store API Use Policy Compliance

Claude Code Browser's use and transfer to any other app of information received from Chrome APIs adheres to the [Chrome Web Store API Use Policy](https://developer.chrome.com/docs/webstore/program-policies/), including the Limited Use requirements.

## Changes

Any changes to this privacy policy will be reflected in this document and the "Last updated" date above.
