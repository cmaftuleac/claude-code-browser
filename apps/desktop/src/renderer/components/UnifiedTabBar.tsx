import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageSquareText, Globe, X, Circle, AlertTriangle, ExternalLink, FolderInput, Copy } from 'lucide-react';
import { useTasksStore } from '../stores/tasks-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useUiStore, type ActiveTab } from '../stores/ui-store';
import { iconFor } from '../lib/file-icon';
import { ContextMenu, type CtxItem } from './ContextMenu';

const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

type MenuAnchor = { x: number; y: number; tab: ActiveTab };

/**
 * Top tab bar. Tabs are equal-citizens of three kinds:
 *   • one conv tab per task (chat conversations)
 *   • one file tab per open file (project-wide; survives conv switches)
 *   • one browser tab per task that has surfaces.browser === true
 * Active tab is tracked in ui-store; tab clicks set it.
 */
export function UnifiedTabBar() {
  const tasks = useTasksStore((s) => s.tasks);
  const closeBrowserSurface = useTasksStore((s) => s.closeBrowserSurface);
  const deleteTask = useTasksStore((s) => s.deleteTask);
  const selectTask = useTasksStore((s) => s.selectTask);
  const workingFiles = useWorkspaceStore((s) => s.workingFiles);
  const fileBuffers = useWorkspaceStore((s) => s.fileBuffers);
  const closeFile = useWorkspaceStore((s) => s.closeFile);
  const closeAllFiles = useWorkspaceStore((s) => s.closeAllFiles);
  const closeOthers = useWorkspaceStore((s) => s.closeOthers);
  const closeToRight = useWorkspaceStore((s) => s.closeToRight);
  const root = useWorkspaceStore((s) => s.root);
  const activeTab = useUiStore((s) => s.activeTab);
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const clearActiveTab = useUiStore((s) => s.clearActiveTab);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);

  const browserTasks = tasks.filter((t) => t.surfaces.browser);
  const barRef = useRef<HTMLDivElement | null>(null);
  // Identifier of the *currently-active* tab — used to scroll it into view
  // whenever it changes (covers both "new tab created" and "user clicked").
  const activeKey =
    activeTab?.kind === 'conv' ? `conv:${activeTab.taskId}`
    : activeTab?.kind === 'file' ? `file:${activeTab.path}`
    : activeTab?.kind === 'browser' ? `browser:${activeTab.taskId}`
    : null;
  useEffect(() => {
    if (!activeKey) return;
    const bar = barRef.current;
    if (!bar) return;
    const el = bar.querySelector<HTMLDivElement>(`[data-tab-key="${CSS.escape(activeKey)}"]`);
    if (!el) return;
    // smooth scrollIntoView with inline:'nearest' keeps the bar mostly stable
    // when the tab is already visible, but reveals it fully when at an edge.
    el.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  }, [activeKey]);

  // Nothing to show? Empty tab bar (parent renders an empty hero).
  const hasAnyTab = tasks.length > 0 || workingFiles.length > 0 || browserTasks.length > 0;
  if (!hasAnyTab) return <div className="ws-tabs" />;

  const isActive = (t: ActiveTab): boolean => {
    if (!activeTab) return false;
    if (activeTab.kind !== t.kind) return false;
    if (t.kind === 'conv' && activeTab.kind === 'conv') return activeTab.taskId === t.taskId;
    if (t.kind === 'browser' && activeTab.kind === 'browser') return activeTab.taskId === t.taskId;
    if (t.kind === 'file' && activeTab.kind === 'file') return activeTab.path === t.path;
    return false;
  };

  /** Pick the next sensible tab after a close. Used by every close path. */
  const pickNextAfterClose = (closing: ActiveTab): ActiveTab | null => {
    // Try same kind first, then any other tab.
    if (closing.kind === 'conv') {
      const idx = tasks.findIndex((t) => t.id === closing.taskId);
      const sibling = tasks[idx + 1] ?? tasks[idx - 1];
      if (sibling) return { kind: 'conv', taskId: sibling.id };
    }
    if (closing.kind === 'file') {
      const idx = workingFiles.indexOf(closing.path);
      const sibling = workingFiles[idx + 1] ?? workingFiles[idx - 1];
      if (sibling) return { kind: 'file', path: sibling };
    }
    if (closing.kind === 'browser') {
      // After closing a browser, fall back to its task's conv.
      return { kind: 'conv', taskId: closing.taskId };
    }
    // Cross-kind fallback.
    const otherTask = tasks.find((t) => closing.kind !== 'conv' || t.id !== closing.taskId);
    if (otherTask) return { kind: 'conv', taskId: otherTask.id };
    const otherFile = workingFiles.find((p) => closing.kind !== 'file' || p !== closing.path);
    if (otherFile) return { kind: 'file', path: otherFile };
    return null;
  };

  const closeTab = (tab: ActiveTab): void => {
    const wasActive = isActive(tab);
    const next = wasActive ? pickNextAfterClose(tab) : null;
    if (tab.kind === 'conv') deleteTask(tab.taskId);
    else if (tab.kind === 'file') closeFile(tab.path);
    else if (tab.kind === 'browser') closeBrowserSurface(tab.taskId);
    if (wasActive) {
      if (next) setActiveTab(next);
      else clearActiveTab();
    }
  };

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
    if (tab.kind === 'browser') {
      return [{ kind: 'item', label: 'Close Preview', icon: <X size={13} strokeWidth={1.75} />, onActivate: () => closeTab(tab) }];
    }
    if (tab.kind === 'conv') {
      const otherConvs = tasks.length - 1;
      const closeAllConvs = (): void => {
        for (const t of [...tasks]) deleteTask(t.id);
      };
      const closeOtherConvs = (): void => {
        for (const t of [...tasks]) if (t.id !== tab.taskId) deleteTask(t.id);
      };
      return [
        { kind: 'item', label: 'Close', icon: <X size={13} strokeWidth={1.75} />, onActivate: () => closeTab(tab) },
        { kind: 'item', label: 'Close Other Conversations', disabled: otherConvs <= 0, onActivate: closeOtherConvs },
        { kind: 'item', label: 'Close All Conversations', disabled: tasks.length <= 1, onActivate: closeAllConvs },
      ];
    }
    // File tab
    const path = tab.path;
    const filesOpen = workingFiles.length;
    const idx = workingFiles.indexOf(path);
    const toRight = idx >= 0 ? filesOpen - idx - 1 : 0;
    return [
      { kind: 'item', label: 'Close', icon: <X size={13} strokeWidth={1.75} />, onActivate: () => closeTab(tab) },
      { kind: 'item', label: 'Close Others', disabled: filesOpen <= 1, onActivate: () => closeOthers(path) },
      { kind: 'item', label: 'Close to the Right', disabled: toRight <= 0, onActivate: () => closeToRight(path) },
      { kind: 'item', label: 'Close All Files', disabled: filesOpen <= 1, onActivate: () => closeAllFiles() },
      { kind: 'divider' },
      { kind: 'item', label: 'Copy Path', icon: <Copy size={13} strokeWidth={1.75} />, onActivate: () => copyPath(path, false) },
      { kind: 'item', label: 'Copy Relative Path', icon: <Copy size={13} strokeWidth={1.75} />, onActivate: () => copyPath(path, true) },
      ...(isElectron
        ? [
            { kind: 'divider' as const },
            { kind: 'item' as const, label: 'Reveal in Finder', icon: <FolderInput size={13} strokeWidth={1.75} />, onActivate: () => { void window.ccb.fs.revealInFinder(path); } },
            { kind: 'item' as const, label: 'Open With…', icon: <ExternalLink size={13} strokeWidth={1.75} />, onActivate: () => { void window.ccb.fs.openWith(path); } },
          ]
        : []),
    ];
  };

  return (
    <div className="ws-tabs" ref={barRef}>
      <AnimatePresence initial={false} mode="popLayout">
        {/* Conv tabs — one per task. */}
        {tasks.map((task) => {
          const tab: ActiveTab = { kind: 'conv', taskId: task.id };
          const active = isActive(tab);
          return (
            <motion.div
              key={`conv:${task.id}`}
              data-tab-key={`conv:${task.id}`}
              layout
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={ANIM}
              className={`ws-tab ${active ? 'is-active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => { setActiveTab(tab); selectTask(task.id); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveTab(tab); selectTask(task.id); } }}
              onContextMenu={(e) => openMenu(e, tab)}
              title={task.title}
            >
              <span className="ws-tab__icon"><MessageSquareText size={13} strokeWidth={1.75} /></span>
              <span className="ws-tab__title">{task.title}</span>
              <button
                className="ws-tab__close"
                onClick={(e) => { e.stopPropagation(); closeTab(tab); }}
                title="Close conversation"
                aria-label="Close conversation"
              >
                <X size={12} strokeWidth={2} />
              </button>
              {active && <motion.span layoutId="ws-tab-underline" className="ws-tab__indicator" transition={ANIM} />}
            </motion.div>
          );
        })}

        {/* File tabs — project-wide. Persist across conv switches. */}
        {workingFiles.map((path) => {
          const tab: ActiveTab = { kind: 'file', path };
          const active = isActive(tab);
          const buf = fileBuffers[path];
          const isText = buf?.kind === 'text';
          const dirty = isText && buf.content !== buf.saved;
          const conflict = isText && buf.conflict;
          const filename = path.split('/').pop() ?? path;
          const spec = iconFor(filename);
          const FI = spec.Icon;
          return (
            <motion.div
              key={`file:${path}`}
              data-tab-key={`file:${path}`}
              layout
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={ANIM}
              className={`ws-tab ${active ? 'is-active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => setActiveTab(tab)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveTab(tab); } }}
              onContextMenu={(e) => openMenu(e, tab)}
              title={path}
            >
              <span className="ws-tab__icon" style={spec.hue ? { color: spec.hue } : undefined}>
                <FI size={13} strokeWidth={1.75} />
              </span>
              <span className="ws-tab__title">{filename}</span>
              <button
                className={`ws-tab__close ${dirty ? 'is-dirty' : ''} ${conflict ? 'is-conflict' : ''}`}
                onClick={(e) => { e.stopPropagation(); closeTab(tab); }}
                title={conflict ? 'Disk changed' : dirty ? 'Unsaved changes' : 'Close'}
              >
                {conflict ? <AlertTriangle size={11} strokeWidth={2} />
                  : dirty ? <Circle size={7} fill="currentColor" strokeWidth={0} />
                    : <X size={12} strokeWidth={2} />}
              </button>
              {active && <motion.span layoutId="ws-tab-underline" className="ws-tab__indicator" transition={ANIM} />}
            </motion.div>
          );
        })}

        {/* Browser tabs — one per task that opened a browser surface. */}
        {browserTasks.map((task) => {
          const tab: ActiveTab = { kind: 'browser', taskId: task.id };
          const active = isActive(tab);
          return (
            <motion.div
              key={`browser:${task.id}`}
              data-tab-key={`browser:${task.id}`}
              layout
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={ANIM}
              className={`ws-tab ${active ? 'is-active' : ''} ${task.surfaceHint === 'browser' && !active ? 'is-pulsing' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => setActiveTab(tab)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveTab(tab); } }}
              onContextMenu={(e) => openMenu(e, tab)}
              title={`Preview · ${task.title}`}
            >
              <span className="ws-tab__icon"><Globe size={13} strokeWidth={1.75} /></span>
              <span className="ws-tab__title">Preview</span>
              <button
                className="ws-tab__close"
                onClick={(e) => { e.stopPropagation(); closeTab(tab); }}
                title="Close preview"
              >
                <X size={12} strokeWidth={2} />
              </button>
              {active && <motion.span layoutId="ws-tab-underline" className="ws-tab__indicator" transition={ANIM} />}
            </motion.div>
          );
        })}
      </AnimatePresence>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildItems(menu)}
          onDismiss={() => setMenu(null)}
        />
      )}
    </div>
  );
}
