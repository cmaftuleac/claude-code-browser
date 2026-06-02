/**
 * Web-mode transport polyfill.
 *
 * When the renderer is loaded in a plain browser (no Electron preload), we
 * install `window.ccb` ourselves so every store/component sees the same shape
 * it would under Electron. The wire protocol is identical (ClientMessage /
 * ServerMessage); the transport is a WebSocket + HTTP /fs endpoints served by
 * apps/server. Same protocol → same handlers → zero downstream component
 * changes.
 *
 * Importing this module is a side-effect; main.tsx loads it before App.
 */

// Bail out under Electron — the contextBridge preload already populated ccb.
if (typeof window !== 'undefined' && !(window as unknown as { ccb?: unknown }).ccb) {
  type AgentEventCb = (msg: unknown) => void;
  type FsChangeCb = (paths: string[]) => void;

  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  let ws: WebSocket | null = null;
  let outbox: string[] = [];
  const agentSubs = new Set<AgentEventCb>();
  const fsSubs = new Set<FsChangeCb>();
  let cachedRoot: { root: string; name: string } | null = null;

  function connect(): void {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      const queued = outbox;
      outbox = [];
      for (const data of queued) ws!.send(data);
    };
    ws.onmessage = (ev) => {
      let m: { type?: string; [k: string]: unknown };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === 'fs:changed' && Array.isArray(m.paths)) {
        for (const cb of fsSubs) cb(m.paths as string[]);
        return;
      }
      if (m.type === 'fs:root' && typeof m.root === 'string' && typeof m.name === 'string') {
        cachedRoot = { root: m.root as string, name: m.name as string };
        return;
      }
      for (const cb of agentSubs) cb(m);
    };
    ws.onclose = () => setTimeout(connect, 1000);
    ws.onerror = () => { /* let onclose drive reconnect */ };
  }
  connect();

  async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
    const r = await fetch(input, init);
    return (await r.json()) as T;
  }

  const api = {
    isElectron: false,

    send(msg: unknown): Promise<void> {
      const data = JSON.stringify(msg);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
      else outbox.push(data);
      return Promise.resolve();
    },

    onAgentEvent(cb: AgentEventCb): () => void {
      agentSubs.add(cb);
      return () => agentSubs.delete(cb);
    },

    editorPreloadPath(): Promise<string> {
      // No preload in browser mode — the visual editor inside <webview> isn't available.
      return Promise.resolve('');
    },

    setGuest(_id: number): void { /* no-op */ },

    ready(): void { /* WS handshake is the readiness signal */ },

    fs: {
      async openFolder(path?: string): Promise<{ root: string; name: string } | null> {
        if (typeof path === 'string' && path.length > 0) {
          try {
            const r = await fetch('/fs/openFolder', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path }),
            });
            if (!r.ok) return null;
            return (await r.json()) as { root: string; name: string };
          } catch {
            return null;
          }
        }
        if (cachedRoot) return cachedRoot;
        try {
          return await fetchJson<{ root: string; name: string }>('/fs/root');
        } catch {
          return null;
        }
      },
      pickFolder(): Promise<string | null> {
        // No native dialog in the browser; callers should use a path input instead.
        return Promise.resolve(null);
      },
      readDir(dir: string): Promise<Array<{ name: string; path: string; isDir: boolean }>> {
        return fetchJson(`/fs/readDir?dir=${encodeURIComponent(dir)}`);
      },
      readFile(path: string): Promise<{ content?: string; error?: string }> {
        return fetchJson(`/fs/readFile?path=${encodeURIComponent(path)}`);
      },
      writeFile(path: string, content: string): Promise<{ ok: boolean; error?: string }> {
        return fetchJson('/fs/writeFile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, content }),
        });
      },
      createProject(parent: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }> {
        return fetchJson('/fs/createProject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parent, name }),
        });
      },
      statFile(path: string): Promise<{ size?: number; isBinary?: boolean; tooLargeForHex?: boolean; error?: string }> {
        return fetchJson(`/fs/statFile?path=${encodeURIComponent(path)}`);
      },
      readChunk(path: string, offset: number, length: number): Promise<{ base64?: string; bytesRead?: number; error?: string }> {
        return fetchJson(`/fs/readChunk?path=${encodeURIComponent(path)}&offset=${offset}&length=${length}`);
      },
      readBinary(path: string): Promise<{ base64?: string; size?: number; error?: string }> {
        return fetchJson(`/fs/readBinary?path=${encodeURIComponent(path)}`);
      },
      revealInFinder(_path: string): Promise<{ ok: boolean; error?: string }> {
        // Browsers can't reveal in Finder. Return a friendly no-op.
        return Promise.resolve({ ok: false, error: 'Reveal in Finder is only available in the desktop app.' });
      },
      openExternal(path: string): Promise<{ ok: boolean; error?: string }> {
        // Web fallback: open the file URL in a new tab. Limited but useful.
        window.open(`file://${path}`, '_blank');
        return Promise.resolve({ ok: true });
      },
      openWith(_path: string): Promise<{ ok: boolean; error?: string }> {
        // The OS-level "Open With…" picker is desktop-only.
        return Promise.resolve({ ok: false, error: 'Open With… is only available in the desktop app.' });
      },
      renameFile(oldPath: string, newName: string): Promise<{ ok: boolean; newPath?: string; error?: string }> {
        return fetchJson('/fs/renameFile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldPath, newName }),
        });
      },
      createFile(parent: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }> {
        return fetchJson('/fs/createFile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parent, name }),
        });
      },
      createFolder(parent: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }> {
        return fetchJson('/fs/createFolder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parent, name }),
        });
      },
      deletePath(path: string): Promise<{ ok: boolean; error?: string }> {
        return fetchJson(`/fs/path?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      },
      copyPaths(srcPaths: string[], destDir: string): Promise<{ ok: boolean; newPaths?: string[]; error?: string }> {
        return fetchJson('/fs/copyPaths', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ srcPaths, destDir }),
        });
      },
      movePaths(srcPaths: string[], destDir: string): Promise<{ ok: boolean; newPaths?: string[]; error?: string }> {
        return fetchJson('/fs/movePaths', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ srcPaths, destDir }),
        });
      },
      getDroppedFilePath(_file: File): string {
        // Browsers don't expose filesystem paths from drag-drops. Web mode
        // would need to read the file blob and POST it via /fs/writeFile,
        // which is out of scope for this iteration.
        return '';
      },
      onFsChange(cb: FsChangeCb): () => void {
        fsSubs.add(cb);
        return () => fsSubs.delete(cb);
      },
    },

    recents: {
      list(): Promise<Array<{ path: string; name: string; lastOpenedAt: number }>> {
        return fetchJson('/recents');
      },
      add(path: string, name: string): Promise<Array<{ path: string; name: string; lastOpenedAt: number }>> {
        return fetchJson('/recents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, name }),
        });
      },
      remove(path: string): Promise<Array<{ path: string; name: string; lastOpenedAt: number }>> {
        return fetchJson(`/recents?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      },
    },

    app: {
      // Web mode: quitting the tab isn't ours to do; the user just closes the tab.
      quit(): Promise<void> { window.close(); return Promise.resolve(); },
      // In a browser tab, native Cmd+W/Cmd+Q go to the browser itself —
      // we don't get key events for them. These hooks are no-ops in web mode.
      onCmdW(_cb: () => void): () => void { return () => {}; },
      onCmdQDown(_cb: () => void): () => void { return () => {}; },
      onCmdQUp(_cb: () => void): () => void { return () => {}; },
      // Web mode has no native menu bar — the browser owns its own.
      onMenu(_channel: string, _cb: (...args: unknown[]) => void): () => void { return () => {}; },
    },
  };

  // Install onto window. Type cast is the cost of stubbing the contextBridge API.
  (window as unknown as { ccb: unknown }).ccb = api;
}
