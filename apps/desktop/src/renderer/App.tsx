import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Circle, Folder, Loader2 } from 'lucide-react';
import { useAgentIpc } from './ipc/useAgentIpc';
import { useGlobalContextMenu } from './hooks/useGlobalContextMenu';
import { useAppMenu } from './hooks/useAppMenu';
import { useNavWatcher } from './stores/nav-store';
import { Titlebar } from './components/Titlebar';
import { TasksRail } from './components/TasksRail';
import { TaskWorkspace } from './components/TaskWorkspace';
import { StateRail } from './components/StateRail';
import { HomeScreen } from './components/HomeScreen';
import { AboutDialog } from './components/AboutDialog';
import { useTasksStore } from './stores/tasks-store';
import { useWorkspaceStore } from './stores/workspace-store';
import { useFileClipboardStore } from './stores/file-clipboard-store';
import { useRecentsStore } from './stores/recents-store';
import { useConnectionStore } from './stores/connection-store';
import { useUiStore, closeActiveTab } from './stores/ui-store';

const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

const RAIL_ANIM = {
  initial: { width: 0, opacity: 0 },
  animate: { width: 'auto', opacity: 1 },
  exit: { width: 0, opacity: 0 },
  transition: { duration: 0.2, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] },
};

export function App() {
  useAgentIpc();
  useNavWatcher();
  useAppMenu();
  const globalCtxMenu = useGlobalContextMenu();
  const status = useConnectionStore((s) => s.status);
  const projectName = useWorkspaceStore((s) => s.name);
  const anyRunning = useTasksStore((s) => s.tasks.some((t) => t.running));
  const tasksRailOpen = useUiStore((s) => s.tasksRailOpen);
  const stateRailOpen = useUiStore((s) => s.stateRailOpen);
  const view = useUiStore((s) => s.view);
  const aboutOpen = useUiStore((s) => s.aboutOpen);
  const closeAbout = useUiStore((s) => s.closeAbout);

  // ── Global shortcuts: Cmd+W (tiered close) and Cmd+Q (hold to quit). ──
  const [holdActive, setHoldActive] = useState(false);
  const [holdProgress, setHoldProgress] = useState(0);
  const holdRafRef = useRef<number | null>(null);
  const holdStartRef = useRef<number>(0);

  const stopHoldAnim = (): void => {
    if (holdRafRef.current != null) cancelAnimationFrame(holdRafRef.current);
    holdRafRef.current = null;
  };

  useEffect(() => {
    // Match Chromium's confirm-to-quit dwell time (kShowDuration = 1500ms in
    // chrome/browser/ui/views/confirm_quit_bubble_controller.cc).
    const HOLD_MS = 1500;

    // Cmd+W ladder lives in ui-store.closeActiveTab (shared with File → Close
    // Tab): close the active tab, else close the project, else quit.
    const offW = window.ccb.app.onCmdW(() => closeActiveTab());

    const offQDown = window.ccb.app.onCmdQDown(() => {
      const hasProject = useWorkspaceStore.getState().root != null;
      if (!hasProject) {
        void window.ccb.app.quit();
        return;
      }
      // Idempotent: ignore key auto-repeat if already counting down.
      if (holdRafRef.current != null) return;
      holdStartRef.current = performance.now();
      setHoldActive(true);
      setHoldProgress(0);
      const tick = (): void => {
        const elapsed = performance.now() - holdStartRef.current;
        const p = Math.min(1, elapsed / HOLD_MS);
        setHoldProgress(p);
        if (p < 1) {
          holdRafRef.current = requestAnimationFrame(tick);
        } else {
          holdRafRef.current = null;
          void window.ccb.app.quit();
        }
      };
      holdRafRef.current = requestAnimationFrame(tick);
    });

    const offQUp = window.ccb.app.onCmdQUp(() => {
      stopHoldAnim();
      setHoldActive(false);
      setHoldProgress(0);
    });

    return () => { offW(); offQDown(); offQUp(); stopHoldAnim(); };
  }, []);

  // ── File-tree keyboard shortcuts: Cmd/Ctrl + C/X/V and Cmd+⌫ to trash. ──
  // We fire these on the active file when the focus is NOT in a text input,
  // Monaco editor, or a contentEditable surface — i.e., when the user is
  // browsing the tree, not typing.
  useEffect(() => {
    const isTypingTarget = (el: Element | null): boolean => {
      if (!el) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
      if ((el as HTMLElement).isContentEditable) return true;
      // Monaco renders into a div with class `monaco-editor` and focuses an
      // internal textarea — caught above.
      return false;
    };
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingTarget(document.activeElement)) return;
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const primary = isMac ? e.metaKey : e.ctrlKey;
      if (e.shiftKey || e.altKey) return;
      const target = useWorkspaceStore.getState().activeFile;
      if (!target) return;

      // Delete branch fires WITHOUT requiring the primary modifier so that
      // plain Delete (= Fn+Backspace on macOS) also trashes the file —
      // matches Finder + VS Code behavior. Cmd/Ctrl+Backspace still works.
      if (e.key === 'Delete' || (primary && e.key === 'Backspace')) {
        e.preventDefault();
        useWorkspaceStore.getState().closeFile(target);
        void window.ccb.fs.deletePath(target);
        const p = target.slice(0, target.lastIndexOf('/'));
        if (p) void useWorkspaceStore.getState().refreshDir(p);
        return;
      }

      // Everything else requires the primary modifier.
      if (!primary) return;
      const k = e.key.toLowerCase();
      const cb = useFileClipboardStore.getState();
      if (k === 'c') { e.preventDefault(); cb.set('copy', [target]); }
      else if (k === 'x') { e.preventDefault(); cb.set('cut', [target]); }
      else if (k === 'v') {
        e.preventDefault();
        if (!cb.mode || cb.paths.length === 0) return;
        const parent = target.slice(0, target.lastIndexOf('/'));
        const wsRoot = useWorkspaceStore.getState().root;
        const destDir = parent || wsRoot;
        if (!destDir) return;
        (async () => {
          if (cb.mode === 'copy') {
            await window.ccb.fs.copyPaths(cb.paths, destDir);
          } else {
            for (const src of cb.paths) {
              useWorkspaceStore.getState().closeFile(src);
            }
            await window.ccb.fs.movePaths(cb.paths, destDir);
            cb.clear();
          }
          void useWorkspaceStore.getState().refreshDir(destDir);
          for (const src of cb.paths) {
            const p = src.slice(0, src.lastIndexOf('/'));
            if (p && p !== destDir) void useWorkspaceStore.getState().refreshDir(p);
          }
        })();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Load recents from disk once on app mount so HomeScreen + Open Recent
  // submenu have data without waiting for a project open.
  useEffect(() => { void useRecentsStore.getState().load(); }, []);

  // Live-reflect on-disk changes into the (project-wide) open file buffers.
  useEffect(() => {
    return window.ccb.fs.onFsChange((paths) => {
      const ws = useWorkspaceStore.getState();
      const dirs = new Set<string>();
      for (const p of paths) {
        const slash = p.lastIndexOf('/');
        if (slash > 0) dirs.add(p.slice(0, slash));
        if (ws.fileBuffers[p]) {
          void window.ccb.fs.readFile(p).then((res) => {
            if (res.content != null) useWorkspaceStore.getState().applyDiskChange(p, res.content);
          });
        }
      }
      for (const d of dirs) void ws.refreshDir(d);
    });
  }, []);

  return (
    <div className="ide">
      <Titlebar />
      {view === 'home' ? (
        <div className="ide__body ide__body--home">
          <HomeScreen />
        </div>
      ) : (
        <div className="ide__body">
            <AnimatePresence initial={false}>
              {tasksRailOpen && (
                <motion.div key="tasks-rail-wrap" className="rail-wrap" {...RAIL_ANIM}>
                  <TasksRail />
                </motion.div>
              )}
            </AnimatePresence>
            <TaskWorkspace />
            <AnimatePresence initial={false}>
              {stateRailOpen && (
                <motion.div key="state-rail-wrap" className="rail-wrap rail-wrap--state" {...RAIL_ANIM}>
                  <StateRail />
                </motion.div>
              )}
            </AnimatePresence>
        </div>
      )}
      <AnimatePresence>
        {holdActive && (
          <motion.div
            key="hold-quit"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="hold-quit"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 4 }}
              transition={{ duration: 0.16, ease: [0.4, 0, 0.2, 1] }}
              className="hold-quit__card"
            >
              <div className="hold-quit__text">
                Hold <kbd className="hold-quit__kbd">⌘</kbd><kbd className="hold-quit__kbd">Q</kbd> to Quit
              </div>
              <div className="hold-quit__bar">
                <div className="hold-quit__bar-fill" style={{ width: `${holdProgress * 100}%` }} />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {aboutOpen && <AboutDialog key="about" onClose={closeAbout} />}
      </AnimatePresence>
      <div className="ide__footer">
        <span className={`ide__footer-item ide__footer-conn--${status}`}>
          <Circle size={9} fill="currentColor" strokeWidth={0} />
          {status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Disconnected'}
        </span>
        {projectName && (
          <span className="ide__footer-item">
            <Folder size={11} strokeWidth={1.75} />
            {projectName}
          </span>
        )}
        <span className="ide__footer-spacer" />
        <AnimatePresence>
          {anyRunning && (
            <motion.span
              key="running"
              initial={{ opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 6 }}
              transition={ANIM}
              className="ide__footer-running"
            >
              <Loader2 size={11} strokeWidth={2} />
              Claude is working…
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      {globalCtxMenu}
    </div>
  );
}
