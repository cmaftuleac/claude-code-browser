/**
 * Electron main process.
 *
 * Replaces the Chrome native-messaging transport with Electron IPC, but reuses
 * the exact ServerMessage/ClientMessage protocol so the renderer's message
 * handling is identical to the extension's. Browser tool requests from the
 * agent (over agent-core's IPC socket) are executed against the embedded
 * <webview>'s webContents.
 */
import { app, BrowserWindow, ipcMain, webContents, shell, session, nativeImage } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { ClientMessage, ServerMessage } from '@fineguide-tesseract/shared';
import { createClaudeCodeBackend, type AgentBackend } from './agent-backend.js';
import { handleBrowserRequest } from './browser-tools.js';
import { scanSlashCommands } from './commands.js';
import { registerFsHandlers, disposeWindowFs, rootForWindow, flushOpenRootsSession, restorableSessionRoots, seedWindowRoot } from './fs.js';
import { listRecents, addRecent, removeRecent } from './recents.js';
import { authMe, authLogin, authSignup, authLogout, authGoogle, cancelGoogle, authUpdateProfile, authSetPlan, BACKEND_ORIGIN } from './auth.js';
import { getSettings, saveSettings, getAgentSettings } from './settings.js';
import { getWorkspaceSnapshot, saveWorkspaceSnapshot, flushWorkspaceSnapshots } from './workspace-snapshots.js';
import { startHostDaemon } from './host-daemon.js';
import { startUpdater } from './updater.js';
import { installAppMenu, refreshAppMenu } from './menu.js';
import { setupMediaProtocol, setMediaToken } from './media-protocol.js';
import { isSafeExternalUrl } from './url-safety.js';
import { startMemoryGovernor, RENDERER_PROCESS_LIMIT } from './memory-governor.js';

/** Per-launch capability token for the media-file:// protocol. Handed only to
 *  the trusted app renderer (preload → mediaUrl query param) so guest <webview>
 *  pages can't read arbitrary local files via the shared scheme handler. */
const MEDIA_TOKEN = randomBytes(24).toString('hex');

/** Restrict an external open to web/mail schemes — a guest page's
 *  window.open()/target=_blank reaches setWindowOpenHandler with an arbitrary
 *  URL, and shell.openExternal('file:///…') (or a custom scheme) would hand it
 *  to the OS handler. Only http/https/mailto are forwarded. */
function openExternalSafe(rawUrl: string): void {
  if (isSafeExternalUrl(rawUrl)) void shell.openExternal(rawUrl);
  else console.warn('[openExternal] blocked non-web URL:', rawUrl);
}

// ── App identity ───────────────────────────────────────────────────────────
// In dev, Electron has no bundle metadata, so name the app and (on Windows) set
// the AppUserModelID for correct taskbar grouping. Packaged builds get these
// from electron-builder, but setting them here is harmless and keeps dev honest.
app.setName('Fineguide Tesseract');
if (process.platform === 'win32') app.setAppUserModelId('ai.fineguide.tesseract');

// Brand icon. A packaged app uses the bundle icon set by electron-builder; in
// dev there is none, so point the dock/window at the committed build/icon.png
// (resolved from dist/main → apps/desktop/build) so the gem shows everywhere.
const BRAND_ICON = join(__dirname, '../../build/icon.png');

// ── Memory: process consolidation + GC (must run before app.whenReady) ────────
// The user opted out of per-tab isolation, so collapse Chromium's process model:
// disabling site isolation + process-per-site + a small renderer-process pool
// means many browser tabs share a few renderer processes instead of one each —
// the single biggest baseline memory win. Trade-off: less crash isolation
// between tabs (accepted per product decision).
app.commandLine.appendSwitch('disable-features', 'site-per-process,IsolateOrigins');
app.commandLine.appendSwitch('process-per-site');
app.commandLine.appendSwitch('renderer-process-limit', String(RENDERER_PROCESS_LIMIT));
// Expose global.gc so the memory governor can force collection under pressure
// (applies to the main process and all renderers).
app.commandLine.appendSwitch('js-flags', '--expose-gc');
// Bound the on-disk HTTP cache so it can't balloon.
app.commandLine.appendSwitch('disk-cache-size', String(64 * 1024 * 1024));

// Privileges must be registered before app.whenReady fires.
setMediaToken(MEDIA_TOKEN);
setupMediaProtocol();

let backend: AgentBackend | null = null;
let backendInit: Promise<AgentBackend> | null = null;
/** browserId → its <webview> guest webContents id, reported by the renderer.
 *  browserIds are app-global uuids and webContents ids are app-global, so this
 *  one map routes the agent to the right guest across ALL windows. */
const guests = new Map<string, number>();
/** The focused browser PER WINDOW (keyed by the window's webContents id) — the
 *  agent target fallback when a conversation has no explicit binding. Window-
 *  scoped so an unbound chat in window A never routes to window B's focused
 *  browser. The common path carries an explicit browserId and skips this. */
const activeBrowserByWindow = new Map<number, string | null>();
/** Session/clientRequestId → owning window, so agent stream events unicast to
 *  the window that started the turn instead of broadcasting to all (which would
 *  duplicate a stream into a second window that has the same session open). */
const sessionWindow = new Map<string, number>();
const requestWindow = new Map<string, number>();

/** Live top-level windows (multi-window). */
function allWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
}
/** The focused window, falling back to the first live one (menu/dialog target). */
function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? allWindows()[0] ?? null;
}

/** Resolve the window that owns a session-keyed message (by sessionId, else by
 *  clientRequestId). Returns undefined for events with no owner mapping. */
function ownerWindowFor(msg: ServerMessage): number | undefined {
  const sid = (msg as { sessionId?: string }).sessionId;
  if (sid && sessionWindow.has(sid)) return sessionWindow.get(sid) ?? undefined;
  const crid = (msg as { clientRequestId?: string }).clientRequestId;
  if (crid && requestWindow.has(crid)) return requestWindow.get(crid) ?? undefined;
  return undefined;
}

/** Send an agent event. Session-keyed events (chat streams, tool use,
 *  session:created/messages) UNICAST to the owning window so a session resumed
 *  in two windows doesn't double-render; events with no owner mapping broadcast
 *  (the renderer's findTaskId still filters them per-window). */
function send(msg: ServerMessage): void {
  // Learn sessionId → window the moment session:created correlates the two,
  // then retire the (now-redundant) clientRequestId mapping.
  if (msg.type === 'session:created') {
    const m = msg as { sessionId?: string; clientRequestId?: string };
    if (m.sessionId && m.clientRequestId && requestWindow.has(m.clientRequestId)) {
      sessionWindow.set(m.sessionId, requestWindow.get(m.clientRequestId)!);
      requestWindow.delete(m.clientRequestId);
    }
  }
  const owner = ownerWindowFor(msg);
  if (owner != null) {
    const wc = webContents.fromId(owner);
    if (wc && !wc.isDestroyed()) { wc.send('agent:event', msg); return; }
    // Owner window gone → fall through to broadcast (harmless; renderer filters).
  }
  for (const w of allWindows()) w.webContents.send('agent:event', msg);
}

/** Free memory under OS pressure (driven by the memory governor + OOM events).
 *  moderate: reap long-idle agent sessions + clear HTTP caches + tell renderers
 *  to trim (clear off-panel DOM trees). critical: also reap ALL idle sessions,
 *  suspend hidden browser tabs (renderer), and force a GC. */
function reclaimMemory(level: 'moderate' | 'critical'): void {
  backend?.reclaim(level);
  void session.defaultSession.clearCache();
  for (const wcId of guests.values()) {
    const g = webContents.fromId(wcId);
    if (g && !g.isDestroyed()) void g.session.clearCache();
  }
  for (const w of allWindows()) w.webContents.send('memory:pressure', { level });
  if (level === 'critical') { try { (globalThis as { gc?: () => void }).gc?.(); } catch { /* gc not exposed */ } }
  console.log(`[memory] reclaim(${level})`);
}

/** Resolve a live guest webContents for `browserId`, falling back to the
 *  requesting window's focused browser (never a cross-window global). */
function guestWebContents(browserId?: string | null, windowId?: number) {
  const id = browserId ?? (windowId != null ? activeBrowserByWindow.get(windowId) : null);
  const wcId = id ? guests.get(id) : undefined;
  if (wcId == null) return null;
  const wc = webContents.fromId(wcId);
  return wc && !wc.isDestroyed() ? wc : null;
}

/** Browser requests parked while a freshly auto-created browser attaches its
 *  guest (agent issued `navigate` with no browser open). Flushed on the next
 *  guest registration; failed after a timeout so the cli's 30s wait never hangs. */
interface ParkedRequest { requestId: string; action: string; params: Record<string, unknown>; browserId?: string; windowId?: number; expiresAt: number }
const PARK_TIMEOUT_MS = 20_000;
const parkedRequests: ParkedRequest[] = [];
let parkTimer: NodeJS.Timeout | null = null;
/** Single timer fired at the EARLIEST parked deadline — fails only entries whose
 *  own deadline passed, then reschedules. One slow request never fails another. */
function scheduleParkTimer(): void {
  if (parkTimer) { clearTimeout(parkTimer); parkTimer = null; }
  if (parkedRequests.length === 0) return;
  const next = Math.min(...parkedRequests.map((r) => r.expiresAt));
  parkTimer = setTimeout(() => {
    parkTimer = null;
    const now = Date.now();
    for (let i = parkedRequests.length - 1; i >= 0; i--) {
      if (parkedRequests[i].expiresAt <= now) {
        const r = parkedRequests.splice(i, 1)[0];
        backend?.sendBrowserResponse(r.requestId, undefined, 'No browser available to navigate.');
      }
    }
    scheduleParkTimer();
  }, Math.max(0, next - Date.now()));
}
/** Flush any parked request whose target browser now has a live guest. */
function flushParkedRequests(): void {
  if (parkedRequests.length === 0) return;
  for (let i = parkedRequests.length - 1; i >= 0; i--) {
    const r = parkedRequests[i];
    // Only flush parks with a CONCRETE target. An undefined-target park (still
    // awaiting browser:ensured) must never resolve via the active-browser
    // fallback — it could land on an unrelated window's guest.
    if (!r.browserId) continue;
    const guest = guestWebContents(r.browserId);
    if (!guest) continue;
    parkedRequests.splice(i, 1);
    handleBrowserRequest(guest, r.action, r.params)
      .then((result) => backend?.sendBrowserResponse(r.requestId, result))
      .catch((err) => backend?.sendBrowserResponse(r.requestId, undefined, String(err?.message ?? err)));
  }
  scheduleParkTimer();
}
/** Fail parked requests whose target browser's guest is gone (called after a
 *  window's guests were dropped on reload/crash). Scoped by target guest, so a
 *  reload in one window never fails another window's in-flight navigations.
 *  Undefined-target parks (auto-create still awaiting an instance) are left to
 *  flush or time out. */
function failParkedWithDeadTarget(reason: string, windowId?: number): void {
  for (let i = parkedRequests.length - 1; i >= 0; i--) {
    const r = parkedRequests[i];
    const deadTarget = r.browserId != null && !guests.has(r.browserId);
    // Also fail this window's still-undefined-target parks (its renderer
    // reloaded / window closed, so browser:ensured will never arrive) instead of
    // letting them hang until the 20s timeout.
    const ownerGone = windowId != null && r.windowId === windowId && r.browserId == null;
    if (deadTarget || ownerGone) {
      parkedRequests.splice(i, 1);
      backend?.sendBrowserResponse(r.requestId, undefined, reason);
    }
  }
  scheduleParkTimer();
}

async function getBackend(): Promise<AgentBackend> {
  // Guard against concurrent init (StrictMode fires app:ready twice) — otherwise
  // two AgentManagers race and the second clobbers the shared IPC port file.
  if (!backendInit) {
    backendInit = createClaudeCodeBackend(send, (requestId, action, params, browserId, windowId) => {
      // Route to the conversation's connected browser; falls back to the
      // REQUESTING WINDOW's focused browser when the conversation has no binding.
      const guest = guestWebContents(browserId, windowId);
      // Agent navigates with no browser open → auto-create one, park the request,
      // and flush it once the new guest attaches. Other actions need an existing
      // page, so they surface the normal "Open a URL first" error.
      if (!guest && action === 'navigate' && typeof params.url === 'string' && params.url) {
        parkedRequests.push({ requestId, action, params, browserId, windowId, expiresAt: Date.now() + PARK_TIMEOUT_MS });
        // If the chat is bound to a (blank) browser, navigate THAT one; else create one.
        // requestId lets the renderer report back which instance actually served it,
        // so we re-key the parked request before flushing (handles a stale/undefined id).
        // Target the window that OWNS this conversation (multi-window correct);
        // fall back to the focused window if it's gone.
        const owner = windowId != null ? webContents.fromId(windowId) : null;
        const target = owner && !owner.isDestroyed() ? owner : focusedWindow()?.webContents;
        target?.send('browser:ensureOpen', { url: params.url, browserId, requestId });
        scheduleParkTimer();
        return;
      }
      handleBrowserRequest(guest, action, params)
        .then((result) => backend?.sendBrowserResponse(requestId, result))
        .catch((err) => backend?.sendBrowserResponse(requestId, undefined, String(err?.message ?? err)));
    }).then((b) => (backend = b));
  }
  return backendInit;
}

/** `reply` targets the window that sent the request (per-window responses);
 *  async agent stream events still broadcast via the backend's `send` callback. */
async function dispatch(msg: ClientMessage, reply: (m: ServerMessage) => void, senderWcId: number): Promise<void> {
  switch (msg.type) {
    case 'ping':
      reply({ type: 'pong' });
      break;
    case 'health:check':
      reply({ type: 'health', nodeVersion: process.version, claudeCodeInstalled: true, claudeAuthenticated: true });
      break;
    case 'commands:list':
      reply({ type: 'commands:list', commands: scanSlashCommands(rootForWindow(senderWcId)) });
      break;
    case 'chat:send': {
      // Remember which window owns this turn so its stream events unicast back
      // (and a still-resolving session can be correlated on session:created).
      if (msg.clientRequestId) requestWindow.set(msg.clientRequestId, senderWcId);
      if (msg.sessionId) sessionWindow.set(msg.sessionId, senderWcId);
      const b = await getBackend();
      b.sendMessage({
        message: msg.message,
        sessionId: msg.sessionId,
        clientRequestId: msg.clientRequestId,
        anchors: msg.anchors,
        images: msg.images,
        files: msg.files,
        url: msg.url,
        // The agent's cwd = the conversation's project. Prefer what the renderer
        // sent; fall back to THIS window's open project root (per-window correct,
        // so Claude Code always runs in the right project — like the extension).
        projectDir: msg.projectDir ?? rootForWindow(senderWcId),
        sources: msg.sources,
        browserId: msg.browserId,
        windowId: senderWcId,
        // Agent config: persisted settings are the DEFAULT, but the renderer's
        // per-conversation run-mode picker (permissionMode / effort / model) wins
        // when present. Applied at session creation; a live session is switched
        // via agent:set_mode below.
        ...getAgentSettings(),
        ...(msg.permissionMode ? { permissionMode: msg.permissionMode } : {}),
        ...(msg.effort ? { effort: msg.effort } : {}),
        ...(msg.model ? { model: msg.model } : {}),
      }).catch((err) => console.error('sendMessage error:', err));
      break;
    }
    case 'session:list': {
      // Always reply — even if backend init rejects — so the renderer's
      // Resume disclosure never hangs on a perpetual "Loading…".
      let sessions: Awaited<ReturnType<AgentBackend['listSessions']>> = [];
      // Scope to THIS window's project (msg.projectDir if sent, else the window's
      // open root) so the Resume list shows only this project's sessions.
      const projectDir = msg.projectDir ?? rootForWindow(senderWcId);
      try { sessions = await (await getBackend()).listSessions(projectDir); } catch { /* empty list */ }
      reply({ type: 'session:list', sessions });
      break;
    }
    case 'session:resume': {
      // The resumed session's stream events belong to THIS window.
      sessionWindow.set(msg.sessionId, senderWcId);
      let messages: Awaited<ReturnType<AgentBackend['getMessages']>> = [];
      try { messages = await (await getBackend()).getMessages(msg.sessionId); } catch { /* empty history */ }
      reply({ type: 'session:messages', sessionId: msg.sessionId, messages });
      break;
    }
    case 'agent:interrupt': {
      const b = await getBackend();
      if (b.interrupt(msg.sessionId ?? '')) reply({ type: 'agent:status', sessionId: msg.sessionId ?? '', status: 'idle' });
      break;
    }
    case 'agent:set_mode': {
      const b = await getBackend();
      void b.setRunMode(msg.sessionId, { permissionMode: msg.permissionMode, model: msg.model });
      break;
    }
    case 'chat:permission': {
      const b = await getBackend();
      b.respondToPermission(msg.requestId, { behavior: msg.behavior, updatedInput: msg.updatedInput, persist: msg.persist, message: msg.message });
      break;
    }
    case 'config:set': {
      const b = await getBackend();
      b.setConfig(msg.projectDir);
      break;
    }
    case 'sources:set':
      reply({ type: 'sources:set', domain: msg.domain, paths: msg.paths });
      break;
    case 'browser:response': {
      const b = await getBackend();
      b.sendBrowserResponse(msg.requestId, msg.result, msg.error);
      break;
    }
  }
}

/** Drop guest entries (and active id) hosted by `wc` — its <webview>s are gone
 *  (window reload/close), so a recycled webContents id can't misroute. */
function dropGuestsHostedBy(wc: Electron.WebContents): void {
  for (const [bid, wcId] of [...guests]) {
    const g = webContents.fromId(wcId);
    if (!g || g.isDestroyed() || g.hostWebContents?.id === wc.id) guests.delete(bid);
  }
  // Clear any window's focused-browser pointer that now dangles.
  for (const [winWcId, active] of activeBrowserByWindow) {
    if (active && !guests.has(active)) activeBrowserByWindow.set(winWcId, null);
  }
}

/** Window backdrop per theme — matches the renderer's base surface so a new
 *  window (or cold launch) doesn't flash a light frame before React paints. */
function themeBackground(): string {
  switch (getSettings().appearance.theme) {
    case 'dark': return '#14120d';
    case 'white': return '#ffffff';
    default: return '#faf7f2'; // claude (cream)
  }
}

function createWindow(restoreRoot?: string): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1680,
    height: 1040,
    backgroundColor: themeBackground(),
    title: 'Fineguide Tesseract',
    ...(existsSync(BRAND_ICON) ? { icon: BRAND_ICON } : {}),
    // Custom frameless chrome: hide the native title bar, render our own
    // breadcrumb titlebar below. Traffic lights are inset to align with it.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 14, y: 13 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
      // Memory: no spellcheck dictionary in RAM; keep hidden renderers throttled;
      // cache compiled code (not full bytecode+metadata) to trim V8 heap.
      spellcheck: false,
      backgroundThrottling: true,
      v8CacheOptions: 'code',
    },
  });
  const winWcId = win.webContents.id;
  // Cold-launch session restore: pre-seed this window's project root so its
  // renderer's `fs:currentRoot` resolves to it and it reopens that project.
  if (restoreRoot) seedWindowRoot(winWcId, restoreRoot);

  // Open target=_blank inside the guest, never as a real OS window. Only web
  // schemes are forwarded to the OS (openExternalSafe), so a page can't coax us
  // into shell-opening a file:// path or custom-scheme handler.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });

  // Diagnostics: surface renderer failures/logs in the main-process stdout.
  const wc = win.webContents;
  wc.on('did-fail-load', (_e, code, desc, url) => console.error('[renderer] did-fail-load', code, desc, url));
  // A renderer reload (View → Reload) destroys this window's <webview>s and
  // regenerates browser uuids — drop only THIS window's guest entries.
  wc.on('did-start-loading', () => { dropGuestsHostedBy(wc); failParkedWithDeadTarget('Renderer reloaded.', wc.id); });
  wc.on('render-process-gone', (_e, details) => {
    dropGuestsHostedBy(wc);
    failParkedWithDeadTarget('Renderer process gone.');
    console.error('[renderer] process-gone', details);
    // A renderer killed for OOM is a hard memory signal → reclaim aggressively.
    if (details.reason === 'oom') reclaimMemory('critical');
  });
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
  win.on('blur', () => {
    if (cmdQHeld) { cmdQHeld = false; wc.send('app:cmdQUp'); }
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.on('closed', () => {
    // Tear down this window's fs watcher/root and any guests it hosted.
    disposeWindowFs(winWcId);
    for (const [bid, wcId] of [...guests]) {
      const g = webContents.fromId(wcId);
      if (!g || g.isDestroyed()) guests.delete(bid);
    }
    // Fail this window's in-flight parked navigates immediately (dead-target +
    // its still-undefined parks) so the agent's browser-cli doesn't hang ~20s.
    failParkedWithDeadTarget('Window closed.', winWcId);
    // Drop this window's per-window state so a recycled webContents id starts clean.
    activeBrowserByWindow.delete(winWcId);
    for (const [sid, w] of sessionWindow) if (w === winWcId) sessionWindow.delete(sid);
    for (const [crid, w] of requestWindow) if (w === winWcId) requestWindow.delete(crid);
  });
  return win;
}

// ── IPC wiring ──────────────────────────────────────────────────────────────

registerFsHandlers();

ipcMain.handle('app:quit', () => { app.quit(); });
/** Close the requesting window (Cmd+W ladder's last rung). On the last window,
 *  window-all-closed quits on Win/Linux; macOS keeps the app running. */
ipcMain.handle('app:closeWindow', (e) => { BrowserWindow.fromWebContents(e.sender)?.close(); });
ipcMain.handle('app:newWindow', () => { createWindow(); });

ipcMain.handle('recents:list', () => listRecents());
ipcMain.handle('recents:add', (_e, path: string, name: string) => {
  const r = addRecent(path, name);
  refreshAppMenu(focusedWindow, openNewWindow);
  return r;
});
ipcMain.handle('recents:remove', (_e, path: string) => {
  const r = removeRecent(path);
  refreshAppMenu(focusedWindow, openNewWindow);
  return r;
});

// Account auth against the remote cloud API (apps/api). Local agent/fs stay local.
ipcMain.handle('auth:me', () => authMe());
ipcMain.handle('auth:login', (_e, email: string, password: string) => authLogin(email, password));
ipcMain.handle('auth:signup', (_e, email: string, password: string, name?: string) => authSignup(email, password, name));
ipcMain.handle('auth:logout', () => authLogout());
ipcMain.handle('auth:google', () => authGoogle());
ipcMain.handle('auth:cancelGoogle', () => { cancelGoogle(); });
ipcMain.handle('auth:updateProfile', (_e, payload) => authUpdateProfile(payload));
ipcMain.handle('auth:setPlan', (_e, payload) => authSetPlan(payload));

// User settings. Plain-JSON persisted in userData; saveSettings broadcasts
// settings:onChange to every window so multiple windows stay in step.
ipcMain.handle('settings:load', () => getSettings());
ipcMain.handle('settings:save', (_e, patch) => saveSettings(patch));

// Per-project workspace snapshot (open tabs + split layout), keyed by project
// root and persisted to disk so reopening a project (after restart or from Home)
// restores its layout. The save IPC updates the in-memory map synchronously, so
// a Cmd+R reload reads the freshest copy even before the debounced disk write.
ipcMain.on('workspace:saveSnapshot', (_e, snapshot: unknown) => saveWorkspaceSnapshot(snapshot));
ipcMain.handle('workspace:getSnapshot', (_e, root: string) => getWorkspaceSnapshot(root));

ipcMain.handle('agent:send', (e, msg: ClientMessage) =>
  dispatch(msg, (m) => { if (!e.sender.isDestroyed()) e.sender.send('agent:event', m); }, e.sender.id));

ipcMain.handle('app:editorPreloadPath', () => join(__dirname, '../preload/editor.js'));

// Hand the media-file:// capability token to the (trusted) app renderer only.
// sendSync so the preload bridge can expose it synchronously at load. Guest
// <webview> pages run their own preload and never call this.
ipcMain.on('ccb:mediaToken', (e) => { e.returnValue = MEDIA_TOKEN; });

// The cloud backend origin (CCB_BACKEND_ORIGIN) — shown read-only in Settings →
// Account. sendSync so the preload bridge can expose it synchronously at load.
ipcMain.on('ccb:backendOrigin', (e) => { e.returnValue = BACKEND_ORIGIN; });

// Persisted appearance, read SYNCHRONOUSLY by the preload so it can paint the
// saved theme onto <html> before the renderer's CSS loads — no flash of the
// default light theme on a dark-theme cold start. (settings-store re-applies the
// same values once it hydrates; this just wins the first paint.)
ipcMain.on('ccb:initialAppearance', (e) => { e.returnValue = getSettings().appearance; });

// The renderer reports each browser instance's <webview> guest id on dom-ready.
ipcMain.on('webview:ready', (_e, browserId: string, wcId: number) => {
  guests.set(browserId, wcId);
  // A freshly auto-created browser just attached — run any parked navigate.
  flushParkedRequests();
});
// A browser instance was closed — drop its guest so a recycled webContents id
// can never route an action to the wrong/destroyed guest.
ipcMain.on('webview:gone', (_e, browserId: string) => {
  guests.delete(browserId);
  for (const [wcId, active] of activeBrowserByWindow) {
    if (active === browserId) activeBrowserByWindow.set(wcId, null);
  }
});
// The focused browser changed in the SENDING window (per-window agent target).
ipcMain.on('browser:setActive', (e, browserId: string | null) => {
  activeBrowserByWindow.set(e.sender.id, browserId);
});
// The renderer reports which browser instance actually serviced an ensureOpen —
// re-key the parked request to it (handles a stale/undefined target) and flush
// once that instance's guest attaches.
ipcMain.on('browser:ensured', (_e, requestId: string, browserId: string) => {
  const parked = parkedRequests.find((r) => r.requestId === requestId);
  if (parked) parked.browserId = browserId;
  flushParkedRequests();
});

// Renderer finished mounting and subscribed to agent:event — send initial state
// to THAT window only (each window mounts independently).
ipcMain.on('app:ready', (e) => {
  if (e.sender.isDestroyed()) return;
  e.sender.send('agent:event', { type: 'connection:ready', serverVersion: app.getVersion() });
  e.sender.send('agent:event', { type: 'health', nodeVersion: process.version, claudeCodeInstalled: true, claudeAuthenticated: true });
});

// Guest <webview>s render with allowpopups; apply the same deny-and-open-externally
// policy the main window uses, so a target=_blank / window.open() in any page can't
// spawn a real OS window. (The main window's handler is set in createWindow.)
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      openExternalSafe(url);
      return { action: 'deny' };
    });
    // App shortcuts while a browser guest has focus: the host menu accelerator
    // and the host window's own before-input-event never see these (the guest
    // webContents owns the keystroke), so intercept here and forward to the host
    // window's renderer. Covers Ctrl+Tab (cycle tabs), Cmd/Ctrl+W (close tab),
    // Cmd/Ctrl+T (new browser tab), Cmd/Ctrl+Shift+T (reopen closed tab),
    // Cmd/Ctrl+Q (hold-to-quit), and Cmd/Ctrl+Z (undo last deletion).
    let guestCmdQHeld = false;
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' && input.type !== 'keyUp') return;
      const host = contents.hostWebContents;
      if (!host || host.isDestroyed()) return;
      const isMac = process.platform === 'darwin';
      const primary = isMac ? input.meta : input.control;
      const k = input.key.toLowerCase();
      const isKeyDown = input.type === 'keyDown';
      const isKeyUp = input.type === 'keyUp';
      const cleanMods = primary && !input.alt && !input.shift;

      if (input.key === 'Tab' && input.control && !input.meta && !input.alt && isKeyDown) {
        event.preventDefault();
        host.send(input.shift ? 'menu:prevTab' : 'menu:nextTab');
      } else if (k === 'w' && isKeyDown && cleanMods) {
        event.preventDefault();
        host.send('app:cmdW');
      } else if (k === 't' && isKeyDown && cleanMods) {
        event.preventDefault();
        host.send('menu:newBrowser');
      } else if (k === 't' && isKeyDown && primary && input.shift && !input.alt) {
        event.preventDefault();
        host.send('menu:reopenClosedTab');
      } else if (k === 'z' && isKeyDown && cleanMods) {
        event.preventDefault();
        host.send('menu:undoDelete');
      } else if (k === 'q') {
        if (isKeyDown && cleanMods) { event.preventDefault(); guestCmdQHeld = true; host.send('app:cmdQDown'); }
        else if (isKeyUp && guestCmdQHeld) { event.preventDefault(); guestCmdQHeld = false; host.send('app:cmdQUp'); }
      } else if (guestCmdQHeld && isKeyUp && (k === 'meta' || k === 'control')) {
        guestCmdQHeld = false;
        host.send('app:cmdQUp');
      }
    });
  }
});

/** Open a fresh top-level window (File → New Window / ⌘N). */
function openNewWindow(): void { createWindow(); }

app.whenReady().then(() => {
  // Dev dock icon (macOS): packaged builds use the .app bundle icon instead.
  if (process.platform === 'darwin' && app.dock && existsSync(BRAND_ICON)) {
    app.dock.setIcon(nativeImage.createFromPath(BRAND_ICON));
  }
  installAppMenu(focusedWindow, openNewWindow);
  // Microphone access for voice mode. Electron denies getUserMedia by default
  // unless a permission handler grants it; allow `media` (audio capture) so the
  // composer's voice conversation can hear the mic. (Note: webkitSpeechRecognition
  // still needs Google's API key that Electron's Chromium doesn't ship, so STT is
  // typically web-build-only — TTS works here regardless.)
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  // Restore the previous session's windows — one per project that was open at
  // quit/kill (hot-exit). Each window reopens its project and rebuilds its tabs +
  // unsaved content. Nothing open last time (or a fresh install) → one Home window.
  const sessionRoots = restorableSessionRoots();
  if (sessionRoots.length > 0) for (const root of sessionRoots) createWindow(root);
  else createWindow();
  // Mode B: expose this machine as a host the account can drive from the web
  // (opt-in via CCB_HOST_DAEMON=1; no-op otherwise). Polls for login internally.
  startHostDaemon();
  // Silent background auto-update (packaged builds only — no-op in dev).
  startUpdater();
  // Watch OS memory pressure and shed resources when it rises.
  startMemoryGovernor({ onPressure: reclaimMemory });
  // A child process (GPU/utility/agent) killed for OOM → reclaim aggressively.
  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'oom') reclaimMemory('critical');
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Flush any pending workspace-snapshot + open-roots writes so the last layout
// and the set of open projects survive quit.
app.on('before-quit', () => { flushWorkspaceSnapshots(); flushOpenRootsSession(); });
