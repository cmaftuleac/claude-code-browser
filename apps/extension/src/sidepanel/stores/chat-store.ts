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

interface ChatState {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  messages: ChatMessage[];
  isAgentRunning: boolean;
  pendingAnchors: ElementAnchor[];

  setSessions: (sessions: SessionInfo[]) => void;
  setActiveSession: (id: string | null) => void;
  selectSession: (id: string) => void;
  addUserMessage: (content: string, anchors?: ElementAnchor[], images?: string[]) => void;
  startAssistantMessage: (messageId: string, kind?: 'text' | 'thinking' | 'tool_use') => void;
  appendDelta: (messageId: string, delta: string) => void;
  completeMessage: (messageId: string, content: string) => void;
  addToolUseMessage: (toolName: string, summary: string) => void;
  setAgentRunning: (running: boolean) => void;
  addAnchor: (anchor: ElementAnchor) => void;
  removeAnchor: (index: number) => void;
  clearAnchors: () => void;
  clearMessages: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  isAgentRunning: false,
  pendingAnchors: [],

  setSessions: (sessions) => set({ sessions }),
  setActiveSession: (id) => set({ activeSessionId: id }),
  // User-initiated switch to a different session: wipe displayed messages + agent state
  // so the previous session's content doesn't flash and stream events from it (gated by
  // sessionId in useNativePort) can't leave the input disabled.
  selectSession: (id) =>
    set({
      activeSessionId: id,
      messages: [],
      isAgentRunning: false,
      pendingAnchors: [],
    }),

  addUserMessage: (content, anchors, images) => {
    bumpStat('messageCount');
    set((state) => ({
      messages: [
        ...state.messages,
        { id: `user-${Date.now()}`, role: 'user', content, timestamp: Date.now(), anchors, images },
      ],
    }));
  },

  startAssistantMessage: (messageId, kind) =>
    set((state) => ({
      messages: [
        ...state.messages,
        { id: messageId, role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true, kind: kind ?? 'text' },
      ],
    })),

  appendDelta: (messageId, delta) =>
    set((state) => ({
      messages: state.messages.map((msg) =>
        msg.id === messageId ? { ...msg, content: msg.content + delta } : msg,
      ),
    })),

  completeMessage: (messageId, content) =>
    set((state) => {
      const existing = state.messages.find((m) => m.id === messageId);
      const finalContent = existing && existing.content.length > 0 ? existing.content : content;
      return {
        messages: state.messages.map((msg) => {
          if (msg.id === messageId) return { ...msg, content: finalContent, isStreaming: false };
          // Also close any still-streaming thinking/text blocks from this turn
          if (msg.isStreaming) return { ...msg, isStreaming: false };
          return msg;
        }),
      };
    }),

  addToolUseMessage: (toolName, summary) =>
    set((state) => ({
      messages: [
        ...state.messages,
        { id: `tool-${Date.now()}`, role: 'assistant', content: summary, timestamp: Date.now(), kind: 'tool_use' },
      ],
    })),

  setAgentRunning: (running) => set({ isAgentRunning: running }),

  addAnchor: (anchor) =>
    set((state) => ({ pendingAnchors: [...state.pendingAnchors, anchor] })),

  removeAnchor: (index) =>
    set((state) => ({ pendingAnchors: state.pendingAnchors.filter((_, i) => i !== index) })),

  clearAnchors: () => set({ pendingAnchors: [] }),
  clearMessages: () => set({ messages: [], activeSessionId: null }),
}));
