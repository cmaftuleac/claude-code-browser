import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FilePlus2, MessageSquareText, Sparkles, FolderTree, Globe, Plus } from 'lucide-react';
import { useTasksStore } from '../stores/tasks-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useUiStore } from '../stores/ui-store';
import { UnifiedTabBar } from './UnifiedTabBar';
import { TaskDocument } from './TaskDocument';
import { FileTabBody } from './FileTabBody';
import { BrowserSurface } from './BrowserSurface';
import { Composer } from './Composer';
import { TREE_DRAG_MIME, extractDroppedPaths } from '../lib/drop-paths';

export function TaskWorkspace() {
  const tasks = useTasksStore((s) => s.tasks);
  const workingFiles = useWorkspaceStore((s) => s.workingFiles);
  const activeTab = useUiStore((s) => s.activeTab);
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const clearActiveTab = useUiStore((s) => s.clearActiveTab);
  const [dragHint, setDragHint] = useState(false);

  // Keep `activeTab` in sync with what actually exists. Three cases:
  //   1. activeTab points to a tab that no longer exists → pick first
  //      available, or clear if nothing left (so Cmd+W can fall through to
  //      closeProject instead of short-circuiting on a stale tab).
  //   2. activeTab is null but tabs exist → focus the first.
  //   3. Otherwise nothing to do.
  // This effect MUST run before any early-return below so hook order stays
  // stable across renders.
  useEffect(() => {
    const tabExists = (): boolean => {
      if (!activeTab) return false;
      if (activeTab.kind === 'conv') return tasks.some((t) => t.id === activeTab.taskId);
      if (activeTab.kind === 'file') return workingFiles.includes(activeTab.path);
      if (activeTab.kind === 'browser') return tasks.some((t) => t.id === activeTab.taskId && t.surfaces.browser);
      return false;
    };
    if (activeTab && tabExists()) return;
    if (tasks.length > 0) setActiveTab({ kind: 'conv', taskId: tasks[0].id });
    else if (workingFiles.length > 0) setActiveTab({ kind: 'file', path: workingFiles[0] });
    else if (activeTab != null) clearActiveTab();
  }, [activeTab, tasks, workingFiles, setActiveTab, clearActiveTab]);

  // Empty hero: no tabs at all (no tasks AND no files AND no browser).
  const anyBrowser = tasks.some((t) => t.surfaces.browser);
  const isEmpty = tasks.length === 0 && workingFiles.length === 0 && !anyBrowser;
  if (isEmpty) {
    return <EmptyWorkspace />;
  }

  const isExternalFileDrag = (dt: DataTransfer | null): boolean => {
    if (!dt) return false;
    const types = Array.from(dt.types ?? []);
    return types.includes('Files') && !types.includes(TREE_DRAG_MIME);
  };
  const isOverComposer = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest('.composer') != null;
  const isStillInside = (e: React.DragEvent): boolean =>
    e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget);

  const onDragEnter = (e: React.DragEvent): void => {
    if (!isExternalFileDrag(e.dataTransfer)) return;
    if (isOverComposer(e.target)) { if (dragHint) setDragHint(false); return; }
    if (!dragHint) setDragHint(true);
  };
  const onDragOver = (e: React.DragEvent): void => {
    if (!isExternalFileDrag(e.dataTransfer)) return;
    if (isOverComposer(e.target)) { if (dragHint) setDragHint(false); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragHint) setDragHint(true);
  };
  const onDragLeave = (e: React.DragEvent): void => {
    if (!isExternalFileDrag(e.dataTransfer)) return;
    if (isStillInside(e)) return;
    if (dragHint) setDragHint(false);
  };
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    if (!isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    if (dragHint) setDragHint(false);
    const { paths } = extractDroppedPaths(e.dataTransfer);
    if (paths.length === 0) return;
    for (const p of paths) {
      const st = await window.ccb.fs.statFile(p);
      if (st.error) continue;
      await useWorkspaceStore.getState().openFile(p);
    }
  };

  // Every open tab stays mounted (toggled with `hidden`) so Monaco models, chat
  // scroll, and webview state survive tab switches.
  return (
    <section className="task-workspace">
      <UnifiedTabBar />
      <div
        className="workspace-body"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(e) => void onDrop(e)}
      >
        {/* Conv panes — one per task, hidden unless it's the active conv tab. */}
        {tasks.map((t) => (
          <div
            key={`pane-conv:${t.id}`}
            className="workspace-pane"
            hidden={!(activeTab?.kind === 'conv' && activeTab.taskId === t.id)}
          >
            <TaskDocument taskId={t.id} />
            <Composer taskId={t.id} />
          </div>
        ))}
        {/* File panes — one per open file. */}
        {workingFiles.map((path) => (
          <div
            key={`pane-file:${path}`}
            className="workspace-pane"
            hidden={!(activeTab?.kind === 'file' && activeTab.path === path)}
          >
            <FileTabBody path={path} />
          </div>
        ))}
        {/* Browser panes — one per task that has its browser surface open. */}
        {tasks.filter((t) => t.surfaces.browser).map((t) => (
          <div
            key={`pane-browser:${t.id}`}
            className="workspace-pane"
            hidden={!(activeTab?.kind === 'browser' && activeTab.taskId === t.id)}
          >
            <BrowserSurface />
          </div>
        ))}

        <AnimatePresence>
          {dragHint && (
            <motion.div
              key="drop-hint"
              className="workspace-drop-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              <motion.div
                className="workspace-drop-overlay__card"
                initial={{ opacity: 0, scale: 0.96, y: 4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 4 }}
                transition={{ duration: 0.14, ease: [0.4, 0, 0.2, 1] }}
              >
                <FilePlus2 size={20} strokeWidth={1.75} />
                <span>Drop files to open</span>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

/**
 * Hero rendered when no tabs of any kind are open. Project stays loaded —
 * file tree on the right, recents in TasksRail — so this is purely a CTA
 * surface, not a "nothing to see here" dead end.
 */
function EmptyWorkspace() {
  const newConversation = useTasksStore((s) => s.newConversation);
  const projectName = useWorkspaceStore((s) => s.name);
  const ANIM = { duration: 0.28, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

  return (
    <div className="task-empty-screen">
      <motion.div
        className="task-empty"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={ANIM}
      >
        <motion.div
          className="task-empty__glyph"
          initial={{ scale: 0.92, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ ...ANIM, delay: 0.04 }}
        >
          <span className="task-empty__halo" aria-hidden />
          <span className="task-empty__ring task-empty__ring--chat" aria-hidden>
            <MessageSquareText size={16} strokeWidth={1.75} />
          </span>
          <span className="task-empty__ring task-empty__ring--tree" aria-hidden>
            <FolderTree size={16} strokeWidth={1.75} />
          </span>
          <span className="task-empty__ring task-empty__ring--browser" aria-hidden>
            <Globe size={16} strokeWidth={1.75} />
          </span>
          <span className="task-empty__core">
            <Sparkles size={32} strokeWidth={1.5} />
          </span>
        </motion.div>

        <motion.h1
          className="task-empty__heading"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...ANIM, delay: 0.08 }}
        >
          Ready when you are
        </motion.h1>
        <motion.p
          className="task-empty__sub"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...ANIM, delay: 0.12 }}
        >
          {projectName
            ? <>You're in <strong>{projectName}</strong>. Start a new conversation, or open a file from the tree on the right.</>
            : <>Start a new conversation, or open a file from the tree on the right.</>}
        </motion.p>

        <motion.button
          className="task-empty__cta"
          onClick={() => newConversation()}
          whileHover={{ y: -1 }}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...ANIM, delay: 0.18 }}
        >
          <Plus size={14} strokeWidth={2} />
          New conversation
        </motion.button>
      </motion.div>
    </div>
  );
}
