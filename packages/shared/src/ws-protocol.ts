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

// ── Client → Server ─────────────────────────────────────────────────────────

export type ClientMessage =
  | {
      type: 'chat:send';
      sessionId?: string;
      message: string;
      anchors?: ElementAnchor[];
      images?: string[];  // base64 data URLs
      url: string;
      projectDir?: string;
    }
  | { type: 'session:list' }
  | { type: 'session:resume'; sessionId: string }
  | { type: 'agent:interrupt'; sessionId: string }
  | { type: 'config:set'; projectDir?: string; cdpPort?: number }
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

export type ServerMessage =
  | {
      type: 'chat:stream';
      sessionId: string;
      delta: string;
      messageId: string;
    }
  | {
      type: 'chat:complete';
      sessionId: string;
      result: string;
      messageId: string;
      costUsd?: number;
    }
  | { type: 'chat:error'; sessionId: string; error: string }
  | {
      type: 'agent:status';
      sessionId: string;
      status: 'running' | 'idle' | 'error';
    }
  | {
      type: 'agent:tool_use';
      sessionId: string;
      toolName: string;
      summary: string;
    }
  | { type: 'session:list'; sessions: SessionInfo[] }
  | { type: 'session:created'; sessionId: string }
  | {
      type: 'session:messages';
      sessionId: string;
      messages: SessionMessage[];
    }
  | { type: 'connection:ready'; serverVersion: string }
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

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
}
