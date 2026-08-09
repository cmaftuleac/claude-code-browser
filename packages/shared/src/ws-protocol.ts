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

// ── Agent plan checklist ────────────────────────────────────────────────────

/** One entry of the agent's TodoWrite list. `activeForm` is the present-tense
 *  label the CLI shows while the item is in progress ("Building the parser"). */
export interface TodoItem {
  content: string;
  status: string;
  activeForm?: string;
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
      /** Per-conversation run-mode override, from the side panel's picker. Applied
       *  at session creation; for a live session see agent:set_mode. */
      permissionMode?: PermissionModeSetting;
      effort?: EffortSetting;
      model?: string;
      /** Ultracode: xhigh effort + standing dynamic-workflow orchestration for the
       *  session. Rides the SDK's flag-settings layer, so it can also be flipped
       *  mid-session (agent:set_mode). Needs an xhigh-capable model and workflows
       *  enabled for the account — the CLI ignores it otherwise. */
      ultracode?: boolean;
      /** Unattended: auto-answer the agent's permission requests instead of showing
       *  an approval card, so an overnight run never stalls. Each auto-approval is
       *  reported back as agent:auto_decision. Only bites in modes that actually gate
       *  (default / acceptEdits / plan / auto) — bypassPermissions never asks anyway. */
      unattended?: boolean;
    }
  /** List sessions for the current website. The host scopes to the project folder
   *  resolved from origin (host:port) + the configured projectDir — Claude Code's
   *  on-disk sessions are the single source of truth, no extension-side registry. */
  | { type: 'session:list'; origin?: string; projectDir?: string }
  /** Load a session's transcript. `origin`/`projectDir` are optional but let the
   *  host resolve the project folder and PRE-WARM the session (spawn + init +
   *  history load off the critical path) so the first message doesn't pay for it. */
  | { type: 'session:resume'; sessionId: string; origin?: string; projectDir?: string; url?: string }
  /** Stop the running turn. `clientRequestId` identifies a brand-new chat whose
   *  session_id hasn't resolved yet — without it the host can only guess which
   *  pending conversation to stop, and would stop the wrong one. */
  | { type: 'agent:interrupt'; sessionId: string; clientRequestId?: string }
  /** Live mid-session run-mode switch — all of these take effect on the running
   *  Query. permissionMode and model use dedicated setters; effort and ultracode go
   *  through the flag-settings layer (applyFlagSettings) and are applied together in
   *  one call, since the panel drives both from a single effort slider. */
  | {
      type: 'agent:set_mode';
      sessionId: string;
      /** Identifies a brand-new chat whose session_id hasn't resolved yet, so a mode
       *  flipped during its first turn still reaches the running Query. */
      clientRequestId?: string;
      permissionMode?: PermissionModeSetting;
      effort?: EffortSetting;
      model?: string;
      ultracode?: boolean;
      unattended?: boolean;
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
  /** List the slash commands / skills available for this website's project folder.
   *  `origin`/`projectDir` resolve that folder — without them only the user-global
   *  ~/.claude ones can be found. */
  | { type: 'commands:list'; origin?: string; projectDir?: string }
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
  /** A permission request that unattended mode answered on the user's behalf. The
   *  panel records these so the run can be reviewed after the fact instead of the
   *  approval simply never having been asked. */
  | {
      type: 'agent:auto_decision';
      sessionId: string;
      clientRequestId?: string;
      toolName: string;
      /** Human-readable one-liner: the command, path, or title that was approved. */
      detail: string;
      decision: 'allow';
    }
  /** The models this machine's Claude Code CLI actually offers, read from the
   *  running Query (`supportedModels()`). Sent once per host process, after the
   *  first session initializes. The picker falls back to MODEL_OPTIONS until then. */
  | { type: 'agent:models'; models: { id: string; label: string }[] }
  /** The session's permission mode changed on the HOST side rather than in the
   *  picker — the agent called EnterPlanMode/ExitPlanMode, or the SDK reconciled
   *  the mode at init. The panel mirrors it into the picker (without echoing an
   *  agent:set_mode back), so the chip never lies about the live mode. */
  | {
      type: 'agent:mode_changed';
      sessionId: string;
      clientRequestId?: string;
      permissionMode: PermissionModeSetting;
    }
  /** The agent's plan checklist (TodoWrite). Replaces the previous list wholesale —
   *  the tool always writes the full list, never a delta. */
  | { type: 'agent:todos'; sessionId: string; clientRequestId?: string; todos: TodoItem[] }
  /** Subagent (Task tool) lifecycle. One card per taskId, updated in place: started →
   *  progress* → done. */
  | {
      type: 'agent:task';
      sessionId: string;
      clientRequestId?: string;
      taskId: string;
      phase: 'started' | 'progress' | 'done';
      /** Omitted when the update didn't change it — the client keeps what it has.
       *  The SDK's task patches carry only changed fields. */
      status?: 'running' | 'completed' | 'failed' | 'stopped';
      description?: string;
      subagentType?: string;
      lastToolName?: string;
      summary?: string;
    }
  /** What the session is doing when it isn't streaming tokens — compaction and the
   *  pre-response wait are both long silences that otherwise look like a hang.
   *  `null` clears the indicator. */
  | { type: 'agent:phase'; sessionId: string; clientRequestId?: string; phase: 'compacting' | 'requesting' | null }
  /** What this machine's CLI actually offers, straight from the session's init frame.
   *  Authoritative, unlike the host's filesystem scan for slash commands. */
  | {
      type: 'agent:capabilities';
      sessionId: string;
      clientRequestId?: string;
      slashCommands: string[];
      agentTypes: string[];
      tools: string[];
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

