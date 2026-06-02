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
      url: string;
      /** Page origin (host:port) — the per-website key. The host resolves the project
       *  folder from `projectDir` (configured) or a default derived from this origin. */
      origin?: string;
      /** The project folder for this origin (sources[0]); becomes the session's cwd. */
      projectDir?: string;
      sources?: string[];  // additional project directories
      /** Visual edits made in the desktop editor, to be persisted to source. */
      editJournal?: EditJournalEntry[];
    }
  /** List sessions for the current website. The host scopes to the project folder
   *  resolved from origin (host:port) + the configured projectDir — Claude Code's
   *  on-disk sessions are the single source of truth, no extension-side registry. */
  | { type: 'session:list'; origin?: string; projectDir?: string }
  | { type: 'session:resume'; sessionId: string }
  | { type: 'agent:interrupt'; sessionId: string }
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
