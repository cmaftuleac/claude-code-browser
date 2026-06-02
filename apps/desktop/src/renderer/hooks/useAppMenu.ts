import { useEffect } from 'react';
import { useTasksStore, selectActiveTask } from '../stores/tasks-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useUiStore } from '../stores/ui-store';
import { useNavStore } from '../stores/nav-store';
import { useRecentsStore } from '../stores/recents-store';

/**
 * Wires the application-menu IPC channels emitted by `apps/desktop/src/main/menu.ts`
 * to the relevant store actions. Mount once in `App.tsx`.
 */
export function useAppMenu(): void {
  useEffect(() => {
    const offs: Array<() => void> = [];

    const sub = (channel: string, fn: (...args: unknown[]) => void): void => {
      offs.push(window.ccb.app.onMenu(channel, fn));
    };

    // ── File ────────────────────────────────────────────────
    sub('newTask', () => { useTasksStore.getState().newConversation(); });

    sub('newFile', () => {
      // The tree owns inline-create. No global "scratch buffer" yet, so
      // route this to a no-op for now — the user can still click a folder's
      // ⋯ menu's "New File" or hit the tree's keyboard path.
      // (Defer: open an in-memory untitled tab.)
    });

    sub('openFolder', () => { void useWorkspaceStore.getState().openFolder(); });

    sub('openRecent', (...args) => {
      const p = args[0];
      if (typeof p === 'string') void useWorkspaceStore.getState().openFolder(p);
    });

    sub('clearRecents', () => {
      const items = useRecentsStore.getState().items;
      for (const r of items) void useRecentsStore.getState().remove(r.path);
    });

    sub('save', () => {
      const t = selectActiveTask(useTasksStore.getState());
      if (t?.activeFile) void useTasksStore.getState().saveFile(t.id, t.activeFile);
    });

    sub('saveAll', () => {
      const t = selectActiveTask(useTasksStore.getState());
      if (t) void useTasksStore.getState().saveAll(t.id);
    });

    sub('closeTab', () => {
      // Same path as the Cmd+W intercept and the tab X buttons: close the
      // currently-visible tab; cascade in tasks-store handles task/project.
      const tasks = useTasksStore.getState();
      const ws = useWorkspaceStore.getState();
      if (tasks.activeId) {
        tasks.closeActiveTab(tasks.activeId);
      } else if (ws.root) {
        ws.closeProject();
      } else {
        void window.ccb.app.quit();
      }
    });

    sub('closeProject', () => {
      const ws = useWorkspaceStore.getState();
      if (ws.root) ws.closeProject();
    });

    // ── View ────────────────────────────────────────────────
    sub('toggleTasksRail', () => { useUiStore.getState().toggleTasksRail(); });
    sub('toggleStateRail', () => { useUiStore.getState().toggleStateRail(); });

    // ── Go ──────────────────────────────────────────────────
    sub('navBack', () => { useNavStore.getState().back(); });
    sub('navForward', () => { useNavStore.getState().forward(); });

    // ── Help ────────────────────────────────────────────────
    sub('about', () => {
      // No about dialog yet — defer; for now, open the README on GitHub.
    });

    // ── App ─────────────────────────────────────────────────
    sub('quit', () => { void window.ccb.app.quit(); });

    return () => { for (const off of offs) off(); };
  }, []);
}
