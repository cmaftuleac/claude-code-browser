import { create } from 'zustand';
import type { SessionInfo } from '@claude-code-browser/shared';

/**
 * On-disk Claude Code sessions available to resume. Populated on demand when
 * the user opens the "Resume session" disclosure (we send `session:list`; the
 * desktop main replies with `session:list`, routed here by useAgentIpc).
 */
interface SessionsState {
  sessions: SessionInfo[];
  loaded: boolean;
  loading: boolean;
  /** Ask the host for the on-disk session list. */
  requestList(): void;
  setSessions(sessions: SessionInfo[]): void;
}

export const useSessionsStore = create<SessionsState>((set) => ({
  sessions: [],
  loaded: false,
  loading: false,
  requestList: () => {
    set({ loading: true });
    window.ccb.send({ type: 'session:list' });
  },
  setSessions: (sessions) =>
    set({
      // Newest first.
      sessions: [...sessions].sort((a, b) => b.lastModified - a.lastModified),
      loaded: true,
      loading: false,
    }),
}));
