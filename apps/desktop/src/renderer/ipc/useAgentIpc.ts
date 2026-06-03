import { useEffect } from 'react';
import type { ServerMessage } from '@claude-code-browser/shared';
import { useTasksStore } from '../stores/tasks-store';
import { useConnectionStore } from '../stores/connection-store';
import { useRecentsStore } from '../stores/recents-store';
import { useSessionsStore } from '../stores/sessions-store';

/**
 * Subscribes to ServerMessage events over the Electron IPC bridge and routes
 * them into the task store + connection store. Replaces the old chat-store
 * wiring; same protocol shapes, different bucket.
 */
export function useAgentIpc(): void {
  useEffect(() => {
    const handleServer = useTasksStore.getState().handleServer;
    const conn = useConnectionStore.getState();

    // Ensure one task always exists so the workspace has somewhere to render.
    useTasksStore.getState().init();

    const unsubscribe = window.ccb.onAgentEvent((msg: ServerMessage) => {
      switch (msg.type) {
        case 'connection:ready':
          conn.setReady(msg.serverVersion);
          window.ccb.send({ type: 'commands:list' });
          void useRecentsStore.getState().load();
          break;
        case 'health':
          conn.setHealth(msg.claudeAuthenticated);
          break;
        case 'commands:list':
          conn.setCommands(msg.commands);
          break;
        case 'session:list':
          useSessionsStore.getState().setSessions(msg.sessions);
          break;
        default:
          handleServer(msg);
      }
    });

    window.ccb.ready();
    return unsubscribe;
  }, []);
}
