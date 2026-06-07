/**
 * Main-window preload. Exposes a minimal, typed `window.ccb` bridge to the
 * renderer — the desktop equivalent of the extension's chrome.runtime.Port.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ClientMessage, ServerMessage, User, AuthResult, ProfilePayload, PlanPayload, Settings, SettingsPatch, UpdaterEvent } from '@fineguide-tesseract/shared';

// Persisted appearance, fetched synchronously at preload load (before the page's
// own scripts run). We can't reliably write <html> from here — at preload top
// level document.documentElement may not exist yet — so we EXPOSE it and let an
// inline <head> script in index.html apply it during parse (when <html> exists,
// before styles paint). That wins the very first frame, so a dark-theme user
// never flashes the default light theme on cold start. settings-store re-applies
// the same values once it hydrates (idempotent). Best-effort: on any failure the
// store's later application is the fallback (prior behavior).
let initialAppearance: Settings['appearance'] | null = null;
try { initialAppearance = (ipcRenderer.sendSync('ccb:initialAppearance') as Settings['appearance']) ?? null; } catch { /* fallback to store */ }
try { contextBridge.exposeInMainWorld('__ccbAppearance', initialAppearance); } catch { /* ignore */ }

const api = {
  /** Always true under Electron — renderer uses this to branch on transport. */
  isElectron: true as const,

  /** Capability token for media-file:// requests (mediaUrl appends it as ?t=).
   *  Lives only in this trusted renderer's process so guest pages can't read
   *  arbitrary local files via the shared scheme handler. */
  mediaToken: ipcRenderer.sendSync('ccb:mediaToken') as string,

  /** The cloud backend origin (CCB_BACKEND_ORIGIN) — shown read-only in
   *  Settings → Account. */
  backendOrigin: ipcRenderer.sendSync('ccb:backendOrigin') as string,

  /** Send a ClientMessage to the agent backend (main process). */
  send(msg: ClientMessage): Promise<void> {
    return ipcRenderer.invoke('agent:send', msg);
  },
  /** Subscribe to ServerMessage events. Returns an unsubscribe fn. */
  onAgentEvent(cb: (msg: ServerMessage) => void): () => void {
    const handler = (_e: unknown, msg: ServerMessage) => cb(msg);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
  /** Absolute path to the <webview> guest editor preload. */
  editorPreloadPath(): Promise<string> {
    return ipcRenderer.invoke('app:editorPreloadPath');
  },
  /** Report a browser instance's <webview> guest webContents id to main. */
  setGuest(browserId: string, webContentsId: number): void {
    ipcRenderer.send('webview:ready', browserId, webContentsId);
  },
  /** Tell main a browser instance's guest was destroyed (instance closed). */
  notifyGuestGone(browserId: string): void {
    ipcRenderer.send('webview:gone', browserId);
  },
  /** Tell main which browser instance is focused (interim agent target). */
  setActiveBrowser(browserId: string | null): void {
    ipcRenderer.send('browser:setActive', browserId);
  },
  /** Main asks the renderer to open/navigate a browser (agent navigated with no
   *  usable guest). `browserId` is the chat's bound browser, if any; `requestId`
   *  correlates the parked agent request. */
  onEnsureBrowser(cb: (payload: { url: string; browserId?: string; requestId: string }) => void): () => void {
    const handler = (_e: unknown, payload: { url: string; browserId?: string; requestId: string }) => cb(payload);
    ipcRenderer.on('browser:ensureOpen', handler);
    return () => ipcRenderer.removeListener('browser:ensureOpen', handler);
  },
  /** Report back which browser instance actually serviced an ensureOpen, so main
   *  re-keys the parked request to it before flushing. */
  browserEnsured(requestId: string, browserId: string): void {
    ipcRenderer.send('browser:ensured', requestId, browserId);
  },
  /** Signal that the renderer has mounted and subscribed. */
  ready(): void {
    ipcRenderer.send('app:ready');
  },
  /** Subscribe to OS memory-pressure escalations from the main-process governor.
   *  Returns an unsubscribe fn. */
  onMemoryPressure(cb: (level: 'moderate' | 'critical') => void): () => void {
    const handler = (_e: unknown, payload: { level: 'moderate' | 'critical' }) => cb(payload.level);
    ipcRenderer.on('memory:pressure', handler);
    return () => ipcRenderer.removeListener('memory:pressure', handler);
  },

  /** Host registry. The desktop app IS its single local host; it doesn't drive
   *  remote hosts, so this reports just "this machine" and selection is inert. */
  host: {
    list(): Promise<Array<{ hostId: string; name: string; kind: 'server' | 'electron'; platform?: string; online: boolean; caps?: string[] }>> {
      return Promise.resolve([{ hostId: 'local', name: 'This computer', kind: 'electron', platform: process.platform, online: true, caps: ['browser', 'webrtc'] }]);
    },
    select(_hostId: string | null): void { /* desktop drives the local machine only */ },
    selected(): string | null { return 'local'; },
    onChange(_cb: (hosts: unknown[]) => void): () => void { return () => { /* no remote registry in Electron */ }; },
  },
  /** WebRTC signaling — unused in Electron (it drives its embedded <webview> directly). */
  signal: {
    send(_browserId: string, _msg: unknown): void { /* no-op in Electron */ },
    on(_cb: (msg: unknown, browserId?: string) => void): () => void { return () => {}; },
  },
  /** Interactive remote-browser control + fallback frames — unused in Electron. */
  browser: {
    send(_browserId: string, _msg: unknown): void { /* no-op in Electron */ },
    on(_cb: (msg: unknown, browserId?: string) => void): () => void { return () => {}; },
    onFrame(_cb: (data: ArrayBuffer) => void): () => void { return () => {}; },
  },

  /** Project filesystem access for the IDE shell. */
  fs: {
    openFolder(path?: string): Promise<{ root: string; name: string } | null> {
      return ipcRenderer.invoke('fs:openFolder', path);
    },
    pickFolder(): Promise<string | null> {
      return ipcRenderer.invoke('fs:pickFolder');
    },
    saveDialog(defaultPath?: string): Promise<string | null> {
      return ipcRenderer.invoke('fs:saveDialog', defaultPath);
    },
    readDir(dir: string): Promise<Array<{ name: string; path: string; isDir: boolean }>> {
      return ipcRenderer.invoke('fs:readDir', dir);
    },
    readFile(path: string): Promise<{ content?: string; error?: string }> {
      return ipcRenderer.invoke('fs:readFile', path);
    },
    writeFile(path: string, content: string): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke('fs:writeFile', path, content);
    },
    createProject(parent: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }> {
      return ipcRenderer.invoke('fs:createProject', parent, name);
    },
    statFile(path: string): Promise<{ size?: number; isBinary?: boolean; mtimeMs?: number; error?: string }> {
      return ipcRenderer.invoke('fs:statFile', path);
    },
    readChunk(path: string, offset: number, length: number): Promise<{ base64?: string; bytesRead?: number; error?: string }> {
      return ipcRenderer.invoke('fs:readChunk', path, offset, length);
    },
    readBinary(path: string): Promise<{ base64?: string; size?: number; error?: string }> {
      return ipcRenderer.invoke('fs:readBinary', path);
    },
    revealInFinder(path: string): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke('fs:revealInFinder', path);
    },
    openExternal(path: string): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke('fs:openExternal', path);
    },
    openWith(path: string): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke('fs:openWith', path);
    },
    renameFile(oldPath: string, newName: string): Promise<{ ok: boolean; newPath?: string; error?: string }> {
      return ipcRenderer.invoke('fs:renameFile', oldPath, newName);
    },
    createFile(parent: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }> {
      return ipcRenderer.invoke('fs:createFile', parent, name);
    },
    createFolder(parent: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }> {
      return ipcRenderer.invoke('fs:createFolder', parent, name);
    },
    deletePath(path: string): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke('fs:deletePath', path);
    },
    undoDelete(): Promise<{ ok: boolean; path?: string; isDir?: boolean; error?: string }> {
      return ipcRenderer.invoke('fs:undoDelete');
    },
    /** Release this window's project root + watcher (on project close). */
    releaseRoot(): Promise<void> {
      return ipcRenderer.invoke('fs:releaseRoot');
    },
    /** This window's open project root (survives a renderer reload, and is
     *  pre-seeded by main on a cold launch when restoring the last session), or null. */
    currentRoot(): Promise<{ root: string; name: string } | null> {
      return ipcRenderer.invoke('fs:currentRoot');
    },
    copyPaths(srcPaths: string[], destDir: string): Promise<{ ok: boolean; newPaths?: string[]; error?: string }> {
      return ipcRenderer.invoke('fs:copyPaths', srcPaths, destDir);
    },
    movePaths(srcPaths: string[], destDir: string): Promise<{ ok: boolean; newPaths?: string[]; error?: string }> {
      return ipcRenderer.invoke('fs:movePaths', srcPaths, destDir);
    },
    /** Resolve a `File` object dropped from the OS into its absolute path. */
    getDroppedFilePath(file: File): string {
      return webUtils.getPathForFile(file);
    },
    onFsChange(cb: (paths: string[]) => void): () => void {
      const handler = (_e: unknown, paths: string[]) => cb(paths);
      ipcRenderer.on('fs:changed', handler);
      return () => ipcRenderer.removeListener('fs:changed', handler);
    },
  },

  /** App-level shell controls. */
  app: {
    /** Quit the desktop app immediately, no confirmation. */
    quit(): Promise<void> {
      return ipcRenderer.invoke('app:quit');
    },
    /** Open a new top-level application window. */
    newWindow(): Promise<void> {
      return ipcRenderer.invoke('app:newWindow');
    },
    /** Close the window this renderer belongs to (Cmd+W ladder's last rung). */
    closeWindow(): Promise<void> {
      return ipcRenderer.invoke('app:closeWindow');
    },
    /** Fires when the user presses Cmd+W (or Ctrl+W on Win/Linux). */
    onCmdW(cb: () => void): () => void {
      const handler = () => cb();
      ipcRenderer.on('app:cmdW', handler);
      return () => ipcRenderer.removeListener('app:cmdW', handler);
    },
    /** Fires on Cmd+Q keydown. The renderer manages the hold-to-quit overlay. */
    onCmdQDown(cb: () => void): () => void {
      const handler = () => cb();
      ipcRenderer.on('app:cmdQDown', handler);
      return () => ipcRenderer.removeListener('app:cmdQDown', handler);
    },
    /** Fires on Cmd+Q keyup. */
    onCmdQUp(cb: () => void): () => void {
      const handler = () => cb();
      ipcRenderer.on('app:cmdQUp', handler);
      return () => ipcRenderer.removeListener('app:cmdQUp', handler);
    },
    /** Subscribe to any of the `menu:*` events fired by main when a menu
     *  item is clicked. The renderer's `useAppMenu` hook fans these out to
     *  the appropriate store actions. */
    onMenu(channel: string, cb: (...args: unknown[]) => void): () => void {
      const handler = (_e: unknown, ...args: unknown[]) => cb(...args);
      ipcRenderer.on(`menu:${channel}`, handler);
      return () => ipcRenderer.removeListener(`menu:${channel}`, handler);
    },
  },

  /** Per-window workspace snapshot (open tabs + split layout) for reload restore.
   *  Held in the main process keyed by this window, so it survives a Cmd+R. */
  workspace: {
    saveSnapshot(snapshot: unknown): void { ipcRenderer.send('workspace:saveSnapshot', snapshot); },
    getSnapshot(root: string): Promise<unknown | null> { return ipcRenderer.invoke('workspace:getSnapshot', root); },
  },

  /** Recent-projects persistence. */
  recents: {
    list(): Promise<Array<{ path: string; name: string; lastOpenedAt: number }>> {
      return ipcRenderer.invoke('recents:list');
    },
    add(path: string, name: string): Promise<Array<{ path: string; name: string; lastOpenedAt: number }>> {
      return ipcRenderer.invoke('recents:add', path, name);
    },
    remove(path: string): Promise<Array<{ path: string; name: string; lastOpenedAt: number }>> {
      return ipcRenderer.invoke('recents:remove', path);
    },
  },

  /** Account auth against the cloud API. The token is held + stored (safeStorage)
   *  by the main process; the local agent/fs IPC stays local and ungated. */
  auth: {
    /** Desktop is never gated — the app works without login. */
    requireAuth(): Promise<boolean> { return Promise.resolve(false); },
    me(): Promise<User | null> { return ipcRenderer.invoke('auth:me'); },
    login(email: string, password: string): Promise<AuthResult> {
      return ipcRenderer.invoke('auth:login', email, password);
    },
    signup(email: string, password: string, name?: string): Promise<AuthResult> {
      return ipcRenderer.invoke('auth:signup', email, password, name);
    },
    loginWithGoogle(): Promise<AuthResult> { return ipcRenderer.invoke('auth:google'); },
    cancelGoogleSignIn(): Promise<void> { return ipcRenderer.invoke('auth:cancelGoogle'); },
    updateProfile(payload: ProfilePayload): Promise<AuthResult> { return ipcRenderer.invoke('auth:updateProfile', payload); },
    setPlan(payload: PlanPayload): Promise<AuthResult> { return ipcRenderer.invoke('auth:setPlan', payload); },
    logout(): Promise<void> { return ipcRenderer.invoke('auth:logout'); },
    onChange(cb: (user: User | null) => void): () => void {
      const handler = (_e: unknown, user: User | null) => cb(user);
      ipcRenderer.on('auth:onChange', handler);
      return () => ipcRenderer.removeListener('auth:onChange', handler);
    },
  },

  /** Silent background auto-update (packaged desktop only). The download runs
   *  in the background and applies on next quit; `onEvent`/`state` drive a
   *  subtle "Update ready" pill, `installNow` lets the user apply it now. */
  updater: {
    /** Subscribe to update lifecycle events. Returns an unsubscribe fn. */
    onEvent(cb: (event: UpdaterEvent) => void): () => void {
      const handler = (_e: unknown, event: UpdaterEvent) => cb(event);
      ipcRenderer.on('updater:event', handler);
      return () => ipcRenderer.removeListener('updater:event', handler);
    },
    /** The latest event (replayed for renderers mounting after it fired). */
    state(): Promise<UpdaterEvent | null> { return ipcRenderer.invoke('updater:state'); },
    /** Force a check now (Settings → "Check for updates"). */
    check(): Promise<void> { return ipcRenderer.invoke('updater:check'); },
    /** Quit and apply the staged update immediately, then relaunch. */
    installNow(): Promise<void> { return ipcRenderer.invoke('updater:installNow'); },
  },

  /** User settings (theme, editor, agent, general). Persisted by the main
   *  process in userData/settings.json; `onChange` keeps windows in sync. */
  settings: {
    load(): Promise<Settings> { return ipcRenderer.invoke('settings:load'); },
    save(patch: SettingsPatch): Promise<Settings> { return ipcRenderer.invoke('settings:save', patch); },
    onChange(cb: (settings: Settings) => void): () => void {
      const handler = (_e: unknown, settings: Settings) => cb(settings);
      ipcRenderer.on('settings:onChange', handler);
      return () => ipcRenderer.removeListener('settings:onChange', handler);
    },
  },
};

export type CcbApi = typeof api;

contextBridge.exposeInMainWorld('ccb', api);
