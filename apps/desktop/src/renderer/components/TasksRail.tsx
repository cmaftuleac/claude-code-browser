import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Info, Pencil, Trash2, ChevronRight, History } from 'lucide-react';
import { useTasksStore } from '../stores/tasks-store';
import { useSessionsStore } from '../stores/sessions-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useUiStore } from '../stores/ui-store';
import { ContextMenu, type CtxItem } from './ContextMenu';
import { ConfirmCard } from './ConfirmCard';

const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

/** Collapsible list of prior on-disk sessions for this project, resumable
 *  into a fresh task. Fetches the list lazily the first time it's opened. */
function ResumeSection() {
  const [open, setOpen] = useState(false);
  const sessions = useSessionsStore((s) => s.sessions);
  const loaded = useSessionsStore((s) => s.loaded);
  const loading = useSessionsStore((s) => s.loading);
  const root = useWorkspaceStore((s) => s.root);
  const resumeSession = useTasksStore((s) => s.resumeSession);

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    // Refetch every time it's opened so newly-created sessions show up; the
    // previously-loaded list stays visible until the fresh reply replaces it.
    if (next) useSessionsStore.getState().requestList();
  };

  // Scope to the current project (sessions carry their cwd). Normalize a
  // trailing slash, and keep sessions with no recorded cwd rather than hiding
  // potentially-resumable history.
  const norm = (p: string): string => p.replace(/\/+$/, '');
  const projectSessions = root
    ? sessions.filter((s) => !s.cwd || norm(s.cwd) === norm(root))
    : sessions;

  const onPick = (id: string, title: string): void => {
    const taskId = resumeSession({ id, title });
    useUiStore.getState().setActiveTab({ kind: 'conv', taskId });
  };

  return (
    <div className="tasks-rail__section">
      <button className="tasks-rail__disclosure" onClick={toggle} aria-expanded={open}>
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={ANIM} style={{ display: 'flex' }}>
          <ChevronRight size={12} strokeWidth={2} />
        </motion.span>
        <History size={12} strokeWidth={1.75} />
        Resume session
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={ANIM}
            style={{ overflow: 'hidden' }}
          >
            {loading && !loaded && <div className="tasks-rail__hint">Loading…</div>}
            {loaded && projectSessions.length === 0 && (
              <div className="tasks-rail__hint">No past sessions for this project.</div>
            )}
            {projectSessions.map((s) => (
              <button
                key={s.id}
                className="session-row"
                onClick={() => onPick(s.id, s.title)}
                title={s.title}
              >
                <span className="session-row__title">{s.title || 'Untitled session'}</span>
                <span className="session-row__time">{new Date(s.lastModified).toLocaleDateString()}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface TaskRowProps {
  id: string;
  title: string;
  isActive: boolean;
  isRunning: boolean;
}

/**
 * Single task row. Owns its own per-row state for inline rename + delete
 * confirmation; the parent only renders the list and decides ordering.
 */
function TaskRow({ id, title, isActive, isRunning }: TaskRowProps) {
  const selectTask = useTasksStore((s) => s.selectTask);
  const renameTask = useTasksStore((s) => s.renameTask);
  const deleteTask = useTasksStore((s) => s.deleteTask);

  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  const startRename = (): void => { setRenameValue(title); setRenaming(true); };
  const cancelRename = (): void => { setRenaming(false); setRenameValue(title); };
  const submitRename = (): void => {
    const next = renameValue.trim();
    if (next && next !== title) renameTask(id, next);
    setRenaming(false);
  };

  const items: CtxItem[] = [
    { kind: 'item', label: 'Rename', icon: <Pencil size={13} strokeWidth={1.75} />, shortcut: '↵', onActivate: startRename },
    { kind: 'divider' },
    { kind: 'item', label: 'Delete Task', icon: <Trash2 size={13} strokeWidth={1.75} />, danger: true, onActivate: () => setConfirmDelete(true) },
  ];

  return (
    <>
      <motion.div
        layout
        initial={{ opacity: 0, y: -4, height: 0 }}
        animate={{ opacity: 1, y: 0, height: 'auto' }}
        exit={{ opacity: 0, x: -8, height: 0 }}
        transition={ANIM}
        className={`task-item ${isActive ? 'is-active' : ''} ${isRunning ? 'is-running' : ''}`}
        role="button"
        tabIndex={renaming ? -1 : 0}
        onClick={() => { if (!renaming) selectTask(id); }}
        onKeyDown={(e) => {
          if (renaming) return;
          if (e.key === 'Enter') { e.preventDefault(); startRename(); }
        }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenuAt({ x: e.clientX, y: e.clientY }); }}
        title={title}
      >
        <span className="task-item__dot" />
        {renaming ? (
          <input
            ref={inputRef}
            className="task-item__rename"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submitRename(); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelRename(); }
              else { e.stopPropagation(); }
            }}
            onBlur={() => { if (renaming) submitRename(); }}
            onClick={(e) => e.stopPropagation()}
            spellCheck={false}
          />
        ) : (
          <span className="task-item__title">{title}</span>
        )}
      </motion.div>

      {menuAt && (
        <ContextMenu x={menuAt.x} y={menuAt.y} items={items} onDismiss={() => setMenuAt(null)} />
      )}
      {confirmDelete && (
        <ConfirmCard
          danger
          title="Delete task"
          message={`"${title}" and its chat history will be removed. This can't be undone.`}
          confirmLabel="Delete"
          onConfirm={() => { setConfirmDelete(false); deleteTask(id); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}

export function TasksRail() {
  const tasks = useTasksStore((s) => s.tasks);
  const activeId = useTasksStore((s) => s.activeId);
  const newConversation = useTasksStore((s) => s.newConversation);

  return (
    <aside className="tasks-rail">
      <button className="tasks-rail__new" onClick={() => newConversation()}>
        <Plus size={14} strokeWidth={2} />
        New task
      </button>

      <div className="tasks-rail__list">
        {tasks.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={ANIM}
            className="tasks-rail__empty"
          >
            No tasks yet.
          </motion.div>
        )}
        <AnimatePresence initial={false}>
          {tasks.map((t) => (
            <TaskRow
              key={t.id}
              id={t.id}
              title={t.title}
              isActive={activeId === t.id}
              isRunning={t.running}
            />
          ))}
        </AnimatePresence>
      </div>

      <ResumeSection />

      <div className="tasks-rail__caption">
        <Info size={11} strokeWidth={1.75} />
        These tasks run locally and aren't synced
      </div>
    </aside>
  );
}
