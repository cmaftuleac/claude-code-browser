import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageSquareText, Globe, X, Circle, AlertTriangle, ExternalLink, FolderInput, Copy, Columns2, Rows2, Settings as SettingsIcon } from 'lucide-react';
import { useTasksStore } from '../stores/tasks-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useBrowserStore } from '../stores/browser-store';
import { useUiStore, type ActiveTab } from '../stores/ui-store';
import { useTabDragStore } from '../stores/tab-drag-store';
import { startTabDrag } from '../lib/tab-dnd';
import { type GroupNode, activeKeyOf } from '../lib/pane-layout';
import { parseTabKey, tabKey, type TabKey } from '../lib/tab-key';
import { isUntitledPath, untitledName } from '../lib/untitled';
import { iconFor } from '../lib/file-icon';
import { ContextMenu, type CtxItem } from './ContextMenu';

const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

type MenuAnchor = { x: number; y: number; tab: ActiveTab };

/**
 * One editor group's tab strip. Tabs are equal-citizens of three kinds (conv /
 * file / browser); the strip is driven by `group.tabs` and shows that group's
 * own active tab. Clicking focuses the tab (and its group). Splitting moves the
 * active tab into a new pane — or, when the group has a single tab, opens a
 * fresh untitled scratch file there — so the split buttons are always usable.
 * Close-others / close-all / close-to-the-right are scoped to THIS group.
 */
export function GroupTabBar({ group }: { group: GroupNode }) {
  const tasks = useTasksStore((s) => s.tasks);
  const deleteTask = useTasksStore((s) => s.deleteTask);
  const selectTask = useTasksStore((s) => s.selectTask);
  const fileBuffers = useWorkspaceStore((s) => s.fileBuffers);
  const closeFile = useWorkspaceStore((s) => s.closeFile);
  const root = useWorkspaceStore((s) => s.root);
  const browserInstances = useBrowserStore((s) => s.instances);
  const closeBrowser = useBrowserStore((s) => s.closeBrowser);
  const focusTab = useUiStore((s) => s.focusTab);
  const splitGroup = useUiStore((s) => s.splitGroup);
  const draggingKey = useTabDragStore((s) => s.key);
  const dropTarget = useTabDragStore((s) => s.target);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  // Insertion index for the drop line while a tab is dragged over THIS strip.
  const dropIndex = dropTarget && dropTarget.groupId === group.id ? dropTarget.index : null;

  const activeKey = activeKeyOf(group);
  const underlineId = `ws-tab-underline-${group.id}`;
  // The Settings tab is a global singleton — splitting it makes no sense, so we
  // hide the split affordances (top-right buttons + context-menu items) for it.
  const activeIsSettings = activeKey ? parseTabKey(activeKey).kind === 'settings' : false;
  // Tabs in THIS group, by kind (in strip order) — close-* commands are scoped here.
  const groupFilePaths = group.tabs.map(parseTabKey).filter((t) => t.kind === 'file').map((t) => (t as { path: string }).path);
  const groupConvIds = group.tabs.map(parseTabKey).filter((t) => t.kind === 'conv').map((t) => (t as { taskId: string }).taskId);

  const barRef = useRef<HTMLDivElement | null>(null);
  // Scroll the active tab into view whenever it changes within this group.
  useEffect(() => {
    if (!activeKey) return;
    const el = barRef.current?.querySelector<HTMLDivElement>(`[data-tab-key="${CSS.escape(activeKey)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  }, [activeKey]);

  const focus = (tab: ActiveTab): void => {
    focusTab(tabKey(tab));
    if (tab.kind === 'conv') selectTask(tab.taskId);
  };

  const closeTab = (tab: ActiveTab): void => {
    // Layout focus follows via the reconcile effect; just drop the entity.
    if (tab.kind === 'conv') deleteTask(tab.taskId);
    else if (tab.kind === 'file') closeFile(tab.path);
    else if (tab.kind === 'settings') useUiStore.getState().closeSettings();
    else closeBrowser(tab.id);
  };

  /** Split moving a specific tab (focus it first so it's the one that moves). */
  const splitTab = (key: TabKey, direction: 'row' | 'column'): void => {
    focusTab(key);
    splitGroup(group.id, direction, 'after');
  };

  // Tab drag-and-drop is pointer-based (see lib/tab-dnd.ts): a tab's
  // onPointerDown starts the drag, the controller tracks the cursor and resolves
  // the drop target via data-strip-group / data-pane-group, and the drop line /
  // pane highlight are derived from the drag store's `target` (dropIndex above).

  const openMenu = (e: React.MouseEvent, tab: ActiveTab): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, tab });
  };

  const copyPath = (path: string, relative: boolean): void => {
    const p = relative && root && path.startsWith(root)
      ? path.slice(root.length).replace(/^\//, '')
      : path;
    void navigator.clipboard.writeText(p).catch(() => { /* clipboard blocked */ });
  };

  const buildItems = (anchor: MenuAnchor): CtxItem[] => {
    const isElectron = window.ccb.isElectron;
    const tab = anchor.tab;
    const key = tabKey(tab);
    const splitItems: CtxItem[] = [
      { kind: 'item', label: 'Split Right', icon: <Columns2 size={13} strokeWidth={1.75} />, onActivate: () => splitTab(key, 'row') },
      { kind: 'item', label: 'Split Down', icon: <Rows2 size={13} strokeWidth={1.75} />, onActivate: () => splitTab(key, 'column') },
      { kind: 'divider' },
    ];
    if (tab.kind === 'browser') {
      return [
        ...splitItems,
        { kind: 'item', label: 'Close Preview', icon: <X size={13} strokeWidth={1.75} />, onActivate: () => closeTab(tab) },
      ];
    }
    if (tab.kind === 'settings') {
      return [
        { kind: 'item', label: 'Close', icon: <X size={13} strokeWidth={1.75} />, onActivate: () => closeTab(tab) },
      ];
    }
    if (tab.kind === 'conv') {
      const others = groupConvIds.filter((id) => id !== tab.taskId);
      return [
        ...splitItems,
        { kind: 'item', label: 'Close', icon: <X size={13} strokeWidth={1.75} />, onActivate: () => closeTab(tab) },
        // Re-assert the kept conversation as active afterward, so deleteTask's
        // global neighbor pick doesn't leave focus on a conv in another pane.
        { kind: 'item', label: 'Close Other Conversations', disabled: others.length === 0, onActivate: () => { others.forEach((id) => deleteTask(id)); selectTask(tab.taskId); } },
        { kind: 'item', label: 'Close All Conversations', disabled: groupConvIds.length === 0, onActivate: () => groupConvIds.forEach((id) => deleteTask(id)) },
      ];
    }
    // File tab — close commands scoped to file tabs in THIS group.
    const path = tab.path;
    const untitled = isUntitledPath(path);
    const idx = groupFilePaths.indexOf(path);
    const others = groupFilePaths.filter((p) => p !== path);
    const toRight = idx >= 0 ? groupFilePaths.slice(idx + 1) : [];
    return [
      ...splitItems,
      { kind: 'item', label: 'Close', icon: <X size={13} strokeWidth={1.75} />, onActivate: () => closeTab(tab) },
      { kind: 'item', label: 'Close Other Files', disabled: others.length === 0, onActivate: () => others.forEach((p) => closeFile(p)) },
      { kind: 'item', label: 'Close Files to the Right', disabled: toRight.length === 0, onActivate: () => toRight.forEach((p) => closeFile(p)) },
      { kind: 'item', label: 'Close All Files', disabled: groupFilePaths.length === 0, onActivate: () => groupFilePaths.forEach((p) => closeFile(p)) },
      ...(untitled
        ? []
        : [
            { kind: 'divider' as const },
            { kind: 'item' as const, label: 'Copy Path', icon: <Copy size={13} strokeWidth={1.75} />, onActivate: () => copyPath(path, false) },
            { kind: 'item' as const, label: 'Copy Relative Path', icon: <Copy size={13} strokeWidth={1.75} />, onActivate: () => copyPath(path, true) },
            ...(isElectron
              ? [
                  { kind: 'divider' as const },
                  { kind: 'item' as const, label: 'Reveal in Finder', icon: <FolderInput size={13} strokeWidth={1.75} />, onActivate: () => { void window.ccb.fs.revealInFinder(path); } },
                  { kind: 'item' as const, label: 'Open With…', icon: <ExternalLink size={13} strokeWidth={1.75} />, onActivate: () => { void window.ccb.fs.openWith(path); } },
                ]
              : []),
          ]),
    ];
  };

  return (
    <div className="ws-tabs" ref={barRef}>
      <div className="ws-tabs__strip" data-strip-group={group.id}>
        <AnimatePresence initial={false} mode="popLayout">
          {group.tabs.map((key, i) => {
            const tab = parseTabKey(key);
            const active = key === activeKey;
            const dropBefore = dropIndex === i;
            const dropAfter = dropIndex === group.tabs.length && i === group.tabs.length - 1;

            // Resolve label / icon / dirty state from the live stores.
            let label: string;
            let title: string;
            let icon: React.ReactNode;
            let iconHue: string | undefined;
            let dirty = false;
            let conflict = false;
            if (tab.kind === 'conv') {
              title = label = tasks.find((t) => t.id === tab.taskId)?.title ?? 'Conversation';
              icon = <MessageSquareText size={13} strokeWidth={1.75} />;
            } else if (tab.kind === 'settings') {
              title = label = 'Settings';
              icon = <SettingsIcon size={13} strokeWidth={1.75} />;
            } else if (tab.kind === 'browser') {
              const inst = browserInstances[tab.id];
              let host = '';
              try { host = inst?.currentUrl ? new URL(inst.currentUrl).host : ''; } catch { /* not a URL yet */ }
              label = title = inst?.title?.trim() || host || 'New Tab';
              icon = <Globe size={13} strokeWidth={1.75} />;
            } else if (isUntitledPath(tab.path)) {
              label = untitledName(tab.path);
              title = `${label} — not saved`;
              const spec = iconFor(label);
              const FI = spec.Icon;
              icon = <FI size={13} strokeWidth={1.75} />;
              iconHue = spec.hue;
              const buf = fileBuffers[tab.path];
              dirty = !!(buf?.kind === 'text' && buf.content !== buf.saved);
            } else {
              title = tab.path;
              label = tab.path.split('/').pop() ?? tab.path;
              const spec = iconFor(label);
              const FI = spec.Icon;
              icon = <FI size={13} strokeWidth={1.75} />;
              iconHue = spec.hue;
              const buf = fileBuffers[tab.path];
              const isText = buf?.kind === 'text';
              dirty = !!(isText && buf.content !== buf.saved);
              conflict = !!(isText && buf.conflict);
            }

            const closeTitle = tab.kind === 'conv' ? 'Close conversation'
              : tab.kind === 'browser' ? 'Close preview'
              : conflict ? 'Disk changed' : dirty ? 'Unsaved changes' : 'Close';

            return (
              <motion.div
                key={key}
                data-tab-key={key}
                layout
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={ANIM}
                className={`ws-tab ${active ? 'is-active' : ''} ${tab.kind === 'browser' && browserInstances[tab.id]?.hint && !active ? 'is-pulsing' : ''} ${key === draggingKey ? 'is-dragging' : ''} ${dropBefore ? 'is-drop-before' : ''} ${dropAfter ? 'is-drop-after' : ''}`}
                role="button"
                tabIndex={0}
                onPointerDown={(e) => startTabDrag(e, key)}
                onClick={() => focus(tab)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focus(tab); } }}
                onContextMenu={(e) => openMenu(e, tab)}
                title={title}
              >
                <span className="ws-tab__icon" style={iconHue ? { color: iconHue } : undefined}>{icon}</span>
                <span className="ws-tab__title">{label}</span>
                <button
                  className={`ws-tab__close ${dirty ? 'is-dirty' : ''} ${conflict ? 'is-conflict' : ''}`}
                  onClick={(e) => { e.stopPropagation(); closeTab(tab); }}
                  title={closeTitle}
                  aria-label={closeTitle}
                >
                  {conflict ? <AlertTriangle size={11} strokeWidth={2} />
                    : dirty ? <Circle size={7} fill="currentColor" strokeWidth={0} />
                      : <X size={12} strokeWidth={2} />}
                </button>
                {active && <motion.span layoutId={underlineId} className="ws-tab__indicator" transition={ANIM} />}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {!activeIsSettings && (
        <div className="ws-tabs__actions">
          <button className="ws-tabs__split-btn" onClick={() => splitGroup(group.id, 'row', 'after')} title="Split right" aria-label="Split right">
            <Columns2 size={14} strokeWidth={1.75} />
          </button>
          <button className="ws-tabs__split-btn" onClick={() => splitGroup(group.id, 'column', 'after')} title="Split down" aria-label="Split down">
            <Rows2 size={14} strokeWidth={1.75} />
          </button>
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={buildItems(menu)} onDismiss={() => setMenu(null)} />
      )}
    </div>
  );
}
