/**
 * Workspace snapshot + reload restore.
 *
 * A renderer reload (Cmd+R) wipes every zustand store. The main process keeps
 * this window's project root, so we can reopen the project — and, with the
 * snapshot persisted here, rebuild the exact set of open tabs and the split
 * layout too.
 *
 * The snapshot is captured (debounced) into the main process on every workspace
 * change and flushed on `pagehide`, then read back on the next startup. Because
 * conversation and browser ids are regenerated after a reload, restore remaps
 * the persisted layout's tab keys old→new and mints fresh group/split ids (the
 * pane-layout id counters reset on reload, so reusing old ids would collide).
 * Tabs whose entity can't be recreated (e.g. an unsent conversation with no
 * session) are dropped and pruned from the layout.
 */
import { useUiStore } from '../stores/ui-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useTasksStore } from '../stores/tasks-store';
import { useBrowserStore } from '../stores/browser-store';
import {
  type LayoutNode,
  makeGroup,
  newSplitId,
  normalize,
  firstGroup,
  findGroup,
  activeKeyOf,
} from './pane-layout';
import { type TabKey, parseTabKey } from './tab-key';
import { isUntitledPath } from './untitled';

/** True while a restore is in flight — suppresses the snapshot-sync writes so an
 *  intermediate (partial) layout can't overwrite the saved one mid-rebuild. */
let restoring = false;

/** Hot-exit cap: skip persisting a single buffer's unsaved content past this many
 *  chars. The file still reopens from disk — only its (rare, huge) unsaved edits
 *  are dropped — keeping workspaces.json from ballooning. */
const MAX_HOT_EXIT_CHARS = 5_000_000;

export interface WorkspaceSnapshot {
  /** The project this snapshot belongs to — restore only if it still matches. */
  root: string;
  files: string[];
  /** Hot-exit: unsaved text buffers (dirty real files + every untitled scratch
   *  buffer), keyed by working-file path. `saved` is the capture-time disk
   *  baseline, used to detect external changes on restore. Absent when nothing
   *  is unsaved. */
  unsaved?: Record<string, { content: string; saved: string }>;
  convs: Array<{ taskId: string; sessionId?: string; title: string }>;
  browsers: Array<{ browserId: string; url: string }>;
  settingsOpen: boolean;
  layout: LayoutNode | null;
  activeGroupId: string | null;
}

/** Read the current workspace into a serializable snapshot (null if no project). */
export function captureSnapshot(): WorkspaceSnapshot | null {
  const ws = useWorkspaceStore.getState();
  if (!ws.root) return null;
  const ui = useUiStore.getState();
  const browser = useBrowserStore.getState();
  // Hot-exit: preserve unsaved text — dirty real files and every untitled scratch
  // buffer (which never auto-saves). Skip oversized buffers (still reopen from disk).
  const unsaved: Record<string, { content: string; saved: string }> = {};
  for (const [p, b] of Object.entries(ws.fileBuffers)) {
    if (b.kind !== 'text') continue;
    if (b.content === b.saved && !isUntitledPath(p)) continue;
    if (b.content.length > MAX_HOT_EXIT_CHARS) continue;
    unsaved[p] = { content: b.content, saved: b.saved };
  }
  return {
    root: ws.root,
    files: [...ws.workingFiles],
    unsaved: Object.keys(unsaved).length ? unsaved : undefined,
    convs: useTasksStore.getState().tasks.map((t) => ({ taskId: t.id, sessionId: t.sessionId, title: t.title })),
    browsers: browser.order.map((id) => {
      const inst = browser.instances[id];
      return { browserId: id, url: inst?.currentUrl || inst?.loadedUrl || '' };
    }),
    settingsOpen: ui.settingsOpen,
    layout: ui.layout,
    activeGroupId: ui.activeGroupId,
  };
}

/** Rebuild a persisted layout subtree: remap tab keys old→new, drop keys whose
 *  entity wasn't restored (not in `live`), and mint fresh group/split ids
 *  (recording old→new group ids so the active group can be re-resolved). */
function rebuild(
  node: LayoutNode,
  keyRemap: Map<TabKey, TabKey>,
  live: Set<TabKey>,
  groupIdMap: Map<string, string>,
): LayoutNode | null {
  if (node.type === 'group') {
    const tabs = node.tabs.map((k) => keyRemap.get(k) ?? k).filter((k) => live.has(k));
    if (tabs.length === 0) return null;
    const oldActive = node.tabs[node.activeIndex];
    const mappedActive = oldActive ? (keyRemap.get(oldActive) ?? oldActive) : undefined;
    const ai = mappedActive ? tabs.indexOf(mappedActive) : 0;
    const g = makeGroup(tabs, ai < 0 ? 0 : ai);
    groupIdMap.set(node.id, g.id);
    return g;
  }
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const rc = rebuild(c, keyRemap, live, groupIdMap);
    if (rc) { children.push(rc); sizes.push(node.sizes[i] ?? 1 / node.children.length); }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]; // collapse; normalize re-wraps the root
  const sum = sizes.reduce((a, b) => a + b, 0) || 1;
  return { type: 'split', id: newSplitId(), direction: node.direction, children, sizes: sizes.map((s) => s / sum) };
}

/** Recreate every tab in the snapshot, then install the (remapped) layout. */
export async function restoreWorkspace(snap: WorkspaceSnapshot): Promise<void> {
  restoring = true;
  try {
    await rebuildFromSnapshot(snap);
  } finally {
    restoring = false;
  }
}

async function rebuildFromSnapshot(snap: WorkspaceSnapshot): Promise<void> {
  const keyRemap = new Map<TabKey, TabKey>();

  // Files — keys (`file:<path>`) are stable, so no remap needed.
  for (const path of snap.files) {
    const u = snap.unsaved?.[path];
    if (isUntitledPath(path)) {
      // Synthetic path: openFile would error. Recreate the scratch buffer with
      // its preserved (hot-exit) content directly.
      useWorkspaceStore.getState().restoreScratch(path, u?.content ?? '');
      continue;
    }
    try { await useWorkspaceStore.getState().openFile(path, { focus: false }); } catch { /* file gone — drop it */ }
    // Re-apply unsaved edits on top of the freshly-read disk content.
    if (u) useWorkspaceStore.getState().applyUnsaved(path, u.content, u.saved);
  }

  // Browsers — `openBrowser` mints a new id; remap `browser:<old>` → `browser:<new>`.
  for (const b of snap.browsers) {
    const newId = useBrowserStore.getState().openBrowser({ url: b.url || undefined, focus: false });
    keyRemap.set(`browser:${b.browserId}`, `browser:${newId}`);
  }

  // Conversations — only those with a sessionId can be resumed (history reloads
  // from the agent). Unsent conversations (no session) are dropped.
  for (const c of snap.convs) {
    if (!c.sessionId) continue;
    const newId = useTasksStore.getState().resumeSession({ id: c.sessionId, title: c.title });
    keyRemap.set(`conv:${c.taskId}`, `conv:${newId}`);
  }

  if (snap.settingsOpen) useUiStore.getState().openSettings();

  // The keys that now actually exist (same shape as TaskWorkspace's `live`).
  const live = new Set<TabKey>([
    ...useWorkspaceStore.getState().workingFiles.map((p) => `file:${p}`),
    ...useBrowserStore.getState().order.map((id) => `browser:${id}`),
    ...useTasksStore.getState().tasks.map((t) => `conv:${t.id}`),
    ...(useUiStore.getState().settingsOpen ? ['settings:'] : []),
  ]);

  const groupIdMap = new Map<string, string>();
  const rebuilt = snap.layout ? normalize(rebuild(snap.layout, keyRemap, live, groupIdMap)) : null;
  if (!rebuilt) return; // nothing survived — leave the (empty) workspace as-is

  const mappedActive = snap.activeGroupId ? groupIdMap.get(snap.activeGroupId) : undefined;
  const activeGroupId = mappedActive && findGroup(rebuilt, mappedActive) ? mappedActive : firstGroup(rebuilt).id;
  useUiStore.getState().restoreLayout(rebuilt, activeGroupId);

  // Align the active task/browser with the focused group's active tab (there's
  // no click to do it during restore).
  const g = findGroup(rebuilt, activeGroupId);
  const activeKey = g ? activeKeyOf(g) : undefined;
  if (activeKey) {
    const t = parseTabKey(activeKey);
    if (t.kind === 'conv') useTasksStore.getState().selectTask(t.taskId);
    else if (t.kind === 'browser') useBrowserStore.getState().setActive(t.id);
  }
}

/**
 * Decide whether to OPEN a project on launch (the manager then restores its
 * tabs once the project is open — see installWorkspaceManager):
 *  1. Reopen this window's project if the main process still holds its root
 *     (the Cmd+R reload case).
 *  2. Otherwise, on a cold launch, optionally reopen the most-recent project.
 * No-ops if a project is already open.
 */
export async function restoreWorkspaceOnStartup(): Promise<void> {
  const hasProject = () => !!useWorkspaceStore.getState().root;
  if (hasProject()) return;

  // The main process holds this window's root — set on a reload (Cmd+R) AND
  // pre-seeded on a COLD launch when main restores the previous session's
  // windows (one per project). This single check covers both: reopen that
  // project, after which the workspace manager restores its tabs + unsaved
  // content (hot-exit).
  const current = await window.ccb.fs.currentRoot?.();
  if (current?.root && !hasProject()) {
    await useWorkspaceStore.getState().openFolder(current.root);
    return;
  }

  // Otherwise (e.g. quit from Home → no project was open): optionally reopen the
  // most-recent project per the preference.
  const settings = await window.ccb.settings.load();
  if (!settings.general.reopenLastProject || hasProject()) return;
  const recents = await window.ccb.recents.list();
  if (recents.length > 0 && !hasProject()) await useWorkspaceStore.getState().openFolder(recents[0].path);
}

function workspaceHasTabs(): boolean {
  return useWorkspaceStore.getState().workingFiles.length > 0
    || useTasksStore.getState().tasks.length > 0
    || useBrowserStore.getState().order.length > 0
    || useUiStore.getState().settingsOpen;
}

/**
 * Wire up tab persistence + restore for the lifetime of the app window:
 *  • Restore — whenever a project opens into an EMPTY workspace (reload,
 *    restart+reopen-last, or reopening from Home), load that project's saved
 *    snapshot (by root) and rebuild its tabs/layout.
 *  • Persist — on every workspace change (debounced) + a `pagehide` flush, so
 *    the latest layout is always saved. Suppressed while a restore is running.
 * Returns a cleanup fn.
 */
export function installWorkspaceManager(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = (): void => {
    if (restoring) return;
    const snap = captureSnapshot();
    if (snap) window.ccb.workspace?.saveSnapshot(snap);
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; save(); }, 400);
  };
  const flush = (): void => { if (timer) { clearTimeout(timer); timer = null; } save(); };

  const tryRestore = async (root: string | null): Promise<void> => {
    if (!root || restoring || workspaceHasTabs()) return;
    const snap = (await window.ccb.workspace?.getSnapshot?.(root)) as WorkspaceSnapshot | null;
    // Re-check after the await — the open may have changed/raced.
    if (!snap || snap.root !== root || workspaceHasTabs() || useWorkspaceStore.getState().root !== root) return;
    await restoreWorkspace(snap);
    save(); // persist the normalized, id-remapped layout
  };

  const unsubRoot = useWorkspaceStore.subscribe((s, prev) => {
    if (s.root && s.root !== prev.root) void tryRestore(s.root);
  });
  const unsubs = [
    useUiStore.subscribe(schedule),
    useWorkspaceStore.subscribe(schedule),
    useTasksStore.subscribe(schedule),
    useBrowserStore.subscribe(schedule),
  ];
  window.addEventListener('pagehide', flush);

  // A project may already be open by the time we install (rare on mount).
  void tryRestore(useWorkspaceStore.getState().root);

  return () => {
    unsubRoot();
    for (const u of unsubs) u();
    window.removeEventListener('pagehide', flush);
    if (timer) clearTimeout(timer);
  };
}
