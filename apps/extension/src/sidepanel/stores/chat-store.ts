import { create } from 'zustand';
import type { ElementAnchor, SessionInfo } from '@claude-code-browser/shared';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  anchors?: ElementAnchor[];
  images?: string[];  // base64 data URLs
  isStreaming?: boolean;
}

interface ChatState {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  messages: ChatMessage[];
  isAgentRunning: boolean;
  pendingAnchors: ElementAnchor[];

  setSessions: (sessions: SessionInfo[]) => void;
  setActiveSession: (id: string | null) => void;
  addUserMessage: (content: string, anchors?: ElementAnchor[], images?: string[]) => void;
  startAssistantMessage: (messageId: string) => void;
  appendDelta: (messageId: string, delta: string) => void;
  completeMessage: (messageId: string, content: string) => void;
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

  addUserMessage: (content, anchors, images) =>
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: `user-${Date.now()}`,
          role: 'user',
          content,
          timestamp: Date.now(),
          anchors,
          images,
        },
      ],
    })),

  startAssistantMessage: (messageId) =>
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: messageId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          isStreaming: true,
        },
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
      // If we already have streamed content, keep it. Only use `content` if empty.
      const finalContent = existing && existing.content.length > 0 ? existing.content : content;
      return {
        messages: state.messages.map((msg) =>
          msg.id === messageId
            ? { ...msg, content: finalContent, isStreaming: false }
            : msg,
        ),
      };
    }),

  setAgentRunning: (running) => set({ isAgentRunning: running }),

  addAnchor: (anchor) =>
    set((state) => ({ pendingAnchors: [...state.pendingAnchors, anchor] })),

  removeAnchor: (index) =>
    set((state) => ({
      pendingAnchors: state.pendingAnchors.filter((_, i) => i !== index),
    })),

  clearAnchors: () => set({ pendingAnchors: [] }),

  clearMessages: () => set({ messages: [], activeSessionId: null }),
}));
