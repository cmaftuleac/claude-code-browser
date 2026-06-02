import { create } from 'zustand';

export type AppView = 'home' | 'workspace';

/** The currently-focused tab in the workspace tab bar. Conversations, files,
 *  and browser surfaces are all "tabs" — three distinct kinds with the same
 *  click-to-focus / X-to-close behavior. */
export type ActiveTab =
  | { kind: 'conv'; taskId: string }
  | { kind: 'file'; path: string }
  | { kind: 'browser'; taskId: string };

interface UiState {
  view: AppView;
  setView: (view: AppView) => void;
  tasksRailOpen: boolean;
  stateRailOpen: boolean;
  toggleTasksRail: () => void;
  toggleStateRail: () => void;
  /** What's currently shown in the workspace body. `null` means "no tab open"
   *  → the empty hero renders. */
  activeTab: ActiveTab | null;
  setActiveTab: (tab: ActiveTab) => void;
  clearActiveTab: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: 'home',
  setView: (view) => set({ view }),
  tasksRailOpen: true,
  stateRailOpen: true,
  toggleTasksRail: () => set((s) => ({ tasksRailOpen: !s.tasksRailOpen })),
  toggleStateRail: () => set((s) => ({ stateRailOpen: !s.stateRailOpen })),
  activeTab: null,
  setActiveTab: (tab) => set({ activeTab: tab }),
  clearActiveTab: () => set({ activeTab: null }),
}));
