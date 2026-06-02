/**
 * Main-window preload. Exposes a minimal, typed `window.ccb` bridge to the
 * renderer — the desktop equivalent of the extension's chrome.runtime.Port.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ClientMessage, ServerMessage } from '@claude-code-browser/shared';

const api = {
  /** Always true under Electron — renderer uses this to branch on transport. */
  isElectron: true as const,

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
  /** Report the attached <webview> guest's webContents id to main. */
  setGuest(webContentsId: number): void {
    ipcRenderer.send('webview:ready', webContentsId);
  },
  /** Signal that the renderer has mounted and subscribed. */
  ready(): void {
    ipcRenderer.send('app:ready');
  },

  /** Project filesystem access for the IDE shell. */
  fs: {
    openFolder(path?: string): Promise<{ root: string; name: string } | null> {
      return ipcRenderer.invoke('fs:openFolder', path);
    },
    pickFolder(): Promise<string | null> {
      return ipcRenderer.invoke('fs:pickFolder');
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
    statFile(path: string): Promise<{ size?: number; isBinary?: boolean; tooLargeForHex?: boolean; error?: string }> {
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
};

export type CcbApi = typeof api;

contextBridge.exposeInMainWorld('ccb', api);
