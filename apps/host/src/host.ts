#!/usr/bin/env node

/**
 * Claude Code Browser — Chrome Native Messaging Host.
 * Minimal startup — heavy imports are lazy-loaded on first use.
 */

import { readNativeMessage, writeNativeMessage, log } from './native-io.js';
import { readdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { ClientMessage, ServerMessage } from '@claude-code-browser/shared';

// Prevent crashes
process.on('uncaughtException', (err) => { log('Uncaught exception:', err.message, err.stack ?? ''); });
process.on('unhandledRejection', (err) => { log('Unhandled rejection:', err); });

process.stdin.resume();

function send(msg: ServerMessage): void {
  writeNativeMessage(msg);
}

// Signal ready immediately — before any heavy imports
send({ type: 'connection:ready', serverVersion: '0.1.0' });

// Check for pending source configs from /browse skill — on startup and every 2 seconds
checkPendingSources();
setInterval(checkPendingSources, 2000);

log('Host started, waiting for messages');

let lastPendingContent = '';

function checkPendingSources() {
  try {
    const pendingFile = '/tmp/ccb-sources/pending.json';
    if (!existsSync(pendingFile)) {
      lastPendingContent = '';
      return;
    }
    const content = readFileSync(pendingFile, 'utf-8');
    // Re-send even if same content (extension may not have received it yet)
    const data = JSON.parse(content);
    if (data.domain && Array.isArray(data.paths)) {
      send({ type: 'sources:set', domain: data.domain, paths: data.paths });
      // Only delete after sending successfully for a few cycles
      if (content === lastPendingContent) {
        // Same content seen twice = extension likely got it, safe to delete
        try { unlinkSync(pendingFile); } catch { /* */ }
        lastPendingContent = '';
      } else {
        lastPendingContent = content;
      }
    }
  } catch { /* no pending sources */ }
}

// ── Slash Command Scanner ─────────────────────────────────────────────────

function scanSlashCommands(): Array<{ name: string; description: string; hint?: string }> {
  const commands: Array<{ name: string; description: string; hint?: string }> = [];
  const seen = new Set<string>();

  // Scan directories: ~/.claude/skills/, ~/.claude/commands/, .claude/skills/, .claude/commands/
  const dirs = [
    join(homedir(), '.claude', 'skills'),
    join(homedir(), '.claude', 'commands'),
    join(process.cwd(), '.claude', 'skills'),
    join(process.cwd(), '.claude', 'commands'),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        // Skills: directory with SKILL.md
        if (entry.isDirectory()) {
          const skillFile = join(dir, entry.name, 'SKILL.md');
          if (existsSync(skillFile)) {
            const parsed = parseSkillFrontmatter(readFileSync(skillFile, 'utf-8'));
            const name = parsed.name || entry.name;
            if (!seen.has(name)) {
              seen.add(name);
              commands.push({
                name: `/${name}`,
                description: parsed.description || '',
                hint: parsed.argumentHint,
              });
            }
          }
        }
        // Commands: .md files directly
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const name = basename(entry.name, '.md');
          if (!seen.has(name)) {
            seen.add(name);
            const content = readFileSync(join(dir, entry.name), 'utf-8');
            const firstLine = content.split('\n').find((l) => l.trim() && !l.startsWith('---'))?.trim() || '';
            commands.push({
              name: `/${name}`,
              description: firstLine.slice(0, 80),
            });
          }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  // Add built-in commands
  const builtins = [
    { name: '/clear', description: 'Clear the conversation' },
    { name: '/compact', description: 'Compact conversation context' },
    { name: '/cost', description: 'Show token usage and cost' },
    { name: '/help', description: 'Show available commands' },
  ];
  for (const cmd of builtins) {
    if (!seen.has(cmd.name.slice(1))) {
      commands.push(cmd);
    }
  }

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string; argumentHint?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const get = (key: string) => {
    const m = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m?.[1]?.trim();
  };
  return {
    name: get('name'),
    description: get('description'),
    argumentHint: get('argument-hint'),
  };
}

// Lazy-loaded modules
let agentManager: import('./agent-manager.js').AgentManager | null = null;
let sessionStore: import('./session-store.js').SessionStore | null = null;
let browserResponseHandler: ((id: string, result?: unknown, error?: string) => void) | null = null;

async function getAgentManager() {
  if (!agentManager) {
    const [{ AgentManager }, { getBrowserToolDefinitions }] = await Promise.all([
      import('./agent-manager.js'),
      import('./browser-tools.js'),
    ]);
    agentManager = new AgentManager(getBrowserToolDefinitions());
  }
  return agentManager;
}

async function getSessionStore() {
  if (!sessionStore) {
    const { SessionStore } = await import('./session-store.js');
    sessionStore = new SessionStore();
  }
  return sessionStore;
}

async function getBrowserResponseHandler() {
  if (!browserResponseHandler) {
    const { handleBrowserResponse } = await import('./browser-tools.js');
    browserResponseHandler = handleBrowserResponse;
  }
  return browserResponseHandler;
}

// ── Message Loop ──────────────────────────────────────────────────────────

async function main() {
  while (true) {
    try {
      const msg = await readNativeMessage() as ClientMessage;
      log('Received:', msg.type);
      handleMessage(msg).catch((err) => log('Error handling message:', err));
    } catch (err) {
      if ((err as Error).message === 'EOF') {
        log('stdin closed, exiting');
        break;
      }
      log('Read error:', err);
      break;
    }
  }
  process.exit(0);
}

async function handleMessage(msg: ClientMessage): Promise<void> {
  switch (msg.type) {
    case 'ping':
      send({ type: 'pong' });
      break;

    case 'health:check':
      send({
        type: 'health',
        nodeVersion: process.version,
        claudeCodeInstalled: true,
        claudeAuthenticated: true,
      });
      break;

    case 'commands:list':
      send({ type: 'commands:list', commands: scanSlashCommands() });
      break;

    case 'chat:send': {
      const am = await getAgentManager();
      const messageId = crypto.randomUUID();
      let resolvedSid = msg.sessionId ?? '';

      send({ type: 'agent:status', sessionId: resolvedSid, status: 'running' });

      await am.sendMessage(
        {
          message: msg.message,
          sessionId: msg.sessionId,
          anchors: msg.anchors,
          images: msg.images,
          url: msg.url,
          projectDir: msg.projectDir,
          sources: msg.sources,
        },
        {
          onSessionId: (sessionId) => {
            resolvedSid = sessionId;
            send({ type: 'session:created', sessionId });
          },
          onStream: (delta) => {
            send({ type: 'chat:stream', sessionId: resolvedSid, delta, messageId });
          },
          onToolUse: (toolName, summary) => {
            send({ type: 'agent:tool_use', sessionId: resolvedSid, toolName, summary });
          },
          onComplete: (result, sessionId, costUsd) => {
            send({ type: 'chat:complete', sessionId, result, messageId, costUsd });
            send({ type: 'agent:status', sessionId, status: 'idle' });
          },
          onError: (error) => {
            send({ type: 'chat:error', sessionId: resolvedSid, error });
            send({ type: 'agent:status', sessionId: resolvedSid, status: 'error' });
          },
        },
      );
      break;
    }

    case 'session:list': {
      const ss = await getSessionStore();
      const sessions = await ss.getSessions().catch(() => []);
      send({ type: 'session:list', sessions });
      break;
    }

    case 'session:resume': {
      const ss = await getSessionStore();
      const messages = await ss.getSessionMessages(msg.sessionId).catch(() => []);
      send({ type: 'session:messages', sessionId: msg.sessionId, messages });
      break;
    }

    case 'agent:interrupt': {
      const am = await getAgentManager();
      am.interruptSession(msg.sessionId);
      break;
    }

    case 'config:set': {
      const am = await getAgentManager();
      am.setConfig(msg.projectDir);
      break;
    }

    case 'sources:set':
      // Forward to extension to store in chrome.storage.local
      send({ type: 'sources:set', domain: msg.domain, paths: msg.paths });
      break;

    case 'browser:response': {
      const handler = await getBrowserResponseHandler();
      handler(msg.requestId, msg.result, msg.error);
      break;
    }
  }
}

main();
