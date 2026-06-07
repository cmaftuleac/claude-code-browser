/**
 * Mode B host daemon (Electron).
 *
 * Dials the cloud backend over a host-side WS, registers THIS machine under the
 * signed-in account, and serves RELAYED agent control: a web client on the same
 * account picks this machine in the host picker and runs Claude Code here. The
 * agent + its sessions live on this machine; ServerMessages stream back to the
 * web client through the backend's host→client relay.
 *
 * Opt-in: only runs when CCB_HOST_DAEMON=1, since it makes the machine remotely
 * drivable whenever logged in (see the Phase 4 "Mode B trust" note in the plan).
 *
 * Integration points (scaffolded, not yet wired):
 *  - Interactive browser mirror: an Electron RTCPeerConnection publishing a
 *    captured BrowserWindow as a video track + input via webContents.sendInputEvent,
 *    over the `browser`/`signal` channels. Today browser tools degrade gracefully.
 *  - Routing the web client's file ops to this machine over a `fs` channel
 *    (today fs still targets the cloud backend).
 */
import { hostname, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createClaudeCodeBackend, type AgentBackend } from './agent-backend.js';
import { getToken, BACKEND_ORIGIN } from './auth.js';
import type { ClientMessage, ServerMessage } from '@fineguide-tesseract/shared';

let socket: WebSocket | null = null;
let backend: AgentBackend | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
const deviceId = randomUUID().slice(0, 8);
// Base dir for remote-driven sessions when the client doesn't specify one.
// Configurable so the owner can scope what their machine exposes (B18/B22).
const HOST_ROOT = process.env.CCB_HOST_ROOT ?? homedir();

function wsUrl(token: string): string {
  return `${BACKEND_ORIGIN.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`;
}

function send(channel: string, payload: unknown): void {
  if (socket && socket.readyState === 1 /* OPEN */) socket.send(JSON.stringify({ channel, payload }));
}

async function ensureBackend(): Promise<AgentBackend> {
  if (backend) return backend;
  backend = await createClaudeCodeBackend(
    (msg: ServerMessage) => send('agent', msg),
    (requestId, action) =>
      backend?.sendBrowserResponse(requestId, undefined, `Browser tools aren't available for remote (Mode B) sessions yet (action: ${action}).`),
  );
  return backend;
}

/** Mirror the cloud backend's agent dispatch, but run it locally on this machine. */
async function handleAgent(msg: ClientMessage): Promise<void> {
  const b = await ensureBackend();
  switch (msg.type) {
    case 'chat:send':
      void b.sendMessage({
        message: msg.message, sessionId: msg.sessionId, clientRequestId: msg.clientRequestId,
        anchors: msg.anchors, images: msg.images, files: msg.files, url: msg.url,
        projectDir: msg.projectDir ?? HOST_ROOT, sources: msg.sources, browserId: msg.browserId,
      }).catch(() => { /* surfaced as chat:error by the backend */ });
      break;
    case 'session:list': {
      const sessions = await b.listSessions(msg.projectDir).catch(() => []);
      send('agent', { type: 'session:list', sessions });
      break;
    }
    case 'session:resume': {
      const messages = await b.getMessages(msg.sessionId).catch(() => []);
      send('agent', { type: 'session:messages', sessionId: msg.sessionId, messages });
      break;
    }
    case 'agent:interrupt':
      if (b.interrupt(msg.sessionId ?? '')) send('agent', { type: 'agent:status', sessionId: msg.sessionId ?? '', status: 'idle' });
      break;
    case 'config:set': b.setConfig(msg.projectDir); break;
    case 'health:check': send('agent', { type: 'health', nodeVersion: process.version, claudeCodeInstalled: true, claudeAuthenticated: true }); break;
    case 'commands:list': send('agent', { type: 'commands:list', commands: [] }); break;
    case 'ping': send('agent', { type: 'pong' }); break;
    case 'browser:response': b.sendBrowserResponse(msg.requestId, msg.result, msg.error); break;
  }
}

function cleanup(): void {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  socket = null;
}

function connect(): void {
  if (stopped) return;
  const token = getToken();
  // No account yet → poll until the user logs in, then connect.
  if (!token) { reconnectTimer = setTimeout(connect, 5000); return; }

  socket = new WebSocket(wsUrl(token));
  socket.onopen = () => {
    send('host', { type: 'host:register', name: hostname(), platform: process.platform, deviceId, caps: ['agent'] });
    heartbeat = setInterval(() => send('host', { type: 'host:heartbeat' }), 20_000);
  };
  socket.onmessage = (ev) => {
    const data = (ev as { data: unknown }).data;
    if (typeof data !== 'string') return;
    let env: { channel?: string; payload?: unknown };
    try { env = JSON.parse(data); } catch { return; }
    if (env.channel === 'agent') void handleAgent(env.payload as ClientMessage);
    // 'browser' / 'signal' → WebRTC peer + input injection (integration point).
  };
  socket.onclose = () => { cleanup(); if (!stopped) reconnectTimer = setTimeout(connect, 3000); };
  socket.onerror = () => { /* onclose drives the reconnect */ };
}

/** Start (or restart) the host daemon. Opt-in via CCB_HOST_DAEMON=1. Idempotent. */
export function startHostDaemon(): void {
  if (process.env.CCB_HOST_DAEMON !== '1') return;
  stopped = false;
  if (socket || reconnectTimer) return;
  connect();
}

export function stopHostDaemon(): void {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  cleanup();
  try { socket?.close(); } catch { /* ignore */ }
}
