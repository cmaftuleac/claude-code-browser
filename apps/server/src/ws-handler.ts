/**
 * WebSocket message handler — routes ClientMessages to the appropriate service.
 */

import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@claude-code-browser/shared';
import type { AgentManager } from './agent-manager.js';
import type { SessionStore } from './session-store.js';

const SERVER_VERSION = '0.1.0';

export class WsHandler {
  private agentManager: AgentManager;
  private sessionStore: SessionStore;

  constructor(agentManager: AgentManager, sessionStore: SessionStore) {
    this.agentManager = agentManager;
    this.sessionStore = sessionStore;
  }

  handleConnection(ws: WebSocket): void {
    this.send(ws, { type: 'connection:ready', serverVersion: SERVER_VERSION });

    ws.on('message', async (raw) => {
      try {
        const msg: ClientMessage = JSON.parse(String(raw));
        await this.handleMessage(ws, msg);
      } catch (err) {
        console.error('[ws] Failed to process message:', err);
      }
    });

    ws.on('close', () => {
      console.log('[ws] Client disconnected');
    });
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async handleMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'ping':
        this.send(ws, { type: 'pong' });
        break;

      case 'chat:send':
        await this.handleChatSend(ws, msg);
        break;

      case 'session:list':
        await this.handleSessionList(ws);
        break;

      case 'session:resume':
        await this.handleSessionResume(ws, msg.sessionId);
        break;

      case 'agent:interrupt':
        this.agentManager.interruptSession(msg.sessionId);
        break;

      case 'config:set':
        this.agentManager.setConfig(msg.projectDir, msg.cdpPort);
        break;

      default:
        console.warn('[ws] Unknown message type:', (msg as { type: string }).type);
    }
  }

  private async handleChatSend(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'chat:send' }>,
  ): Promise<void> {
    const messageId = crypto.randomUUID();
    // Track the real session ID once the SDK provides it
    let resolvedSid = msg.sessionId ?? '';

    this.send(ws, { type: 'agent:status', sessionId: resolvedSid, status: 'running' });

    await this.agentManager.sendMessage(
      {
        message: msg.message,
        sessionId: msg.sessionId,
        anchors: msg.anchors,
        images: msg.images,
        url: msg.url,
        projectDir: msg.projectDir,
      },
      {
        onSessionId: (sessionId) => {
          resolvedSid = sessionId;
          this.send(ws, { type: 'session:created', sessionId });
        },
        onStream: (delta) => {
          this.send(ws, { type: 'chat:stream', sessionId: resolvedSid, delta, messageId });
        },
        onToolUse: (toolName, summary) => {
          this.send(ws, { type: 'agent:tool_use', sessionId: resolvedSid, toolName, summary });
        },
        onComplete: (result, sessionId, costUsd) => {
          this.send(ws, {
            type: 'chat:complete',
            sessionId,
            result,
            messageId,
            costUsd,
          });
          this.send(ws, { type: 'agent:status', sessionId, status: 'idle' });
        },
        onError: (error) => {
          this.send(ws, { type: 'chat:error', sessionId: resolvedSid, error });
          this.send(ws, { type: 'agent:status', sessionId: resolvedSid, status: 'error' });
        },
      },
    );
  }

  private async handleSessionList(ws: WebSocket): Promise<void> {
    try {
      const sessions = await this.sessionStore.getSessions();
      this.send(ws, { type: 'session:list', sessions });
    } catch (err) {
      console.error('[ws] Failed to list sessions:', err);
      this.send(ws, { type: 'session:list', sessions: [] });
    }
  }

  private async handleSessionResume(ws: WebSocket, sessionId: string): Promise<void> {
    try {
      const messages = await this.sessionStore.getSessionMessages(sessionId);
      this.send(ws, { type: 'session:messages', sessionId, messages });
    } catch (err) {
      console.error('[ws] Failed to resume session:', err);
      this.send(ws, { type: 'session:messages', sessionId, messages: [] });
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
