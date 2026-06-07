/**
 * Pluggable agent backend. Only Claude Code is implemented for now (wrapping the
 * shared AgentManager + SessionStore from @fineguide-tesseract/agent-core), but
 * the interface is the seam where Codex / Gemini CLI / OpenCode adapters slot in.
 */
import type { ServerMessage, SessionInfo, SessionMessage, AttachedFile, PermissionModeSetting, McpServerSpec, EffortSetting } from '@fineguide-tesseract/shared';

export interface BackendSendParams {
  message: string;
  sessionId?: string;
  clientRequestId?: string;
  anchors?: import('@fineguide-tesseract/shared').ElementAnchor[];
  images?: string[];
  /** Generic (non-image) file attachments; written to /tmp and referenced in the prompt. */
  files?: AttachedFile[];
  url: string;
  projectDir?: string;
  sources?: string[];
  /** The browser instance this conversation drives (multi-instance desktop). */
  browserId?: string;
  /** webContents id of the window that owns this conversation (ensureOpen routing). */
  windowId?: number;
  // Agent config from user settings (main injects via getAgentSettings). These
  // are structurally compatible with the SDK types agent-core forwards to query().
  model?: string;
  permissionMode?: PermissionModeSetting;
  effort?: Exclude<EffortSetting, ''>;
  mcpServers?: Record<string, McpServerSpec>;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

export interface AgentBackend {
  readonly id: string;
  sendMessage(params: BackendSendParams): Promise<void>;
  interrupt(sessionId: string): boolean;
  /** List resumable sessions, optionally scoped to a project directory (cwd). */
  listSessions(projectDir?: string): Promise<SessionInfo[]>;
  getMessages(sessionId: string): Promise<SessionMessage[]>;
  setConfig(projectDir?: string): void;
  sendBrowserResponse(requestId: string, result?: unknown, error?: string): void;
  /** Resolve a pending tool-permission request (renderer replied to a prior
   *  agent:permission_request via chat:permission). */
  respondToPermission(requestId: string, decision: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; persist?: boolean; message?: string }): void;
  /** Live mid-session run-mode switch (permission mode + model take effect now). */
  setRunMode(sessionId: string, opts: { permissionMode?: PermissionModeSetting; model?: string }): Promise<void>;
  /** Free memory under OS pressure: 'moderate' reaps long-idle sessions,
   *  'critical' reaps every idle (non-running) session. */
  reclaim(level: 'moderate' | 'critical'): void;
}

export type BrowserRequestHandler = (
  requestId: string,
  action: string,
  params: Record<string, unknown>,
  /** The browser instance the requesting conversation is connected to (or
   *  undefined → main falls back to the active browser). */
  browserId?: string,
  /** webContents id of the window that owns the requesting conversation. */
  windowId?: number,
) => void;

/**
 * Build the Claude Code backend. agent-core is ESM; the Electron main bundle is
 * CJS, so we reach it through a dynamic import (the same bridge host.ts uses).
 */
export async function createClaudeCodeBackend(
  send: (msg: ServerMessage) => void,
  onBrowserRequest: BrowserRequestHandler,
): Promise<AgentBackend> {
  const { AgentManager, SessionStore } = await import('@fineguide-tesseract/agent-core');
  const manager = new AgentManager(send, onBrowserRequest);
  const store = new SessionStore();

  return {
    id: 'claude-code',
    sendMessage: (params) => manager.sendMessage(params),
    interrupt: (sessionId) => manager.interruptSession(sessionId),
    listSessions: (projectDir) => store.getSessions(projectDir),
    getMessages: (sessionId) => store.getSessionMessages(sessionId),
    setConfig: (projectDir) => manager.setConfig(projectDir),
    sendBrowserResponse: (requestId, result, error) =>
      manager.sendBrowserResponse(requestId, result, error),
    respondToPermission: (requestId, decision) => manager.respondToPermission(requestId, decision),
    setRunMode: (sessionId, opts) => manager.setRunMode(sessionId, opts),
    reclaim: (level) => manager.reclaim(level),
  };
}
