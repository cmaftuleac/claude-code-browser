import { create } from 'zustand';
import type { ElementAnchor, SessionInfo } from '@claude-code-browser/shared';

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
  kind?: 'text' | 'thinking' | 'tool_use';
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

const emptyState = (): SessionState => ({ messages: [], isRunning: false, historyLoaded: false });

interface ChatState {
  sessions: SessionInfo[];
  sessionStates: Record<string, SessionState>;
  pendingNewChats: Record<string, SessionState>;
  activeView: ActiveView;
  /** Pending anchors live globally because they describe the current draft message,
   *  not the session — switching sessions mid-pick would be surprising. */
  pendingAnchors: ElementAnchor[];

  setSessions: (sessions: SessionInfo[]) => void;

  /** Start a fresh pending chat. Returns the minted clientRequestId so the caller
   *  can attach it to the chat:send payload. */
  newChat: () => string;

  /** Switch the view to an existing session id. Creates an empty bucket if missing.
   *  Returns true when the caller should fire session:resume (bucket was new/empty). */
  selectSession: (id: string) => boolean;

  /** Move a pending bucket onto its real sessionId, updating the active view if
   *  it was pointing at this pending. Called when session:created arrives. */
  migratePendingToSession: (clientRequestId: string, sessionId: string) => void;

  addUserMessage: (content: string, anchors?: ElementAnchor[], images?: string[]) => void;
  startAssistantMessage: (sessionKey: string, messageId: string, kind?: 'text' | 'thinking' | 'tool_use') => void;
  appendDelta: (sessionKey: string, messageId: string, delta: string) => void;
  completeMessage: (sessionKey: string, messageId: string, content: string) => void;
  addToolUseMessage: (sessionKey: string, summary: string) => void;
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

  setSessions: (sessions) => set({ sessions }),

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
          }
        : { ...pending, historyLoaded: true };
      const { [clientRequestId]: _drop, ...restPending } = state.pendingNewChats;
      const newActive: ActiveView =
        state.activeView.kind === 'pending' && state.activeView.clientRequestId === clientRequestId
          ? { kind: 'session', sessionId }
          : state.activeView;
      return {
        ...state,
        sessionStates: { ...state.sessionStates, [sessionId]: merged },
        pendingNewChats: restPending,
        activeView: newActive,
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
          id: `user-${Date.now()}`, role: 'user', content, timestamp: Date.now(), anchors, images,
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
          { id: `user-${Date.now()}`, role: 'user', content, timestamp: Date.now(), anchors, images },
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

  addToolUseMessage: (sessionKey, summary) =>
    set((state) => withBucket(state, sessionKey, (s) => ({
      ...s,
      messages: [
        ...s.messages,
        { id: `tool-${Date.now()}`, role: 'assistant', content: summary, timestamp: Date.now(), kind: 'tool_use' },
      ],
    }))),

  updateLastToolUse: (sessionKey, summary) =>
    set((state) => withBucket(state, sessionKey, (s) => {
      const lastTool = [...s.messages].reverse().find((m) => m.kind === 'tool_use');
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
      // Preserve any in-progress streaming tail (deltas that arrived after the
      // bucket was created but before disk history was fetched).
      const tail = existing ? existing.messages.filter((m) => m.isStreaming) : [];
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
      const sessionStates: Record<string, SessionState> = {};
      for (const [k, v] of Object.entries(state.sessionStates)) sessionStates[k] = { ...v, isRunning: false };
      const pendingNewChats: Record<string, SessionState> = {};
      for (const [k, v] of Object.entries(state.pendingNewChats)) pendingNewChats[k] = { ...v, isRunning: false };
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

/** The session id that owns the current view, or null for empty/pending. */
export const selectActiveSessionId = (s: ChatState): string | null =>
  s.activeView.kind === 'session' ? s.activeView.sessionId : null;
