import { create } from 'zustand';
import { useTasksStore } from './tasks-store';
import { useWorkspaceStore } from './workspace-store';

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
  /** Help → About overlay visibility. */
  aboutOpen: boolean;
  openAbout: () => void;
  closeAbout: () => void;
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
  aboutOpen: false,
  openAbout: () => set({ aboutOpen: true }),
  closeAbout: () => set({ aboutOpen: false }),
}));

/**
 * Tiered "close the active tab" — shared by the Cmd+W intercept and the
 * File → Close Tab menu item so they never drift:
 *   1. Close the currently-active tab (conv / file / browser).
 *   2. No live tab but a project is open → close the project (Home view).
 *   3. No project → quit.
 *
 * `activeTab` is the single source of truth; we validate it against live
 * store state first, since it can briefly point at a just-removed target
 * before the reconcile effect catches up. A conversation tab closes the whole
 * task (its Browser sibling included) — matching the tab's own X button and
 * the right-click "Close" item, so all three close affordances agree. (The
 * tab bar / workspace render a conv tab per task regardless of `surfaces.conv`,
 * so merely hiding the conv surface would be a no-op here.)
 */
export function closeActiveTab(): void {
  const ui = useUiStore.getState();
  const ws = useWorkspaceStore.getState();
  const tasks = useTasksStore.getState();
  const tab = ui.activeTab;
  const tabIsLive = tab
    ? tab.kind === 'conv' ? tasks.tasks.some((t) => t.id === tab.taskId)
    : tab.kind === 'file' ? ws.workingFiles.includes(tab.path)
    : tab.kind === 'browser' ? tasks.tasks.some((t) => t.id === tab.taskId && t.surfaces.browser)
    : false
    : false;
  if (tab && tabIsLive) {
    if (tab.kind === 'conv') tasks.deleteTask(tab.taskId);
    else if (tab.kind === 'file') ws.closeFile(tab.path);
    else if (tab.kind === 'browser') tasks.closeBrowserSurface(tab.taskId);
    return;
  }
  if (ws.root) ws.closeProject();
  else void window.ccb.app.quit();
}
