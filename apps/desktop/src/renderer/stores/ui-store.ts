import { create } from 'zustand';
import { useTasksStore } from './tasks-store';
import { useWorkspaceStore } from './workspace-store';
import { useBrowserStore } from './browser-store';
import { useClosedTabsStore } from './closed-tabs-store';
import { tabKey, parseTabKey, type TabKey } from '../lib/tab-key';
import {
  type LayoutNode,
  type SplitDirection,
  appendTabs,
  clampIndex,
  collectTabKeys,
  findGroup,
  firstGroup,
  locateTab,
  makeGroup,
  moveTab as moveTabOp,
  normalize,
  pruneDead,
  renameTab as renameTabOp,
  resizeSplit as resizeSplitOp,
  setGroupActive,
  splitGroup as splitGroupOp,
  splitGroupNewTab as splitGroupNewTabOp,
} from '../lib/pane-layout';

export type AppView = 'home' | 'workspace';

/** The currently-focused tab in the workspace tab bar. Conversations, files,
 *  and the browser are all "tabs" — three distinct kinds with the same
 *  click-to-focus / X-to-close behavior. Files and the browser are
 *  project-wide; only conversations are per-task. */
export type ActiveTab =
  | { kind: 'conv'; taskId: string }
  | { kind: 'file'; path: string }
  | { kind: 'browser'; id: string }
  | { kind: 'settings' };

interface UiState {
  view: AppView;
  setView: (view: AppView) => void;
  tasksRailOpen: boolean;
  stateRailOpen: boolean;
  toggleTasksRail: () => void;
  toggleStateRail: () => void;

  /** The split-pane layout shown in the workspace body. `null` ⇒ no tabs open
   *  → the empty hero renders. The root is always a `split` (see pane-layout). */
  layout: LayoutNode | null;
  /** Which group has focus — where new tabs land and which group a Cmd+W /
   *  split command targets. */
  activeGroupId: string | null;
  /** A tab to focus once it appears in the layout. Set when something is opened
   *  before the reconcile effect has inserted it (store updated, effect pending);
   *  consumed by `reconcile`. */
  pendingFocus: TabKey | null;

  /** Focus a tab by descriptor (back-compat shim over `focusTab`). */
  setActiveTab: (tab: ActiveTab) => void;
  /** Reset the workspace to empty (used by closeProject). */
  clearActiveTab: () => void;
  /** Reopen the most-recently-closed tab — browser / file / conversation /
   *  settings — and focus it (Cmd+Shift+T). No-op when the history is empty. */
  reopenLastClosed: () => void;
  /** Focus a tab by key; also makes its group active. Stashes `pendingFocus`
   *  if the tab isn't in the layout yet. */
  focusTab: (key: TabKey) => void;
  focusGroup: (groupId: string) => void;
  /** Move a group's active tab into a new sibling group (split Right/Down). A
   *  single-tab group instead opens a fresh untitled scratch file in the new
   *  pane, so splitting is never a dead-end. */
  splitGroup: (groupId: string, direction: SplitDirection, position: 'before' | 'after') => void;
  resizeSplit: (splitId: string, sizes: number[]) => void;
  /** True while a divider is being dragged — lets PaneTree make flex-size
   *  changes instant (no spring) so the drag tracks the cursor 1:1. */
  paneResizing: boolean;
  setPaneResizing: (v: boolean) => void;
  /** Re-key a tab in place (untitled → real path after Save As). */
  renameTab: (oldKey: TabKey, newKey: TabKey) => void;
  /** Drag-to-move a tab into another group (or reorder within one). `index` is
   *  the insertion position in the target group's strip (default: end). */
  moveTab: (key: TabKey, targetGroupId: string, index?: number) => void;
  /** Cycle the focused group's active tab (Ctrl+Tab / Ctrl+Shift+Tab). +1 next,
   *  -1 previous; wraps around. No-op if the group has ≤1 tab. */
  cycleTab: (dir: 1 | -1) => void;
  /** Sync the layout with the live set of open tabs (the single writer that
   *  inserts/removes layout tabs as tasks/files/browser appear and vanish). */
  reconcile: (live: TabKey[]) => void;
  /** Install a fully-built layout wholesale (reload restore). The caller has
   *  already recreated every referenced tab, so reconcile becomes a no-op. */
  restoreLayout: (layout: LayoutNode, activeGroupId: string | null) => void;

  /** Whether the singleton Settings tab is open in THIS window. The tab itself
   *  lives in the layout (keyed `settings:`); this flag is what TaskWorkspace
   *  feeds into `reconcile` so the tab appears/vanishes. */
  settingsOpen: boolean;
  /** Open (or focus, if already open) the Settings tab. `section` deep-links a
   *  panel section; consumed by SettingsPanel via `settingsSection`. */
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  /** The section the Settings tab should show (deep-link target). */
  settingsSection: SettingsSection;
  setSettingsSection: (section: SettingsSection) => void;
}

/** Sections of the Settings tab — also the deep-link target for openSettings. */
export type SettingsSection = 'appearance' | 'editor' | 'agent' | 'account' | 'general' | 'about';

export const useUiStore = create<UiState>((set, get) => ({
  view: 'home',
  setView: (view) => set({ view }),
  tasksRailOpen: true,
  stateRailOpen: true,
  toggleTasksRail: () => set((s) => ({ tasksRailOpen: !s.tasksRailOpen })),
  toggleStateRail: () => set((s) => ({ stateRailOpen: !s.stateRailOpen })),

  layout: null,
  activeGroupId: null,
  pendingFocus: null,

  setActiveTab: (tab) => get().focusTab(tabKey(tab)),

  clearActiveTab: () => set({ layout: null, activeGroupId: null, pendingFocus: null }),

  reopenLastClosed: () => {
    const entry = useClosedTabsStore.getState().pop();
    if (!entry) return;
    if (entry.kind === 'browser') {
      const id = useBrowserStore.getState().openBrowser({ url: entry.url, focus: true });
      get().setActiveTab({ kind: 'browser', id });
    } else if (entry.kind === 'file') {
      void useWorkspaceStore.getState().openFile(entry.path); // focuses by default
    } else if (entry.kind === 'conv') {
      useTasksStore.getState().restoreTask(entry.task, entry.index);
      get().setActiveTab({ kind: 'conv', taskId: entry.task.id });
    } else {
      get().openSettings();
    }
  },

  focusTab: (key) => {
    const parsed = parseTabKey(key);
    if (parsed.kind === 'browser') {
      useBrowserStore.getState().setActive(parsed.id);
      useBrowserStore.getState().clearHint(parsed.id);
    }
    const { layout } = get();
    const loc = layout ? locateTab(layout, key) : null;
    if (!layout || !loc) {
      // Not inserted yet — let reconcile focus it when it appears.
      set({ pendingFocus: key });
      return;
    }
    set({ layout: setGroupActive(layout, loc.groupId, loc.index), activeGroupId: loc.groupId });
  },

  focusGroup: (groupId) => {
    const { layout, activeGroupId } = get();
    if (groupId === activeGroupId) return;
    if (layout && findGroup(layout, groupId)) set({ activeGroupId: groupId });
  },

  splitGroup: (groupId, direction, position) => {
    const { layout } = get();
    if (!layout) return;
    const group = findGroup(layout, groupId);
    if (!group) return;
    if (group.tabs.length > 1) {
      const res = splitGroupOp(layout, groupId, direction, position);
      if (!res.newGroupId || !res.root) return;
      set({ layout: res.root, activeGroupId: res.newGroupId });
    } else {
      // Single tab: open a fresh untitled scratch file in the new pane.
      // newUntitledFile adds the buffer/workingFile without focusing; we place
      // it in the new sibling group ourselves and focus that group. (reconcile
      // then sees the key already present, so it doesn't double-append.)
      const path = useWorkspaceStore.getState().newUntitledFile();
      const res = splitGroupNewTabOp(layout, groupId, direction, position, `file:${path}`);
      if (!res.newGroupId || !res.root) return;
      set({ layout: res.root, activeGroupId: res.newGroupId });
    }
  },

  resizeSplit: (splitId, sizes) => {
    const { layout } = get();
    if (!layout) return;
    set({ layout: resizeSplitOp(layout, splitId, sizes) });
  },

  paneResizing: false,
  setPaneResizing: (v) => set({ paneResizing: v }),

  renameTab: (oldKey, newKey) => {
    const { layout, pendingFocus } = get();
    if (!layout) return;
    set({
      layout: renameTabOp(layout, oldKey, newKey),
      pendingFocus: pendingFocus === oldKey ? newKey : pendingFocus,
    });
  },

  moveTab: (key, targetGroupId, index) => {
    const { layout } = get();
    if (!layout) return;
    const res = moveTabOp(layout, key, targetGroupId, index);
    if (!res.moved || !res.root) return;
    set({ layout: res.root, activeGroupId: targetGroupId, pendingFocus: null });
    // Keep the rest of the app in step with the now-focused, moved tab.
    const tab = parseTabKey(key);
    if (tab.kind === 'conv') useTasksStore.getState().selectTask(tab.taskId);
    else if (tab.kind === 'browser') {
      useBrowserStore.getState().setActive(tab.id);
      useBrowserStore.getState().clearHint(tab.id);
    }
  },

  cycleTab: (dir) => {
    const { layout, activeGroupId } = get();
    if (!layout || !activeGroupId) return;
    const g = findGroup(layout, activeGroupId);
    if (!g || g.tabs.length <= 1) return;
    const n = g.tabs.length;
    const cur = clampIndex(g.activeIndex, n);
    const key = g.tabs[(cur + dir + n) % n];
    get().focusTab(key);
    // Match click-to-focus: cycling onto a conversation makes it the active task.
    const tab = parseTabKey(key);
    if (tab.kind === 'conv') useTasksStore.getState().selectTask(tab.taskId);
  },

  reconcile: (live) => {
    const liveSet = new Set(live);
    let layout = get().layout;
    let activeGroupId = get().activeGroupId;
    let pendingFocus = get().pendingFocus;

    // 1. Prune dead tabs (+ de-dupe) and normalize the tree.
    layout = normalize(pruneDead(layout, liveSet));

    // 2. Drop a pending focus whose tab vanished before it could appear.
    if (pendingFocus && !liveSet.has(pendingFocus)) pendingFocus = null;

    // 3. Append newly-appeared tabs to the active group (or seed a root group).
    const present = layout ? new Set(collectTabKeys(layout)) : new Set<TabKey>();
    const appeared = live.filter((k) => !present.has(k));
    if (appeared.length > 0) {
      if (!layout) {
        const g = makeGroup(appeared, appeared.length - 1);
        layout = normalize(g);
        activeGroupId = g.id;
      } else {
        const target = (activeGroupId && findGroup(layout, activeGroupId)) || firstGroup(layout);
        layout = appendTabs(layout, target.id, appeared);
      }
    }

    // 4. Honor a pending focus now that its tab exists.
    if (pendingFocus && layout) {
      const loc = locateTab(layout, pendingFocus);
      if (loc) {
        layout = setGroupActive(layout, loc.groupId, loc.index);
        activeGroupId = loc.groupId;
        pendingFocus = null;
      }
    }

    // 5. Repair activeGroupId.
    if (!layout) activeGroupId = null;
    else if (!activeGroupId || !findGroup(layout, activeGroupId)) activeGroupId = firstGroup(layout).id;

    set({ layout, activeGroupId, pendingFocus });
  },

  restoreLayout: (layout, activeGroupId) => set({ layout, activeGroupId, pendingFocus: null }),

  settingsOpen: false,
  settingsSection: 'appearance',
  openSettings: (section) => {
    if (section) set({ settingsSection: section });
    // Set the flag first so TaskWorkspace's reconcile inserts the tab, then
    // focus it (focusTab stashes pendingFocus until the tab appears).
    set({ settingsOpen: true });
    get().focusTab('settings:');
  },
  closeSettings: () => {
    // Record for Reopen Closed Tab (Cmd+Shift+T) only when it was actually open.
    if (get().settingsOpen) useClosedTabsStore.getState().push({ kind: 'settings' });
    set({ settingsOpen: false });
  },
  setSettingsSection: (section) => set({ settingsSection: section }),
}));

/** The active tab descriptor, derived from the focused group. */
export function getActiveTab(): ActiveTab | null {
  const { layout, activeGroupId } = useUiStore.getState();
  if (!layout || !activeGroupId) return null;
  const g = findGroup(layout, activeGroupId);
  if (!g || g.tabs.length === 0) return null;
  return parseTabKey(g.tabs[clampIndex(g.activeIndex, g.tabs.length)]);
}

/**
 * Tiered "close the active tab" — shared by the Cmd+W intercept and the
 * File → Close Tab menu item so they never drift:
 *   1. Close the currently-active tab (conv / file / browser) via its store
 *      mutation; the reconcile effect prunes the layout and refocuses.
 *   2. No live tab but a project is open → close the project (Home view).
 *   3. No project → quit.
 *
 * The active tab is derived from the focused group; we validate it against live
 * store state first, since it can briefly point at a just-removed target before
 * the reconcile effect catches up. A conversation tab closes the whole task —
 * matching the tab's own X button — so all close affordances agree.
 */
export function closeActiveTab(): void {
  const ws = useWorkspaceStore.getState();
  const tasks = useTasksStore.getState();
  const tab = getActiveTab();
  const tabIsLive = tab
    ? tab.kind === 'conv' ? tasks.tasks.some((t) => t.id === tab.taskId)
    : tab.kind === 'file' ? ws.workingFiles.includes(tab.path)
    : tab.kind === 'browser' ? useBrowserStore.getState().instances[tab.id] != null
    : tab.kind === 'settings' ? useUiStore.getState().settingsOpen
    : false
    : false;
  if (tab && tabIsLive) {
    if (tab.kind === 'conv') tasks.deleteTask(tab.taskId);
    else if (tab.kind === 'file') ws.closeFile(tab.path);
    else if (tab.kind === 'browser') useBrowserStore.getState().closeBrowser(tab.id);
    else if (tab.kind === 'settings') useUiStore.getState().closeSettings();
    return;
  }
  if (ws.root) ws.closeProject();
  // Nothing left in this window → close it (multi-window). On the last window,
  // window-all-closed quits on Win/Linux; macOS keeps the app alive (standard).
  // Flush unsaved edits first (PyCharm saves on close) so closing the window
  // never drops in-flight buffers.
  else void ws.saveAll().finally(() => window.ccb.app.closeWindow());
}
