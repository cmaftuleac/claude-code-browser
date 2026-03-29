# Claude Code Browser

A Chrome extension that lets you **point at page elements** and have Claude Code fix them — no screenshots, no copy-pasting selectors.

## How it works

1. Open any web page in Chrome
2. Open the Claude Code Browser side panel
3. Click on elements to select them
4. Ask Claude to fix, modify, or inspect them
5. Claude sees the element, reads your source code, and makes the fix

## Features

- **Element Picker** — Click any element on the page to select it. The extension captures its CSS selector, XPath, DOM path, and HTML snippet.
- **Inline Element Chips** — Selected elements appear as inline chips in the chat, like `⦾ <button>`, so you can reference multiple elements in natural language.
- **DOM Tree Panel** — Collapsible tree view of the page's DOM structure. Click nodes to add them to your message. Hovering highlights elements on the page.
- **Streaming Chat** — Real-time streaming responses from Claude Code, with full Markdown rendering (tables, code blocks, lists).
- **Session Management** — Browse and resume previous Claude Code sessions.
- **Browser Tools** — Claude can navigate, take screenshots, click elements, and evaluate JavaScript on your page via `chrome.debugger` API — no separate browser needed.
- **Image Support** — Paste or drag images into the chat input.
- **Slash Commands** — Dynamic `/` commands loaded from your Claude Code skills and commands.
- **VS Code Skill** — `/browse <url>` command available in Claude Code (VS Code, CLI) to open pages for inspection.

## Architecture

```
Chrome Extension (React)  ←Native Messaging→  Node.js Host  ←Agent SDK→  Claude Code
     ↕ chrome.debugger                              ↕
  Browser Tools                              Custom MCP Tools
  (navigate, snapshot,                       (browser_navigate,
   screenshot, click,                         browser_snapshot,
   evaluate)                                  browser_screenshot, etc.)
```

The extension communicates with a local Node.js host process via Chrome's Native Messaging API. Chrome automatically launches and manages the host process — no manual server needed.

## Installation

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — `npm install -g @anthropic-ai/claude-code`
- Google Chrome

---

### Option A: Install from npm + Chrome Web Store (Recommended)

The simplest way — installs from published packages:

```bash
npx claude-code-browser install
```

This single command:
1. Checks Node.js and Claude Code CLI (installs if missing)
2. Registers the native messaging host for Chrome
3. Installs the `/browse` skill for Claude Code
4. Opens the Chrome Web Store page for the extension (one-click install)

After installing the extension, **restart Chrome** (Cmd+Q / close all windows, then reopen).

> **Note:** If the extension is already installed, the installer auto-detects its ID. If not, it will prompt you to provide one after installing from the Chrome Web Store.

---

### Option B: Build everything locally

For development or if you want to run from source:

```bash
# 1. Clone and install
git clone https://github.com/anthropics/claude-code-browser.git
cd claude-code-browser
npm install

# 2. Build the extension
npm run build:extension

# 3. Load extension in Chrome
#    → Open chrome://extensions
#    → Enable "Developer mode"
#    → Click "Load unpacked"
#    → Select: apps/extension/dist/
#    → Note the extension ID shown

# 4. Build and install the native host
npm run build:host
node apps/host/dist/install.js install <your-extension-id>

# 5. Restart Chrome (Cmd+Q then reopen)
```

---

### Verify Installation

Open the extension's side panel. You should see the main chat UI with:
- **Connected** status (green dot)
- **Sessions** list
- **Components** (DOM tree) panel

If you see "Setup Required", the native host isn't registered — run the install command shown on screen.

### What the installer does

- Registers the native messaging host so Chrome auto-launches it
- Installs the `/browse` skill globally (`~/.claude/skills/browse/`)
- Rewrites the host shebang with your absolute Node.js path (required for Chrome's minimal PATH)
- On Windows: sets the registry key for Chrome native messaging

### Uninstall

```bash
# If installed via npm:
npx claude-code-browser uninstall

# If built locally:
node apps/host/dist/install.js uninstall
```

This removes the native messaging host, wrapper script, and `/browse` skill.

## Usage

### Side Panel

1. Click the extension icon or right-click → Claude Code Browser
2. **Element Picker** (⌖) — Click the crosshair button, then click any element on the page
3. **Attach File** (@) — Attach images to your message
4. **Slash Commands** (/) — Access commands like `/screenshot`, `/navigate`, `/browse`
5. **DOM Tree** — Expand the "Components" panel to browse the page structure
6. **Stop** (■) — Cancel a running request

### VS Code / CLI

Use the `/browse` skill in any Claude Code session:

```
/browse https://localhost:3000
```

This opens the URL in Chrome. Use the extension's side panel to select elements and chat.

## Project Structure

```
claude-code-browser/
├── apps/
│   ├── extension/          # Chrome Extension (Manifest V3, React, Vite)
│   │   ├── src/
│   │   │   ├── background/ # Service worker (native messaging relay)
│   │   │   ├── content/    # Content script (element picker, DOM tree)
│   │   │   └── sidepanel/  # React app (chat, components, stores)
│   │   └── dist/           # Built extension (load this in Chrome)
│   ├── host/               # Native Messaging Host (Node.js)
│   │   └── src/
│   │       ├── host.ts     # Main entry (message loop)
│   │       ├── agent-manager.ts  # Claude Agent SDK integration
│   │       ├── browser-tools.ts  # Custom browser MCP tools
│   │       └── install.ts  # Cross-platform installer
│   └── server/             # (Legacy) WebSocket server
├── packages/
│   └── shared/             # Shared TypeScript types
├── skills/
│   └── browse/SKILL.md     # /browse skill for Claude Code
└── package.json            # Monorepo root (npm workspaces)
```

## Development

```bash
# Build everything
npm run build

# Watch extension (rebuilds on change)
npm run dev:extension

# Build host after changes
npm run build:host

# Rebuild extension
npm run build:extension
```

After rebuilding the extension, click the refresh icon on `chrome://extensions` to reload it.

## How the Browser Tools Work

The extension provides 5 custom tools to Claude Code via the Agent SDK:

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate the active tab to a URL |
| `browser_snapshot` | Get the page's accessibility tree or DOM structure |
| `browser_screenshot` | Capture a PNG screenshot of the visible area |
| `browser_click` | Click an element by CSS selector or XPath |
| `browser_evaluate` | Execute JavaScript on the page |

These use Chrome's `chrome.debugger` API — no separate CDP browser needed. When Claude calls a tool, the request flows: Agent SDK → Host → Extension service worker → Side panel → `chrome.debugger` → Result flows back.

## Author

Created by [Corneliu Maftuleac](https://x.com/cmaftuleac).

## License

MIT — free to use, modify, and distribute. See [LICENSE](LICENSE) for details.
