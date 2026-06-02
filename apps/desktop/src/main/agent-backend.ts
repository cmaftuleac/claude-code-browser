/**
 * Pluggable agent backend. Only Claude Code is implemented for now (wrapping the
 * shared AgentManager + SessionStore from @claude-code-browser/agent-core), but
 * the interface is the seam where Codex / Gemini CLI / OpenCode adapters slot in.
 */
import type { ServerMessage, SessionInfo, SessionMessage } from '@claude-code-browser/shared';

export interface BackendSendParams {
  message: string;
  sessionId?: string;
  clientRequestId?: string;
  anchors?: import('@claude-code-browser/shared').ElementAnchor[];
  images?: string[];
  url: string;
  projectDir?: string;
  sources?: string[];
}

export interface AgentBackend {
  readonly id: string;
  sendMessage(params: BackendSendParams): Promise<void>;
  interrupt(sessionId: string): boolean;
  listSessions(): Promise<SessionInfo[]>;
  getMessages(sessionId: string): Promise<SessionMessage[]>;
  setConfig(projectDir?: string): void;
  sendBrowserResponse(requestId: string, result?: unknown, error?: string): void;
}

export type BrowserRequestHandler = (
  requestId: string,
  action: string,
  params: Record<string, unknown>,
) => void;

/**
 * Build the Claude Code backend. agent-core is ESM; the Electron main bundle is
 * CJS, so we reach it through a dynamic import (the same bridge host.ts uses).
 */
export async function createClaudeCodeBackend(
  send: (msg: ServerMessage) => void,
  onBrowserRequest: BrowserRequestHandler,
): Promise<AgentBackend> {
  const { AgentManager, SessionStore } = await import('@claude-code-browser/agent-core');
  const manager = new AgentManager(send, onBrowserRequest);
  const store = new SessionStore();

  return {
    id: 'claude-code',
    sendMessage: (params) => manager.sendMessage(params),
    interrupt: (sessionId) => manager.interruptSession(sessionId),
    listSessions: () => store.getSessions(),
    getMessages: (sessionId) => store.getSessionMessages(sessionId),
    setConfig: (projectDir) => manager.setConfig(projectDir),
    sendBrowserResponse: (requestId, result, error) =>
      manager.sendBrowserResponse(requestId, result, error),
  };
}
