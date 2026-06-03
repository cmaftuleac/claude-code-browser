/**
 * Electron main process.
 *
 * Replaces the Chrome native-messaging transport with Electron IPC, but reuses
 * the exact ServerMessage/ClientMessage protocol so the renderer's message
 * handling is identical to the extension's. Browser tool requests from the
 * agent (over agent-core's IPC socket) are executed against the embedded
 * <webview>'s webContents.
 */
import { app, BrowserWindow, ipcMain, webContents, shell } from 'electron';
import { join } from 'node:path';
import type { ClientMessage, ServerMessage } from '@claude-code-browser/shared';
import { createClaudeCodeBackend, type AgentBackend } from './agent-backend.js';
import { handleBrowserRequest } from './browser-tools.js';
import { scanSlashCommands } from './commands.js';
import { registerFsHandlers } from './fs.js';
import { listRecents, addRecent, removeRecent } from './recents.js';
import { installAppMenu, refreshAppMenu } from './menu.js';
import { setupMediaProtocol } from './media-protocol.js';

// Privileges must be registered before app.whenReady fires.
setupMediaProtocol();

let mainWindow: BrowserWindow | null = null;
let backend: AgentBackend | null = null;
let backendInit: Promise<AgentBackend> | null = null;
/** webContents id of the <webview> guest, reported by the renderer. */
let guestId: number | null = null;

function send(msg: ServerMessage): void {
  mainWindow?.webContents.send('agent:event', msg);
}

function guestWebContents() {
  if (guestId == null) return null;
  const wc = webContents.fromId(guestId);
  return wc && !wc.isDestroyed() ? wc : null;
}

async function getBackend(): Promise<AgentBackend> {
  // Guard against concurrent init (StrictMode fires app:ready twice) — otherwise
  // two AgentManagers race and the second clobbers the shared IPC port file.
  if (!backendInit) {
    backendInit = createClaudeCodeBackend(send, (requestId, action, params) => {
      handleBrowserRequest(guestWebContents(), action, params)
        .then((result) => backend?.sendBrowserResponse(requestId, result))
        .catch((err) => backend?.sendBrowserResponse(requestId, undefined, String(err?.message ?? err)));
    }).then((b) => (backend = b));
  }
  return backendInit;
}

async function dispatch(msg: ClientMessage): Promise<void> {
  switch (msg.type) {
    case 'ping':
      send({ type: 'pong' });
      break;
    case 'health:check':
      send({ type: 'health', nodeVersion: process.version, claudeCodeInstalled: true, claudeAuthenticated: true });
      break;
    case 'commands:list':
      send({ type: 'commands:list', commands: scanSlashCommands() });
      break;
    case 'chat:send': {
      const b = await getBackend();
      b.sendMessage({
        message: msg.message,
        sessionId: msg.sessionId,
        clientRequestId: msg.clientRequestId,
        anchors: msg.anchors,
        images: msg.images,
        url: msg.url,
        projectDir: msg.projectDir,
        sources: msg.sources,
      }).catch((err) => console.error('sendMessage error:', err));
      break;
    }
    case 'session:list': {
      // Always reply — even if backend init rejects — so the renderer's
      // Resume disclosure never hangs on a perpetual "Loading…".
      let sessions: Awaited<ReturnType<AgentBackend['listSessions']>> = [];
      try { sessions = await (await getBackend()).listSessions(); } catch { /* empty list */ }
      send({ type: 'session:list', sessions });
      break;
    }
    case 'session:resume': {
      let messages: Awaited<ReturnType<AgentBackend['getMessages']>> = [];
      try { messages = await (await getBackend()).getMessages(msg.sessionId); } catch { /* empty history */ }
      send({ type: 'session:messages', sessionId: msg.sessionId, messages });
      break;
    }
    case 'agent:interrupt': {
      const b = await getBackend();
      if (b.interrupt(msg.sessionId ?? '')) send({ type: 'agent:status', sessionId: msg.sessionId ?? '', status: 'idle' });
      break;
    }
    case 'config:set': {
      const b = await getBackend();
      b.setConfig(msg.projectDir);
      break;
    }
    case 'sources:set':
      send({ type: 'sources:set', domain: msg.domain, paths: msg.paths });
      break;
    case 'browser:response': {
      const b = await getBackend();
      b.sendBrowserResponse(msg.requestId, msg.result, msg.error);
      break;
    }
  }
}

function createWindow(): void {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 1040,
    backgroundColor: '#faf7f2',
    title: 'Claude Code Browser',
    // Custom frameless chrome: hide the native title bar, render our own
    // breadcrumb titlebar below. Traffic lights are inset to align with it.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 14, y: 13 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
    },
  });

  // Open target=_blank inside the guest, never as a real OS window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Diagnostics: surface renderer failures/logs in the main-process stdout.
  const wc = mainWindow.webContents;
  wc.on('did-fail-load', (_e, code, desc, url) => console.error('[renderer] did-fail-load', code, desc, url));
  wc.on('render-process-gone', (_e, details) => console.error('[renderer] process-gone', details));
  wc.on('preload-error', (_e, p, err) => console.error('[preload-error]', p, err));
  wc.on('console-message', (_e, level, message, line, sourceId) =>
    console.log(`[renderer console:${level}] ${message} (${sourceId}:${line})`));

  // Intercept Cmd+W and Cmd+Q before the menu accelerator fires.
  // `event.preventDefault()` suppresses both menu shortcuts and the page's
  // own keydown/keyup. We track Cmd+Q keydown state so that we always
  // forward the corresponding keyUp, even when the modifier has been
  // released first (common during a quick tap on macOS — the OS reorders
  // the events, so Q's keyup arrives with meta=false).
  let cmdQHeld = false;
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' && input.type !== 'keyUp') return;
    const isMac = process.platform === 'darwin';
    const primary = isMac ? input.meta : input.control;
    const k = input.key.toLowerCase();
    const isKeyDown = input.type === 'keyDown';
    const isKeyUp = input.type === 'keyUp';
    const cleanMods = primary && !input.alt && !input.shift;
    if (k === 'w' && isKeyDown && cleanMods) {
      event.preventDefault();
      wc.send('app:cmdW');
    } else if (k === 'q') {
      if (isKeyDown && cleanMods) {
        event.preventDefault();
        cmdQHeld = true;
        wc.send('app:cmdQDown');
      } else if (isKeyUp && cmdQHeld) {
        event.preventDefault();
        cmdQHeld = false;
        wc.send('app:cmdQUp');
      }
    } else if (cmdQHeld && isKeyUp && (k === 'meta' || k === 'control')) {
      // Some macOS hardware sends the modifier-up *before* the Q-up. If we
      // haven't seen Q-up yet by the time Cmd lifts, treat that as release.
      cmdQHeld = false;
      wc.send('app:cmdQUp');
    }
  });
  // Window blur (focus moves elsewhere mid-hold) = release.
  mainWindow.on('blur', () => {
    if (cmdQHeld) { cmdQHeld = false; wc.send('app:cmdQUp'); }
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── IPC wiring ──────────────────────────────────────────────────────────────

registerFsHandlers(() => mainWindow);

ipcMain.handle('app:quit', () => { app.quit(); });

ipcMain.handle('recents:list', () => listRecents());
ipcMain.handle('recents:add', (_e, path: string, name: string) => {
  const r = addRecent(path, name);
  refreshAppMenu(() => mainWindow);
  return r;
});
ipcMain.handle('recents:remove', (_e, path: string) => {
  const r = removeRecent(path);
  refreshAppMenu(() => mainWindow);
  return r;
});

ipcMain.handle('agent:send', (_e, msg: ClientMessage) => dispatch(msg));

ipcMain.handle('app:editorPreloadPath', () => join(__dirname, '../preload/editor.js'));

// The renderer reports the <webview> guest's id once it is attached.
ipcMain.on('webview:ready', (_e, id: number) => {
  guestId = id;
});

// Renderer finished mounting and subscribed to agent:event — send initial state.
ipcMain.on('app:ready', () => {
  send({ type: 'connection:ready', serverVersion: app.getVersion() });
  send({ type: 'health', nodeVersion: process.version, claudeCodeInstalled: true, claudeAuthenticated: true });
});

app.whenReady().then(() => {
  installAppMenu(() => mainWindow);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
