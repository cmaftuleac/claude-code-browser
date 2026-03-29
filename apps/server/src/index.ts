/**
 * Claude Code Browser — local bridge server.
 *
 * Exposes an HTTP health endpoint and a WebSocket that the Chrome extension
 * connects to. Incoming messages are routed through AgentManager (Claude Agent SDK)
 * and optionally through Playwright MCP via CDP.
 */

import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

import { CdpManager } from './cdp-manager.js';
import { SessionStore } from './session-store.js';
import { AgentManager } from './agent-manager.js';
import { WsHandler } from './ws-handler.js';

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = Number(process.env.CCB_PORT) || 9315;
const CDP_PORT = Number(process.env.CCB_CDP_PORT) || 9222;
const VERSION = '0.1.0';

// ── Bootstrap ────────────────────────────────────────────────────────────────

const app = express();
const server = createServer(app);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: VERSION });
});

// Services
const cdpManager = new CdpManager(CDP_PORT);
const sessionStore = new SessionStore();
const agentManager = new AgentManager(cdpManager);
const wsHandler = new WsHandler(agentManager, sessionStore);

// WebSocket server on /ws path
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  console.log('[server] Client connected');
  wsHandler.handleConnection(ws);
});

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[server] Claude Code Browser server listening on http://localhost:${PORT}`);
  console.log(`[server] WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`[server] CDP target: http://127.0.0.1:${CDP_PORT}`);

  // Check CDP availability on startup (non-blocking)
  cdpManager.isAvailable().then((ok) => {
    if (ok) {
      console.log('[server] CDP connection verified');
    } else {
      console.log('[server] CDP not available — Playwright MCP tools will be disabled');
    }
  });
});
