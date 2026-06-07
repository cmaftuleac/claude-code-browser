import { useLayoutEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FilePlus2, Plus } from 'lucide-react';
import { useTasksStore } from '../stores/tasks-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useBrowserStore } from '../stores/browser-store';
import { useUiStore } from '../stores/ui-store';
import type { TabKey } from '../lib/tab-key';
import { PaneTree } from './PaneTree';
import { TabDragGhost } from './TabDragGhost';
import { BrandMark } from './icons/BrandMark';
import { TREE_DRAG_MIME, extractDroppedPaths } from '../lib/drop-paths';

export function TaskWorkspace() {
  const tasks = useTasksStore((s) => s.tasks);
  const workingFiles = useWorkspaceStore((s) => s.workingFiles);
  const browserOrder = useBrowserStore((s) => s.order);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const layout = useUiStore((s) => s.layout);
  const [dragHint, setDragHint] = useState(false);

  // Keep the split layout in sync with the live set of open tabs. This is the
  // single writer that inserts/removes layout tabs as conversations, files, and
  // browser instances appear and vanish (from any call site). A layout effect so
  // a freshly-built layout paints without a one-frame empty flash.
  useLayoutEffect(() => {
    const live: TabKey[] = [
      ...tasks.map((t) => `conv:${t.id}`),
      ...workingFiles.map((p) => `file:${p}`),
      ...browserOrder.map((id) => `browser:${id}`),
      ...(settingsOpen ? ['settings:'] : []),
    ];
    useUiStore.getState().reconcile(live);
  }, [tasks, workingFiles, browserOrder, settingsOpen]);

  // Empty hero: no tabs at all (no tasks AND no files AND no browsers AND no settings).
  const isEmpty = tasks.length === 0 && workingFiles.length === 0 && browserOrder.length === 0 && !settingsOpen;
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

  // The workspace body is a recursive split tree of editor groups; each group
  // keeps its own tabs mounted (toggled with `hidden`) so Monaco models, chat
  // scroll, and webview state survive switches within the group.
  return (
    <section className="task-workspace">
      <div
        className="workspace-body"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(e) => void onDrop(e)}
      >
        {layout && <PaneTree node={layout} />}
        {/* Browser overlays are mounted at the App root (not here) so they
            survive routing to Home / project back-forward without reloading.
            See App.tsx. */}
        <TabDragGhost />

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
          <span className="task-empty__warp" aria-hidden>
            {Array.from({ length: 24 }, (_, i) => {
              const a = (i * 137.5) % 360;
              const delay = ((i * 0.13) % 2.6).toFixed(2);
              const dur = (2.4 + (i % 5) * 0.22).toFixed(2);
              return (
                <span
                  key={i}
                  className="task-empty__streak"
                  style={{ '--a': `${a.toFixed(1)}deg`, animationDelay: `${delay}s`, animationDuration: `${dur}s` } as React.CSSProperties}
                />
              );
            })}
          </span>
          <span className="task-empty__halo" aria-hidden />
          <BrandMark size={168} shimmer className="task-empty__mark" />
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
