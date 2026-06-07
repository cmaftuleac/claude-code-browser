import type { PermissionModeSetting, EffortSetting } from './settings.js';

// ── Element Anchor ──────────────────────────────────────────────────────────

export interface ElementAnchor {
  /** CSS selector */
  selector: string;
  /** XPath */
  xpath: string;
  /** Full DOM path with classes (e.g. div#root > div.flex > button.nav-btn) */
  domPath: string;
  /** Tag name (e.g. "button") */
  tagName: string;
  /** First 80 chars of textContent */
  textPreview: string;
  /** Outer HTML snippet (truncated) */
  htmlSnippet: string;
  /** Bounding rect at time of selection */
  boundingRect?: { x: number; y: number; width: number; height: number };
}

// ── DOM Tree (Components sidebar) ────────────────────────────────────────────

/** One node of the page DOM tree shown in the "Components" sidebar. Built in the
 *  guest (extension content-script / desktop editor preload) by walking the live
 *  DOM; `path` is a dot-separated child-index path (body-relative, e.g. "0.2.1")
 *  and `anchor` is the same ElementAnchor used for picks. */
export interface DomTreeNode {
  tagName: string;
  id: string;
  /** Space-separated class list (truncated). */
  classes: string;
  /** Dot-separated child-index path from the tree root (document.body = ""). */
  path: string;
  childCount: number;
  children: DomTreeNode[];
  /** True when children were capped (renders a "… N more" row). */
  truncated: boolean;
  anchor: ElementAnchor;
}

// ── Chat attachments ─────────────────────────────────────────────────────────

/** A non-image file attached to a chat message. The host writes it to a temp dir
 *  and references the path in the user prompt (mirrors the image data-URL flow).
 *  Images keep their own `images: string[]` channel; this is the generic one. */
export interface AttachedFile {
  /** Original filename (extension preserved so /tmp names + the prompt are meaningful). */
  name: string;
  /** data:<mime>;base64,<…> */
  dataUrl: string;
}

// ── Visual Edit Journal ─────────────────────────────────────────────────────

/** A single visual edit made in the desktop "Photoshop for HTML" editor.
 *  The journal is serialized into a chat:send so the agent can persist the
 *  equivalent change to source ("Save to code"). */
export interface EditJournalEntry {
  /** CSS selector of the edited element at edit time */
  selector: string;
  /** XPath of the edited element */
  xpath?: string;
  /** Kind of edit performed */
  type: 'style' | 'attr' | 'text' | 'move' | 'resize' | 'reparent';
  /** For style/attr edits: the property/attribute name (e.g. "color", "width", "href") */
  name?: string;
  /** Value before the edit (string for style/attr/text; serialized for move/resize/reparent) */
  before?: string;
  /** Value after the edit */
  after?: string;
}

// ── Client → Server ─────────────────────────────────────────────────────────

export type ClientMessage =
  | {
      type: 'chat:send';
      sessionId?: string;
      /** Set by the client when sessionId is absent (brand-new chat). The host echoes
       *  it back on session:created (and on any events emitted before session_id resolves),
       *  letting the client correlate the eventual real session with its pending bucket. */
      clientRequestId?: string;
      message: string;
      anchors?: ElementAnchor[];
      images?: string[];
      /** Generic (non-image) file attachments; host writes them to a temp dir
       *  and references the paths in the prompt. */
      files?: AttachedFile[];
      url: string;
      /** Page origin (host:port) — the per-website key. The host resolves the project
       *  folder from `projectDir` (configured) or a default derived from this origin. */
      origin?: string;
      /** The project folder for this origin (sources[0]); becomes the session's cwd. */
      projectDir?: string;
      sources?: string[];  // additional project directories
      /** Visual edits made in the desktop editor, to be persisted to source. */
      editJournal?: EditJournalEntry[];
      /** The browser instance this conversation drives (multi-instance desktop).
       *  The extension/host ignore it (single pinned tab). */
      browserId?: string;
      /** Per-conversation run-mode override. Omitted ⇒ the backend falls back to
       *  the user's saved agent settings. Applied at session creation; for a live
       *  session see agent:set_mode. */
      permissionMode?: PermissionModeSetting;
      effort?: EffortSetting;
      model?: string;
    }
  /** List sessions for the current website. The host scopes to the project folder
   *  resolved from origin (host:port) + the configured projectDir — Claude Code's
   *  on-disk sessions are the single source of truth, no extension-side registry. */
  | { type: 'session:list'; origin?: string; projectDir?: string }
  | { type: 'session:resume'; sessionId: string }
  | { type: 'agent:interrupt'; sessionId: string }
  /** Live mid-session run-mode switch. permissionMode + model take effect on the
   *  running Query immediately (setPermissionMode / setModel); effort has no live
   *  SDK setter, so it only applies to conversations created afterwards. */
  | {
      type: 'agent:set_mode';
      sessionId: string;
      permissionMode?: PermissionModeSetting;
      effort?: EffortSetting;
      model?: string;
    }
  /** The user's decision on a pending tool-permission request (replies to a prior
   *  agent:permission_request with the same requestId). `persist` ⇒ "allow & don't
   *  ask again" — the backend returns the SDK's suggested permission updates so the
   *  same kind of call won't prompt again this session. */
  | {
      type: 'chat:permission';
      requestId: string;
      behavior: 'allow' | 'deny';
      /** Optional edited tool input to run instead of the original. */
      updatedInput?: Record<string, unknown>;
      persist?: boolean;
      /** Optional reason shown to the agent when denying. */
      message?: string;
    }
  /** Ask the host to (un)install itself to a specific npm version and re-wire its
   *  native-messaging manifest, then exit so Chrome respawns the fresh host. Only
   *  sent to hosts known (by serverVersion) to support it. */
  | { type: 'host:update'; targetVersion: string }
  | { type: 'config:set'; projectDir?: string; cdpPort?: number }
  | { type: 'sources:set'; domain: string; paths: string[] }
  | { type: 'health:check' }
  | { type: 'commands:list' }
  | {
      type: 'browser:response';
      requestId: string;
      result?: unknown;
      error?: string;
    }
  | { type: 'ping' };

// ── Server → Client ─────────────────────────────────────────────────────────

/** clientRequestId is set on events emitted before the SDK has resolved the canonical
 *  session_id. Once sessionId is non-empty, sessionId alone is sufficient — the field
 *  exists so events fired in the pre-resolution window can still be routed to the
 *  pending bucket the client created on submit. */
export type ServerMessage =
  | {
      type: 'chat:stream';
      sessionId: string;
      clientRequestId?: string;
      delta: string;
      messageId: string;
      kind?: 'text' | 'thinking' | 'tool_use';
    }
  | {
      type: 'chat:complete';
      sessionId: string;
      clientRequestId?: string;
      result: string;
      messageId: string;
      costUsd?: number;
    }
  | { type: 'chat:error'; sessionId: string; clientRequestId?: string; error: string }
  | {
      type: 'agent:status';
      sessionId: string;
      clientRequestId?: string;
      status: 'running' | 'idle' | 'error';
    }
  | {
      type: 'agent:tool_use';
      sessionId: string;
      clientRequestId?: string;
      toolName: string;
      summary: string;
    }
  /** The agent is asking the user to approve a gated tool call — raised by the
   *  canUseTool callback in every non-bypass mode (Ask / Edit-automatically for
   *  commands / Plan / Auto). The client renders an approval card and must reply
   *  with a chat:permission carrying the same requestId, or the turn blocks. */
  | {
      type: 'agent:permission_request';
      sessionId: string;
      clientRequestId?: string;
      requestId: string;
      toolName: string;
      /** Full prompt sentence from the SDK bridge (preferred display text). */
      title?: string;
      /** Short noun phrase for the action (compact label, e.g. "Read file"). */
      displayName?: string;
      /** Human-readable subtitle. */
      description?: string;
      /** The tool input (e.g. the Bash command / file path) for display. */
      input: Record<string, unknown>;
      /** Path that triggered the request, if applicable. */
      blockedPath?: string;
    }
  | { type: 'session:list'; sessions: SessionInfo[] }
  | { type: 'session:created'; sessionId: string; clientRequestId?: string }
  | {
      type: 'session:messages';
      sessionId: string;
      messages: SessionMessage[];
    }
  | { type: 'connection:ready'; serverVersion: string }
  /** Result of a host:update request. On success the host is exiting; the extension
   *  reconnects and re-checks the new serverVersion. On failure the host stays alive
   *  and the extension shows manual-update instructions with `reason`. */
  | { type: 'host:update:result'; success: boolean; reason?: string; installedVersion?: string }
  | {
      type: 'health';
      nodeVersion: string;
      claudeCodeInstalled: boolean;
      claudeAuthenticated: boolean;
    }
  | {
      type: 'commands:list';
      commands: Array<{ name: string; description: string; hint?: string }>;
    }
  | { type: 'sources:set'; domain: string; paths: string[] }
  | {
      type: 'browser:request';
      requestId: string;
      action: 'navigate' | 'snapshot' | 'screenshot' | 'click' | 'evaluate';
      params: Record<string, unknown>;
    }
  | { type: 'pong' };

// ── Session Types ───────────────────────────────────────────────────────────

export interface SessionInfo {
  id: string;
  title: string;
  lastModified: number;
  cwd?: string;
}

export interface SessionMessageBlock {
  kind: 'text' | 'thinking' | 'tool_use';
  content: string;
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  blocks?: SessionMessageBlock[];
  timestamp?: number;
}

// ── Multiplexed control-plane envelope ───────────────────────────────────────
//
// The web client opens exactly ONE WebSocket to the backend (see web-transport).
// Everything is multiplexed over it via an Envelope tagged with a `channel`,
// optionally routed to a specific `hostId` (the cloud server, or one of the
// user's Electron machines acting as a host daemon). The legacy raw
// ClientMessage/ServerMessage protocol above is unchanged — it is carried as the
// payload of the `agent` channel, and still used as-is over Electron IPC and the
// extension's native-messaging transport (which do NOT use this envelope).
//
// Media (the live browser video) is NEVER carried here — it flows peer-to-peer
// over WebRTC. This channel only relays SDP/ICE signaling for it.

/** Logical channels multiplexed over the single control WebSocket. */
export type ControlChannel =
  | 'agent' // ClientMessage / ServerMessage (legacy protocol above), per session
  | 'host' // host registry: list / select / register / heartbeat / online / offline
  | 'browser' // human-driven browser control: attach / detach / input / nav / state
  | 'signal' // WebRTC SDP/ICE relay + ICE-server (STUN/TURN) credentials
  | 'frame' // fallback JPEG/WebCodecs video stream (binary; see BINARY FRAME note)
  | 'notify'; // server→client notifications / toasts

/** One framed message on the control WS. `payload` is narrowed by `channel`. */
export interface Envelope<P = unknown> {
  channel: ControlChannel;
  /** Host this frame is routed to/from. Absent = the backend itself (e.g. host:list). */
  hostId?: string;
  /** Agent session id (channels 'agent' / 'browser'). */
  sessionId?: string;
  /** Browser surface id (channels 'browser' / 'signal' / 'frame'). */
  browserId?: string;
  payload: P;
}

// ── `host` channel — discovery & registry ────────────────────────────────────

export interface HostInfo {
  hostId: string;
  name: string;
  kind: 'server' | 'electron';
  /** 'darwin' | 'win32' | 'linux' for electron hosts; undefined for the server. */
  platform?: string;
  online: boolean;
  /** Advertised capabilities, e.g. ['browser', 'webrtc', 'fs']. */
  caps?: string[];
}

/** Web client → backend (host channel). */
export type HostClientMessage =
  | { type: 'host:list' }
  | { type: 'host:select'; hostId: string };

/** Backend → web client (host channel). */
export type HostServerMessage =
  | { type: 'host:list'; hosts: HostInfo[] }
  | { type: 'host:online'; host: HostInfo }
  | { type: 'host:offline'; hostId: string };

/** Electron host daemon → backend, over the host-side WS (registration). */
export type HostRegisterMessage =
  | { type: 'host:register'; name: string; platform: string; caps?: string[] }
  | { type: 'host:heartbeat' };

// ── `signal` channel — WebRTC signaling (no media) ───────────────────────────

/** ICE server config without depending on lib.dom (shared is consumed by Node too). */
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** DOM-free shape of RTCIceCandidateInit, for relaying candidates through Node. */
export interface IceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type SignalMessage =
  /** backend → both peers: STUN/TURN servers to use (short-TTL TURN creds). */
  | { type: 'signal:ready'; iceServers: IceServerConfig[] }
  | { type: 'signal:offer'; sdp: string }
  | { type: 'signal:answer'; sdp: string }
  | { type: 'signal:ice'; candidate: IceCandidateInit }
  | { type: 'signal:close' };

// ── `browser` channel — human-driven control of the mirrored page ────────────

export type BrowserInputEvent =
  | {
      kind: 'mouse';
      action: 'move' | 'down' | 'up' | 'click';
      /** Coordinates in CSS px relative to the streamed viewport. */
      x: number;
      y: number;
      button?: number; // 0 left, 1 middle, 2 right
      buttons?: number;
      clickCount?: number;
    }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | {
      kind: 'key';
      action: 'down' | 'up' | 'char';
      key: string;
      code?: string;
      text?: string;
      /** Bitmask: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift (CDP convention). */
      modifiers?: number;
    };

/** Web client → host (browser channel). */
export type BrowserControlMessage =
  | { type: 'browser:attach'; url?: string }
  | { type: 'browser:detach' }
  | { type: 'browser:input'; event: BrowserInputEvent }
  | { type: 'browser:nav'; action: 'back' | 'forward' | 'reload' | 'goto'; url?: string };

/** Host → web client (browser channel). */
export type BrowserStateMessage =
  | {
      type: 'browser:state';
      url: string;
      title: string;
      canGoBack: boolean;
      canGoForward: boolean;
      loading: boolean;
    }
  /** Stream metadata for the fallback `frame` channel: codec + viewport. */
  | { type: 'browser:config'; transport: 'webrtc' | 'frames'; codec?: string; description?: string; width: number; height: number };

// ── `notify` channel ─────────────────────────────────────────────────────────

export type NotifyMessage = { type: 'notify'; level: 'info' | 'success' | 'warning' | 'error'; message: string };

// ── BINARY FRAME note (`frame` channel) ──────────────────────────────────────
//
// The fallback video stream sends binary WS frames (ArrayBuffer), NOT JSON
// envelopes — base64 in JSON would add ~33% + GC churn. Wire layout (Phase 2):
//   [ u8 version=1 ][ u8 flags (bit0: keyframe) ][ u8 browserIdLen ]
//   [ browserId utf8 ][ u32 seq ][ ...encoded payload (JPEG or VideoChunk) ]
// `browser:config` (above) announces the codec/dimensions before frames start.
// Defined as a comment now; the codec helpers land with the Phase 2 fallback.

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a control-plane envelope. */
export function envelope<P>(channel: ControlChannel, payload: P, route?: { hostId?: string; sessionId?: string; browserId?: string }): Envelope<P> {
  return { channel, payload, ...route };
}

/** Narrowing guard for a parsed control-WS JSON message. */
export function isEnvelope(m: unknown): m is Envelope {
  return typeof m === 'object' && m !== null && typeof (m as { channel?: unknown }).channel === 'string' && 'payload' in (m as object);
}
