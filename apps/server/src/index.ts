/**
 * Fineguide Tesseract — local server (web-mode backend).
 *
 * Runs the agent (via @fineguide-tesseract/agent-core) and exposes:
 *  - WebSocket at /ws    → ClientMessage/ServerMessage protocol (same as Electron main).
 *  - HTTP /fs/*          → readDir/readFile/writeFile + root probe.
 *  - WS fs:changed       → recursive file-watcher events pushed to clients.
 *
 * The renderer (apps/desktop) installs a window.ccb polyfill in the browser
 * that talks to this server, so the React app runs identically in Electron or
 * a plain web browser.
 *
 * Env:
 *   CCB_PORT   server port (default 9315)
 *   CCB_ROOT   project root the agent operates in (default cwd)
 */
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { readdir, readFile, writeFile, mkdir, stat, rename, rm, cp } from 'node:fs/promises';
import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync, readFileSync, writeFileSync, watch, createReadStream, type FSWatcher } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ClientMessage, ServerMessage, HostInfo, IceServerConfig, BrowserInputEvent } from '@fineguide-tesseract/shared';
import { encodeFrame as encodeFrameWire } from '@fineguide-tesseract/shared';
import { requireAuth, verifyWsClient, REQUIRE_AUTH, userIdFromRequest } from './auth-guard.js';
import { handleServerBrowserRequest, startMirror, stopMirror, dispatchInput, navMirror } from './browser-host.js';
import { buildIceServers } from './turn.js';
import { resolveUserRoot, scopeBrowserId, sanitizeUserId } from './users.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.CCB_PORT ?? 9315);
const ROOT = resolve(process.env.CCB_ROOT ?? process.cwd());
const VERSION = '0.2.0';

// ── WebRTC ICE/TURN (signaling-only; media stays peer-to-peer) ───────────────
const STUN_URL = process.env.STUN_URL ?? 'stun:stun.l.google.com:19302';
const TURN_HOST = process.env.TURN_HOST ?? ''; // e.g. turn:turn.example.com:3478
const TURN_SECRET = process.env.TURN_SECRET ?? ''; // coturn static-auth-secret

/** ICE servers for clients/hosts — STUN + (when configured) a short-lived coturn
 *  credential. See ./turn.ts (pure + unit-tested). */
function iceServers(): IceServerConfig[] {
  return buildIceServers({ stunUrl: STUN_URL, turnHost: TURN_HOST, turnSecret: TURN_SECRET });
}

// ── Per-user workspace isolation (Mode A) ────────────────────────────────────
/** Each authenticated user gets their own subtree under CCB_ROOT, so workspaces
 *  AND Claude Code sessions (which the SDK scopes by cwd) don't collide between
 *  tenants. Auth off (local dev) → the shared ROOT, unchanged. Path logic lives
 *  in ./users.ts (pure + unit-tested); here we also create the dir. */
function userRoot(userId: string | null): string {
  const dir = resolveUserRoot(ROOT, userId, REQUIRE_AUTH);
  if (dir !== ROOT) { try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ } }
  return dir;
}

const BINARY_EXT = new Set([
  'png','jpg','jpeg','gif','webp','ico','bmp','avif','tiff','tif','heic',
  'woff','woff2','ttf','otf','eot',
  'mp4','webm','mov','mp3','wav','ogg','m4a','flac','oga','aac','opus','wma','aiff','aif',
  'mkv','avi','m4v','mpeg','mpg','wmv','flv','3gp',
  'pdf','zip','gz','tar','wasm','node','so','dylib','dll','exe',
  'doc','docx','odt','rtf',
  'xls','xlsx','ods',
  'ppt','pptx','odp',
  'parquet','arrow','feather','ipc','orc','avro','msgpack',
  'sqlite','sqlite3','db','db3',
  'bin','dat','pkl','pyc','class','jar','war','ear',
  'iso','dmg','rar','7z','bz2','xz','lz4','zst',
]);
const TEXT_SIZE_LIMIT = 5 * 1024 * 1024;
const IGNORED = new Set(['.git', 'node_modules', '.DS_Store']);

// ── WS clients + broadcast ──────────────────────────────────────────────────

// ── Host registry + client connections ───────────────────────────────────────
//
// The web client multiplexes everything over ONE control WS (envelopes), and
// targets a *host* by hostId: the cloud server (this process, in-process agent)
// or — Mode B — one of the user's Electron machines that dialed in + registered.
// Media never flows here; only WebRTC signaling does.

const SERVER_HOST_ID = 'server';

interface HostEntry {
  info: HostInfo;
  /** null for the in-process server host; the host-side socket for remote (electron) hosts. */
  ws: WebSocket | null;
  /** null = visible to every account (the server host); else scoped to one user. */
  ownerUserId: string | null;
}
const hosts = new Map<string, HostEntry>();
hosts.set(SERVER_HOST_ID, {
  info: { hostId: SERVER_HOST_ID, name: 'Cloud server', kind: 'server', online: true, caps: ['browser', 'webrtc', 'fs'] },
  ws: null,
  ownerUserId: null,
});

interface ClientConn {
  ws: WebSocket;
  userId: string | null;
  /** Stable per-connection id, stamped onto envelopes relayed to a remote host
   *  so the host can target its WebRTC answer/ICE back to THIS client (B9). */
  clientId: string;
  /** Host this client's agent/browser/signal traffic targets. */
  selectedHostId: string;
  /** browserIds this client is currently mirroring (receiving frames for). */
  attached: Set<string>;
}
const clients = new Set<ClientConn>();
/** A remote host's socket → its hostId (host→client relay + cleanup on close). */
const hostSockets = new Map<WebSocket, string>();

type WireMessage = ServerMessage | { type: 'fs:changed'; paths: string[] } | { type: 'fs:root'; root: string; name: string };

/** Send an enveloped frame to a single socket. */
function wire(ws: WebSocket, channel: string, payload: unknown, route?: { hostId?: string; browserId?: string; sessionId?: string }): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ channel, payload, ...route }));
}

/** Push fs:changed to each server-host client, filtered to paths inside that
 *  client's own workspace (B6) so tenants don't see each other's file paths.
 *  Auth off → every path is under the shared ROOT, so nothing is filtered. */
function broadcastFsChanged(paths: string[]): void {
  for (const c of clients) {
    if (c.selectedHostId !== SERVER_HOST_ID || c.ws.readyState !== c.ws.OPEN) continue;
    const croot = resolveUserRoot(ROOT, c.userId, REQUIRE_AUTH);
    const visible = paths.filter((p) => isInsideRoot(croot, p));
    if (visible.length === 0) continue;
    c.ws.send(JSON.stringify({ channel: 'agent', payload: { type: 'fs:changed', paths: visible } }));
  }
}

/** Visible hosts for an account: the always-on server + that user's electron hosts. */
function hostsForUser(userId: string | null): HostInfo[] {
  const out: HostInfo[] = [];
  for (const h of hosts.values()) if (h.ownerUserId === null || h.ownerUserId === userId) out.push(h.info);
  return out;
}

/** Push a fresh host:list to every client of the affected account. */
function announceHosts(userId: string | null): void {
  for (const c of clients) {
    if (userId === null || c.userId === userId) wire(c.ws, 'host', { type: 'host:list', hosts: hostsForUser(c.userId) });
  }
}

/** Forward a client envelope to a remote (electron) host's socket. Returns false if offline. */
function relayToHost(hostId: string, env: unknown): boolean {
  const h = hosts.get(hostId);
  if (!h || !h.ws || h.ws.readyState !== h.ws.OPEN) return false;
  h.ws.send(JSON.stringify(env));
  return true;
}

/** Forward a host→client envelope to clients bound to that host. If the host
 *  echoed a `clientId` (e.g. a WebRTC answer/ICE for a specific viewer), deliver
 *  only to that client; otherwise fan out (e.g. the shared agent stream). */
function relayToClients(hostId: string, env: unknown): void {
  const data = JSON.stringify(env);
  const targetClientId = (env as { clientId?: string }).clientId;
  for (const c of clients) {
    if (c.selectedHostId !== hostId || c.ws.readyState !== c.ws.OPEN) continue;
    if (targetClientId && c.clientId !== targetClientId) continue;
    c.ws.send(data);
  }
}

// ── host / signal / browser channel handlers (server host, in-process) ───────

function handleHostChannel(conn: ClientConn, payload: Record<string, unknown> | undefined): void {
  const type = payload?.type;
  if (type === 'host:list') { wire(conn.ws, 'host', { type: 'host:list', hosts: hostsForUser(conn.userId) }); return; }
  if (type === 'host:select' && typeof payload?.hostId === 'string') { conn.selectedHostId = payload.hostId; return; }
  if (type === 'host:register' && typeof payload?.name === 'string') {
    // Mode B: promote this socket to a remote (electron) host owned by this
    // account. Validate/clamp the client-supplied fields (B8): a sanitized,
    // length-capped deviceId keeps the hostId well-formed; caps must be strings.
    const name = (payload.name as string).slice(0, 80) || 'Device';
    const platform = typeof payload.platform === 'string' ? payload.platform.slice(0, 32) : undefined;
    const deviceId = (typeof payload.deviceId === 'string' ? payload.deviceId : '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || randomUUID().slice(0, 8);
    const caps = Array.isArray(payload.caps)
      ? (payload.caps.filter((x) => typeof x === 'string') as string[]).slice(0, 16)
      : ['browser', 'webrtc'];
    const hostId = `electron:${conn.userId ?? 'local'}:${deviceId}`;
    hosts.set(hostId, {
      info: { hostId, name, kind: 'electron', platform, online: true, caps },
      ws: conn.ws,
      ownerUserId: conn.userId,
    });
    hostSockets.set(conn.ws, hostId);
    announceHosts(conn.userId);
    return;
  }
  // host:heartbeat → no-op; the live socket is the presence signal.
}

// ── Fallback frame relay (binary `frame` channel over the one WS) ────────────
//
// *** DISABLED FOR NOW (flag below). *** The browser mirror uses direct P2P
// WebRTC only; this JPEG-over-WS path is the degraded fallback for networks/
// hosts where WebRTC can't establish. The implementation is kept intact behind
// the flag — set it true (here AND in the client's WS_FRAME_FALLBACK in
// WebBrowserMirror.tsx) to re-enable. While disabled, the server-host attach
// advertises `transport: 'webrtc'` and does NOT start a CDP screencast.
//
// Wire layout (see ws-protocol.ts): [u8 ver=1][u8 flags(bit0 keyframe)]
// [u8 idLen][idBytes][u32 seq][jpeg payload]. The client demuxes by browserId
// and draws onto a <canvas>. JPEG frames are all keyframes.
// Typed `boolean` (not the literal `false`) so the gated blocks below aren't
// reported as statically-unreachable code.
const WS_FRAME_FALLBACK: boolean = false;
// Mirror viewers keyed by the SCOPED page key (scopeBrowserId(userId, browserId)),
// so screencast lifecycle + per-stream sequencing are per-tenant. Each frame is
// tagged with the RAW browserId the client knows (carried in the attach closure).
const mirrorViewers = new Map<string, Set<ClientConn>>();
const frameSeqs = new Map<string, number>();
function nextFrameSeq(scopedKey: string): number {
  const n = ((frameSeqs.get(scopedKey) ?? 0) + 1) >>> 0;
  frameSeqs.set(scopedKey, n);
  return n;
}
/** Encode + push a JPEG frame to every viewer of a scoped mirror key. JPEG → all
 *  keyframes. Wire format + matching decoder live in @fineguide-tesseract/shared. */
function sendFrameToViewers(scopedKey: string, rawBrowserId: string, jpeg: Buffer): void {
  const viewers = mirrorViewers.get(scopedKey);
  if (!viewers || viewers.size === 0) return;
  const buf = encodeFrameWire(rawBrowserId, jpeg, { keyframe: true, seq: nextFrameSeq(scopedKey) });
  for (const c of viewers) if (c.ws.readyState === c.ws.OPEN) c.ws.send(buf);
}
/** Drop a viewer from a mirror; stop the screencast when the last one leaves. */
function dropMirrorViewer(scopedKey: string, conn: ClientConn): void {
  const viewers = mirrorViewers.get(scopedKey);
  if (!viewers) return;
  viewers.delete(conn);
  if (viewers.size === 0) { mirrorViewers.delete(scopedKey); frameSeqs.delete(scopedKey); void stopMirror(scopedKey); }
}

/** WebRTC signaling for the SERVER host. This build has no co-located WebRTC
 *  publisher, so a server-host offer can't be answered here.
 *  - Fallback ENABLED  → steer the client to JPEG frames.
 *  - Fallback DISABLED → leave the offer unanswered (Mode A server-host live
 *    mirror is unavailable until the GStreamer publisher lands; Mode B answers
 *    via the Electron host through relayToHost, not this handler). */
function handleSignal(conn: ClientConn, env: { browserId?: unknown; payload?: unknown }): void {
  const browserId = typeof env.browserId === 'string' ? env.browserId : 'default';
  const payload = env.payload as Record<string, unknown> | undefined;
  if (WS_FRAME_FALLBACK && payload?.type === 'signal:offer') {
    wire(conn.ws, 'browser', { type: 'browser:config', transport: 'frames', codec: 'jpeg', width: 1280, height: 800 }, { browserId });
  }
}

/** Interactive control of the server-host page — attach/detach/input/nav.
 *  The page is keyed by the per-tenant scoped id (B3); messages back to the
 *  client carry the RAW browserId the client knows. */
function handleBrowserControl(conn: ClientConn, env: { browserId?: unknown; payload?: unknown }): void {
  const browserId = typeof env.browserId === 'string' ? env.browserId : 'default';
  const key = scopeBrowserId(conn.userId, browserId);
  const payload = env.payload as Record<string, unknown> | undefined;
  const type = payload?.type;
  if (type === 'browser:attach') {
    conn.attached.add(browserId);
    let viewers = mirrorViewers.get(key);
    if (!viewers) { viewers = new Set(); mirrorViewers.set(key, viewers); }
    viewers.add(conn);
    void (async () => {
      // WS frame fallback DISABLED → don't start the CDP screencast; advertise
      // WebRTC so the client negotiates a direct peer connection. (When the
      // fallback is re-enabled, startMirror streams JPEG frames instead.)
      let vp = { width: 1280, height: 800 };
      if (WS_FRAME_FALLBACK) {
        vp = await startMirror(key, (jpeg) => sendFrameToViewers(key, browserId, jpeg));
      }
      wire(conn.ws, 'browser', { type: 'browser:config', transport: WS_FRAME_FALLBACK ? 'frames' : 'webrtc', codec: 'jpeg', width: vp.width, height: vp.height }, { browserId });
      if (typeof payload?.url === 'string' && payload.url) {
        const st = await navMirror(key, 'goto', payload.url);
        wire(conn.ws, 'browser', { type: 'browser:state', url: st.url, title: st.title, canGoBack: false, canGoForward: false, loading: false }, { browserId });
      }
    })().catch((err) => wire(conn.ws, 'notify', { type: 'notify', level: 'error', message: `Browser unavailable: ${err instanceof Error ? err.message : String(err)}` }));
    return;
  }
  if (type === 'browser:detach') {
    conn.attached.delete(browserId);
    dropMirrorViewer(key, conn);
    return;
  }
  if (type === 'browser:input' && payload?.event) {
    void dispatchInput(key, payload.event as BrowserInputEvent).catch(() => { /* drop a bad event */ });
    return;
  }
  if (type === 'browser:nav' && typeof payload?.action === 'string') {
    void navMirror(key, payload.action as 'back' | 'forward' | 'reload' | 'goto', payload.url as string | undefined)
      .then((st) => wire(conn.ws, 'browser', { type: 'browser:state', url: st.url, title: st.title, canGoBack: false, canGoForward: false, loading: false }, { browserId }));
    return;
  }
}

// ── Agent core (lazy, ESM) ──────────────────────────────────────────────────
//
// ONE AgentManager PER USER (B25): the agent stream, session events, and browser
// requests are delivered only to the owning user's connected tabs — never
// broadcast to other tenants. SessionStore is shared (it only READS on-disk
// sessions, scoped by the cwd we pass in). Auth off → a single null-keyed
// manager + all clients are that one tenant, unchanged from before.

type AnyAgentManager = import('@fineguide-tesseract/agent-core').AgentManager;
type AnySessionStore = import('@fineguide-tesseract/agent-core').SessionStore;

const managers = new Map<string, AnyAgentManager>();
let sessionStore: AnySessionStore | null = null;
let corePromise: Promise<typeof import('@fineguide-tesseract/agent-core')> | null = null;

/** Deliver a server-host agent message to all of ONE user's connected tabs. */
function sendToUser(userId: string | null, msg: WireMessage): void {
  const data = JSON.stringify({ channel: 'agent', payload: msg });
  for (const c of clients) {
    if (c.selectedHostId === SERVER_HOST_ID && c.userId === userId && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }
}

async function getManager(userId: string | null): Promise<AnyAgentManager> {
  const key = userId ?? '';
  const existing = managers.get(key);
  if (existing) return existing;
  if (!corePromise) corePromise = import('@fineguide-tesseract/agent-core');
  const { AgentManager, SessionStore } = await corePromise;
  if (!sessionStore) sessionStore = new SessionStore();
  const manager: AnyAgentManager = new AgentManager(
    (m) => sendToUser(userId, m), // only THIS user's tabs
    (requestId, action, params, browserId) => {
      // Scope the agent's browser to this user (B3) so its CDP page is the user's
      // own and matches their interactive mirror.
      void handleServerBrowserRequest(scopeBrowserId(userId, browserId ?? 'default'), action, params)
        .then((result) => manager.sendBrowserResponse(requestId, result))
        .catch((err) => manager.sendBrowserResponse(requestId, undefined, err instanceof Error ? err.message : String(err)));
    },
  );
  manager.setConfig(userRoot(userId));
  managers.set(key, manager);
  return manager;
}

// ── Per-user manager reaping ─────────────────────────────────────────────────
// Drop a tenant's AgentManager 30 min after their LAST connection closes
// (cancelled if they reconnect within the window), so idle tenants don't
// accumulate empty managers over a long-running server. Force-disposes any
// lingering sessions first so no child process is orphaned.
const MANAGER_REAP_MS = Number(process.env.CCB_MANAGER_REAP_MS ?? 30 * 60 * 1000);
const managerReapTimers = new Map<string, ReturnType<typeof setTimeout>>();

function userHasClients(userId: string | null): boolean {
  for (const c of clients) if (c.userId === userId) return true;
  return false;
}

function cancelManagerReap(userId: string | null): void {
  const key = userId ?? '';
  const t = managerReapTimers.get(key);
  if (t) { clearTimeout(t); managerReapTimers.delete(key); }
}

function scheduleManagerReap(userId: string | null): void {
  const key = userId ?? '';
  if (managerReapTimers.has(key)) return; // already pending
  const t = setTimeout(() => {
    managerReapTimers.delete(key);
    if (userHasClients(userId)) return; // reconnected during the window
    const m = managers.get(key);
    if (m) { try { m.disposeAll(); } catch { /* ignore */ } managers.delete(key); console.log('[ccb-server] reaped idle agent manager for', key || '(default)'); }
  }, MANAGER_REAP_MS);
  if (typeof t.unref === 'function') t.unref(); // never hold the process open
  managerReapTimers.set(key, t);
}

async function dispatch(msg: ClientMessage, userId: string | null = null): Promise<void> {
  const manager = await getManager(userId);
  switch (msg.type) {
    case 'ping':
      sendToUser(userId, { type: 'pong' });
      break;
    case 'health:check':
      sendToUser(userId, { type: 'health', nodeVersion: process.version, claudeCodeInstalled: true, claudeAuthenticated: true });
      break;
    case 'commands:list':
      sendToUser(userId, { type: 'commands:list', commands: [] });
      break;
    case 'chat:send':
      manager.sendMessage({
        message: msg.message,
        sessionId: msg.sessionId,
        clientRequestId: msg.clientRequestId,
        anchors: msg.anchors,
        images: msg.images,
        url: msg.url,
        projectDir: msg.projectDir ?? userRoot(userId),
        sources: msg.sources,
        // Raw browserId — the per-user manager's onBrowserRequest closure scopes
        // it by userId (B3), so we must NOT double-scope here.
        browserId: msg.browserId,
        // Per-conversation run mode from the web client's picker (no server-side
        // settings layer → these or the orchestrator default are authoritative).
        ...(msg.permissionMode ? { permissionMode: msg.permissionMode } : {}),
        ...(msg.effort ? { effort: msg.effort } : {}),
        ...(msg.model ? { model: msg.model } : {}),
      }).catch((err) => console.error('sendMessage error:', err instanceof Error ? err.message : String(err)));
      break;
    case 'session:list': {
      const sessions = await sessionStore!.getSessions(msg.projectDir ?? userRoot(userId)).catch(() => []);
      sendToUser(userId, { type: 'session:list', sessions });
      break;
    }
    case 'session:resume': {
      const messages = await sessionStore!.getSessionMessages(msg.sessionId).catch(() => []);
      sendToUser(userId, { type: 'session:messages', sessionId: msg.sessionId, messages });
      break;
    }
    case 'agent:interrupt':
      if (manager.interruptSession(msg.sessionId ?? '')) {
        sendToUser(userId, { type: 'agent:status', sessionId: msg.sessionId ?? '', status: 'idle' });
      }
      break;
    case 'agent:set_mode':
      void manager.setRunMode(msg.sessionId, { permissionMode: msg.permissionMode, model: msg.model });
      break;
    case 'chat:permission':
      manager.respondToPermission(msg.requestId, { behavior: msg.behavior, updatedInput: msg.updatedInput, persist: msg.persist, message: msg.message });
      break;
    case 'config:set':
      manager.setConfig(msg.projectDir);
      break;
    case 'sources:set':
      sendToUser(userId, { type: 'sources:set', domain: msg.domain, paths: msg.paths });
      break;
    case 'browser:response':
      manager.sendBrowserResponse(msg.requestId, msg.result, msg.error);
      break;
  }
}

// ── Filesystem ──────────────────────────────────────────────────────────────

function isInsideRoot(root: string, p: string): boolean {
  const rel = relative(root, resolve(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The authenticated user id on a request (set by requireAuth), or null. */
function reqUserId(req: unknown): string | null {
  return (req as { user?: { sub?: string } }).user?.sub ?? null;
}

/** The per-request workspace root: each authenticated user's own subtree (B5),
 *  or the shared ROOT when auth is off. */
function reqRoot(req: unknown): string {
  return userRoot(reqUserId(req));
}

/** Reject a path that escapes the caller's workspace root. Enforced only when
 *  auth is on (multi-tenant); local dev keeps the prior, unrestricted behavior.
 *  Returns true (and sends an error) when the path is rejected. */
function rejectOutsideRoot(req: unknown, res: import('express').Response, p: string): boolean {
  if (REQUIRE_AUTH && !isInsideRoot(reqRoot(req), p)) {
    res.status(403).json({ error: 'Path is outside your workspace.' });
    return true;
  }
  return false;
}

const app = express();
// Most routes cap JSON bodies at 5mb; the hot-exit snapshot (POST /workspace) can
// carry unsaved editor content, so it gets a roomier limit.
const jsonParser = express.json({ limit: '5mb' });
const snapshotParser = express.json({ limit: '32mb' });
app.use((req, res, next) => (req.path === '/workspace' ? snapshotParser : jsonParser)(req, res, next));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

app.get('/health', (_req, res) => { res.json({ status: 'ok', version: VERSION, requireAuth: REQUIRE_AUTH }); });

// Gate filesystem + recents behind a valid JWT when CCB_REQUIRE_AUTH=true (web build).
// No-op otherwise. /health and the SPA static stay open; /auth lives on the cloud API.
app.use(['/fs', '/recents', '/workspace'], requireAuth);

app.get('/fs/root', (req, res) => {
  const r = userRoot((req as unknown as { user?: { sub?: string } }).user?.sub ?? null);
  res.json({ root: r, name: basename(r) });
});

app.get('/fs/readDir', async (req, res) => {
  const dir = String(req.query.dir ?? reqRoot(req));
  if (rejectOutsideRoot(req, res, dir)) return;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    res.json(entries
      .filter((e) => e.name !== '.DS_Store')
      .map((e) => ({ name: e.name, path: join(dir, e.name), isDir: e.isDirectory() }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1)));
  } catch {
    res.json([]);
  }
});

app.get('/fs/readFile', async (req, res) => {
  const p = String(req.query.path ?? '');
  if (rejectOutsideRoot(req, res, p)) return;
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  if (BINARY_EXT.has(ext)) { res.json({ error: 'Binary file — not shown in the editor.' }); return; }
  try {
    const s = statSync(p);
    if (s.size > TEXT_SIZE_LIMIT) { res.json({ error: 'File too large for text view.' }); return; }
    res.json({ content: await readFile(p, 'utf-8') });
  } catch (err) {
    res.json({ error: String((err as Error).message) });
  }
});

app.get('/fs/statFile', (req, res) => {
  const p = String(req.query.path ?? '');
  if (rejectOutsideRoot(req, res, p)) return;
  try {
    const s = statSync(p);
    if (!s.isFile()) { res.json({ error: 'Not a file' }); return; }
    const ext = p.split('.').pop()?.toLowerCase() ?? '';
    const isBinary = BINARY_EXT.has(ext) || s.size > TEXT_SIZE_LIMIT;
    res.json({ size: s.size, isBinary, mtimeMs: s.mtimeMs });
  } catch (err) {
    res.json({ error: String((err as Error).message) });
  }
});

/** Stream a file with HTTP Range support — feeds the browser's <video>/<audio>
 *  scrubber and <img> loader without buffering the whole file into RAM. */
app.get('/fs/stream', (req, res) => {
  const p = String(req.query.path ?? '');
  if (rejectOutsideRoot(req, res, p)) return;
  let stat;
  try { stat = statSync(p); } catch (err) { res.status(404).json({ error: String((err as Error).message) }); return; }
  if (!stat.isFile()) { res.status(400).json({ error: 'Not a file' }); return; }

  const range = req.headers.range;
  // Naive MIME by extension — Chromium's <video> works fine with octet-stream too.
  res.setHeader('Accept-Ranges', 'bytes');

  if (!range) {
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'no-cache');
    createReadStream(p).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { res.status(416).end(); return; }
  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) { res.status(416).end(); return; }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', end - start + 1);
  createReadStream(p, { start, end }).pipe(res);
});

app.get('/fs/readBinary', async (req, res) => {
  const p = String(req.query.path ?? '');
  if (rejectOutsideRoot(req, res, p)) return;
  const CAP = 256 * 1024 * 1024;
  try {
    const s = statSync(p);
    if (s.size > CAP) { res.json({ error: `File is too large to load whole (${(s.size / 1024 / 1024).toFixed(1)} MB).` }); return; }
    const data = await readFile(p);
    res.json({ base64: data.toString('base64'), size: s.size });
  } catch (err) {
    res.json({ error: String((err as Error).message) });
  }
});

app.get('/fs/readChunk', (req, res) => {
  const p = String(req.query.path ?? '');
  if (rejectOutsideRoot(req, res, p)) return;
  const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
  const length = Math.min(1024 * 1024, Math.max(0, Math.floor(Number(req.query.length) || 0)));
  if (length === 0) { res.json({ base64: '', bytesRead: 0 }); return; }
  let fd: number | null = null;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(length);
    const bytesRead = readSync(fd, buf, 0, length, offset);
    res.json({ base64: buf.subarray(0, bytesRead).toString('base64'), bytesRead });
  } catch (err) {
    res.json({ error: String((err as Error).message) });
  } finally {
    if (fd != null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
});

app.post('/fs/renameFile', async (req, res) => {
  const { oldPath, newName } = (req.body ?? {}) as { oldPath?: unknown; newName?: unknown };
  if (typeof oldPath !== 'string' || typeof newName !== 'string') { res.json({ ok: false, error: 'Bad request' }); return; }
  const trimmed = newName.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    res.json({ ok: false, error: 'Invalid name.' }); return;
  }
  if (!isInsideRoot(reqRoot(req), oldPath)) { res.json({ ok: false, error: 'Refusing to rename outside the project root.' }); return; }
  const newPath = join(dirname(oldPath), trimmed);
  if (existsSync(newPath)) { res.json({ ok: false, error: `A file named "${trimmed}" already exists.` }); return; }
  try {
    await rename(oldPath, newPath);
    res.json({ ok: true, newPath });
  } catch (err) {
    res.json({ ok: false, error: String((err as Error).message) });
  }
});

/** Create an empty file inside the project root. Mirrors the Electron IPC. */
app.post('/fs/createFile', async (req, res) => {
  const { parent, name } = (req.body ?? {}) as { parent?: unknown; name?: unknown };
  if (typeof parent !== 'string' || typeof name !== 'string') { res.json({ ok: false, error: 'Bad request' }); return; }
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    res.json({ ok: false, error: 'Invalid name.' }); return;
  }
  if (!isInsideRoot(reqRoot(req), parent)) { res.json({ ok: false, error: 'Refusing to create outside the project root.' }); return; }
  const target = join(parent, trimmed);
  if (existsSync(target)) { res.json({ ok: false, error: `"${trimmed}" already exists.` }); return; }
  try {
    await writeFile(target, '', 'utf-8');
    res.json({ ok: true, path: target });
  } catch (err) {
    res.json({ ok: false, error: String((err as Error).message) });
  }
});

/** Create an empty directory inside the project root. */
app.post('/fs/createFolder', async (req, res) => {
  const { parent, name } = (req.body ?? {}) as { parent?: unknown; name?: unknown };
  if (typeof parent !== 'string' || typeof name !== 'string') { res.json({ ok: false, error: 'Bad request' }); return; }
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    res.json({ ok: false, error: 'Invalid name.' }); return;
  }
  if (!isInsideRoot(reqRoot(req), parent)) { res.json({ ok: false, error: 'Refusing to create outside the project root.' }); return; }
  const target = join(parent, trimmed);
  if (existsSync(target)) { res.json({ ok: false, error: `"${trimmed}" already exists.` }); return; }
  try {
    await mkdir(target);
    res.json({ ok: true, path: target });
  } catch (err) {
    res.json({ ok: false, error: String((err as Error).message) });
  }
});

/** Append " 2", " 3"… until a free slot is found. Finder-style. */
function resolveUniqueName(dir: string, name: string): string {
  const direct = join(dir, name);
  if (!existsSync(direct)) return direct;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10_000; i++) {
    const candidate = join(dir, `${base} ${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return direct;
}

app.post('/fs/copyPaths', async (req, res) => {
  const { srcPaths, destDir } = (req.body ?? {}) as { srcPaths?: unknown; destDir?: unknown };
  if (!Array.isArray(srcPaths) || typeof destDir !== 'string') { res.json({ ok: false, error: 'Bad request' }); return; }
  if (!isInsideRoot(reqRoot(req), destDir)) { res.json({ ok: false, error: 'Refusing to copy outside the project root.' }); return; }
  try {
    const newPaths: string[] = [];
    for (const src of srcPaths) {
      if (typeof src !== 'string' || !src) continue;
      if (!isInsideRoot(reqRoot(req), src)) { res.json({ ok: false, error: 'Refusing to copy from outside the project root.' }); return; }
      const target = resolveUniqueName(destDir, basename(src));
      await cp(src, target, { recursive: true, errorOnExist: false, force: false });
      newPaths.push(target);
    }
    res.json({ ok: true, newPaths });
  } catch (err) {
    res.json({ ok: false, error: String((err as Error).message) });
  }
});

app.post('/fs/movePaths', async (req, res) => {
  const { srcPaths, destDir } = (req.body ?? {}) as { srcPaths?: unknown; destDir?: unknown };
  if (!Array.isArray(srcPaths) || typeof destDir !== 'string') { res.json({ ok: false, error: 'Bad request' }); return; }
  if (!isInsideRoot(reqRoot(req), destDir)) { res.json({ ok: false, error: 'Refusing to move outside the project root.' }); return; }
  try {
    const newPaths: string[] = [];
    for (const src of srcPaths) {
      if (typeof src !== 'string' || !src) continue;
      if (!isInsideRoot(reqRoot(req), src)) { res.json({ ok: false, error: 'Refusing to move from outside the project root.' }); return; }
      if (dirname(src) === destDir) { newPaths.push(src); continue; }
      const target = resolveUniqueName(destDir, basename(src));
      await rename(src, target);
      newPaths.push(target);
    }
    res.json({ ok: true, newPaths });
  } catch (err) {
    res.json({ ok: false, error: String((err as Error).message) });
  }
});

/**
 * Delete a path (file or folder) inside the project root.
 *
 * Web mode lacks Electron's `shell.trashItem`, so we fall back to a hard
 * recursive delete. The desktop app uses the IPC which goes to Trash —
 * recoverable. This endpoint is the unrecoverable variant; client UI must
 * make that distinction clear before calling.
 */
app.delete('/fs/path', async (req, res) => {
  const p = String(req.query.path ?? '');
  if (!p) { res.json({ ok: false, error: 'Bad request' }); return; }
  if (!isInsideRoot(reqRoot(req), p)) { res.json({ ok: false, error: 'Refusing to delete outside the project root.' }); return; }
  try {
    await rm(p, { recursive: true, force: false });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: String((err as Error).message) });
  }
});

// ── Recents (persisted JSON in ~/.ccb/) ────────────────────────────────────

interface RecentProject { path: string; name: string; lastOpenedAt: number; }
const RECENTS_CAP = 24;

// Per-user recents (B24): authenticated users get their own file so project
// paths don't leak across tenants; auth off → the shared recents.json (unchanged).
function recentsFile(userId: string | null): string {
  return join(homedir(), '.ccb', userId ? `recents-${sanitizeUserId(userId)}.json` : 'recents.json');
}

function readRecents(userId: string | null): RecentProject[] {
  try {
    const raw = readFileSync(recentsFile(userId), 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter((x) => x && typeof x.path === 'string' && typeof x.name === 'string' && typeof x.lastOpenedAt === 'number');
  } catch { return []; }
}
function writeRecents(userId: string | null, items: RecentProject[]): void {
  try {
    const file = recentsFile(userId);
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(items, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}

app.get('/recents', (req, res) => {
  res.json(readRecents(reqUserId(req)).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, RECENTS_CAP));
});

app.post('/recents', (req, res) => {
  const uid = reqUserId(req);
  const { path: p, name } = (req.body ?? {}) as { path?: unknown; name?: unknown };
  if (typeof p !== 'string' || typeof name !== 'string') { res.status(400).json({ error: 'Bad request' }); return; }
  const next = [{ path: p, name, lastOpenedAt: Date.now() }, ...readRecents(uid).filter((x) => x.path !== p)].slice(0, RECENTS_CAP);
  writeRecents(uid, next);
  res.json(next);
});

app.delete('/recents', (req, res) => {
  const uid = reqUserId(req);
  const p = String(req.query.path ?? '');
  const next = readRecents(uid).filter((x) => x.path !== p);
  writeRecents(uid, next);
  res.json(next);
});

// ── Workspace snapshots (hot-exit) ──────────────────────────────────────────
// Open tabs + split layout + unsaved editor content, keyed by project root so a
// project restores its tabs/layout and preserves unsaved work across reloads and
// restarts. Per-tenant like recents; mirrors the desktop main `workspaces.json`
// (object map root→snapshot, MRU-ordered, LRU-capped).

const MAX_WORKSPACES = 30;

function workspacesFile(userId: string | null): string {
  return join(homedir(), '.ccb', userId ? `workspaces-${sanitizeUserId(userId)}.json` : 'workspaces.json');
}
function readWorkspaces(userId: string | null): Record<string, unknown> {
  try {
    const obj = JSON.parse(readFileSync(workspacesFile(userId), 'utf-8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {};
  } catch { return {}; }
}
function writeWorkspaces(userId: string | null, obj: Record<string, unknown>): void {
  try {
    const file = workspacesFile(userId);
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(obj), 'utf-8');
  } catch { /* best-effort */ }
}

app.get('/workspace', (req, res) => {
  const root = String(req.query.root ?? '');
  if (!root) { res.json(null); return; }
  res.json(readWorkspaces(reqUserId(req))[root] ?? null);
});

app.post('/workspace', (req, res) => {
  const uid = reqUserId(req);
  const snapshot = (req.body ?? null) as { root?: unknown } | null;
  const root = snapshot?.root;
  if (typeof root !== 'string' || !root) { res.status(400).json({ error: 'Bad request' }); return; }
  const cur = readWorkspaces(uid);
  delete cur[root];          // re-insert at the end → most-recently-used
  cur[root] = snapshot;
  // Prune oldest (keys are insertion-ordered) beyond the cap.
  const keys = Object.keys(cur);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_WORKSPACES))) delete cur[k];
  writeWorkspaces(uid, cur);
  res.json({ ok: true });
});

// ── Open arbitrary path / create empty project (no native dialog on server) ─

app.post('/fs/openFolder', async (req, res) => {
  const { path: p } = (req.body ?? {}) as { path?: unknown };
  if (typeof p !== 'string' || !p) { res.status(400).json({ error: 'path required' }); return; }
  if (rejectOutsideRoot(req, res, p)) return; // multi-tenant: can't open outside your workspace
  try {
    const s = await stat(p);
    if (!s.isDirectory()) { res.status(400).json({ error: 'Not a directory' }); return; }
    res.json({ root: resolve(p), name: basename(p) });
  } catch (err) {
    res.status(404).json({ error: String((err as Error).message) });
  }
});

app.post('/fs/createProject', async (req, res) => {
  const { parent, name } = (req.body ?? {}) as { parent?: unknown; name?: unknown };
  if (typeof parent !== 'string' || typeof name !== 'string') { res.json({ ok: false, error: 'Bad request' }); return; }
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    res.json({ ok: false, error: 'Invalid project name.' });
    return;
  }
  const expandedParent = parent.startsWith('~/') ? join(homedir(), parent.slice(2)) : (parent === '~' ? homedir() : parent);
  const target = join(expandedParent, trimmed);
  // multi-tenant: a new project must live inside the caller's workspace.
  if (REQUIRE_AUTH && !isInsideRoot(reqRoot(req), target)) { res.json({ ok: false, error: 'Refusing to create a project outside your workspace.' }); return; }
  if (existsSync(target)) { res.json({ ok: false, error: `A folder named "${trimmed}" already exists.` }); return; }
  try {
    await mkdir(target, { recursive: true });
    res.json({ ok: true, path: target });
  } catch (err) {
    res.json({ ok: false, error: String((err as Error).message) });
  }
});

app.post('/fs/writeFile', async (req, res) => {
  const { path: p, content } = (req.body ?? {}) as { path?: unknown; content?: unknown };
  if (typeof p !== 'string' || typeof content !== 'string') { res.json({ ok: false, error: 'Bad request' }); return; }
  if (!isInsideRoot(reqRoot(req), p)) { res.json({ ok: false, error: 'Refusing to write outside the project root.' }); return; }
  try {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: String((err as Error).message) });
  }
});

// ── Renderer static (production / single-Node-service mode) ───────────────
// Same path whether run as src/index.ts (tsx) or dist/index.js — `apps/server/{src|dist}/../../desktop/dist-web`.
const STATIC_DIR = process.env.CCB_STATIC_DIR
  ? resolve(process.env.CCB_STATIC_DIR)
  : resolve(__dirname, '..', '..', 'desktop', 'dist-web');
const STATIC_AVAILABLE = existsSync(join(STATIC_DIR, 'index.html'));

if (STATIC_AVAILABLE) {
  app.use(express.static(STATIC_DIR));
  // SPA fallback: any GET that fell through the API routes returns index.html.
  // (WebSocket upgrades don't reach Express GET; /fs/* and /health are defined above.)
  app.get('*', (_req, res) => { res.sendFile(join(STATIC_DIR, 'index.html')); });
}

// ── FS watcher → broadcast fs:changed ──────────────────────────────────────

let watcher: FSWatcher | null = null;
function startWatching(root: string): void {
  watcher?.close();
  let timer: NodeJS.Timeout | null = null;
  const pending = new Set<string>();
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename);
      if (rel.split(sep).some((seg) => IGNORED.has(seg))) return;
      pending.add(join(root, rel));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const paths = [...pending];
        pending.clear();
        broadcastFsChanged(paths);
      }, 120);
    });
  } catch {
    console.warn('[ccb-server] recursive watch unsupported on this platform');
  }
}
startWatching(ROOT);

// ── HTTP + WS bootstrap ────────────────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: verifyWsClient });

wss.on('connection', (ws, req) => {
  const conn: ClientConn = { ws, userId: userIdFromRequest(req), clientId: randomUUID(), selectedHostId: SERVER_HOST_ID, attached: new Set() };
  clients.add(conn);
  cancelManagerReap(conn.userId); // this tenant is active again — keep its manager
  console.log(`[ccb-server] ws client connected (${clients.size} total)`);

  const connRoot = userRoot(conn.userId);
  wire(ws, 'agent', { type: 'connection:ready', serverVersion: VERSION });
  wire(ws, 'agent', { type: 'health', nodeVersion: process.version, claudeCodeInstalled: true, claudeAuthenticated: true });
  wire(ws, 'agent', { type: 'fs:root', root: connRoot, name: basename(connRoot) });
  wire(ws, 'host', { type: 'host:list', hosts: hostsForUser(conn.userId) });

  ws.on('message', (raw) => {
    // NOTE (review B1): control frames are JSON text. Binary WS messages (e.g. a
    // remote host relaying fallback `frame` bytes) would be String()'d here and
    // dropped. Moot today — the fallback is disabled and Mode B media is direct
    // WebRTC — but binary host→client frame relay would need an isBinary branch
    // that parses the frame header for routing before re-sending.
    let env: { channel?: unknown; payload?: unknown; hostId?: unknown; browserId?: unknown };
    try { env = JSON.parse(String(raw)) as typeof env; } catch { return; }

    // Tolerate a legacy raw ClientMessage (no envelope) → server-host agent.
    if (!env || typeof env.channel !== 'string' || !('payload' in env)) {
      void dispatch(env as unknown as ClientMessage, conn.userId);
      return;
    }
    const channel = env.channel;
    const targetHost = typeof env.hostId === 'string' ? env.hostId : conn.selectedHostId;

    // ICE/TURN creds are minted by the backend (it holds TURN_SECRET), whichever
    // host ultimately answers the offer. Answer get-ice before any routing.
    if (channel === 'signal' && (env.payload as { type?: string } | undefined)?.type === 'signal:get-ice') {
      wire(ws, 'signal', { type: 'signal:ready', iceServers: iceServers() }, { browserId: typeof env.browserId === 'string' ? env.browserId : undefined });
      return;
    }

    // host channel: registry ops (incl. promoting this socket to a remote host).
    if (channel === 'host') { handleHostChannel(conn, env.payload as Record<string, unknown> | undefined); return; }

    // If this socket is itself a registered (electron) host, its frames flow
    // back out to the clients bound to it.
    const asHost = hostSockets.get(ws);
    if (asHost && (channel === 'agent' || channel === 'signal' || channel === 'browser' || channel === 'frame')) {
      relayToClients(asHost, env);
      return;
    }

    // Client → a remote host: stamp our clientId (so the host can target replies
    // back to us) and relay verbatim (Mode B).
    if (targetHost !== SERVER_HOST_ID) {
      (env as { clientId?: string }).clientId = conn.clientId;
      if (!relayToHost(targetHost, env)) wire(ws, 'notify', { type: 'notify', level: 'error', message: 'Selected host is offline.' });
      return;
    }

    // Server host (in-process).
    if (channel === 'agent') { void dispatch(env.payload as ClientMessage, conn.userId); return; }
    if (channel === 'signal') { handleSignal(conn, env); return; }
    if (channel === 'browser') { handleBrowserControl(conn, env); return; }
    // 'frame' / 'notify' are server→client only.
  });

  ws.on('close', () => {
    clients.delete(conn);
    for (const bid of conn.attached) dropMirrorViewer(scopeBrowserId(conn.userId, bid), conn);
    // If that was the tenant's last connection, schedule their manager for reaping.
    if (!userHasClients(conn.userId)) scheduleManagerReap(conn.userId);
    const hid = hostSockets.get(ws);
    if (hid) {
      hostSockets.delete(ws);
      const h = hosts.get(hid);
      hosts.delete(hid);
      if (h) {
        for (const c of clients) if (c.selectedHostId === hid) c.selectedHostId = SERVER_HOST_ID;
        announceHosts(h.ownerUserId);
      }
    }
  });
  ws.on('error', () => { clients.delete(conn); });
});

server.listen(PORT, () => {
  console.log(`[ccb-server] listening on :${PORT}`);
  console.log(`[ccb-server] project root: ${ROOT}`);
  console.log(`[ccb-server] ws ws://localhost:${PORT}/ws · health http://localhost:${PORT}/health`);
  if (STATIC_AVAILABLE) {
    console.log(`[ccb-server] serving renderer from ${STATIC_DIR}`);
    console.log(`[ccb-server] open http://localhost:${PORT} in any browser`);
  } else {
    console.log(`[ccb-server] (no static renderer at ${STATIC_DIR} — run 'npm run build:web -w apps/desktop' to produce it)`);
  }
});
