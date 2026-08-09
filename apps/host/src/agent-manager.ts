/**
 * Core orchestration — bridges user messages to the Claude Agent SDK using
 * streaming-input mode. One long-lived Query per session lets new user
 * messages be injected mid-turn without interrupting the agent.
 */

import { query, startup } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKUserMessage, PermissionMode, McpServerConfig, EffortLevel, PermissionResult, PermissionUpdate, Options } from '@anthropic-ai/claude-agent-sdk';
import type { ElementAnchor, ServerMessage, AttachedFile, PermissionModeSetting } from '@claude-code-browser/shared';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { log } from './native-io.js';
import { resolveProjectDir, normalizeDir } from './project-dir.js';

export interface SendMessageParams {
  message: string;
  sessionId?: string;
  /** Client-generated correlation token for brand-new sessions. Echoed back on
   *  session:created and any events emitted before the canonical session_id resolves. */
  clientRequestId?: string;
  anchors?: ElementAnchor[];
  images?: string[];
  /** Generic (non-image) file attachments; written to /tmp and referenced in the prompt. */
  files?: AttachedFile[];
  url: string;
  /** Page origin (host:port); used to derive a per-website default project folder. */
  origin?: string;
  projectDir?: string;
  sources?: string[];
  // Agent config (kept in parity with packages/agent-core). Applied at session
  // creation. The extension has no Settings UI yet, so these stay unset there —
  // this is type/option parity so the two orchestrators don't drift.
  model?: string;
  permissionMode?: PermissionMode;
  /** '' is the picker's "Default" rung — it clears the flag layer rather than pinning
   *  a level. Kept distinct from `undefined` ("caller has no opinion"). */
  effort?: EffortLevel | '';
  mcpServers?: Record<string, McpServerConfig>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Ultracode: xhigh effort + standing dynamic-workflow orchestration. Lives in the
   *  SDK's flag-settings layer, not a query() option, so it is both baked in here at
   *  creation and live-settable via setRunMode. */
  ultracode?: boolean;
  /** Unattended: auto-approve gated tool calls instead of parking them for the user,
   *  reporting each one back as agent:auto_decision. Live-settable via setRunMode. */
  unattended?: boolean;
  /** Pre-warm only: spawn + initialize the session but push no user message.
   *  Suppresses the client-facing error emit (nobody is waiting on this turn). */
  warm?: boolean;
}

/** Best-effort string extraction from any SDK message — used for unknown
 *  / unhandled message types so they get *some* visible representation
 *  instead of being silently dropped. */
const HUMAN_READABLE_FIELDS = ['message', 'text', 'content', 'summary', 'description', 'output', 'stdout', 'error', 'reason', 'name'] as const;

function extractHumanReadable(message: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of HUMAN_READABLE_FIELDS) {
    const v = message[key];
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length > 0) parts.push((v as string[]).join('\n'));
  }
  return parts.join('\n');
}

/** Most human-relevant line from a tool's input — the command, path or pattern.
 *  Used to describe an unattended auto-approval in one line. */
function describeToolInput(input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'plan']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200);
  }
  return '';
}

/** Longest string value shipped inside a tool input. The approval card only ever
 *  shows a preview, and native messaging drops the whole frame past 1MB. */
const INPUT_VALUE_CAP = 8_000;
/** Ceiling for the whole serialized input, well under Chrome's 1MB frame limit. */
const INPUT_TOTAL_CAP = 128_000;

/** A tool input safe to put on the wire: long strings are truncated with a visible
 *  marker, and the result is bounded in AGGREGATE too.
 *
 *  Applied to permission cards, whose payload is the tool's REAL input (a whole
 *  file's contents for Write, a full patch list for MultiEdit). An oversized frame is
 *  dropped silently by native-io, so the card never renders and the parked turn hangs
 *  forever — which means a per-value cap alone is not enough: strings nested inside
 *  arrays/objects skip it entirely, and enough small values still blow the budget. */
function capInputForTransport(input: Record<string, unknown>): Record<string, unknown> {
  const capStrings = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.length > INPUT_VALUE_CAP
        ? `${v.slice(0, INPUT_VALUE_CAP)}\n\n… [${v.length - INPUT_VALUE_CAP} more characters]`
        : v;
    }
    if (Array.isArray(v)) return v.map(capStrings);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, capStrings(x)]));
    }
    return v;
  };
  const out = capStrings(input) as Record<string, unknown>;
  // Still too big (hundreds of keys, or a huge non-string structure)? Ship a readable
  // stand-in rather than a frame that will be thrown away in silence.
  try {
    if (JSON.stringify(out).length <= INPUT_TOTAL_CAP) return out;
  } catch {
    // Not serializable (cycles) — the frame would fail anyway; fall through.
  }
  const summary: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && v.length <= 400) summary[k] = v;
  }
  summary._truncated = 'This tool input was too large to display in full.';
  return summary;
}

/** Read an SDK field that is typed `unknown` as a string, or '' when it isn't one. */
function sstr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** The label of a question's first option — the agent orders options best-first, so
 *  this is the sane stand-in when nobody is around to choose (unattended runs). */
function defaultAnswers(input: Record<string, unknown>): Record<string, string> {
  const answers: Record<string, string> = {};
  const questions = Array.isArray(input.questions) ? input.questions : [];
  for (const q of questions) {
    if (!q || typeof q !== 'object') continue;
    const { question, options } = q as { question?: unknown; options?: unknown };
    if (typeof question !== 'string' || !Array.isArray(options) || options.length === 0) continue;
    const first = options[0];
    const label = typeof first === 'string' ? first : (first as { label?: unknown })?.label;
    if (typeof label === 'string') answers[question] = label;
  }
  return answers;
}

/** The todo list out of a TodoWrite call's (fully streamed) argument JSON. Returns
 *  null only when the payload isn't a todo list at all (a truncated parse), so a
 *  partial stream can't blank the panel — but an intentionally EMPTY list still
 *  returns [], which is how the agent clears a finished checklist. */
function parseTodos(rawInput: string): Array<{ content: string; status: string; activeForm?: string }> | null {
  try {
    const parsed = JSON.parse(rawInput) as { todos?: unknown };
    if (!Array.isArray(parsed.todos)) return null;
    return parsed.todos
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map((t) => ({
        content: typeof t.content === 'string' ? t.content : '',
        status: typeof t.status === 'string' ? t.status : 'pending',
        ...(typeof t.activeForm === 'string' ? { activeForm: t.activeForm } : {}),
      }))
      .filter((t) => t.content);
  } catch {
    return null;
  }
}

/** Narrow a permission mode the SDK reports back to one the picker can display, or
 *  null when it has no equivalent (the SDK's PermissionMode is a superset — it also
 *  has `dontAsk`). Null means "don't mirror it": the panel echoes whatever the chip
 *  shows on the next chat:send, so collapsing an unknown mode to `default` would not
 *  just mislabel the session, it would go on to actually CHANGE it to default.
 *
 *  Inlined rather than imported from @claude-code-browser/shared: that package is
 *  a devDependency (type-only, erased at build), so a *runtime* import from it
 *  would leave an unresolvable specifier in the published dist/. */
const DISPLAYABLE_MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'];

function toModeSetting(raw: unknown): PermissionModeSetting | null {
  return typeof raw === 'string' && DISPLAYABLE_MODES.includes(raw)
    ? (raw as PermissionModeSetting)
    : null;
}

function systemHeader(type: string, subtype?: string): string {
  return `_${subtype ? `${type}/${subtype}` : type}_`;
}

function formatToolDetail(name: string, rawInput: string): string {
  try {
    const input = JSON.parse(rawInput) as Record<string, unknown>;
    switch (name) {
      case 'Bash': return `Running Bash command\n\`\`\`\n${input.command}\n\`\`\``;
      case 'Read': return `Reading file\n\`${input.file_path}\``;
      case 'Edit': return `Editing file\n\`${input.file_path}\``;
      case 'Write': return `Writing file\n\`${input.file_path}\``;
      case 'Grep': return `Searching for \`${input.pattern}\`${input.path ? ` in \`${input.path}\`` : ''}`;
      case 'Glob': return `Finding files \`${input.pattern}\`${input.path ? ` in \`${input.path}\`` : ''}`;
      case 'ExitPlanMode': {
        // The SDK injects the plan body into the input as a `plan` field at runtime.
        const plan = typeof input.plan === 'string' ? input.plan : '';
        if (plan) return `**Plan**\n\n${plan}`;
        if (typeof input.planFilePath === 'string') return `**Plan** (see \`${input.planFilePath}\`)`;
        return '**Plan**';
      }
      default: {
        if (name.startsWith('browser_')) return `Running ${name.replace('_', ' ')}`;
        const firstVal = Object.values(input)[0];
        if (firstVal && typeof firstVal === 'string') return `${name}: ${String(firstVal).slice(0, 120)}`;
        return name;
      }
    }
  } catch {
    return name;
  }
}

/**
 * Push-based AsyncIterable used as the streaming-input prompt for query().
 * Resolves pending next() calls when push() is called; closes cleanly on end().
 */
class AsyncMessagePump<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private resolvers: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) r({ value, done: false });
    else this.buffer.push(value);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end();
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      },
    };
  }
}

interface LiveSession {
  /** Empty until the SDK reports session_id on the first frame */
  sessionId: string;
  /** Client-generated correlation token. Echoed on session:created and on any events
   *  emitted while sessionId is still empty, so the client can route them to its
   *  pending bucket. Undefined for resumed sessions (no correlation needed). */
  clientRequestId?: string;
  pump: AsyncMessagePump<SDKUserMessage>;
  query: Query;
  abort: AbortController;
  cwd: string;
  /** Active additionalDirectories — kept in sync with the SDK's flag settings layer */
  sources: string[];
  /** Set when the user clicks Stop. The SDK emits `result/error_during_execution`
   *  in response to interrupt(), so we use this flag to distinguish a deliberate
   *  stop from a real error. Reset when the resulting message is consumed. */
  interrupted: boolean;
  /** True while a turn is in flight (message pushed, no `result` yet). */
  streaming: boolean;
  /** Last time a turn started or ended — LRU key + idle-reap clock. */
  lastActivity: number;
  /** Pending idle-reap timer (cleared on new turn / teardown). */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Set once when reaped so we never double-reap. */
  reaped: boolean;
  /** Unattended mode for THIS session. Mutable so the picker can flip it mid-run;
   *  canUseTool reads it at decision time, not at session creation. */
  unattended: boolean;
  /** True from a pre-warm until the first user message is pushed. Nobody is waiting
   *  on a warm, so a failure must not paint chat:error into a conversation the user
   *  merely opened — it is logged instead. Cleared by sendMessage. */
  warm: boolean;
  /** Turns pushed into the pump that haven't reported a `result` yet. Usually 0 or 1,
   *  but the user can send a follow-up mid-turn and both run on the same pump — the
   *  session is only idle once this reaches 0. */
  pendingTurns: number;
  /** How many prompts this turn has parked on the user (approval cards, questions).
   *  A parked session looks permanently "streaming" to the reaper, so the cap uses
   *  this to tell "working" apart from "waiting on a human who left". */
  parked: number;
  /** True once this session's permission mode came from the picker rather than the
   *  `bypassPermissions` fallback. A pre-warm (session:resume) carries no run mode, so
   *  until the first send reconciles it, a `status` frame reporting the fallback would
   *  be mirrored back as agent:mode_changed and silently reset the user's selection. */
  modeAuthoritative: boolean;
}

function sourcesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  for (let i = 0; i < as.length; i++) if (as[i] !== bs[i]) return false;
  return true;
}

// ── Memory: idle-session reaping (mirrors packages/agent-core) ────────────────
const IDLE_REAP_MS = 5 * 60 * 1000;
const MODERATE_IDLE_MS = 60 * 1000;
const MAX_LIVE_SESSIONS = 4;

export class AgentManager {
  private ipcServer: NetServer | null = null;
  private ipcPort = 0;
  /** Resolves once the IPC server is listening and this.ipcPort is set. Awaited
   *  before spawning the agent process so CCB_IPC_PORT is never injected as 0. */
  private ipcReady: Promise<void> = Promise.resolve();
  private ipcClients = new Set<Socket>();
  private projectDir: string | undefined;
  private liveSessions = new Map<string, LiveSession>();
  /** Sessions whose canonical sessionId is not yet known (first frame pending) */
  private pendingLiveSessions = new Set<LiveSession>();
  /** In-flight pre-warms, keyed by sessionId. A warm only registers in liveSessions
   *  AFTER startup()'s spawn + init + transcript load resolves, so a chat:send that
   *  lands during that window would otherwise miss it and spawn a SECOND CLI
   *  resuming the same JSONL. Both paths await this instead. */
  private resumeWarming = new Map<string, Promise<void>>();
  /** requestId → a parked canUseTool decision (see respondToPermission). Resolves
   *  when the extension replies with chat:permission, or denies on turn abort.
   *  Mirrors packages/agent-core. */
  private pendingPermissions = new Map<string, { resolve: (r: PermissionResult) => void; suggestions?: PermissionUpdate[]; cleanup: () => void }>();
  private browserCliPath: string;

  constructor(
    private send: (msg: ServerMessage) => void,
    private onBrowserRequest: (requestId: string, action: string, params: Record<string, unknown>) => void,
  ) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    this.browserCliPath = join(__dirname, 'browser-cli.js');
    this.startIpcServer();
  }

  private startIpcServer(): void {
    this.ipcServer = createServer((socket) => {
      this.ipcClients.add(socket);
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          try {
            const msg = JSON.parse(line) as { requestId: string; action: string; params: Record<string, unknown> };
            this.onBrowserRequest(msg.requestId, msg.action, msg.params);
          } catch { /* ignore */ }
        }
      });
      socket.on('close', () => this.ipcClients.delete(socket));
      socket.on('error', () => this.ipcClients.delete(socket));
    });
    this.ipcReady = new Promise<void>((resolve) => {
      this.ipcServer!.listen(0, '127.0.0.1', () => {
        const addr = this.ipcServer!.address();
        this.ipcPort = typeof addr === 'object' && addr ? addr.port : 0;
        log('IPC server listening on port', this.ipcPort);
        // Write the port file too (in addition to the CCB_IPC_PORT env). The env
        // is the per-process channel (correct for multiple concurrent hosts), but
        // it can be lost if the agent's shell sandbox strips env/TMPDIR; the file
        // is the single-host fallback the agent's browser-cli reads from the same
        // tmpdir. Written only after the port is known, so it's never stale-zero.
        writeFile(join(tmpdir(), 'ccb-ipc-port'), String(this.ipcPort)).catch(() => {});
        resolve();
      });
    });
  }

  sendBrowserResponse(requestId: string, result?: unknown, error?: string): void {
    const msg = JSON.stringify({ requestId, result, error }) + '\n';
    for (const client of this.ipcClients) {
      try { client.write(msg); } catch { /* ignore */ }
    }
  }

  /** Resolve a parked canUseTool decision (extension replied with chat:permission).
   *  No-op if unknown (already resolved / aborted). Mirrors packages/agent-core. */
  respondToPermission(requestId: string, decision: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; persist?: boolean; message?: string }): void {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return;
    this.pendingPermissions.delete(requestId);
    entry.cleanup();
    if (decision.behavior === 'allow') {
      entry.resolve({
        behavior: 'allow',
        ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
        ...(decision.persist && entry.suggestions && entry.suggestions.length > 0 ? { updatedPermissions: entry.suggestions } : {}),
      });
    } else {
      entry.resolve({ behavior: 'deny', message: decision.message || 'Denied by user.' });
    }
  }

  /** AskUserQuestion: park a promise, raise the multiple-choice question card
   *  (agent:permission_request with toolName='AskUserQuestion'), and resolve it from
   *  the panel's chat:permission reply, which carries `updatedInput.answers`.
   *  Deliberately reuses pendingPermissions and the PermissionResult shape so the
   *  existing answer round-trip needs no second channel; the PreToolUse hook maps the
   *  result into hookSpecificOutput. Mirrors canUseTool's abort handling so an
   *  interrupted turn never leaks a parked card. */
  private raiseQuestion(live: LiveSession, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      // UNATTENDED: an overnight run must not stall on a question, so answer it the
      // way the agent's own ordering suggests — first option per question — and report
      // what was chosen. `answers` is a record of question text → chosen label.
      if (live.unattended) {
        const answers = defaultAnswers(input);
        // No readable option to pick means allowing it would send the tool through
        // with no answers — and an unanswered AskUserQuestion dangles forever, which
        // is exactly the stall unattended mode exists to prevent. Deny instead: the
        // agent is told why and can proceed without the answer.
        if (Object.keys(answers).length === 0) {
          resolve({ behavior: 'deny', message: 'The question could not be read, so it was skipped (unattended run).' });
          return;
        }
        const detail = Object.entries(answers).map(([q, a]) => `${q} → ${a}`).join('; ');
        const evt: ServerMessage = {
          type: 'agent:auto_decision',
          sessionId: live.sessionId,
          toolName: 'AskUserQuestion',
          detail,
          decision: 'allow',
        };
        if (!live.sessionId && live.clientRequestId) this.send({ ...evt, clientRequestId: live.clientRequestId });
        else this.send(evt);
        resolve({ behavior: 'allow', updatedInput: { ...input, answers } });
        return;
      }
      const requestId = crypto.randomUUID();
      // See canUseTool: a card on screen keeps the turn "streaming", so the session
      // cap needs to see that this one is waiting on a human.
      let holding = true;
      live.parked += 1;
      const unpark = () => { if (holding) { holding = false; live.parked = Math.max(0, live.parked - 1); } };
      const onAbort = () => {
        if (this.pendingPermissions.delete(requestId)) {
          unpark();
          resolve({ behavior: 'deny', message: 'Interrupted.', interrupt: true });
        }
      };
      const cleanup = () => { unpark(); signal.removeEventListener('abort', onAbort); };
      if (signal.aborted) { unpark(); resolve({ behavior: 'deny', message: 'Interrupted.', interrupt: true }); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingPermissions.set(requestId, { resolve, cleanup });
      const evt: ServerMessage = {
        type: 'agent:permission_request',
        sessionId: live.sessionId,
        requestId,
        toolName: 'AskUserQuestion',
        input: capInputForTransport(input),
      };
      if (!live.sessionId && live.clientRequestId) this.send({ ...evt, clientRequestId: live.clientRequestId });
      else this.send(evt);
    });
  }

  /** Live mid-session run-mode switch — every field takes effect on the running
   *  Query. permissionMode and model have dedicated setters; effort and ultracode
   *  go through the flag-settings layer.
   *
   *  Effort has no dedicated setter, which is easy to misread as "not live". It is:
   *  `applyFlagSettings({ effortLevel })` sets it mid-session, and that path uniquely
   *  accepts 'max' (Settings.effortLevel itself stops at 'xhigh' because max is
   *  session-scoped). This matters because the panel now drives effort and ultracode
   *  from ONE slider — if effort were dropped here, half of every drag would be a
   *  silent no-op. */
  async setRunMode(
    sessionId: string,
    opts: { permissionMode?: PermissionMode; model?: string; effort?: EffortLevel | ''; ultracode?: boolean; unattended?: boolean; clientRequestId?: string },
  ): Promise<void> {
    let live = this.liveSessions.get(sessionId);
    // A brand-new chat's turn is already running before its session_id resolves, so
    // fall back to matching the pending session by clientRequestId — otherwise a mode
    // flipped during that first turn is silently dropped.
    if (!live && opts.clientRequestId) {
      for (const pending of this.pendingLiveSessions) {
        if (pending.clientRequestId === opts.clientRequestId) { live = pending; break; }
      }
    }
    if (!live) return;
    // Local flag, not an SDK call — canUseTool reads it on the next gated tool.
    if (opts.unattended !== undefined) live.unattended = opts.unattended;
    if (opts.permissionMode) live.modeAuthoritative = true;
    try {
      if (opts.permissionMode) await live.query.setPermissionMode(opts.permissionMode);
      if (opts.model !== undefined) await live.query.setModel(opts.model || undefined);
      // Effort + ultracode are the two projections of one slider, so apply them in a
      // SINGLE call: successive applyFlagSettings calls shallow-merge, so two calls
      // would briefly leave the session on a mixed rung. Deliberately scoped to just
      // these keys — bundling the `permissions` object used for additionalDirectories
      // would replace that key wholesale and drop the session's extra source folders.
      const flags: { effortLevel?: EffortLevel | null; ultracode?: boolean } = {};
      // '' is the picker's "Default" rung; null clears the flag layer back to the
      // user's own setting rather than pinning a level.
      if (opts.effort !== undefined) flags.effortLevel = opts.effort === '' ? null : opts.effort;
      if (opts.ultracode !== undefined) flags.ultracode = opts.ultracode;
      if (Object.keys(flags).length > 0) await live.query.applyFlagSettings(flags);
    } catch (err) {
      log('setRunMode failed:', err instanceof Error ? err.message : String(err));
    }
  }

  setConfig(projectDir?: string): void {
    if (projectDir) this.projectDir = projectDir;
  }

  /** Pre-warm a session the user just opened: spawn the CLI, let it finish its
   *  initialize handshake and load the transcript, and leave it resident so the
   *  first chat:send only has to push. Best-effort — a failure is swallowed
   *  (`warm: true` keeps createLiveSession from emitting a client-facing error),
   *  and a session that is already resident is left alone. */
  async warmSession(params: SendMessageParams): Promise<void> {
    const sid = params.sessionId;
    if (!sid) return;
    if (this.liveSessions.has(sid)) return;      // already resident
    const inFlight = this.resumeWarming.get(sid);
    if (inFlight) return inFlight;               // coalesce onto the running warm

    const p = (async () => {
      await this.ipcReady;
      let live: LiveSession;
      try {
        // `url` is deliberately NOT overridden: the system prompt is baked at query()
        // creation and this warmed session is reused for every later turn, so blanking
        // it here would leave a resumed conversation permanently unable to see the tab.
        live = await this.createLiveSession({ ...params, message: '', clientRequestId: undefined, warm: true });
      } catch (err) {
        log('warmSession failed (best-effort):', err instanceof Error ? err.message : String(err));
        return;
      }
      // Resident but idle — arm the reaper so a warm nobody follows up on is freed.
      this.scheduleIdleReap(live);
    })().finally(() => this.resumeWarming.delete(sid));

    this.resumeWarming.set(sid, p);
    return p;
  }

  /** Sessions with a turn in flight right now.
   *
   *  A reconnecting panel has just cleared every session's running flag (its port
   *  drop can't tell "host died" from "panel reloaded"), while the service worker
   *  deliberately keeps the host alive and the turn keeps streaming. Nothing else in
   *  the protocol says "still running", so the panel would show neither a spinner nor
   *  a Stop button for a genuinely live turn — and would happily push a second
   *  message into the same pump. */
  getRunningSessionIds(): string[] {
    const ids: string[] = [];
    for (const [id, live] of this.liveSessions) {
      if (live.streaming && !live.reaped) ids.push(id);
    }
    return ids;
  }

  /** The models this machine's CLI actually offers. Read once from any resident
   *  Query; null when nothing is live yet (the panel then keeps its fallback list). */
  async getSupportedModels(): Promise<{ id: string; label: string }[] | null> {
    // A brand-new conversation lives in pendingLiveSessions until its session_id
    // resolves on the first frame, so check both — otherwise the very first
    // chat:send (the common case) finds nothing and the picker never updates.
    const live = (this.liveSessions.values().next().value
      ?? this.pendingLiveSessions.values().next().value) as LiveSession | undefined;
    if (!live) return null;
    try {
      const models = await live.query.supportedModels();
      // `value` is what you pass back as `model` (may be an alias like 'sonnet').
      return models.map((m) => ({ id: m.value, label: m.displayName || m.value }));
    } catch (err) {
      log('supportedModels failed:', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  private buildSystemPrompt(url?: string): string {
    const cli = `${process.execPath} ${this.browserCliPath}`;
    const pageInfo = url ? `\nThe user's current browser tab is: ${url}` : '';
    return `You are Claude Code Browser, an AI assistant helping developers inspect and fix web pages.
You have direct access to the user's browser tab via CLI tools. Use the Bash tool to call them:${pageInfo}

BROWSER TOOLS (use via Bash):
- \`${cli} navigate '{"url":"<url>"}'\` — Navigate to a URL
- \`${cli} snapshot\` — Get page DOM structure
- \`${cli} screenshot\` — Take a screenshot
- \`${cli} click '{"selector":"<css>"}'\` — Click an element
- \`${cli} evaluate '{"expression":"<js>"}'\` — Run JavaScript on the page

CRITICAL RULES:
- The browser tools operate on the user's pinned browser tab, not any other tab.
- Use snapshot to see the page structure before making changes.
- Use screenshot to see the visual state.
- When element selectors are provided, use click or evaluate to interact.
- You can read and edit project source files if a project directory is configured.
- Always confirm before making destructive changes to source files.`;
  }

  async sendMessage(params: SendMessageParams): Promise<void> {
    // Ensure the IPC server is listening (this.ipcPort resolved) before any agent
    // process spawns, so CCB_IPC_PORT is injected with the real port, not 0.
    await this.ipcReady;
    // Save attached images to disk and append paths to the user message.
    if (params.images && params.images.length > 0) {
      const imgDir = join(tmpdir(), 'ccb-images');
      await mkdir(imgDir, { recursive: true });
      const paths: string[] = [];
      for (let i = 0; i < params.images.length; i++) {
        const match = params.images[i].match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
          // pid + random keep names unique across concurrent host processes.
          const filePath = join(imgDir, `img-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${i}.${ext}`);
          await writeFile(filePath, Buffer.from(match[2], 'base64'));
          paths.push(filePath);
        }
      }
      if (paths.length > 0) {
        params.message += '\n\nAttached images (use Read tool to view them):\n' + paths.map((p) => `- ${p}`).join('\n');
      }
    }

    // Save generic file attachments to disk and append their paths to the message.
    if (params.files && params.files.length > 0) {
      const fileDir = join(tmpdir(), 'ccb-files');
      await mkdir(fileDir, { recursive: true });
      const paths: string[] = [];
      for (let i = 0; i < params.files.length; i++) {
        const f = params.files[i];
        const match = f.dataUrl.match(/^data:[^;]*;base64,(.+)$/);
        if (!match) continue;
        const safe = (f.name || `file-${i}`).replace(/[^\w.\-]+/g, '_').slice(-100);
        // pid + random keep names unique across concurrent host processes.
        const filePath = join(fileDir, `${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${i}-${safe}`);
        await writeFile(filePath, Buffer.from(match[1], 'base64'));
        paths.push(filePath);
      }
      if (paths.length > 0) {
        params.message += '\n\nAttached files (use Read tool to view them):\n' + paths.map((p) => `- ${p}`).join('\n');
      }
    }

    const userText = this.buildPrompt(params);

    // A pre-warm for this session may still be spawning; wait for it rather than
    // racing it into a second CLI on the same transcript.
    if (params.sessionId) {
      const warming = this.resumeWarming.get(params.sessionId);
      if (warming) await warming;
    }

    // Find or create a LiveSession for this conversation. A brand-new chat has no
    // sessionId yet, so it is matched by clientRequestId instead: two sends inside the
    // spawn+initialize window would otherwise each spawn their own CLI, both reporting
    // session:created for the same clientRequestId — one conversation forked into two
    // resident processes, the second one's answer streaming into a bucket the user
    // can't see.
    let live: LiveSession | null = params.sessionId ? this.liveSessions.get(params.sessionId) ?? null : null;
    if (!live && params.clientRequestId) {
      for (const pending of this.pendingLiveSessions) {
        if (pending.clientRequestId === params.clientRequestId) { live = pending; break; }
      }
    }
    if (!live) {
      live = await this.createLiveSession(params);
    } else {
      // Mark busy + disarm the idle reaper BEFORE the await below, so a 5-min
      // idle timer firing mid-`applyFlagSettings` can't reap this session and
      // drop the message we're about to push.
      live.streaming = true;
      live.lastActivity = Date.now();
      if (live.idleTimer) { clearTimeout(live.idleTimer); live.idleTimer = undefined; }
      // Existing session: the picker's run mode only reaches query() at creation, so
      // a resident session (notably one pre-warmed by session:resume, which carries
      // no run mode) would otherwise run this turn under whatever it was spawned
      // with. Reconcile EVERY axis the picker drives — mode, model, effort, ultracode
      // and unattended — before pushing, so the chip and the turn agree. Reconciling
      // only mode+model left the other three silently stuck at their creation value
      // whenever the user changed them while looking at a different conversation.
      // This is exactly what agent:set_mode does, so it goes through the same method
      // — two copies of the reconcile drifted apart once already (the '' model rung
      // was fixed in one and not the other).
      if (live.sessionId) {
        await this.setRunMode(live.sessionId, params);
      }
      // If the user changed paths in the UI, push the new additionalDirectories
      // into the running Query before this turn fires.
      const nextSources = params.sources ?? [];
      if (!sourcesEqual(live.sources, nextSources)) {
        try {
          await live.query.applyFlagSettings({
            permissions: { additionalDirectories: nextSources },
          });
          log('Updated additionalDirectories for session', live.sessionId, '->', nextSources);
          live.sources = nextSources;
        } catch (err) {
          log('applyFlagSettings failed:', err instanceof Error ? err.message : String(err));
        }
      }
    }

    // A turn is starting: cancel any pending idle reap and mark it busy. It is also
    // no longer a silent pre-warm — from here on errors ARE user-facing.
    live.warm = false;
    // Clear the previous turn's Stop here rather than when its result arrived, so any
    // interrupt fallout the SDK throws afterwards is still recognised as fallout.
    live.interrupted = false;
    live.streaming = true;
    live.lastActivity = Date.now();
    if (live.idleTimer) { clearTimeout(live.idleTimer); live.idleTimer = undefined; }

    const sdkMsg: SDKUserMessage = {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: userText },
    };
    live.pendingTurns += 1;
    live.pump.push(sdkMsg);
  }

  private async createLiveSession(params: SendMessageParams): Promise<LiveSession> {
    // Make room before spawning another resident child process.
    this.enforceSessionCap();
    // The project folder is the session's cwd, which determines its Claude Code
    // session bucket. Resolve to a normalized absolute path so the cwd used here
    // encodes to the same bucket that listSessions({ dir }) reads later. Default to
    // a per-origin folder (never the host's install dir) when nothing is configured.
    const cwd = normalizeDir(
      params.projectDir
      ?? this.projectDir
      ?? params.sources?.[0]
      ?? resolveProjectDir(params.origin)
      ?? process.cwd(),
    );
    // Materialize the folder when it's about to be used as a working dir (only here,
    // never on listing). Idempotent for existing user folders.
    try { mkdirSync(cwd, { recursive: true }); } catch { /* best-effort */ }
    const abortController = new AbortController();
    const pump = new AsyncMessagePump<SDKUserMessage>();

    // canUseTool fires mid-turn, after `live` (below) exists; this holder lets the
    // closure read the (later-resolved) sessionId/clientRequestId. `live` is built
    // after query() here, so we can't close over it lexically (cf. agent-core).
    const liveRef: { current: LiveSession | null } = { current: null };

    // Annotated so the inline callbacks below keep their contextual parameter types
    // (an un-annotated object literal would make them implicitly `any`).
    const queryOptions: Options = {
        // Permission ALLOW-LIST (auto-approve regardless of mode) — deliberately NOT
        // the `tools` option, which is the tool REGISTRY. Restricting the registry to a
        // handful of names silently removed everything else the CLI offers: no Task
        // (subagents), no TodoWrite, no WebSearch/WebFetch, no Skill (this project's own
        // /browse skill could never self-trigger), no Workflow (which made the Ultracode
        // toggle inert), and no AskUserQuestion or EnterPlanMode/ExitPlanMode — so the
        // agent could not ask a question or enter plan mode from the chat the way the
        // CLI and the desktop app do. Omitting `tools` restores the full built-in set.
        //
        // Read/Glob/Grep/TodoWrite are safe to auto-approve (no side effects, and the
        // todo list must never prompt). Edit/Write/Bash are deliberately absent so the
        // gated modes actually gate them: `default` routes them through canUseTool →
        // approval card, `acceptEdits` auto-accepts edits while Bash still prompts, and
        // `bypassPermissions` (the picker default) runs everything regardless.
        allowedTools: ['Read', 'Glob', 'Grep', 'TodoWrite'],
        permissionMode: params.permissionMode ?? 'bypassPermissions',
        // `bypassPermissions` is the default AND a selectable mode (incl. via the
        // live ⇧+Tab switch); the SDK requires this flag to authorize it. It only
        // *permits* bypass — the active behavior is still governed by permissionMode.
        allowDangerouslySkipPermissions: true,
        // Ask for readable reasoning. Thinking happens (and is billed) either way —
        // `display` only controls whether the text comes back. It defaults to
        // 'omitted' on current models, which streamed thinking blocks with EMPTY
        // text: the panel's thinking bubble had nothing to render, so a turn showed
        // only the thinking_tokens counter above and looked like a stall.
        thinking: { type: 'adaptive', display: 'summarized' },
        ...(params.model ? { model: params.model } : {}),
        ...(params.effort ? { effort: params.effort } : {}),
        ...(params.mcpServers && Object.keys(params.mcpServers).length > 0 ? { mcpServers: params.mcpServers } : {}),
        ...(params.maxTurns && params.maxTurns > 0 ? { maxTurns: params.maxTurns } : {}),
        ...(params.maxBudgetUsd && params.maxBudgetUsd > 0 ? { maxBudgetUsd: params.maxBudgetUsd } : {}),
        // Ultracode is a settings-layer flag, not a query() option. Seed it here so a
        // session created with the toggle on starts orchestrating from turn one.
        ...(params.ultracode ? { settings: { ultracode: true } } : {}),
        // AskUserQuestion has no server-side executor — its "result" IS the user's
        // selection, so if nothing answers it the tool_use dangles and the turn hangs
        // forever. It is raised from a PreToolUse hook rather than canUseTool because
        // hooks fire in EVERY permission mode, while canUseTool is shadowed whenever
        // the mode auto-approves (bypassPermissions is this panel's default).
        hooks: {
          PreToolUse: [{
            matcher: 'AskUserQuestion',
            hooks: [async (input, _toolUseId, opts) => {
              if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'AskUserQuestion') return {};
              const live = liveRef.current;
              if (!live) return {};
              const original = (input.tool_input ?? {}) as Record<string, unknown>;
              const decision = await this.raiseQuestion(live, original, opts.signal);
              if (decision.behavior === 'allow') {
                // A PreToolUse updatedInput REPLACES the tool input, so merge: the tool
                // still needs its own `questions` alongside the `answers` we add.
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    permissionDecision: 'allow' as const,
                    updatedInput: { ...original, ...(decision.updatedInput ?? {}) },
                  },
                };
              }
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: 'deny' as const,
                  permissionDecisionReason: decision.message || 'The user dismissed the question without answering.',
                },
              };
            }],
          }],
        },
        // Surface every gated tool call to the extension for approval. Only invoked
        // when the active mode actually gates the tool (never in bypassPermissions).
        // Parks a Promise resolved by respondToPermission (chat:permission), or
        // denies on abort so an interrupted turn never leaks a pending decision.
        //
        // DO NOT REMOVE THIS EVEN THOUGH THE SDK WARNS IT IS "NOT INVOKED".
        // Passing canUseTool is what makes the CLI EXPOSE AskUserQuestion at all —
        // verified by A/B on the init tool list: without it the tool is absent, with
        // it present, in every permission mode. Under bypassPermissions the SDK logs
        // `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` because the callback itself never fires,
        // which reads like an invitation to delete it. Doing so would silently remove
        // the agent's ability to ask the user anything (the question card is raised
        // from the PreToolUse hook above, which needs the tool to exist to match on).
        canUseTool: (toolName, input, opts) =>
          new Promise<PermissionResult>((resolve) => {
            // AskUserQuestion is owned by the PreToolUse hook above (it fires in every
            // mode). Approving here would otherwise raise a SECOND card for the same
            // call — one asking "Allow AskUserQuestion?" instead of showing the question.
            if (toolName === 'AskUserQuestion') { resolve({ behavior: 'allow' }); return; }
            // UNATTENDED: answer on the user's behalf rather than parking the turn,
            // and report what was decided so the run is reviewable afterwards. Read
            // off the live session (not params) so the picker can flip it mid-run.
            const liveNow = liveRef.current;
            if (liveNow?.unattended) {
              const detail = describeToolInput(input) || opts.title || toolName;
              const evt: ServerMessage = {
                type: 'agent:auto_decision',
                sessionId: liveNow.sessionId,
                toolName,
                detail,
                decision: 'allow',
              };
              if (!liveNow.sessionId && liveNow.clientRequestId) this.send({ ...evt, clientRequestId: liveNow.clientRequestId });
              else this.send(evt);
              resolve({ behavior: 'allow' });
              return;
            }
            const requestId = crypto.randomUUID();
            const live = liveRef.current;
            // Park accounting: a card on screen keeps the turn "streaming" forever, so
            // the session cap needs to know this one is waiting on a human, not working.
            let holding = true;
            if (live) live.parked += 1;
            const unpark = () => { if (holding && live) { holding = false; live.parked = Math.max(0, live.parked - 1); } };
            const onAbort = () => {
              if (this.pendingPermissions.delete(requestId)) {
                unpark();
                resolve({ behavior: 'deny', message: 'Interrupted.', interrupt: true });
              }
            };
            const cleanup = () => { unpark(); opts.signal.removeEventListener('abort', onAbort); };
            if (opts.signal.aborted) { unpark(); resolve({ behavior: 'deny', message: 'Interrupted.', interrupt: true }); return; }
            opts.signal.addEventListener('abort', onAbort, { once: true });
            this.pendingPermissions.set(requestId, { resolve, suggestions: opts.suggestions, cleanup });
            const evt: ServerMessage = {
              type: 'agent:permission_request',
              sessionId: live?.sessionId ?? '',
              requestId,
              toolName,
              title: opts.title,
              displayName: opts.displayName,
              description: opts.description,
              // Capped: native messaging silently DROPS any frame over Chrome's 1MB
              // limit, so a Write of a megabyte-long `content` would mean no card ever
              // appears and the turn hangs on a promise nobody can resolve.
              input: capInputForTransport(input),
              blockedPath: opts.blockedPath,
            };
            if (live && !live.sessionId && live.clientRequestId) this.send({ ...evt, clientRequestId: live.clientRequestId });
            else this.send(evt);
          }),
        // We override the spawn ONLY to inject CCB_IPC_PORT — everything else must
        // stay the SDK's business. `options.command` is whatever the SDK resolved:
        // since 0.2.113 that is a self-contained NATIVE binary shipped as a
        // per-platform optional dependency (@anthropic-ai/claude-agent-sdk-<plat>-<arch>),
        // which REPLACED the old bundled cli.js. So spawn it directly — never under
        // `node`, and never by guessing a path ourselves; hardcoding `node cli.js`
        // is what broke on the 0.3.x upgrade.
        spawnClaudeCodeProcess: (options) => {
          const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            // Inject THIS host's IPC port so the agent's Bash-spawned browser-cli
            // (and the MCP server) talk to this process's IPC server — not some
            // other host process's. Critical for per-panel host isolation: each
            // host listens on its own ephemeral port; without this, browser tools
            // would route to whichever host last wrote the shared port file.
            env: { ...options.env, CCB_IPC_PORT: String(this.ipcPort) },
            signal: options.signal,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return child as any;
        },
        systemPrompt: this.buildSystemPrompt(params.url),
        includePartialMessages: true,
        cwd,
        additionalDirectories: params.sources,
        abortController,
        ...(params.sessionId && { resume: params.sessionId }),
    };

    // PRE-WARM eager init: a RESUME warm (the sessionId is already known) spawns via
    // the SDK's startup(), so the CLI finishes its initialize handshake AND loads the
    // resumed transcript during the warm — off the user's critical path — instead of
    // on the first pushed message. startup().query() returns a normal Query, so reap,
    // interrupt, and every other live.query path work unchanged.
    // A warm with no sessionId must NOT use this: session_id is assigned at init, and
    // emitting it during a silent warm would lose the session:created binding.
    const q = (params.warm && params.sessionId)
      ? (await startup({ options: queryOptions })).query(pump)
      : query({ prompt: pump, options: queryOptions });

    const live: LiveSession = {
      sessionId: params.sessionId ?? '',
      clientRequestId: params.clientRequestId,
      pump,
      query: q,
      abort: abortController,
      cwd,
      sources: params.sources ?? [],
      interrupted: false,
      streaming: false,
      lastActivity: Date.now(),
      reaped: false,
      unattended: params.unattended ?? false,
      warm: params.warm ?? false,
      pendingTurns: 0,
      parked: 0,
      modeAuthoritative: params.permissionMode !== undefined,
    };
    liveRef.current = live; // so canUseTool can read the resolved sessionId

    if (params.sessionId) this.liveSessions.set(params.sessionId, live);
    else this.pendingLiveSessions.add(live);

    this.runConsumer(live).catch((err) => log('Consumer error:', err instanceof Error ? err.message : String(err)));
    return live;
  }

  private async runConsumer(live: LiveSession): Promise<void> {
    let currentToolName = '';
    let currentToolInput = '';
    let insideXmlToolBlock = false;

    // Inject clientRequestId on streaming events while sessionId is still empty,
    // so the extension can route pre-resolution events to its pending bucket.
    type StreamingEvent = Extract<ServerMessage,
      { type: 'chat:stream' | 'chat:complete' | 'chat:error' | 'agent:status' | 'agent:tool_use'
        | 'agent:mode_changed' | 'agent:todos' | 'agent:task' | 'agent:phase' | 'agent:capabilities' }>;
    const emit = (evt: StreamingEvent): void => {
      if (!live.sessionId && live.clientRequestId) {
        this.send({ ...evt, clientRequestId: live.clientRequestId });
      } else {
        this.send(evt);
      }
    };

    try {
      for await (const message of live.query) {
        // Resolve canonical sessionId on first frame that carries it.
        if (!live.sessionId && 'session_id' in message && message.session_id) {
          const sid = message.session_id as string;
          live.sessionId = sid;
          this.pendingLiveSessions.delete(live);
          this.liveSessions.set(sid, live);
          // session:created must include clientRequestId so the extension migrates
          // its pending bucket to the real sessionId.
          this.send({ type: 'session:created', sessionId: sid, clientRequestId: live.clientRequestId });
          // Deliberately do NOT renameSession() with the first message: that sets
          // customTitle, which permanently masks Claude Code's auto-generated
          // summary. Leaving customTitle unset lets listSessions().summary surface
          // the generated Haiku title (falling back to the first prompt until it's
          // generated). See session-store.getSessions.
        }

        const sid = live.sessionId;

        switch (message.type) {
          case 'stream_event': {
            const event = message.event as unknown as {
              type: string;
              content_block?: { type: string; name?: string };
              delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
            };

            if (event.type === 'content_block_start') {
              if (event.content_block?.type === 'tool_use' && event.content_block.name) {
                currentToolName = event.content_block.name;
                currentToolInput = '';
                emit({ type: 'agent:tool_use', sessionId: sid, toolName: currentToolName, summary: currentToolName });
              }
            }
            if (event.type === 'content_block_delta') {
              if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
                emit({ type: 'chat:stream', sessionId: sid, delta: event.delta.thinking, messageId: message.uuid, kind: 'thinking' });
              }
              if (event.delta?.type === 'text_delta' && event.delta.text) {
                const text = event.delta.text;
                // Detect opening of XML tool blocks and suppress all content until closed
                if (/<(?:tool_call|tool_result|function_calls|antml:function_calls)[\s>]/i.test(text)) {
                  insideXmlToolBlock = true;
                  break;
                }
                if (insideXmlToolBlock) {
                  if (/<\/(?:tool_call|tool_result|function_calls|antml:function_calls)\s*>/i.test(text)) {
                    insideXmlToolBlock = false;
                  }
                  break;
                }
                if (/<\/?(?:invoke|antml:invoke|antml:parameter)[\s>]/.test(text)) break;
                if (/<parameter\s+name=/.test(text)) break;
                if (/^\s*<\/(?:parameter|invoke|function_calls)>\s*$/.test(text)) break;
                emit({ type: 'chat:stream', sessionId: sid, delta: text, messageId: message.uuid, kind: 'text' });
              }
              if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                currentToolInput += event.delta.partial_json;
              }
            }
            if (event.type === 'content_block_stop' && currentToolName) {
              const detail = formatToolDetail(currentToolName, currentToolInput);
              if (detail) {
                emit({ type: 'agent:tool_use', sessionId: sid, toolName: '_update_', summary: detail });
              }
              // The agent's plan checklist. Read here rather than from the tool_use
              // event, which carries no input — only the streamed argument JSON has it.
              if (currentToolName === 'TodoWrite') {
                const todos = parseTodos(currentToolInput);
                // `null` means "couldn't read it"; `[]` means "the agent cleared the
                // list" — only the former is a reason not to emit.
                if (todos) emit({ type: 'agent:todos', sessionId: sid, todos });
              }
              currentToolName = '';
              currentToolInput = '';
            }
            break;
          }
          case 'tool_use_summary': {
            const summary = (message as { summary: string }).summary;
            emit({ type: 'agent:tool_use', sessionId: sid, toolName: '_update_', summary });
            break;
          }
          case 'result': {
            const r = message as Record<string, unknown>;
            const turnSid = (r.session_id as string) || sid;
            const turnMessageId = (r.uuid as string) || crypto.randomUUID();
            // These three track ONE content block, but the consumer outlives the turn:
            // a Stop mid tool_use means content_block_stop never arrives, so without
            // this the stale name/JSON would fire on the NEXT turn's first block (a
            // bogus tool bubble, or a truncated TodoWrite re-parsed as the checklist),
            // and a latched insideXmlToolBlock would swallow every later text delta.
            currentToolName = '';
            currentToolInput = '';
            insideXmlToolBlock = false;
            if (r.subtype === 'success') {
              emit({
                type: 'chat:complete',
                sessionId: turnSid,
                result: r.result as string,
                messageId: turnMessageId,
                costUsd: r.total_cost_usd as number | undefined,
              });
              emit({ type: 'agent:status', sessionId: turnSid, status: 'idle' });
            } else if (live.interrupted) {
              // User clicked Stop. The SDK reports this as error_during_execution.
              // Deliberately NOT clearing `interrupted` here: stopping mid-tool-call
              // leaves a dangling tool_use, and the SDK's reader throws an
              // `[ede_diagnostic] … stop_reason=tool_use` right after this frame.
              // Clearing now made the catch below treat that as a fresh failure and
              // paint a raw stack trace under the "interrupted" line. The flag is
              // reset when the next turn is pushed (see sendMessage).
              log('Session interrupted by user:', turnSid);
              emit({ type: 'chat:error', sessionId: turnSid, error: 'Interrupted.' });
              emit({ type: 'agent:status', sessionId: turnSid, status: 'idle' });
            } else {
              const errors = Array.isArray(r.errors) ? (r.errors as unknown[]).map(String).filter(Boolean) : [];
              const detail = errors.length > 0
                ? errors.join('\n')
                : `Agent returned ${r.subtype as string}${r.stop_reason ? ` (stop_reason: ${r.stop_reason as string})` : ''}`;
              log('Session result error:', turnSid, JSON.stringify({ subtype: r.subtype, stop_reason: r.stop_reason, errors }));
              emit({ type: 'chat:error', sessionId: turnSid, error: detail });
              emit({ type: 'agent:status', sessionId: turnSid, status: 'error' });
            }
            // One turn finished. The user can send a follow-up while a turn is still
            // streaming (it is queued onto the same pump), so only go idle once every
            // pushed turn has reported back — otherwise the session looks idle for the
            // whole of the queued turn and the reaper or the session cap can free it
            // mid-run, leaving it streaming but unreachable.
            live.pendingTurns = Math.max(0, live.pendingTurns - 1);
            if (live.pendingTurns === 0) {
              live.streaming = false;
              live.lastActivity = Date.now();
              this.scheduleIdleReap(live);
            } else {
              live.lastActivity = Date.now();
              // The queued turn is still going, so tell the panel it is still running:
              // its own chat:complete handler just cleared the flag for this one.
              emit({ type: 'agent:status', sessionId: turnSid, status: 'running' });
            }
            break;
          }
          case 'auth_status': {
            const m = message as { isAuthenticating?: boolean; output?: string[]; error?: string };
            const lines: string[] = [systemHeader('auth_status')];
            if (m.isAuthenticating) lines.push('Authenticating…');
            if (m.error) lines.push(`Error: ${m.error}`);
            if (m.output?.length) lines.push(m.output.join('\n'));
            emit({ type: 'agent:tool_use', sessionId: sid, toolName: '_notice_', summary: lines.join('\n\n') });
            break;
          }
          case 'rate_limit_event': {
            const info = (message as { rate_limit_info?: { status?: string; resetsAt?: number; rateLimitType?: string; utilization?: number } }).rate_limit_info ?? {};
            const lines: string[] = [systemHeader('rate_limit_event')];
            if (info.status) lines.push(`Status: \`${info.status}\``);
            if (info.rateLimitType) lines.push(`Window: \`${info.rateLimitType}\``);
            if (typeof info.utilization === 'number') lines.push(`Utilization: ${Math.round(info.utilization * 100)}%`);
            if (info.resetsAt) lines.push(`Resets: ${new Date(info.resetsAt * 1000).toLocaleString()}`);
            emit({ type: 'agent:tool_use', sessionId: sid, toolName: '_notice_', summary: lines.join('\n\n') });
            break;
          }
          case 'system': {
            const m = message as Record<string, unknown> & { subtype?: string };
            const subtype = m.subtype;
            switch (subtype) {
              case 'api_retry': {
                const attempt = m.attempt ?? '?';
                const max = m.max_retries ?? '?';
                const errStatus = m.error_status ? ` (HTTP ${m.error_status})` : '';
                emit({ type: 'agent:tool_use', sessionId: sid, toolName: '_notice_', summary: `${systemHeader('system', 'api_retry')}\n\nRetrying API call (${attempt}/${max})${errStatus}…` });
                break;
              }
              // Subagent (Task tool) lifecycle → one live card per task_id, rather than
              // the two disconnected chat lines this used to append.
              case 'task_started': {
                const taskId = sstr(m.task_id);
                // `skip_transcript` marks ambient housekeeping the SDK asks clients not
                // to show; rendering a card for it would clutter the chat with work the
                // user never asked for.
                if (!taskId || m.skip_transcript === true) break;
                emit({
                  type: 'agent:task', sessionId: sid, taskId, phase: 'started', status: 'running',
                  description: sstr(m.description) || 'subagent task',
                  ...(sstr(m.subagent_type) ? { subagentType: sstr(m.subagent_type) } : {}),
                });
                break;
              }
              case 'task_progress': {
                const taskId = sstr(m.task_id);
                // Same skip as task_started: without it a hidden task's progress ping
                // creates the very card task_started refused to create — seeded with the
                // placeholder description, since progress frames carry none.
                if (!taskId || m.skip_transcript === true) break;
                emit({
                  type: 'agent:task', sessionId: sid, taskId, phase: 'progress', status: 'running',
                  ...(sstr(m.description) ? { description: sstr(m.description) } : {}),
                  ...(sstr(m.subagent_type) ? { subagentType: sstr(m.subagent_type) } : {}),
                  ...(sstr(m.last_tool_name) ? { lastToolName: sstr(m.last_tool_name) } : {}),
                });
                break;
              }
              // A task can reach its terminal state through task_updated alone (its
              // `patch` carries the status), so this must settle the card too —
              // otherwise a finished subagent spins forever.
              case 'task_updated': {
                const taskId = sstr(m.task_id);
                if (!taskId || m.skip_transcript === true) break;
                const patch = (m.patch && typeof m.patch === 'object' ? m.patch : {}) as Record<string, unknown>;
                const raw = sstr(patch.status);
                const terminal = raw === 'completed' || raw === 'failed' || raw === 'killed';
                // `patch` carries only what CHANGED, so a patch without a status (say
                // just `end_time`) must leave the card's status alone — defaulting it
                // to 'running' would turn a finished task back into a spinner.
                const status = raw === 'completed' ? 'completed' as const
                  : raw === 'failed' ? 'failed' as const
                  : raw === 'killed' ? 'stopped' as const
                  : raw === 'running' || raw === 'pending' || raw === 'paused' ? 'running' as const
                  : undefined;
                emit({
                  type: 'agent:task', sessionId: sid, taskId,
                  phase: terminal ? 'done' : 'progress',
                  ...(status ? { status } : {}),
                  ...(sstr(patch.description) ? { description: sstr(patch.description) } : {}),
                  ...(sstr(patch.error) ? { summary: sstr(patch.error) } : {}),
                });
                break;
              }
              case 'task_notification': {
                if (m.skip_transcript === true) break;
                const taskId = sstr(m.task_id);
                const status = (['completed', 'failed', 'stopped'].includes(sstr(m.status)) ? sstr(m.status) : 'completed') as 'completed' | 'failed' | 'stopped';
                const summary = sstr(m.summary);
                // A notification without a task_id can't update a card — keep the old
                // inline notice for that case so the information isn't simply dropped.
                if (!taskId) {
                  const body = summary ? `**${status}** — ${summary}` : `**${status}**`;
                  emit({ type: 'agent:tool_use', sessionId: sid, toolName: '_notice_', summary: `${systemHeader('system', 'task_notification')}\n\n${body}` });
                  break;
                }
                emit({
                  type: 'agent:task', sessionId: sid, taskId, phase: 'done', status,
                  ...(summary ? { summary } : {}),
                });
                break;
              }
              case 'local_command_output': {
                const content = (m.content as string) || '';
                if (content.trim()) {
                  emit({ type: 'agent:tool_use', sessionId: sid, toolName: '_notice_', summary: `${systemHeader('system', 'local_command_output')}\n\n${content}` });
                }
                break;
              }
              case 'hook_response': {
                const stdout = (m.stdout as string) || '';
                const stderr = (m.stderr as string) || '';
                const out = stdout || stderr;
                if (out.trim()) {
                  const hookName = (m.hook_name as string) || 'hook';
                  emit({ type: 'agent:tool_use', sessionId: sid, toolName: '_notice_', summary: `${systemHeader('system', `hook_response/${hookName}`)}\n\n${out}` });
                }
                break;
              }
              // Agent-initiated mode switch (EnterPlanMode / ExitPlanMode), mirrored
              // to the picker so the chip tracks the live mode rather than the last
              // thing the user clicked. Deliberately NOT emitted for `init`: a session
              // pre-warmed on resume is created without the picker's mode, so its init
              // would report plain bypassPermissions and overwrite the user's choice.
              case 'status': {
                // Only mirror once the picker's mode actually governs this session:
                // a pre-warm spawns on the bypassPermissions fallback, so an early
                // status frame would otherwise overwrite the user's selection with it.
                if (m.permissionMode !== undefined && live.modeAuthoritative) {
                  const mode = toModeSetting(m.permissionMode);
                  if (mode) emit({ type: 'agent:mode_changed', sessionId: sid, permissionMode: mode });
                }
                // Long silences have a reason: compaction and the pre-response wait are
                // both minutes of nothing otherwise, which reads as a dead session.
                // `status: null` is how the SDK says the wait is OVER, so emit on every
                // frame that carries the key — skipping the null would pin the banner up
                // for the rest of the turn.
                if ('status' in m) {
                  const phase = m.status === 'compacting' ? 'compacting' as const
                    : m.status === 'requesting' ? 'requesting' as const
                    : null;
                  emit({ type: 'agent:phase', sessionId: sid, phase });
                }
                break;
              }
              // Compaction finished — clear the indicator and say what happened, since
              // the transcript the user is looking at was just rewritten underneath them.
              case 'compact_boundary': {
                emit({ type: 'agent:phase', sessionId: sid, phase: null });
                const trigger = sstr((m.compact_metadata as Record<string, unknown> | undefined)?.trigger) || sstr(m.trigger);
                emit({
                  type: 'agent:tool_use', sessionId: sid, toolName: '_notice_',
                  summary: `${systemHeader('system', 'compact_boundary')}\n\nContext compacted${trigger ? ` (${trigger})` : ''} — earlier turns are now summarized.`,
                });
                break;
              }
              // What this machine's CLI actually offers. The panel's slash menu is built
              // from a filesystem scan that can only guess; this is the authoritative list.
              case 'init': {
                emit({
                  type: 'agent:capabilities',
                  sessionId: sid,
                  slashCommands: Array.isArray(m.slash_commands) ? (m.slash_commands as string[]) : [],
                  agentTypes: Array.isArray(m.agents) ? (m.agents as string[]) : [],
                  tools: Array.isArray(m.tools) ? (m.tools as string[]) : [],
                });
                break;
              }
              // `thinking_tokens` is a running token COUNTER (estimated_tokens +
              // delta), not thinking content — the actual reasoning arrives as
              // thinking_delta on stream_event. Surfacing it as a notice produced a
              // wall of identical "system/thinking_tokens" cards that said nothing.
              // Dropped silently, and deliberately NOT logged: it fires continuously
              // during every turn and would flood the host log instead of the panel.
              case 'thinking_tokens':
                break;
              // Low-value subtypes — don't render. Log so we notice if their semantics change.
              case 'session_state_changed':
              case 'hook_started':
              case 'hook_progress':
              case 'files_persisted':
              case 'elicitation_complete':
                break;
              default: {
                // Unknown subtype — best-effort surface
                const text = extractHumanReadable(m);
                const header = systemHeader('system', subtype);
                const body = text ? `${header}\n\n${text}` : header;
                emit({ type: 'agent:tool_use', sessionId: sid, toolName: '_notice_', summary: body });
                log('best-effort surfaced unknown system subtype:', subtype ?? '?');
                break;
              }
            }
            break;
          }
          // Redundant or non-user-visible — already conveyed via stream_event / silent.
          case 'assistant':
          case 'user':
          case 'tool_progress':
          case 'prompt_suggestion':
            break;
          default: {
            // Genuinely unknown top-level type — best-effort surface so it never silently drops.
            const m = message as Record<string, unknown>;
            const text = extractHumanReadable(m);
            const header = systemHeader((m.type as string) || 'unknown');
            const body = text ? `${header}\n\n${text}` : header;
            emit({ type: 'agent:tool_use', sessionId: sid, toolName: '_notice_', summary: body });
            log('best-effort surfaced unknown SDK message type:', (m.type as string) || '?');
            break;
          }
        }
      }
    } catch (err: unknown) {
      const sid = live.sessionId;
      if (live.interrupted || live.abort.signal.aborted) {
        live.interrupted = false;
        log('Session interrupted by user (caught from iterator):', sid);
        emit({ type: 'chat:error', sessionId: sid, error: 'Interrupted.' });
        emit({ type: 'agent:status', sessionId: sid, status: 'idle' });
      } else {
        // Full detail (stack included) goes to the log; the chat bubble gets the
        // message only. Dumping a Node stack trace into a 360px panel produced an
        // unreadable wall of `file:///…/sdk.mjs:107:25252` that told the user nothing.
        const detail = err instanceof Error
          ? `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`
          : String(err);
        const userFacing = err instanceof Error ? err.message : String(err);
        if (live.warm) {
          // A pre-warm that died before the user typed anything. Nobody is waiting on
          // it, and the next chat:send just spawns a fresh session — so log it rather
          // than painting an error bubble into a conversation the user only opened.
          log('Pre-warm session failed (best-effort):', sid, detail);
        } else {
          log('Session iterator error:', sid, detail);
          emit({ type: 'chat:error', sessionId: sid, error: userFacing });
          emit({ type: 'agent:status', sessionId: sid, status: 'error' });
        }
      }
    } finally {
      if (live.idleTimer) { clearTimeout(live.idleTimer); live.idleTimer = undefined; }
      // Delete by IDENTITY, not by id. A reaped/capped session's CLI child shuts down
      // asynchronously, and the user can send again in that window — which registers a
      // NEW live session under the same id. Deleting by id here would evict that new
      // entry, leaving it streaming but unreachable: Stop would no-op, setRunMode would
      // no-op, it would never be reaped, and the next send would spawn a second CLI
      // resuming the same transcript. (pendingLiveSessions below is already identity-based.)
      if (live.sessionId && this.liveSessions.get(live.sessionId) === live) {
        this.liveSessions.delete(live.sessionId);
      }
      this.pendingLiveSessions.delete(live);
      try { live.query.close(); } catch { /* ignore */ }
    }
  }

  interruptSession(sessionId: string, clientRequestId?: string): boolean {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      log('Interrupting session:', sessionId);
      live.interrupted = true;
      live.query.interrupt().catch((err) => {
        log('interrupt() failed, falling back to abort:', err instanceof Error ? err.message : String(err));
        try { live.abort.abort(); } catch { /* ignore */ }
      });
      return true;
    }
    // A brand-new chat has no canonical id yet, so it is matched by clientRequestId.
    // Without that match this fell back to the FIRST pending session, which means
    // pressing Stop in one new chat killed a different one.
    for (const pending of this.pendingLiveSessions) {
      if (clientRequestId && pending.clientRequestId !== clientRequestId) continue;
      if (!clientRequestId && this.pendingLiveSessions.size > 1) {
        log('Refusing to interrupt: several pending sessions and no clientRequestId to pick one');
        break;
      }
      log('Interrupting pending session (no canonical id yet)');
      pending.interrupted = true;
      pending.query.interrupt().catch(() => {
        try { pending.abort.abort(); } catch { /* ignore */ }
      });
      return true;
    }
    log('No active session to interrupt for:', sessionId);
    return false;
  }

  // ── Idle reaping (memory) ───────────────────────────────────────────────────

  private scheduleIdleReap(live: LiveSession): void {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    const sid = live.sessionId;
    if (!sid) return;
    live.idleTimer = setTimeout(() => this.reapIdleSession(sid), IDLE_REAP_MS);
  }

  /** Close an idle session's Query (→ child process freed via runConsumer's
   *  finally), keeping the on-disk session resumable. Map-delete first so a
   *  racing sendMessage re-creates it with resume. */
  /** Free a session. `force` skips the streaming guard — required for the cap's
   *  last-resort eviction of a session parked on an abandoned approval, which is
   *  "streaming" by definition and would otherwise never be removed. */
  private reapIdleSession(sessionId: string, force = false): void {
    const live = this.liveSessions.get(sessionId);
    if (!live || live.reaped || (live.streaming && !force)) return;
    log('Reaping idle session:', sessionId);
    live.reaped = true;
    if (live.idleTimer) { clearTimeout(live.idleTimer); live.idleTimer = undefined; }
    this.liveSessions.delete(sessionId);
    live.pump.end();
  }

  reapIdleSessions(maxIdleMs: number): number {
    const now = Date.now();
    let n = 0;
    for (const live of [...this.liveSessions.values()]) {
      if (!live.streaming && !live.reaped && now - live.lastActivity >= maxIdleMs) {
        this.reapIdleSession(live.sessionId);
        n++;
      }
    }
    return n;
  }

  reapAllIdle(): number {
    let n = 0;
    for (const live of [...this.liveSessions.values()]) {
      if (!live.streaming && !live.reaped) { this.reapIdleSession(live.sessionId); n++; }
    }
    return n;
  }

  reclaim(level: 'moderate' | 'critical'): void {
    const n = level === 'critical' ? this.reapAllIdle() : this.reapIdleSessions(MODERATE_IDLE_MS);
    if (n > 0) log(`Memory reclaim (${level}): reaped ${n} idle session(s)`);
  }

  private enforceSessionCap(): void {
    // Counts BOTH maps: a brand-new chat lives in pendingLiveSessions until its first
    // frame resolves a session_id, so counting only liveSessions let N simultaneous
    // new chats each spawn a CLI unchecked and leave the map permanently over cap.
    while (this.liveSessions.size + this.pendingLiveSessions.size >= MAX_LIVE_SESSIONS) {
      let lru: LiveSession | null = null;
      for (const s of this.liveSessions.values()) {
        if (s.streaming || s.reaped) continue;
        if (!lru || s.lastActivity < lru.lastActivity) lru = s;
      }
      // Every resident session is "streaming" — but a session parked on an approval
      // card counts as streaming forever (its `result` can't arrive until the user
      // answers, and the idle timer is only re-armed there). Without this fallback a
      // few abandoned cards make the cap unenforceable and CLI children accumulate
      // without bound. Evict the stalest parked one: it was going nowhere anyway, and
      // the next send re-spawns it with `resume`.
      if (!lru) {
        for (const s of this.liveSessions.values()) {
          if (s.reaped || s.parked === 0) continue;
          if (!lru || s.lastActivity < lru.lastActivity) lru = s;
        }
        if (lru) {
          // FORCE: a parked session is `streaming` by definition (its turn can't finish
          // until the user answers), so a normal reap would refuse and this loop would
          // re-pick the same session forever — a 100% CPU spin that stops the host from
          // reading stdin at all, killing every panel bound to it.
          log('Session cap reached with no idle session; evicting one parked on an approval:', lru.sessionId);
          this.reapIdleSession(lru.sessionId, true);
          continue;
        }
      }
      if (!lru) break;
      this.reapIdleSession(lru.sessionId);
    }
  }

  private buildPrompt(params: SendMessageParams): string {
    // User text leads so the SDK's auto-generated session summary picks up the human-readable line,
    // not the anchor metadata block (which is identical across sessions).
    const parts: string[] = [params.message];
    if (params.anchors && params.anchors.length > 0) {
      parts.push('', 'Selected elements:');
      for (let i = 0; i < params.anchors.length; i++) {
        const a = params.anchors[i];
        const rect = a.boundingRect;
        parts.push(`\nElement ${i + 1}:`);
        parts.push(`  DOM Path: ${a.domPath}`);
        if (rect) parts.push(`  Position: top=${Math.round(rect.y)}px, left=${Math.round(rect.x)}px, width=${Math.round(rect.width)}px, height=${Math.round(rect.height)}px`);
        parts.push(`  XPath: ${a.xpath}`, `  CSS: ${a.selector}`, `  HTML: ${a.htmlSnippet}`);
        if (a.textPreview) parts.push(`  Text: "${a.textPreview}"`);
      }
    }
    return parts.join('\n');
  }
}
