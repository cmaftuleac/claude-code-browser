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
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type Settings,
  type SettingsPatch,
  type User,
  type AuthResult,
  type ProfilePayload,
  type PlanPayload,
  type TesseractClaims,
  type UpdaterEvent,
} from '@fineguide-tesseract/shared';

// Bail out under Electron — the contextBridge preload already populated ccb.
if (typeof window !== 'undefined' && !(window as unknown as { ccb?: unknown }).ccb) {
  type AgentEventCb = (msg: unknown) => void;
  type FsChangeCb = (paths: string[]) => void;

  type AuthChangeCb = (user: User | null) => void;

  let ws: WebSocket | null = null;
  let wsStopped = false;
  let outbox: string[] = [];
  const agentSubs = new Set<AgentEventCb>();
  const fsSubs = new Set<FsChangeCb>();
  const authSubs = new Set<AuthChangeCb>();
  let cachedRoot: { root: string; name: string } | null = null;
  // Which host (cloud server / a user's Electron machine) agent traffic routes to.
  // null = the backend's default host (the cloud server). Tagged onto every
  // outgoing control envelope so the backend routes it.
  let selectedHostId: string | null = null;

  // Multiplexed control channels (all over the single socket).
  type HostInfoT = { hostId: string; name: string; kind: 'server' | 'electron'; platform?: string; online: boolean; caps?: string[] };
  let knownHosts: HostInfoT[] = [];
  const hostSubs = new Set<(hosts: HostInfoT[]) => void>();
  // One-shot resolvers for in-flight host.list() calls, flushed on the next push.
  let hostListWaiters: Array<(hosts: HostInfoT[]) => void> = [];
  const signalSubs = new Set<(msg: unknown, browserId?: string) => void>();
  const browserSubs = new Set<(msg: unknown, browserId?: string) => void>();
  const frameSubs = new Set<(data: ArrayBuffer) => void>();

  // ── Auth token + cached user (localStorage; wrapped for private-mode safety) ──
  const TOKEN_KEY = 'ccb.authToken';
  const USER_KEY = 'ccb.authUser';
  let token: string | null = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch { token = null; }
  function readCachedUser(): User | null {
    try { const raw = localStorage.getItem(USER_KEY); return raw ? (JSON.parse(raw) as User) : null; } catch { return null; }
  }
  function setSession(t: string | null, user: User | null): void {
    token = t;
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY);
      if (user) localStorage.setItem(USER_KEY, JSON.stringify(user)); else localStorage.removeItem(USER_KEY);
    } catch { /* ignore */ }
  }
  /** Decode the JWT payload (no signature check — the server already verified it) so
   *  the full profile, incl. the onboarding gate signal, is available offline/at boot. */
  function decodeClaims(t: string): User | null {
    try {
      const payload = t.split('.')[1];
      if (!payload) return null;
      const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
      const bytes = Uint8Array.from(atob(b64 + pad), (ch) => ch.charCodeAt(0));
      const c = JSON.parse(new TextDecoder().decode(bytes)) as TesseractClaims;
      if (!c.sub) return null;
      return {
        id: c.sub,
        email: c.email,
        name: c.name,
        accountType: c.accountType,
        orgId: c.orgId,
        orgName: c.orgName,
        plan: c.plan,
        interval: c.interval,
        onboardingComplete: c.onboardingComplete,
      };
    } catch { return null; }
  }
  // ── User settings (localStorage) ────────────────────────────────────────
  const SETTINGS_KEY = 'ccb.settings';
  const settingsSubs = new Set<(s: Settings) => void>();
  function readSettings(): Settings {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return mergeSettings(raw ? (JSON.parse(raw) as Partial<Settings>) : null);
    } catch { return DEFAULT_SETTINGS; }
  }

  // Capture a Google redirect token (#token=…) on boot, then strip it from the URL.
  try {
    if (location.hash.startsWith('#token=')) {
      const t = decodeURIComponent(location.hash.slice('#token='.length));
      // Cache the claim-derived profile too, so the onboarding gate has the
      // onboardingComplete signal immediately — before /auth/me round-trips.
      if (t) setSession(t, decodeClaims(t));
      history.replaceState(null, '', location.pathname + location.search);
    }
  } catch { /* ignore */ }

  function authHeaders(init?: RequestInit): RequestInit {
    if (!token) return init ?? {};
    return { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } };
  }
  /** Explicit denial only: clear the session and notify the gate (→ login). */
  function handleUnauthorized(): void {
    setSession(null, null);
    for (const cb of authSubs) cb(null);
  }

  function buildWsUrl(): string {
    const base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  /** Deliver an unwrapped `agent`-channel payload (ServerMessage + fs:* host state). */
  function deliverAgent(m: { type?: string; [k: string]: unknown }): void {
    if (m.type === 'fs:changed' && Array.isArray(m.paths)) {
      for (const cb of fsSubs) cb(m.paths as string[]);
      return;
    }
    if (m.type === 'fs:root' && typeof m.root === 'string' && typeof m.name === 'string') {
      cachedRoot = { root: m.root as string, name: m.name as string };
      return;
    }
    for (const cb of agentSubs) cb(m);
  }

  /** Maintain the host registry cache from `host`-channel pushes. */
  function deliverHost(m: { type?: string; hosts?: HostInfoT[]; host?: HostInfoT; hostId?: string }): void {
    if (m.type === 'host:list' && Array.isArray(m.hosts)) knownHosts = m.hosts;
    else if (m.type === 'host:online' && m.host) knownHosts = [...knownHosts.filter((h) => h.hostId !== m.host!.hostId), m.host];
    else if (m.type === 'host:offline' && m.hostId) knownHosts = knownHosts.filter((h) => h.hostId !== m.hostId);
    else return;
    for (const cb of hostSubs) cb(knownHosts);
    if (hostListWaiters.length) { const w = hostListWaiters; hostListWaiters = []; for (const r of w) r(knownHosts); }
  }

  /** Multiplex an outgoing message onto a channel of the single socket. */
  function sendEnvelope(channel: string, payload: unknown, route?: { hostId?: string; browserId?: string }): void {
    const env: { channel: string; payload: unknown; hostId?: string; browserId?: string } = { channel, payload };
    // `host` ops address the backend itself; everything else routes to the host.
    if (channel !== 'host' && selectedHostId) env.hostId = selectedHostId;
    if (route?.hostId) env.hostId = route.hostId;
    if (route?.browserId) env.browserId = route.browserId;
    const data = JSON.stringify(env);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    else outbox.push(data);
  }

  function connect(): void {
    ws = new WebSocket(buildWsUrl());
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const queued = outbox;
      outbox = [];
      for (const data of queued) ws!.send(data);
    };
    ws.onmessage = (ev) => {
      // Binary = a `frame`-channel video frame (fallback streaming, Phase 2).
      if (typeof ev.data !== 'string') {
        if (ev.data instanceof ArrayBuffer) for (const cb of frameSubs) cb(ev.data);
        return;
      }
      let raw: { channel?: unknown; payload?: unknown; browserId?: unknown; [k: string]: unknown };
      try { raw = JSON.parse(ev.data); } catch { return; }
      // Control-plane envelope → route by channel. Raw frames (no `channel`,
      // e.g. an older server) fall back to the agent channel for resilience.
      if (typeof raw.channel === 'string' && 'payload' in raw) {
        const inner = (raw.payload ?? {}) as { type?: string; [k: string]: unknown };
        const bid = typeof raw.browserId === 'string' ? raw.browserId : undefined;
        switch (raw.channel) {
          case 'agent': deliverAgent(inner); break;
          case 'host': deliverHost(inner); break;
          case 'signal': for (const cb of signalSubs) cb(inner, bid); break;
          case 'browser': for (const cb of browserSubs) cb(inner, bid); break;
          // 'notify' has no consumer yet.
        }
        return;
      }
      deliverAgent(raw as { type?: string; [k: string]: unknown });
    };
    ws.onclose = () => { if (!wsStopped && shouldConnect()) setTimeout(connect, 1000); };
    ws.onerror = () => { /* let onclose drive reconnect */ };
  }
  // A gated server rejects a tokenless socket — don't loop-reconnect while logged out.
  function shouldConnect(): boolean { return requireAuthCache !== true || token != null; }
  /** Re-dial the socket (with the current token). Called after login/logout. */
  function reconnect(): void {
    wsStopped = false;
    if (ws) { const old = ws; ws = null; try { old.onclose = null; old.close(); } catch { /* ignore */ } }
    outbox = []; // drop anything queued under the anon socket
    if (shouldConnect()) connect();
  }

  // requireAuth detection via /health (cached). Falls back to false so a down/old
  // server never hard-blocks the app.
  let requireAuthCache: boolean | null = null;
  async function detectRequireAuth(): Promise<boolean> {
    if (requireAuthCache !== null) return requireAuthCache;
    try {
      const r = await fetch('/health');
      const j = (await r.json().catch(() => ({}))) as { requireAuth?: boolean };
      requireAuthCache = j?.requireAuth === true;
    } catch { requireAuthCache = false; }
    return requireAuthCache;
  }

  // Defer the initial WS connect when the server is gated and we have no token —
  // a gated server rejects a tokenless socket. reconnect() opens it after login.
  void (async () => {
    const required = await detectRequireAuth();
    if (!required || token) connect();
  })();

  async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
    const r = await fetch(input, authHeaders(init));
    if (r.status === 401) { handleUnauthorized(); throw new Error('unauthorized'); }
    return (await r.json()) as T;
  }

  /** POST JSON to an /auth endpoint, surfacing the server's error message.
   *  Does NOT trigger the global 401 logout — a failed login is not an expired session. */
  async function postAuth<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(path, authHeaders({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    const data = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!r.ok) throw new Error(data?.error ?? data?.message ?? `Request failed (${r.status})`);
    return data as T;
  }

  const api = {
    isElectron: false,
    // Web streams media over /fs/stream, which is JWT-gated when auth is on. An
    // <img>/<video> request can't set an Authorization header, so mediaUrl()
    // appends this as `?token=`. A getter so it always reflects the live token
    // (updated on login/logout). Empty when logged out / auth off.
    get mediaToken(): string { return token ?? ''; },
    // Web talks to the same-origin gateway.
    get backendOrigin(): string { return location.origin; },

    send(msg: unknown): Promise<void> {
      // Agent traffic rides the `agent` channel of the one socket, routed to the
      // selected host (null = the default cloud server).
      sendEnvelope('agent', msg);
      return Promise.resolve();
    },

    onAgentEvent(cb: AgentEventCb): () => void {
      agentSubs.add(cb);
      return () => agentSubs.delete(cb);
    },

    // ── Host registry (account-keyed) ──────────────────────────────────────
    host: {
      list(): Promise<HostInfoT[]> {
        // Resolve with the FRESH list (next host:list push), falling back to the
        // cached list after 1.5s so a down/slow backend never hangs the caller.
        sendEnvelope('host', { type: 'host:list' });
        return new Promise<HostInfoT[]>((resolve) => {
          hostListWaiters.push(resolve);
          setTimeout(() => {
            const i = hostListWaiters.indexOf(resolve);
            if (i >= 0) { hostListWaiters.splice(i, 1); resolve(knownHosts); }
          }, 1500);
        });
      },
      select(hostId: string | null): void {
        selectedHostId = hostId;
        if (hostId) sendEnvelope('host', { type: 'host:select', hostId });
      },
      selected(): string | null { return selectedHostId; },
      onChange(cb: (hosts: HostInfoT[]) => void): () => void {
        hostSubs.add(cb);
        if (knownHosts.length) cb(knownHosts);
        return () => hostSubs.delete(cb);
      },
    },

    // ── WebRTC signaling relay (SDP/ICE; media stays peer-to-peer) ─────────
    signal: {
      send(browserId: string, msg: unknown): void { sendEnvelope('signal', msg, { browserId }); },
      on(cb: (msg: unknown, browserId?: string) => void): () => void { signalSubs.add(cb); return () => signalSubs.delete(cb); },
    },

    // ── Interactive browser control + fallback frame stream ────────────────
    browser: {
      send(browserId: string, msg: unknown): void { sendEnvelope('browser', msg, { browserId }); },
      on(cb: (msg: unknown, browserId?: string) => void): () => void { browserSubs.add(cb); return () => browserSubs.delete(cb); },
      onFrame(cb: (data: ArrayBuffer) => void): () => void { frameSubs.add(cb); return () => frameSubs.delete(cb); },
    },

    editorPreloadPath(): Promise<string> {
      // No preload in browser mode — the visual editor inside <webview> isn't available.
      return Promise.resolve('');
    },

    setGuest(_browserId: string, _id: number): void { /* no-op — no webContents in browser mode */ },
    notifyGuestGone(_browserId: string): void { /* no-op */ },
    setActiveBrowser(_browserId: string | null): void { /* no-op */ },
    onEnsureBrowser(_cb: (payload: { url: string; browserId?: string; requestId: string }) => void): () => void { return () => { /* no-op */ }; },
    browserEnsured(_requestId: string, _browserId: string): void { /* no-op */ },

    ready(): void { /* WS handshake is the readiness signal */ },
    onMemoryPressure(_cb: (level: 'moderate' | 'critical') => void): () => void { return () => { /* no-op in web mode */ }; },

    fs: {
      async openFolder(path?: string): Promise<{ root: string; name: string } | null> {
        if (typeof path === 'string' && path.length > 0) {
          try {
            const r = await fetch('/fs/openFolder', authHeaders({
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path }),
            }));
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
      saveDialog(_defaultPath?: string): Promise<string | null> {
        // No native save dialog in the browser; untitled Save As is a no-op here.
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
      statFile(path: string): Promise<{ size?: number; isBinary?: boolean; mtimeMs?: number; error?: string }> {
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
      openExternal(_path: string): Promise<{ ok: boolean; error?: string }> {
        // Browsers can't open local files, and building a `file://` target from
        // a renderer-supplied path is an unvalidated navigation we don't want.
        return Promise.resolve({ ok: false, error: 'Opening local files is only available in the desktop app.' });
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
      undoDelete(): Promise<{ ok: boolean; path?: string; isDir?: boolean; error?: string }> {
        // Web mode has no staging-trash undo; deletions there are not undoable.
        return Promise.resolve({ ok: false, error: 'Undo delete is not available in the web app.' });
      },
      releaseRoot(): Promise<void> { return Promise.resolve(); },
      // No per-window root survives a web reload — the in-memory cache resets.
      currentRoot(): Promise<{ root: string; name: string } | null> { return Promise.resolve(cachedRoot); },
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

    // Per-user snapshot store on the server (hot-exit): open tabs + layout +
    // unsaved editor content, keyed by project root. Persistence is debounced by
    // the caller; a final sub-second of edits before an abrupt close may not land
    // (a fetch in `pagehide` is unreliable) — the keystroke-debounced saves cover
    // the common case. Best-effort: swallow errors so a failed save never throws.
    workspace: {
      saveSnapshot(snapshot: unknown): void {
        void fetchJson('/workspace', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(snapshot),
        }).catch(() => {});
      },
      getSnapshot(root: string): Promise<unknown | null> {
        return fetchJson<unknown>(`/workspace?root=${encodeURIComponent(root)}`).catch(() => null);
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

    auth: {
      requireAuth(): Promise<boolean> { return detectRequireAuth(); },
      async me(): Promise<User | null> {
        if (!token) return null;
        try {
          const { user } = await fetchJson<{ user: User }>('/auth/me');
          setSession(token, user);
          return user;
        } catch (e) {
          // 401 already cleared the session in fetchJson (logged out). Any OTHER
          // error (network/5xx/offline) must NOT log out — keep the cached user
          // (falling back to the claim-derived profile when nothing is cached yet).
          if (e instanceof Error && e.message === 'unauthorized') return null;
          return readCachedUser() ?? (token ? decodeClaims(token) : null);
        }
      },
      async login(email: string, password: string): Promise<AuthResult> {
        const res = await postAuth<AuthResult>('/auth/login', { email, password });
        setSession(res.token, res.user); reconnect();
        for (const cb of authSubs) cb(res.user);
        return res;
      },
      async signup(email: string, password: string, name?: string): Promise<AuthResult> {
        const res = await postAuth<AuthResult>('/auth/signup', { email, password, name });
        setSession(res.token, res.user); reconnect();
        for (const cb of authSubs) cb(res.user);
        return res;
      },
      loginWithGoogle(): Promise<AuthResult> {
        // Full-page redirect to the hosted login (fineguide.ai via the apps/api seam);
        // the page navigates away and reloads with #token=… on return.
        window.location.assign(`/auth/google/start?redirect=${encodeURIComponent(location.origin)}`);
        return new Promise<AuthResult>(() => { /* never resolves — navigation occurs */ });
      },
      // Web uses a full-page redirect, so there's nothing in-flight to cancel.
      cancelGoogleSignIn(): Promise<void> { return Promise.resolve(); },
      // Onboarding step 1 / step 2. Same userId → the live WS token stays valid, so we
      // refresh the session + notify subscribers WITHOUT a disruptive reconnect.
      async updateProfile(payload: ProfilePayload): Promise<AuthResult> {
        const res = await postAuth<AuthResult>('/fineguide/profile', payload);
        setSession(res.token, res.user);
        for (const cb of authSubs) cb(res.user);
        return res;
      },
      async setPlan(payload: PlanPayload): Promise<AuthResult> {
        const res = await postAuth<AuthResult>('/fineguide/plan', payload);
        setSession(res.token, res.user);
        for (const cb of authSubs) cb(res.user);
        return res;
      },
      async logout(): Promise<void> {
        try { await fetch('/auth/logout', authHeaders({ method: 'POST' })); } catch { /* best effort */ }
        setSession(null, null); reconnect();
        for (const cb of authSubs) cb(null);
      },
      onChange(cb: AuthChangeCb): () => void { authSubs.add(cb); return () => authSubs.delete(cb); },
    },

    // ── User settings (localStorage; agent config is desktop-only for now) ──
    settings: {
      load(): Promise<Settings> {
        try {
          const raw = localStorage.getItem(SETTINGS_KEY);
          return Promise.resolve(mergeSettings(raw ? (JSON.parse(raw) as Partial<Settings>) : null));
        } catch { return Promise.resolve(DEFAULT_SETTINGS); }
      },
      save(patch: SettingsPatch): Promise<Settings> {
        const cur = readSettings();
        const next: Settings = {
          version: 1,
          appearance: { ...cur.appearance, ...patch.appearance },
          editor: { ...cur.editor, ...patch.editor },
          agent: { ...cur.agent, ...patch.agent, mcpServers: patch.agent?.mcpServers ?? cur.agent.mcpServers },
          general: { ...cur.general, ...patch.general },
        };
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
        for (const cb of settingsSubs) cb(next);
        return Promise.resolve(next);
      },
      onChange(cb: (s: Settings) => void): () => void { settingsSubs.add(cb); return () => settingsSubs.delete(cb); },
    },

    // Web build updates by reloading the page (new SPA from the gateway) — there
    // is no native bundle to swap, so the updater is inert here.
    updater: {
      onEvent(_cb: (event: UpdaterEvent) => void): () => void { return () => {}; },
      state(): Promise<UpdaterEvent | null> { return Promise.resolve(null); },
      check(): Promise<void> { return Promise.resolve(); },
      installNow(): Promise<void> { return Promise.resolve(); },
    },

    app: {
      // Web mode: quitting the tab isn't ours to do; the user just closes the tab.
      quit(): Promise<void> { window.close(); return Promise.resolve(); },
      // No native windows in web mode.
      newWindow(): Promise<void> { window.open(window.location.href, '_blank'); return Promise.resolve(); },
      closeWindow(): Promise<void> { window.close(); return Promise.resolve(); },
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
