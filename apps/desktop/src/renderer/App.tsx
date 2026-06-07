import { useEffect, useRef, useState } from 'react';
import { useMonaco } from '@monaco-editor/react';
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
import { BrowserOverlay } from './components/BrowserOverlay';
import { HostPicker } from './components/HostPicker';
import { UpdatePill } from './components/UpdatePill';
import { initUpdateListener } from './stores/update-store';
import { useHostStore } from './stores/host-store';
import { useTasksStore } from './stores/tasks-store';
import { useWorkspaceStore } from './stores/workspace-store';
import { useBrowserStore } from './stores/browser-store';
import { useFileClipboardStore } from './stores/file-clipboard-store';
import { useRecentsStore } from './stores/recents-store';
import { useConnectionStore } from './stores/connection-store';
import { useSettingsStore } from './stores/settings-store';
import { useUiStore, closeActiveTab } from './stores/ui-store';
import { parentDir } from './lib/path-util';
import { installMemoryReclaim } from './lib/memory-reclaim';
import { restoreWorkspaceOnStartup, installWorkspaceManager } from './lib/workspace-snapshot';

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
  // Browser overlays live at the App root (portaled to <body>) so they persist
  // across routing to Home / project back-forward — TaskWorkspace unmounts in
  // those views, which would otherwise destroy every <webview> and reload it.
  const browserOrder = useBrowserStore((s) => s.order);

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
      // Always require the hold (Chrome-style), whether or not a project is
      // open — Cmd+Q should never quit on a single tap.
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
          // Flush unsaved edits before quitting (PyCharm saves on quit).
          void useWorkspaceStore.getState().saveAll().finally(() => window.ccb.app.quit());
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

      // Cmd/Ctrl+Z outside a text editor → undo the last file deletion. (Monaco
      // owns Z when the editor is focused — caught by isTypingTarget above.)
      if (primary && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void useWorkspaceStore.getState().undoDelete();
        return;
      }

      const target = useWorkspaceStore.getState().activeFile;
      if (!target) return;

      // Delete branch fires WITHOUT requiring the primary modifier so that
      // plain Delete (= Fn+Backspace on macOS) also trashes the file —
      // matches Finder + VS Code behavior. Cmd/Ctrl+Backspace still works.
      if (e.key === 'Delete' || (primary && e.key === 'Backspace')) {
        e.preventDefault();
        // flush:false — we're trashing it; a save would recreate it post-delete.
        useWorkspaceStore.getState().closeFile(target, { flush: false });
        const p = parentDir(target);
        // Await the delete (staging move) before refreshing so the tree doesn't
        // briefly re-show the just-deleted file (matches FileTreeNode's flow).
        void window.ccb.fs.deletePath(target).then(() => { if (p) void useWorkspaceStore.getState().refreshDir(p); });
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
        const parent = parentDir(target);
        const wsRoot = useWorkspaceStore.getState().root;
        const destDir = parent || wsRoot;
        if (!destDir) return;
        (async () => {
          if (cb.mode === 'copy') {
            await window.ccb.fs.copyPaths(cb.paths, destDir);
          } else {
            for (const src of cb.paths) {
              // flush:false — the file is moving; writing the old path would
              // race the move and leave a stray copy behind.
              useWorkspaceStore.getState().closeFile(src, { flush: false });
            }
            await window.ccb.fs.movePaths(cb.paths, destDir);
            cb.clear();
          }
          void useWorkspaceStore.getState().refreshDir(destDir);
          for (const src of cb.paths) {
            const p = parentDir(src);
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

  // Subscribe to the account's host registry (cloud server + the user's online
  // machines). Web shows a picker when there's more than one; desktop has one.
  useEffect(() => { useHostStore.getState().init(); }, []);

  // Hydrate user settings + apply the persisted theme/accent/density to <html>.
  useEffect(() => { void useSettingsStore.getState().init(); }, []);

  // Tab/layout persistence + restore. The manager (installed first) watches for
  // a project opening into an empty workspace and rebuilds its saved tabs — so a
  // Cmd+R reload, an app restart (reopen-last-project), or reopening a project
  // from Home all come back to the exact layout. restoreWorkspaceOnStartup then
  // decides whether to auto-open a project on launch (which triggers the manager).
  useEffect(() => {
    const cleanup = installWorkspaceManager();
    void restoreWorkspaceOnStartup();
    return cleanup;
  }, []);

  // Memory: idle-tab sweep + OS memory-pressure handler (suspends hidden tabs,
  // GC). Sessions/caches are reclaimed in the main process.
  useEffect(() => installMemoryReclaim(), []);

  // Listen for silent auto-update progress (packaged desktop only; web no-op).
  useEffect(() => initUpdateListener(), []);

  // Mirror the focused browser instance to main so the agent's browser tools
  // target the browser the user is looking at (interim, until per-session routing).
  useEffect(() => {
    let prev = useBrowserStore.getState().activeId;
    window.ccb.setActiveBrowser(prev);
    return useBrowserStore.subscribe((s) => {
      if (s.activeId !== prev) { prev = s.activeId; window.ccb.setActiveBrowser(s.activeId); }
    });
  }, []);

  // The agent navigated with no usable guest → navigate the chat's bound (blank)
  // browser if it exists, else create a fresh one. Report the actual instance id
  // back so main re-keys the parked request to it (handles a stale/undefined id).
  useEffect(() => {
    return window.ccb.onEnsureBrowser(({ url, browserId, requestId }) => {
      const bs = useBrowserStore.getState();
      let id: string;
      if (browserId && bs.instances[browserId]) {
        bs.navigate(browserId, url);
        bs.setActive(browserId);
        id = browserId;
      } else {
        id = bs.openBrowser({ url, focus: true });
      }
      useUiStore.getState().setActiveTab({ kind: 'browser', id });
      window.ccb.browserEnsured(requestId, id);
    });
  }, []);

  // Live-reflect on-disk changes into the (project-wide) open file buffers.
  // Disk always wins; reloadFromDisk handles every file kind (text adopts the
  // new content undo-ably, media/binary bump a revision so viewers re-fetch).
  useEffect(() => {
    return window.ccb.fs.onFsChange((paths) => {
      const ws = useWorkspaceStore.getState();
      const dirs = new Set<string>();
      for (const p of paths) {
        const parent = parentDir(p);
        if (parent) dirs.add(parent);
        if (ws.fileBuffers[p]) void ws.reloadFromDisk(p);
      }
      for (const d of dirs) void ws.refreshDir(d);
    });
  }, []);

  // PyCharm-style auto-save on frame deactivation: when the app/window loses
  // OS focus or is hidden (switching to another app), flush all dirty files.
  useEffect(() => {
    const flush = (): void => {
      // window 'blur' also fires when focus moves into a child <webview>/DevTools
      // (still within the app). Only flush on true app deactivation, never on a
      // focus hop to a guest — otherwise we'd churn writes mid-edit.
      if (document.hasFocus()) return;
      void useWorkspaceStore.getState().saveAll();
    };
    const onVisible = (): void => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('blur', flush);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('blur', flush);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Monaco model lifetime is owned here, not by FileEditor's unmount. FileEditor
  // sets keepCurrentModel, so a file's model (and undo stack) survives the editor
  // unmounting — which happens on tab switches, when a tab MOVES between panes,
  // and during the brief double-mount window while a split collapses. We instead
  // dispose a model only when its file truly leaves `workingFiles` (real close),
  // and dispose everything when the project switches/closes. This is what keeps a
  // collapse from blanking the surviving editor while still letting a reopened
  // file rebuild cleanly (no stale model to collide with the re-read buffer).
  const monaco = useMonaco();
  const projectRoot = useWorkspaceStore((s) => s.root);
  const workingFiles = useWorkspaceStore((s) => s.workingFiles);
  useEffect(() => {
    if (!monaco) return;
    const live = new Set(workingFiles.map((p) => monaco.Uri.parse(p).toString()));
    for (const m of monaco.editor.getModels()) {
      if (!live.has(m.uri.toString())) m.dispose();
    }
  }, [monaco, workingFiles]);
  useEffect(() => {
    if (!monaco) return;
    // Dispose everything when the project is closed/switched (or App unmounts).
    return () => { for (const m of monaco.editor.getModels()) m.dispose(); };
  }, [monaco, projectRoot]);

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
      {/* One overlay per browser instance — keyed by stable uuid (never index) so
          closing a middle instance can't reparent a sibling's webview. Mounted
          here (App root, portaled to <body>) so they outlive view switches. */}
      {browserOrder.map((id) => <BrowserOverlay key={id} browserId={id} />)}
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
        <HostPicker />
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
      <UpdatePill />
      {globalCtxMenu}
    </div>
  );
}
