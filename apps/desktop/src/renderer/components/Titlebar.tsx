import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, ArrowRight, ChevronRight, LayoutGrid } from 'lucide-react';
import { useTasksStore, selectActiveTask } from '../stores/tasks-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useUiStore } from '../stores/ui-store';
import { useNavStore } from '../stores/nav-store';

const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

/** PanelLeft icon — fills the left sidebar when `filled` is true. */
function PanelLeftIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
      {filled && <rect x="3" y="3" width="6" height="18" rx="2" fill="currentColor" stroke="none" opacity="0.35" />}
    </svg>
  );
}

/** PanelRight icon — fills the right sidebar when `filled` is true. */
function PanelRightIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
      {filled && <rect x="15" y="3" width="6" height="18" rx="2" fill="currentColor" stroke="none" opacity="0.35" />}
    </svg>
  );
}

/** Slim draggable top strip — Cowork-warm; breadcrumb of app · project · task. */
export function Titlebar() {
  const projectName = useWorkspaceStore((s) => s.name);
  const task = useTasksStore(selectActiveTask);
  const tasksRailOpen = useUiStore((s) => s.tasksRailOpen);
  const stateRailOpen = useUiStore((s) => s.stateRailOpen);
  const toggleTasksRail = useUiStore((s) => s.toggleTasksRail);
  const toggleStateRail = useUiStore((s) => s.toggleStateRail);
  const view = useUiStore((s) => s.view);
  const closeProject = useWorkspaceStore((s) => s.closeProject);
  const canBack = useNavStore((s) => s.cursor > 0);
  const canForward = useNavStore((s) => s.cursor < s.history.length - 1);
  const back = useNavStore((s) => s.back);
  const forward = useNavStore((s) => s.forward);

  return (
    <div className="titlebar">
      <div className="titlebar__breadcrumb">
        <span className="titlebar__app">claude-code-browser</span>
        <AnimatePresence initial={false}>
          {projectName && (
            <motion.span
              key="proj"
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -4 }}
              transition={ANIM}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <ChevronRight className="titlebar__sep" size={12} />
              <span className="titlebar__crumb">{projectName}</span>
            </motion.span>
          )}
        </AnimatePresence>
        <AnimatePresence initial={false} mode="wait">
          {task && (
            <motion.span
              key={task.id + ':' + task.title}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 4 }}
              transition={ANIM}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <ChevronRight className="titlebar__sep" size={12} />
              <span className="titlebar__crumb titlebar__crumb--active">{task.title}</span>
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <div className="titlebar__actions">
        <AnimatePresence initial={false}>
          {view === 'workspace' && (
            <motion.div
              key="ws-actions"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={ANIM}
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <button
                className="titlebar__toggle"
                onClick={back}
                disabled={!canBack}
                title="Back"
              >
                <ArrowLeft size={14} strokeWidth={1.75} />
              </button>
              <button
                className="titlebar__toggle"
                onClick={forward}
                disabled={!canForward}
                title="Forward"
              >
                <ArrowRight size={14} strokeWidth={1.75} />
              </button>
              <button
                className="titlebar__toggle"
                onClick={closeProject}
                title="Back to projects"
              >
                <LayoutGrid size={14} strokeWidth={1.75} />
              </button>
              <button
                className={`titlebar__toggle ${tasksRailOpen ? 'is-on' : 'is-off'}`}
                onClick={toggleTasksRail}
                title={tasksRailOpen ? 'Hide tasks panel' : 'Show tasks panel'}
              >
                <PanelLeftIcon filled={tasksRailOpen} />
              </button>
              <button
                className={`titlebar__toggle ${stateRailOpen ? 'is-on' : 'is-off'}`}
                onClick={toggleStateRail}
                title={stateRailOpen ? 'Hide state panel' : 'Show state panel'}
              >
                <PanelRightIcon filled={stateRailOpen} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
