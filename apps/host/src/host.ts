#!/usr/bin/env node

/**
 * Claude Code Browser — Chrome Native Messaging Host.
 * Minimal startup — heavy imports are lazy-loaded on first use.
 */

import { readNativeMessage, writeNativeMessage, log } from './native-io.js';
import { readdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolveProjectDir } from './project-dir.js';
import type { ClientMessage, ServerMessage } from '@claude-code-browser/shared';

// Prevent crashes
process.on('uncaughtException', (err) => { log('Uncaught exception:', err.message, err.stack ?? ''); });
process.on('unhandledRejection', (err) => { log('Unhandled rejection:', err); });

process.stdin.resume();

function send(msg: ServerMessage): void {
  writeNativeMessage(msg);
}

/** Read the host's real version from its own package.json. Published layout is
 *  dist/host.js → ../package.json (the build writes dist/package.json as a
 *  {"type":"module"} stub with no version, so we must read one level up). Falls
 *  back to '0.0.0' so a failed read fails safe to the extension's manual-update
 *  path rather than a false "compatible". */
function resolveHostVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch { /* fall through to fallback */ }
  return '0.0.0';
}

const HOST_VERSION = resolveHostVersion();

// Signal ready immediately — before any heavy imports
send({ type: 'connection:ready', serverVersion: HOST_VERSION });

// Check for pending source configs from /browse skill — on startup and every 2 seconds
checkPendingSources();
setInterval(checkPendingSources, 2000);

log('Host started, waiting for messages');

function checkPendingSources() {
  try {
    const dir = '/tmp/ccb-sources';
    if (!existsSync(dir)) return;
    // Consume per-domain pending files written by the /browse skill. With one host
    // process per panel, N hosts poll this dir — so we consume-and-delete in one
    // pass (whichever host grabs a file first wins; others find it gone). A single
    // send suffices because the SW persists sources keyed by domain in shared
    // chrome.storage, which the panel viewing that domain reads regardless of which
    // host forwarded it. (Matches both legacy `pending.json` and `pending-<dom>.json`.)
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('pending') || !name.endsWith('.json')) continue;
      const file = join(dir, name);
      try {
        const data = JSON.parse(readFileSync(file, 'utf-8'));
        if (data.domain && Array.isArray(data.paths)) {
          send({ type: 'sources:set', domain: data.domain, paths: data.paths });
        }
        unlinkSync(file);
      } catch { /* mid-write or already consumed by another host */ }
    }
  } catch { /* no pending sources dir */ }
}

// ── Slash Command Scanner ─────────────────────────────────────────────────

/** Scan the user's + the project's skills/commands folders.
 *
 *  `projectDir` must be passed explicitly: this host is spawned by Chrome, so
 *  process.cwd() is whatever directory Chrome happened to have (typically `/`) and
 *  never the session's project — scanning it meant project-local `.claude/commands`
 *  were silently never found. Falls back to the configured project dir. */
function scanSlashCommands(projectDir?: string): Array<{ name: string; description: string; hint?: string }> {
  const commands: Array<{ name: string; description: string; hint?: string }> = [];
  const seen = new Set<string>();

  const dirs = [
    join(homedir(), '.claude', 'skills'),
    join(homedir(), '.claude', 'commands'),
    ...(projectDir ? [join(projectDir, '.claude', 'skills'), join(projectDir, '.claude', 'commands')] : []),
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

async function getAgentManager() {
  if (!agentManager) {
    const { AgentManager } = await import('./agent-manager.js');
    agentManager = new AgentManager(
      send,
      (requestId, action, params) => {
        // Relay browser request from MCP server process to Chrome extension
        send({ type: 'browser:request', requestId, action: action as any, params });
      },
    );
  }
  return agentManager;
}

/** Ask the running CLI which models it offers and push them to the panel. Needs a
 *  resident session (the list comes off a live Query), so callers fire this after
 *  creating/warming one; a no-op until then.
 *
 *  Cached rather than sent once: the host outlives panel reloads, and a panel that
 *  reconnects has an empty model list. Without a re-send it would fall back to the
 *  bundled table for the rest of the host's life and could offer a model this CLI
 *  doesn't have. `resetModelsPushed` is called when a panel (re)connects. */
let cachedModels: { id: string; label: string }[] | null = null;
async function pushSupportedModels(am: Awaited<ReturnType<typeof getAgentManager>>): Promise<void> {
  if (cachedModels) return;   // already known; health:check re-sends it to new panels
  const models = await am.getSupportedModels().catch(() => null);
  if (!models || models.length === 0) return;
  cachedModels = models;
  send({ type: 'agent:models', models });
}

async function getSessionStore() {
  if (!sessionStore) {
    const { SessionStore } = await import('./session-store.js');
    sessionStore = new SessionStore();
  }
  return sessionStore;
}

// browserResponseHandler is no longer needed — responses go through agent manager IPC

// ── Self-Update ─────────────────────────────────────────────────────────────

interface StepResult { ok: boolean; code: number | null; stdout: string; stderr: string; timedOut: boolean; }

/** Spawn a command, capture stdout/stderr (bounded), with a hard timeout. The
 *  Chrome-spawned host has a minimal PATH (no nvm), so we prepend node's own dir
 *  to PATH — npm and our bin live there as siblings of `process.execPath`, and
 *  npm's `#!/usr/bin/env node` launcher then resolves node. */
function runStep(cmd: string, args: string[], timeoutMs: number): Promise<StepResult> {
  return new Promise((resolve) => {
    const nodeDir = dirname(process.execPath);
    const sep = platform() === 'win32' ? ';' : ':';
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, {
        env: { ...process.env, PATH: `${nodeDir}${sep}${process.env.PATH ?? ''}` },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: platform() === 'win32', // needed to run npm.cmd / *.cmd shims
      });
    } catch (e) {
      resolve({ ok: false, code: null, stdout: '', stderr: String(e), timedOut: false });
      return;
    }
    child.stdout?.on('data', (b: Buffer) => { stdout = (stdout + b.toString()).slice(-4000); });
    child.stderr?.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-4000); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ ok: false, code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: null, stdout, stderr: String(e), timedOut: false }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, stdout, stderr, timedOut: false }); });
  });
}

function classifyNpmFailure(s: StepResult): string {
  if (s.timedOut) return 'npm timed out — check your network connection';
  const tail = `${s.stdout}\n${s.stderr}`;
  if (/EACCES|EPERM|permission denied/i.test(tail)) return 'permission denied — a system Node install may need sudo to update globally';
  return 'npm install failed: ' + tail.replace(/\s+/g, ' ').trim().slice(-200);
}

/** Update the globally-installed claude-code-browser to `targetVersion` and re-wire
 *  the native-messaging manifest, then exit so Chrome respawns the fresh host. */
async function handleHostUpdate(targetVersion: string): Promise<void> {
  // Validate before interpolating into an npm spec (no arg/shell injection).
  if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(targetVersion)) {
    send({ type: 'host:update:result', success: false, reason: 'invalid target version' });
    return;
  }

  const isWin = platform() === 'win32';
  const nodeDir = dirname(process.execPath);
  const npmBin = join(nodeDir, isWin ? 'npm.cmd' : 'npm');

  // Step 1: install the target version globally.
  log(`host:update → npm i -g claude-code-browser@${targetVersion}`);
  const step1 = await runStep(npmBin, ['i', '-g', `claude-code-browser@${targetVersion}`], 180_000);
  if (!step1.ok) {
    log('host:update npm install failed', step1.stderr);
    send({ type: 'host:update:result', success: false, reason: classifyNpmFailure(step1), installedVersion: HOST_VERSION });
    return; // stay alive — extension shows manual instructions
  }

  // Step 2: re-run the freshly-installed installer to restore the absolute-node
  // shebang npm just reset, and to repoint the manifest at the new global host
  // (covers npx-cache installs whose manifest pointed elsewhere). This reuses all
  // of install.ts's manifest/shebang/extension-detection logic.
  //
  // NOTE: `claude-code-browser install` calls killStaleHosts() (pkill of our own
  // host.js) AFTER it has rewritten the manifest+shebang, so this process may be
  // SIGKILLed before the lines below run. That's fine: either path ends with us
  // dead and Chrome respawning the updated host. The success message is best-effort.
  const ccbBin = join(nodeDir, isWin ? 'claude-code-browser.cmd' : 'claude-code-browser');
  let step2: StepResult;
  if (existsSync(ccbBin)) {
    log('host:update → claude-code-browser install');
    step2 = await runStep(ccbBin, ['install'], 60_000);
  } else {
    // Fallback: global bin dir differs from node's dir (custom npm prefix). Locate
    // the freshly-installed installer via `npm root -g` and run it with node.
    const rootRes = await runStep(npmBin, ['root', '-g'], 30_000);
    const root = rootRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
    const installJs = root ? join(root, 'claude-code-browser', 'dist', 'install.js') : '';
    if (!installJs || !existsSync(installJs)) {
      send({ type: 'host:update:result', success: false, reason: 'could not locate installer after update' });
      return;
    }
    log('host:update → node install.js install');
    step2 = await runStep(process.execPath, [installJs, 'install'], 60_000);
  }
  if (!step2.ok) {
    send({ type: 'host:update:result', success: false, reason: 're-wire failed: ' + `${step2.stdout}\n${step2.stderr}`.replace(/\s+/g, ' ').trim().slice(-200) });
    return;
  }

  // Success (reached only if killStaleHosts didn't already kill us). Flush the
  // framed message, then exit so the next Chrome connect spawns the new host.
  send({ type: 'host:update:result', success: true, installedVersion: targetVersion });
  setTimeout(() => process.exit(0), 200);
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
      // A panel asking for health has just (re)connected, and a reloaded panel starts
      // with an empty model list. Re-send what we already know so its picker doesn't
      // spend the rest of the host's life on the bundled fallback table.
      if (cachedModels) send({ type: 'agent:models', models: cachedModels });
      // Re-announce turns that are still running. The panel cleared its own running
      // flags when the port dropped, but the service worker kept us alive and those
      // turns never stopped — without this they'd stream on with no spinner and no
      // way to Stop them.
      if (agentManager) {
        for (const sessionId of agentManager.getRunningSessionIds()) {
          send({ type: 'agent:status', sessionId, status: 'running' });
        }
      }
      break;

    case 'commands:list':
      send({ type: 'commands:list', commands: scanSlashCommands(resolveProjectDir(msg.origin, msg.projectDir)) });
      break;

    case 'chat:send': {
      const am = await getAgentManager();
      // Note: extension self-marks the session as running on submit. We don't
      // re-emit agent:status here because msg.sessionId can be undefined for
      // brand-new chats — the resulting sessionId:'' would land in the wrong
      // bucket on the extension side. The proper running signal is the first
      // chat:stream event (and the per-session bucket already exists).
      am.sendMessage({
        message: msg.message,
        sessionId: msg.sessionId,
        clientRequestId: msg.clientRequestId,
        anchors: msg.anchors,
        images: msg.images,
        files: msg.files,
        url: msg.url,
        origin: msg.origin,
        projectDir: msg.projectDir,
        sources: msg.sources,
        // Per-conversation run mode from the side panel's picker. The host has no
        // settings layer, so these (or the orchestrator default) are authoritative.
        // effort / ultracode / unattended are forwarded VERBATIM (including '' and
        // false) rather than truthiness-spread: a resident session needs to be told
        // to turn these back OFF too, and '' is the picker's meaningful "Default".
        ...(msg.permissionMode ? { permissionMode: msg.permissionMode } : {}),
        // `model` belongs with them: '' is the picker's "Default" rung, and the
        // reconcile is written to CLEAR a pinned model on '' — truthiness-spreading it
        // here meant undefined arrived instead and unpinning silently never worked.
        model: msg.model,
        effort: msg.effort,
        ultracode: msg.ultracode,
        unattended: msg.unattended,
      })
        // Only once sendMessage RESOLVES is a session actually registered, so chain
        // the model read off it — firing immediately would race the spawn and find
        // no live Query to ask.
        .then(() => pushSupportedModels(am))
        .catch((err) => log('sendMessage error:', err instanceof Error ? err.message : String(err)));
      break;
    }

    case 'session:list': {
      // Scope to the website's project folder. Unknown origin (chrome:// / no tab)
      // → empty list; never leak the machine-wide all-projects list.
      const dir = resolveProjectDir(msg.origin, msg.projectDir);
      if (!dir) {
        send({ type: 'session:list', sessions: [] });
        break;
      }
      const ss = await getSessionStore();
      const sessions = await ss.getSessions(dir).catch(() => []);
      send({ type: 'session:list', sessions });
      break;
    }

    case 'session:resume': {
      const ss = await getSessionStore();
      const messages = await ss.getSessionMessages(msg.sessionId).catch(() => []);
      send({ type: 'session:messages', sessionId: msg.sessionId, messages });
      // The user just opened this conversation and will very likely type into it.
      // Pre-warm it in the background so the first message doesn't pay for the CLI
      // spawn + initialize + transcript reload. Needs a project folder to use as
      // cwd; skip the warm (not the resume) when the origin doesn't resolve.
      const dir = resolveProjectDir(msg.origin, msg.projectDir);
      if (dir) {
        const am = await getAgentManager();
        // Chain the model read off the warm: fired now it would find no resident
        // Query (the warm registers only once startup() resolves) and no-op.
        // The tab URL rides along: systemPrompt is baked at query() creation and the
        // resident session is reused for every later send, so warming with url:'' left
        // resumed conversations permanently unable to see which page the user is on.
        void am.warmSession({ sessionId: msg.sessionId, message: '', url: msg.url ?? '', projectDir: dir })
          .then(() => pushSupportedModels(am))
          .catch((err) => log('warmSession error:', err instanceof Error ? err.message : String(err)));
      }
      break;
    }

    case 'agent:interrupt': {
      const am = await getAgentManager();
      const stopped = am.interruptSession(msg.sessionId ?? '', msg.clientRequestId);
      if (stopped) {
        // Echo the correlation id back too: a brand-new chat is stopped by
        // clientRequestId (its sessionId is still ''), and the panel routes on
        // sessionId-then-clientRequestId — without it this confirmation matches no
        // bucket and is silently discarded.
        send({
          type: 'agent:status',
          sessionId: msg.sessionId ?? '',
          ...(msg.clientRequestId ? { clientRequestId: msg.clientRequestId } : {}),
          status: 'idle',
        });
      }
      break;
    }

    case 'agent:set_mode': {
      const am = await getAgentManager();
      void am.setRunMode(msg.sessionId, {
        permissionMode: msg.permissionMode,
        model: msg.model,
        effort: msg.effort,
        ultracode: msg.ultracode,
        unattended: msg.unattended,
        clientRequestId: msg.clientRequestId,
      });
      break;
    }

    case 'chat:permission': {
      const am = await getAgentManager();
      am.respondToPermission(msg.requestId, { behavior: msg.behavior, updatedInput: msg.updatedInput, persist: msg.persist, message: msg.message });
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
      const am = await getAgentManager();
      am.sendBrowserResponse(msg.requestId, msg.result, msg.error);
      break;
    }

    case 'host:update':
      await handleHostUpdate(msg.targetVersion);
      break;
  }
}

main();
