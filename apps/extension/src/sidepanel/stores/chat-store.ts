import { create } from 'zustand';
import type { ElementAnchor, SessionInfo, ClientMessage, PermissionModeSetting, EffortSetting, TodoItem } from '@claude-code-browser/shared';

export function bumpStat(field: 'messageCount' | 'sessionCount') {
  chrome.storage.local.get('ccb-stats', (res) => {
    const prev = (res['ccb-stats'] as { installedAt: number; messageCount: number; sessionCount: number } | undefined)
      ?? { installedAt: Date.now(), messageCount: 0, sessionCount: 0 };
    chrome.storage.local.set({ 'ccb-stats': { ...prev, [field]: prev[field] + 1 } });
  });
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  anchors?: ElementAnchor[];
  images?: string[];
  isStreaming?: boolean;
  kind?: 'text' | 'thinking' | 'tool_use' | 'permission' | 'question' | 'task';
  /** Set when kind==='permission' — a gated tool awaiting the user's approval, or
   *  (kind==='question') an AskUserQuestion awaiting the user's selections. Both ride
   *  the same request/response channel, so they share this field. */
  permission?: {
    requestId: string;
    toolName: string;
    title?: string;
    displayName?: string;
    description?: string;
    input: Record<string, unknown>;
    blockedPath?: string;
    decided?: 'allow' | 'deny' | 'expired' | 'auto';
    /** kind==='question' only: the labels the user picked, per question, so a decided
     *  card can still show them. Kept as arrays rather than re-splitting the joined
     *  wire string — an option label may itself contain ", ". */
    answers?: Record<string, string[]>;
  };
  /** kind==='tool_use' only: this bubble is a system notice (API retry, hook output,
   *  compaction), not the tool call in flight — so a later `_update_` must skip it. */
  isNotice?: boolean;
  /** Set when kind==='task' — a subagent card, updated in place as the task runs. */
  task?: {
    taskId: string;
    status: 'running' | 'completed' | 'failed' | 'stopped';
    description: string;
    subagentType?: string;
    lastToolName?: string;
    summary?: string;
  };
}

/** One question of an AskUserQuestion call, as the SDK shapes it. */
export interface AgentQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

/** Read the questions out of an AskUserQuestion tool input, dropping anything
 *  malformed so a bad payload renders as "nothing to ask" rather than crashing. */
export function parseQuestions(input: Record<string, unknown>): AgentQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const out: AgentQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const { question, header, multiSelect, options } = q as Record<string, unknown>;
    if (typeof question !== 'string' || !Array.isArray(options)) continue;
    const opts = options
      .map((o) => (typeof o === 'string'
        ? { label: o }
        : { label: String((o as { label?: unknown })?.label ?? ''), description: (o as { description?: string })?.description }))
      .filter((o) => o.label);
    if (opts.length === 0) continue;
    out.push({
      question,
      ...(typeof header === 'string' ? { header } : {}),
      ...(multiSelect === true ? { multiSelect: true } : {}),
      options: opts,
    });
  }
  return out;
}

/** Run mode for ONE conversation. Every conversation carries its own: the picker
 *  edits the active one and nothing else, so putting a chat in Plan mode (or letting
 *  an approval card drop it to Bypass) can never leak into a different chat. New
 *  chats start from `defaultRunMode`, which is what the picker edits when no
 *  conversation is open yet.
 *
 *  Sent on chat:send and switched live via agent:set_mode. */
export interface RunMode {
  permissionMode: PermissionModeSetting;
  effort: EffortSetting;
  model: string;
  /** Ultracode: xhigh effort + standing dynamic-workflow orchestration. Needs an
   *  xhigh-capable model and workflows enabled on the account. */
  ultracode: boolean;
  /** Unattended: auto-approve gated tool calls so a long run never stalls on an
   *  approval card. Each decision is still recorded in the transcript. */
  unattended: boolean;
}

export interface SessionState {
  messages: ChatMessage[];
  isRunning: boolean;
  /** True once we have authoritative full history for this session — either
   *  because we observed it from session:created (live), or because session:messages
   *  has been processed (disk). False when the bucket only contains live deltas
   *  caught after the extension reconnected mid-stream, in which case we still
   *  need to fetch disk to fill in earlier turns. */
  historyLoaded: boolean;
  /** The agent's current plan checklist (TodoWrite). Replaced wholesale on each
   *  update — the tool always writes the full list. */
  todos: TodoItem[];
  /** What the session is doing while not streaming: compaction and the pre-response
   *  wait are both long silences that otherwise read as a hang. */
  phase: 'compacting' | 'requesting' | null;
}

/** What the UI is currently looking at:
 *  - `session`: a real, host-known session (resumed from disk or migrated from pending)
 *  - `pending`: a brand-new chat the user has started but for which session:created
 *               has not yet arrived. Bucket is keyed by clientRequestId.
 *  - `empty`: no view selected (e.g., fresh "+ New Chat" before the user has typed,
 *             or initial app state). The input still lets the user type/submit. */
export type ActiveView =
  | { kind: 'session'; sessionId: string }
  | { kind: 'pending'; clientRequestId: string }
  | { kind: 'empty' };

/** Stable empty array for selectors so Zustand's referential-equality short-circuit
 *  keeps working when the active bucket is missing. */
export const EMPTY_MESSAGES: ChatMessage[] = [];

const emptyState = (): SessionState => ({ messages: [], isRunning: false, historyLoaded: false, todos: [], phase: null });

/** Stable empty array so the todo selector keeps its referential-equality short-circuit. */
export const EMPTY_TODOS: TodoItem[] = [];

interface ChatState {
  sessions: SessionInfo[];
  sessionStates: Record<string, SessionState>;
  pendingNewChats: Record<string, SessionState>;
  activeView: ActiveView;
  /** Pending anchors live globally because they describe the current draft message,
   *  not the session — switching sessions mid-pick would be surprising. */
  pendingAnchors: ElementAnchor[];
  /** Run mode per conversation, keyed the same way buckets are (sessionId, or
   *  clientRequestId while a new chat's id is unresolved). A conversation with no
   *  entry runs on `defaultRunMode`. */
  runModes: Record<string, RunMode>;
  /** What a NEW conversation starts with, and what the picker edits when nothing is
   *  open. Persisted; default bypassPermissions preserves the prior always-run
   *  behavior. */
  defaultRunMode: RunMode;
  /** The native-port sender, registered by useNativePort so store actions
   *  (respondPermission / live setRunMode) can talk to the host. */
  _send?: (msg: ClientMessage) => boolean;
  /** Models this machine's CLI reports (agent:models). Empty until the host has a
   *  live session to ask; the picker falls back to MODEL_OPTIONS meanwhile. */
  models: { id: string; label: string }[];

  setSessions: (sessions: SessionInfo[]) => void;
  setModels: (models: { id: string; label: string }[]) => void;
  setSend: (fn: (msg: ClientMessage) => boolean) => void;
  /** Update the ACTIVE conversation's run mode — and only that one. Everything here
   *  switches its live session immediately via agent:set_mode (effort included — it
   *  rides the flag-settings layer). With no conversation open, this edits the
   *  default that new chats inherit. */
  setRunMode: (patch: Partial<RunMode>) => void;
  /** Give a conversation its own copy of a run mode (used when a brand-new chat is
   *  created, so it keeps the default it started from rather than tracking later
   *  changes to that default). No-op if it already has one. */
  adoptRunMode: (sessionKey: string, runMode: RunMode) => void;
  /** Mirror a permission mode the HOST switched to for ONE session (agent:mode_changed
   *  — e.g. the agent called EnterPlanMode). Pure state: unlike setRunMode it must not
   *  send agent:set_mode back, which would bounce the host's own change at it. */
  syncPermissionMode: (sessionKey: string, permissionMode: PermissionModeSetting) => void;
  /** Append a pending tool-permission request to a bucket (agent:permission_request).
   *  An AskUserQuestion request lands as a `question` card instead of an approval one. */
  addPermissionRequest: (sessionKey: string, perm: NonNullable<ChatMessage['permission']>) => void;
  /** Reply to a permission request (the approval card) and mark it decided. */
  /** Returns whether the decision actually reached the host — callers that also act
   *  on it locally (e.g. "Allow and continue" switching the run mode) must not do so
   *  when the reply was lost. */
  respondPermission: (requestId: string, decision: { behavior: 'allow' | 'deny'; persist?: boolean }) => boolean;
  /** Answer an AskUserQuestion card: `answers` is a record of question text → chosen
   *  label (multi-select joined by ", "), which is the shape the tool's schema wants. */
  answerQuestion: (requestId: string, picked: Record<string, string[]>) => void;
  /** Replace a bucket's plan checklist (agent:todos). */
  setTodos: (sessionKey: string, todos: TodoItem[]) => void;
  /** Set what the session is doing between token streams (agent:phase). */
  setPhase: (sessionKey: string, phase: 'compacting' | 'requesting' | null) => void;
  /** Create or update a subagent card in place, keyed by taskId (agent:task). Fields
   *  the event didn't carry are left as they were — task updates are partial. */
  upsertTask: (sessionKey: string, task: Partial<NonNullable<ChatMessage['task']>> & { taskId: string }) => void;
  /** Mark any still-undecided permission cards in a bucket as expired (turn ended). */
  expirePermissions: (sessionKey: string) => void;
  /** Record a permission that unattended mode auto-approved (agent:auto_decision). */
  addAutoDecision: (sessionKey: string, d: { toolName: string; detail: string }) => void;

  /** Start a fresh pending chat. Returns the minted clientRequestId so the caller
   *  can attach it to the chat:send payload. */
  newChat: () => string;

  /** Switch the view to an existing session id. Creates an empty bucket if missing.
   *  Returns true when the caller should fire session:resume (bucket was new/empty). */
  selectSession: (id: string) => boolean;

  /** Switch the view to an in-progress pending chat (session_id not yet resolved).
   *  Lets the user navigate back to a new chat they started before its answer/
   *  session:created arrived — purely local, no resume needed. */
  selectPending: (clientRequestId: string) => void;

  /** Move a pending bucket onto its real sessionId, updating the active view if
   *  it was pointing at this pending. Called when session:created arrives. */
  migratePendingToSession: (clientRequestId: string, sessionId: string) => void;

  addUserMessage: (content: string, anchors?: ElementAnchor[], images?: string[]) => void;
  startAssistantMessage: (sessionKey: string, messageId: string, kind?: 'text' | 'thinking' | 'tool_use') => void;
  appendDelta: (sessionKey: string, messageId: string, delta: string) => void;
  completeMessage: (sessionKey: string, messageId: string, content: string) => void;
  addToolUseMessage: (sessionKey: string, summary: string, isNotice?: boolean) => void;
  updateLastToolUse: (sessionKey: string, summary: string) => void;
  addSystemMessage: (sessionKey: string, message: ChatMessage) => void;
  setSessionRunning: (sessionKey: string, running: boolean) => void;
  /** Set isStreaming on a single message without touching siblings. Used by the
   *  kind-transition path in chat:stream to seal off the prior partial block
   *  (or re-open a previously sealed one) without collapsing the whole turn. */
  setMessageStreaming: (sessionKey: string, messageId: string, isStreaming: boolean) => void;
  /** Load disk-persisted history into a session bucket. If the bucket already
   *  has authoritative history (historyLoaded=true), this is a no-op. Otherwise
   *  the disk messages replace the bucket's history prefix while any in-progress
   *  streaming messages currently in the bucket are preserved as a tail. */
  loadSessionHistory: (sessionId: string, messages: ChatMessage[]) => void;
  markAllSessionsIdle: () => void;

  addAnchor: (anchor: ElementAnchor) => void;
  removeAnchor: (index: number) => void;
  clearAnchors: () => void;
}

function uuid(): string {
  return crypto.randomUUID();
}

/** Bucket key for a view, or null when nothing is open. Conversations are keyed by
 *  sessionId once resolved, by clientRequestId before that. */
function activeViewKey(view: ActiveView): string | null {
  if (view.kind === 'session') return view.sessionId;
  if (view.kind === 'pending') return view.clientRequestId;
  return null;
}

const RUN_MODE_KEY = 'ccb-run-mode';
const SESSION_MODES_KEY = 'ccb-session-run-modes';
/** Per-session modes kept on disk. Bounded so a heavy user's history can't grow this
 *  without limit; the oldest entries fall back to the default, which is harmless. */
const SESSION_MODES_CAP = 100;

const PERMISSION_MODES: readonly (string | undefined)[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'];
const EFFORTS: readonly (string | undefined)[] = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Validate a persisted run mode field by field against `fallback`. Anything unknown
 *  (an older build's value, a hand-edited entry) is replaced rather than trusted. */
function coerceRunMode(saved: unknown, fallback: RunMode): RunMode {
  if (!saved || typeof saved !== 'object') return fallback;
  const s = saved as Partial<RunMode>;
  return {
    permissionMode: PERMISSION_MODES.includes(s.permissionMode) ? s.permissionMode as PermissionModeSetting : fallback.permissionMode,
    effort: EFFORTS.includes(s.effort) ? s.effort as EffortSetting : fallback.effort,
    model: typeof s.model === 'string' ? s.model : fallback.model,
    ultracode: typeof s.ultracode === 'boolean' ? s.ultracode : fallback.ultracode,
    unattended: typeof s.unattended === 'boolean' ? s.unattended : fallback.unattended,
  };
}

/** The default new chats inherit, persisted across side-panel reloads.
 *
 *  Without this a user who deliberately chose "Ask before edits" silently got
 *  `bypassPermissions` back on the next panel load — a safety setting quietly
 *  reverting to the least safe value. Written fire-and-forget; a failed write only
 *  costs the preference, never the turn. */
function persistRunMode(runMode: RunMode): void {
  defaultRunModeTouched = true;
  try { chrome.storage.local.set({ [RUN_MODE_KEY]: runMode }); } catch { /* storage unavailable */ }
}

/** True once the user has picked a default this session. `hydrateRunMode` reads
 *  storage asynchronously, and a choice made inside that window must not be undone by
 *  the (by then stale) stored value landing on top of it. */
let defaultRunModeTouched = false;

/** Persist the per-session modes, MERGED over what is already stored.
 *
 *  Deliberately not filtered against the session list: that list is scoped to the
 *  current website, so filtering by it and writing the result wholesale deleted every
 *  other site's saved modes on the next save — the same "safety setting silently
 *  reverts to bypassPermissions" regression this persistence exists to prevent.
 *  Read-modify-write instead, trimmed to a cap so it can't grow without bound. */
function persistSessionRunModes(runModes: Record<string, RunMode>): void {
  try {
    chrome.storage.local.get(SESSION_MODES_KEY, (res) => {
      const stored = (res?.[SESSION_MODES_KEY] ?? {}) as Record<string, RunMode>;
      const merged = { ...stored, ...runModes };
      const entries = Object.entries(merged).slice(-SESSION_MODES_CAP);
      try { chrome.storage.local.set({ [SESSION_MODES_KEY]: Object.fromEntries(entries) }); } catch { /* storage unavailable */ }
    });
  } catch { /* storage unavailable */ }
}

/** Load the persisted run modes into the store. Called once at panel startup; unknown
 *  or malformed values fall back to the shipped defaults field by field. */
export function hydrateRunMode(): void {
  try {
    chrome.storage.local.get([RUN_MODE_KEY, SESSION_MODES_KEY], (res) => {
      const cur = useChatStore.getState().defaultRunMode;
      const defaultRunMode = coerceRunMode(res?.[RUN_MODE_KEY], cur);
      const savedSessions = res?.[SESSION_MODES_KEY] as Record<string, unknown> | undefined;
      const runModes: Record<string, RunMode> = {};
      if (savedSessions && typeof savedSessions === 'object') {
        for (const [id, mode] of Object.entries(savedSessions)) runModes[id] = coerceRunMode(mode, defaultRunMode);
      }
      // Merge under anything already set this session — a mode chosen before storage
      // answered must win over the stale value it is racing.
      useChatStore.setState((state) => ({
        // Anything chosen while the storage read was in flight wins over what it
        // returns — for the default as much as for the per-session entries.
        ...(defaultRunModeTouched ? {} : { defaultRunMode }),
        runModes: { ...runModes, ...state.runModes },
      }));
    });
  } catch { /* storage unavailable */ }
}

/** Returns a mutated copy of `state` after applying `fn` to the bucket at `key`.
 *  Auto-creates the bucket in sessionStates when missing. Falls back to
 *  pendingNewChats only when the key already exists there. */
function withBucket(
  state: ChatState,
  key: string,
  fn: (s: SessionState) => SessionState,
): Pick<ChatState, 'sessionStates' | 'pendingNewChats'> {
  if (state.pendingNewChats[key]) {
    return {
      sessionStates: state.sessionStates,
      pendingNewChats: { ...state.pendingNewChats, [key]: fn(state.pendingNewChats[key]) },
    };
  }
  const prev = state.sessionStates[key] ?? emptyState();
  return {
    sessionStates: { ...state.sessionStates, [key]: fn(prev) },
    pendingNewChats: state.pendingNewChats,
  };
}

function activeKey(view: ActiveView): string | null {
  if (view.kind === 'session') return view.sessionId;
  if (view.kind === 'pending') return view.clientRequestId;
  return null;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  sessionStates: {},
  pendingNewChats: {},
  activeView: { kind: 'empty' },
  pendingAnchors: [],
  runModes: {},
  defaultRunMode: { permissionMode: 'bypassPermissions', effort: '', model: '', ultracode: false, unattended: false },
  models: [],

  setSessions: (sessions) => set({ sessions }),

  setModels: (models) => set({ models }),

  setSend: (fn) => set({ _send: fn }),

  setRunMode: (patch) => {
    const state = get();
    const { activeView, _send } = state;
    const key = activeViewKey(activeView);
    const next = { ...selectActiveRunMode(state), ...patch };

    if (!key) {
      // Nothing open: the picker is choosing what the NEXT chat starts with.
      set({ defaultRunMode: next });
      persistRunMode(next);
    } else {
      // A conversation is open, so this edits that conversation ALONE. The default
      // is deliberately left untouched — changing one chat's mode must not silently
      // re-aim every future chat.
      const runModes = { ...state.runModes, [key]: next };
      set({ runModes });
      persistSessionRunModes({ [key]: next });
    }
    // Switch a live (session-resolved) conversation immediately — every field here
    // takes effect on the running Query. effort is included: it has no dedicated SDK
    // setter but IS live via the flag-settings layer, and since one slider now drives
    // effort together with ultracode, omitting it would make half of each drag a
    // silent no-op on the current session.
    if (
      key && _send &&
      (patch.permissionMode !== undefined || patch.model !== undefined ||
       patch.effort !== undefined || patch.ultracode !== undefined ||
       patch.unattended !== undefined)
    ) {
      _send({
        type: 'agent:set_mode',
        // A pending chat has no session id yet; the host matches it by
        // clientRequestId so a mode flipped mid-first-turn still lands.
        sessionId: activeView.kind === 'session' ? activeView.sessionId : '',
        ...(activeView.kind === 'pending' ? { clientRequestId: activeView.clientRequestId } : {}),
        ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
        ...(patch.ultracode !== undefined ? { ultracode: patch.ultracode } : {}),
        ...(patch.unattended !== undefined ? { unattended: patch.unattended } : {}),
      });
    }
  },

  adoptRunMode: (sessionKey, runMode) =>
    set((state) => (state.runModes[sessionKey]
      ? state
      : { runModes: { ...state.runModes, [sessionKey]: runMode } })),

  syncPermissionMode: (sessionKey, permissionMode) =>
    set((state) => {
      // Scoped to the session the host reported, so a background conversation
      // entering plan mode records it against itself rather than moving the picker.
      const cur = state.runModes[sessionKey] ?? state.defaultRunMode;
      if (cur.permissionMode === permissionMode) return state;
      const runModes = { ...state.runModes, [sessionKey]: { ...cur, permissionMode } };
      // Persisted like a user edit: the agent putting a chat into plan mode is part of
      // that chat's state, and should survive a panel reload the same way.
      persistSessionRunModes({ [sessionKey]: runModes[sessionKey] });
      return { runModes };
    }),

  addPermissionRequest: (sessionKey, perm) =>
    set((state) => withBucket(state, sessionKey, (s) => ({
      ...s,
      messages: [
        ...s.messages,
        {
          id: `perm-${perm.requestId}`,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          // AskUserQuestion is not an approval — it's the agent asking the user to
          // choose, and it renders as a question card with the options.
          kind: perm.toolName === 'AskUserQuestion' ? 'question' : 'permission',
          permission: perm,
        },
      ],
    }))),

  respondPermission: (requestId, decision) => {
    // Only record the decision if it actually reached the host. A dead port swallows
    // the reply silently, and marking the card decided anyway would grey out its
    // buttons over a still-parked promise — an unanswerable card and a dead turn.
    if (!get()._send?.({ type: 'chat:permission', requestId, behavior: decision.behavior, persist: decision.persist })) return false;
    // Mark the matching card decided across every bucket (requestId is unique).
    const mark = (states: Record<string, SessionState>): Record<string, SessionState> => {
      const out: Record<string, SessionState> = {};
      for (const [k, v] of Object.entries(states)) {
        out[k] = {
          ...v,
          // Question cards route their Skip/Dismiss through here too, so both kinds
          // must be matched — otherwise a skipped question stays clickable forever.
          messages: v.messages.map((m) =>
            (m.kind === 'permission' || m.kind === 'question') && m.permission?.requestId === requestId && !m.permission.decided
              ? { ...m, permission: { ...m.permission, decided: decision.behavior } }
              : m),
        };
      }
      return out;
    };
    set((state) => ({ sessionStates: mark(state.sessionStates), pendingNewChats: mark(state.pendingNewChats) }));
    return true;
  },

  answerQuestion: (requestId, picked) => {
    // The tool's schema wants `answers` as a record of question text → ONE string,
    // with multi-select answers comma-separated. The host merges it into the original
    // input (a replaced input would lose `questions`). The per-question arrays are
    // kept on the card instead of re-splitting this string, whose separator is
    // ambiguous the moment an option label itself contains ", ".
    const answers: Record<string, string> = {};
    for (const [question, labels] of Object.entries(picked)) answers[question] = labels.join(', ');
    // As in respondPermission: don't mark it answered unless the answer went out.
    if (!get()._send?.({ type: 'chat:permission', requestId, behavior: 'allow', updatedInput: { answers } })) return;
    const mark = (states: Record<string, SessionState>): Record<string, SessionState> => {
      const out: Record<string, SessionState> = {};
      for (const [k, v] of Object.entries(states)) {
        out[k] = {
          ...v,
          messages: v.messages.map((m) =>
            m.kind === 'question' && m.permission?.requestId === requestId && !m.permission.decided
              ? { ...m, permission: { ...m.permission, decided: 'allow' as const, answers: picked } }
              : m),
        };
      }
      return out;
    };
    set((state) => ({ sessionStates: mark(state.sessionStates), pendingNewChats: mark(state.pendingNewChats) }));
  },

  setTodos: (sessionKey, todos) =>
    set((state) => withBucket(state, sessionKey, (s) => ({ ...s, todos }))),

  setPhase: (sessionKey, phase) =>
    set((state) => {
      // Bail before withBucket, which would rebuild the bucket maps either way. This
      // runs per streamed delta (chat:stream clears the phase), so an unchanged value
      // must be a true no-op, not just an equal-valued new object.
      const cur = state.pendingNewChats[sessionKey] ?? state.sessionStates[sessionKey];
      if (cur && cur.phase === phase) return state;
      return withBucket(state, sessionKey, (s) => ({ ...s, phase }));
    }),

  upsertTask: (sessionKey, task) =>
    set((state) => withBucket(state, sessionKey, (s) => {
      const id = `task-${task.taskId}`;
      const existing = s.messages.findIndex((m) => m.id === id);
      if (existing === -1) {
        // First sighting: fill the fields a partial update may not carry.
        const seeded = { status: 'running' as const, description: 'subagent task', ...task };
        return {
          ...s,
          messages: [...s.messages, { id, role: 'assistant', content: '', timestamp: Date.now(), kind: 'task', task: seeded }],
        };
      }
      // Update in place: progress events carry only what changed, so merge rather
      // than replace — otherwise a bare progress ping would blank the description.
      const prev = s.messages[existing];
      const merged = { ...prev, task: { ...prev.task, ...task } as NonNullable<ChatMessage['task']> };
      return { ...s, messages: s.messages.map((m, i) => (i === existing ? merged : m)) };
    })),

  addAutoDecision: (sessionKey, d) =>
    set((state) => withBucket(state, sessionKey, (s) => ({
      ...s,
      messages: [
        ...s.messages,
        {
          id: `auto-${crypto.randomUUID()}`,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          kind: 'permission',
          permission: {
            requestId: '',
            toolName: d.toolName,
            title: `Auto-approved ${d.toolName}`,
            input: d.detail ? { detail: d.detail } : {},
            decided: 'auto',
          },
        },
      ],
    }))),

  expirePermissions: (sessionKey) =>
    set((state) => withBucket(state, sessionKey, (s) => ({
      ...s,
      // Question cards expire the same way approval cards do — the turn that raised
      // them is over, so their buttons must stop being clickable. Subagent cards get
      // settled here too: agent:task is the only thing that ever moves them off
      // 'running', and a turn killed by Stop or an error emits no final task event,
      // so their spinners would run forever.
      messages: s.messages.map((m) => {
        if ((m.kind === 'permission' || m.kind === 'question') && m.permission && !m.permission.decided) {
          return { ...m, permission: { ...m.permission, decided: 'expired' as const } };
        }
        if (m.kind === 'task' && m.task?.status === 'running') {
          return { ...m, task: { ...m.task, status: 'stopped' as const } };
        }
        return m;
      }),
      // A finished turn is not compacting or waiting on anything.
      phase: null,
    }))),

  newChat: () => {
    const clientRequestId = uuid();
    set((state) => ({
      pendingNewChats: { ...state.pendingNewChats, [clientRequestId]: emptyState() },
      activeView: { kind: 'pending', clientRequestId },
      pendingAnchors: [],
    }));
    return clientRequestId;
  },

  selectSession: (id) => {
    const state = get();
    // We need a disk fetch unless we already have authoritative history. A bucket
    // populated only by live deltas after an extension reconnect has historyLoaded=false
    // even if it has messages — so we still fetch to get the earlier turns.
    const needsResume = !state.sessionStates[id] || !state.sessionStates[id].historyLoaded;
    set({
      activeView: { kind: 'session', sessionId: id },
      sessionStates: state.sessionStates[id]
        ? state.sessionStates
        : { ...state.sessionStates, [id]: emptyState() },
      pendingAnchors: [],
    });
    return needsResume;
  },

  selectPending: (clientRequestId) =>
    set((state) =>
      state.pendingNewChats[clientRequestId]
        ? { activeView: { kind: 'pending', clientRequestId }, pendingAnchors: [] }
        : state),

  migratePendingToSession: (clientRequestId, sessionId) =>
    set((state) => {
      const pending = state.pendingNewChats[clientRequestId];
      if (!pending) {
        // No pending bucket — session was started by something we didn't track.
        // Just ensure a fresh bucket exists for the new sessionId.
        if (state.sessionStates[sessionId]) return state;
        return { ...state, sessionStates: { ...state.sessionStates, [sessionId]: emptyState() } };
      }
      // Since this migration is triggered by session:created (a brand-new session),
      // we observed every event from the start: mark history as loaded so a later
      // switch-back doesn't trigger an unnecessary session:resume.
      const existing = state.sessionStates[sessionId];
      const merged: SessionState = existing
        ? {
            messages: [...pending.messages, ...existing.messages],
            isRunning: pending.isRunning || existing.isRunning,
            historyLoaded: true,
            // Carry the live-progress fields across the migration. The pending bucket
            // is the one that was actually streaming, so its checklist/phase win —
            // dropping them here would blank the todo list at the exact moment
            // session:created lands, mid-turn.
            todos: pending.todos.length > 0 ? pending.todos : existing.todos,
            phase: pending.phase ?? existing.phase,
          }
        : { ...pending, historyLoaded: true };
      const { [clientRequestId]: _drop, ...restPending } = state.pendingNewChats;
      const newActive: ActiveView =
        state.activeView.kind === 'pending' && state.activeView.clientRequestId === clientRequestId
          ? { kind: 'session', sessionId }
          : state.activeView;
      // The run mode is keyed like the bucket, so it has to move with it — otherwise
      // a chat started in Plan mode would silently revert to the default the moment
      // its session id resolved.
      const { [clientRequestId]: pendingMode, ...restModes } = state.runModes;
      const runModes = pendingMode
        ? { ...restModes, [sessionId]: state.runModes[sessionId] ?? pendingMode }
        : state.runModes;
      return {
        ...state,
        sessionStates: { ...state.sessionStates, [sessionId]: merged },
        pendingNewChats: restPending,
        activeView: newActive,
        runModes,
      };
    }),

  addUserMessage: (content, anchors, images) => {
    bumpStat('messageCount');
    set((state) => {
      const key = activeKey(state.activeView);
      if (!key) {
        // Empty view — auto-mint a pending bucket so the message has a home.
        // ChatInput is expected to call newChat() before submit, but be defensive.
        const cid = uuid();
        const bucket = emptyState();
        bucket.messages = [{
          id: `user-${uuid()}`, role: 'user', content, timestamp: Date.now(), anchors, images,
        }];
        return {
          pendingNewChats: { ...state.pendingNewChats, [cid]: bucket },
          activeView: { kind: 'pending', clientRequestId: cid },
        };
      }
      return withBucket(state, key, (s) => ({
        ...s,
        messages: [
          ...s.messages,
          { id: `user-${uuid()}`, role: 'user', content, timestamp: Date.now(), anchors, images },
        ],
      }));
    });
  },

  startAssistantMessage: (sessionKey, messageId, kind) =>
    set((state) => withBucket(state, sessionKey, (s) => ({
      ...s,
      messages: [
        ...s.messages,
        { id: messageId, role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true, kind: kind ?? 'text' },
      ],
    }))),

  appendDelta: (sessionKey, messageId, delta) =>
    set((state) => withBucket(state, sessionKey, (s) => ({
      ...s,
      messages: s.messages.map((m) => m.id === messageId ? { ...m, content: m.content + delta } : m),
    }))),

  completeMessage: (sessionKey, messageId, content) =>
    set((state) => withBucket(state, sessionKey, (s) => {
      const existing = s.messages.find((m) => m.id === messageId);
      const finalContent = existing && existing.content.length > 0 ? existing.content : content;
      return {
        ...s,
        messages: s.messages.map((m) => {
          if (m.id === messageId) return { ...m, content: finalContent, isStreaming: false };
          if (m.isStreaming) return { ...m, isStreaming: false };
          return m;
        }),
      };
    })),

  addToolUseMessage: (sessionKey, summary, isNotice) =>
    set((state) => withBucket(state, sessionKey, (s) => ({
      ...s,
      messages: [
        ...s.messages,
        {
          // uuid, not Date.now(): parallel tool_use blocks land in the same millisecond,
          // and duplicate ids make updateLastToolUse/appendDelta rewrite BOTH bubbles.
          id: `tool-${uuid()}`,
          role: 'assistant',
          content: summary,
          timestamp: Date.now(),
          kind: 'tool_use',
          // Notices (retries, hook output, compaction) render as tool bubbles but are
          // NOT the running tool call, so the next _update_ must not overwrite them.
          ...(isNotice ? { isNotice: true } : {}),
        },
      ],
    }))),

  updateLastToolUse: (sessionKey, summary) =>
    set((state) => withBucket(state, sessionKey, (s) => {
      const lastTool = [...s.messages].reverse().find((m) => m.kind === 'tool_use' && !m.isNotice);
      if (!lastTool) return s;
      return {
        ...s,
        messages: s.messages.map((m) => m.id === lastTool.id ? { ...m, content: summary } : m),
      };
    })),

  addSystemMessage: (sessionKey, message) =>
    set((state) => withBucket(state, sessionKey, (s) => ({ ...s, messages: [...s.messages, message] }))),

  setSessionRunning: (sessionKey, running) =>
    set((state) => withBucket(state, sessionKey, (s) => ({ ...s, isRunning: running }))),

  setMessageStreaming: (sessionKey, messageId, isStreaming) =>
    set((state) => withBucket(state, sessionKey, (s) => ({
      ...s,
      messages: s.messages.map((m) => m.id === messageId ? { ...m, isStreaming } : m),
    }))),

  loadSessionHistory: (sessionId, messages) =>
    set((state) => {
      const existing = state.sessionStates[sessionId];
      if (existing && existing.historyLoaded) return state;  // already authoritative
      // Preserve any in-progress tail (things that arrived after the bucket was
      // created but before disk history was fetched). Streaming deltas AND live cards:
      // an undecided approval/question card never sets isStreaming, and dropping one
      // deadlocks the turn — the host's promise stays parked with no way left to
      // answer it, and the expire path only runs on a completion that can never come.
      // Anything newer than the disk snapshot is live state the host has not persisted
      // yet, so it must survive. Keyed on the newest disk timestamp rather than on
      // `isStreaming`: a turn that COMPLETED during the resume round-trip has already
      // had that flag cleared, and filtering on it silently threw the whole answer away
      // while replacing it with history that predates the turn.
      const newestOnDisk = messages.reduce((max, m) => (m.timestamp > max ? m.timestamp : max), 0);
      const tail = existing
        ? existing.messages.filter((m) =>
          m.timestamp > newestOnDisk
          || m.isStreaming
          || ((m.kind === 'permission' || m.kind === 'question') && m.permission && !m.permission.decided)
          || (m.kind === 'task' && m.task?.status === 'running'))
        : [];
      return {
        ...state,
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...(existing ?? emptyState()),
            messages: [...messages, ...tail],
            historyLoaded: true,
          },
        },
      };
    }),

  markAllSessionsIdle: () =>
    set((state) => {
      // The host is gone, so nothing will ever answer or finish: alongside isRunning
      // and phase, settle the cards a turn-end would have settled. chat:complete /
      // chat:error can no longer arrive, so expirePermissions will never run — leaving
      // approval buttons live over a host that cannot receive the reply, and subagent
      // cards spinning for the life of the panel.
      const idle = (v: SessionState): SessionState => ({
        ...v,
        isRunning: false,
        phase: null,
        messages: v.messages.map((m) => {
          if ((m.kind === 'permission' || m.kind === 'question') && m.permission && !m.permission.decided) {
            return { ...m, permission: { ...m.permission, decided: 'expired' as const } };
          }
          if (m.kind === 'task' && m.task?.status === 'running') {
            return { ...m, task: { ...m.task, status: 'stopped' as const } };
          }
          return m;
        }),
      });
      const sessionStates: Record<string, SessionState> = {};
      for (const [k, v] of Object.entries(state.sessionStates)) sessionStates[k] = idle(v);
      const pendingNewChats: Record<string, SessionState> = {};
      for (const [k, v] of Object.entries(state.pendingNewChats)) pendingNewChats[k] = idle(v);
      return { ...state, sessionStates, pendingNewChats };
    }),

  addAnchor: (anchor) => set((state) => ({ pendingAnchors: [...state.pendingAnchors, anchor] })),
  removeAnchor: (index) => set((state) => ({ pendingAnchors: state.pendingAnchors.filter((_, i) => i !== index) })),
  clearAnchors: () => set({ pendingAnchors: [] }),
}));

// ── Selectors ─────────────────────────────────────────────────────────────

/** Messages for the currently-active view. Stable empty fallback. */
export const selectActiveMessages = (s: ChatState): ChatMessage[] => {
  if (s.activeView.kind === 'session') return s.sessionStates[s.activeView.sessionId]?.messages ?? EMPTY_MESSAGES;
  if (s.activeView.kind === 'pending') return s.pendingNewChats[s.activeView.clientRequestId]?.messages ?? EMPTY_MESSAGES;
  return EMPTY_MESSAGES;
};

/** Running flag for the currently-active view. */
export const selectActiveIsRunning = (s: ChatState): boolean => {
  if (s.activeView.kind === 'session') return s.sessionStates[s.activeView.sessionId]?.isRunning ?? false;
  if (s.activeView.kind === 'pending') return s.pendingNewChats[s.activeView.clientRequestId]?.isRunning ?? false;
  return false;
};

/** Run mode governing the active conversation — its own if it has one, otherwise the
 *  default new chats inherit. This is what the picker displays and edits. */
export const selectActiveRunMode = (s: ChatState): RunMode => {
  const key = activeViewKey(s.activeView);
  return (key && s.runModes[key]) || s.defaultRunMode;
};

/** The agent's plan checklist for the active view (agent:todos). */
export const selectActiveTodos = (s: ChatState): TodoItem[] => {
  if (s.activeView.kind === 'session') return s.sessionStates[s.activeView.sessionId]?.todos ?? EMPTY_TODOS;
  if (s.activeView.kind === 'pending') return s.pendingNewChats[s.activeView.clientRequestId]?.todos ?? EMPTY_TODOS;
  return EMPTY_TODOS;
};

/** What the active session is doing between token streams (agent:phase). */
export const selectActivePhase = (s: ChatState): 'compacting' | 'requesting' | null => {
  if (s.activeView.kind === 'session') return s.sessionStates[s.activeView.sessionId]?.phase ?? null;
  if (s.activeView.kind === 'pending') return s.pendingNewChats[s.activeView.clientRequestId]?.phase ?? null;
  return null;
};

/** The session id that owns the current view, or null for empty/pending. */
export const selectActiveSessionId = (s: ChatState): string | null =>
  s.activeView.kind === 'session' ? s.activeView.sessionId : null;

/** Title for the currently-active view, for the header above the messages. Works
 *  for any view: host title → local first message → id fallback (session), first
 *  message → "New chat" (pending), '' (empty). */
export const selectActiveTitle = (s: ChatState): string => {
  if (s.activeView.kind === 'session') {
    const id = s.activeView.sessionId;
    const host = s.sessions.find((x) => x.id === id);
    if (host?.title) return host.title;
    const local = s.sessionStates[id];
    return (local && firstUserText(local)) || `Session ${id.slice(0, 8)}`;
  }
  if (s.activeView.kind === 'pending') {
    const st = s.pendingNewChats[s.activeView.clientRequestId];
    return (st && firstUserText(st)) || 'New chat';
  }
  return '';
};

// ── Session list (unified, immediate) ──────────────────────────────────────

/** A row in the session list. `pending` rows are in-progress new chats whose
 *  Claude Code session_id hasn't resolved yet (id = clientRequestId); `session`
 *  rows are real sessions (id = sessionId). */
export interface SessionListEntry {
  kind: 'pending' | 'session';
  id: string;
  title: string;
  lastModified: number;
  isRunning: boolean;
}

function firstUserText(st: SessionState): string {
  return (st.messages.find((m) => m.role === 'user')?.content ?? '').trim();
}
function lastTs(st: SessionState): number {
  return st.messages.length ? st.messages[st.messages.length - 1].timestamp : 0;
}
/** Timestamp of the most recent USER message — the recency key the list sorts by,
 *  so a session jumps to the top the instant the user sends a message in it. */
function lastUserTs(st: SessionState): number {
  for (let i = st.messages.length - 1; i >= 0; i--) {
    if (st.messages[i].role === 'user') return st.messages[i].timestamp;
  }
  return 0;
}

/** Build the session list from LOCAL state first so a new chat shows the instant
 *  the user sends — independent of the host's disk-backed listSessions (which lags
 *  until the agent has written the session). Merges: in-progress pending chats +
 *  the host's sessions + any locally-known sessions not yet in the host list
 *  (freshly created/migrated). Deduped by id, newest first. */
export function buildSessionEntries(
  sessions: SessionInfo[],
  pendingNewChats: Record<string, SessionState>,
  sessionStates: Record<string, SessionState>,
): SessionListEntry[] {
  const entries: SessionListEntry[] = [];
  // Pending chats with at least a user message.
  for (const [cid, st] of Object.entries(pendingNewChats)) {
    if (st.messages.length === 0) continue;
    entries.push({ kind: 'pending', id: cid, title: firstUserText(st) || 'New chat', lastModified: lastUserTs(st) || lastTs(st), isRunning: st.isRunning });
  }
  // Host (disk) sessions. Sort key is the most recent of the host's lastModified and
  // the local last-user-message time, so sending a message bumps the session to the
  // top immediately — before the host's disk list refreshes.
  const hostIds = new Set<string>();
  for (const s of sessions) {
    hostIds.add(s.id);
    const local = sessionStates[s.id];
    entries.push({
      kind: 'session', id: s.id, title: s.title,
      lastModified: Math.max(s.lastModified, local ? lastUserTs(local) : 0),
      isRunning: local?.isRunning ?? false,
    });
  }
  // Locally-known sessions the host hasn't listed yet (just created/migrated; disk lag).
  for (const [sid, st] of Object.entries(sessionStates)) {
    if (hostIds.has(sid) || st.messages.length === 0) continue;
    entries.push({ kind: 'session', id: sid, title: firstUserText(st) || `Session ${sid.slice(0, 8)}`, lastModified: lastUserTs(st) || lastTs(st), isRunning: st.isRunning });
  }
  return entries.sort((a, b) => b.lastModified - a.lastModified);
}
