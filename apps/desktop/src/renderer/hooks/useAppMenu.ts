import { useEffect } from 'react';
import { useTasksStore } from '../stores/tasks-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useUiStore, closeActiveTab } from '../stores/ui-store';
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
      // Drive the tree's existing inline-create flow at the project root. The
      // root ContextPanel picks up the pendingCreate signal, opens an inline
      // name input, and creates + opens the file on submit. Ensure the State
      // Rail (which hosts the file tree) is open first, or the row — and the
      // menu action — would have nowhere to render.
      const ws = useWorkspaceStore.getState();
      if (!ws.root) return;
      const ui = useUiStore.getState();
      if (!ui.stateRailOpen) ui.toggleStateRail();
      ws.requestCreate(ws.root, 'file');
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
      const ws = useWorkspaceStore.getState();
      if (ws.activeFile) void ws.saveFile(ws.activeFile);
    });

    sub('saveAll', () => {
      void useWorkspaceStore.getState().saveAll();
    });

    // Same shared ladder as the Cmd+W intercept: close the active tab, else
    // close the project, else quit.
    sub('closeTab', () => { closeActiveTab(); });

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
    sub('about', () => { useUiStore.getState().openAbout(); });

    // ── App ─────────────────────────────────────────────────
    sub('quit', () => { void window.ccb.app.quit(); });

    return () => { for (const off of offs) off(); };
  }, []);
}
