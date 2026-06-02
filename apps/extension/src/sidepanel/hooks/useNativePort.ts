import { useEffect, useRef, useCallback } from 'react';
import type { ClientMessage, ServerMessage } from '@claude-code-browser/shared';
import { useConnectionStore } from '../stores/connection-store';
import { useChatStore, bumpStat, type ChatMessage } from '../stores/chat-store';
import { handleBrowserRequest } from '../browser-handler';
import { MIN_HOST_VERSION, SELF_UPDATE_MIN_VERSION } from '../config';
import { cmpSemver } from '../semver';
import { MY_TAB_ID } from '../tab';

// Watchdog for an in-flight silent host:update. Module-level so it survives the
// hook re-running on reconnect. If neither host:update:result nor a fresh
// connection:ready resolves the update within this window (host hung / never
// respawned), fall back to the manual-update screen.
const UPDATE_WATCHDOG_MS = 4 * 60 * 1000;
let updateWatchdog: ReturnType<typeof setTimeout> | null = null;

function clearUpdateWatchdog() {
  if (updateWatchdog) {
    clearTimeout(updateWatchdog);
    updateWatchdog = null;
  }
}

function armUpdateWatchdog() {
  clearUpdateWatchdog();
  updateWatchdog = setTimeout(() => {
    updateWatchdog = null;
    const cs = useConnectionStore.getState();
    if (!cs.hostUpdating) return; // already resolved
    cs.setNeedsManualUpdate({ target: MIN_HOST_VERSION, current: null, reason: 'Automatic update timed out.' });
    cs.setStatus('disconnected');
  }, UPDATE_WATCHDOG_MS);
}

/** Resolve the project context for the pinned tab: `origin` is host:port (the
 *  per-website key, port included so localhost:3000 ≠ localhost:5173), and
 *  `projectDir` is the site's configured project folder (sources[0]) or undefined.
 *  origin is '' when there's no pinned http(s) tab (e.g. chrome:// page). */
function getProjectContext(callback: (ctx: { origin: string; projectDir?: string }) => void) {
  // Use this panel's own tab directly (not the store) so it's correct even before
  // the navigation-refresh effect has populated targetTabId.
  const tabId = MY_TAB_ID;
  if (tabId == null) { callback({ origin: '' }); return; }
  chrome.tabs.get(tabId, (tab) => {
    let origin = '';
    try { origin = new URL(tab?.url ?? '').host; } catch { /* not a parseable URL */ }
    if (chrome.runtime.lastError || !origin) { callback({ origin: '' }); return; }
    chrome.storage.local.get(`ccb-sources-${origin}`, (result) => {
      const paths = (result[`ccb-sources-${origin}`] as string[] | undefined) ?? [];
      callback({ origin, projectDir: paths[0] });
    });
  });
}

/** Pick the routing key for a server event: prefer the canonical sessionId, fall
 *  back to clientRequestId for events emitted before session_id resolved. */
function routeKey(msg: { sessionId?: string; clientRequestId?: string }): string | null {
  if (msg.sessionId) return msg.sessionId;
  if (msg.clientRequestId) return msg.clientRequestId;
  return null;
}

/**
 * Connects to the native host via the service worker.
 * Side panel ↔ service worker (chrome.runtime.connect) ↔ native host (connectNative).
 */
export function useNativePort() {
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const setStatus = useConnectionStore((s) => s.setStatus);

  const send = useCallback((msg: ClientMessage) => {
    try {
      portRef.current?.postMessage(msg);
    } catch {
      // Port disconnected
    }
  }, []);

  const connect = useCallback(() => {
    setStatus('connecting');

    const port = chrome.runtime.connect({ name: 'sidepanel' });
    portRef.current = port;

    // Identify our tab to the SW first — this pairs us with our dedicated host
    // (spawning it on first connect, reusing it on reload).
    if (MY_TAB_ID != null) {
      try { port.postMessage({ type: '_panel_init', tabId: MY_TAB_ID }); } catch { /* */ }
    }

    // Ask the host for this website's sessions, scoped by its project folder.
    // Claude Code is the source of truth — the host lists listSessions({ dir }).
    const requestSessionList = () =>
      getProjectContext(({ origin, projectDir }) =>
        send({ type: 'session:list', origin, projectDir }));

    type InternalMessage =
      | { type: '_native_status'; connected?: boolean; error?: string }
      | { type: '_target_tab'; tabId: number | null; url?: string };
    type IncomingMessage = ServerMessage | InternalMessage;

    port.onMessage.addListener((msg: IncomingMessage) => {
      const store = useChatStore.getState();

      // Internal status messages from service worker
      if (msg.type === '_native_status') {
        if (msg.connected) {
          // Native host connected but we wait for connection:ready
        } else {
          setStatus('disconnected');
          // Native host died — every in-flight session is gone with it.
          useChatStore.getState().markAllSessionsIdle();
        }
        return;
      }

      if (msg.type === '_target_tab') {
        useConnectionStore.getState().setTargetTab(msg.tabId, msg.url);
        return;
      }

      switch (msg.type) {
        case 'connection:ready': {
          const v = msg.serverVersion;
          const cs = useConnectionStore.getState();

          // Compatible: host is equal-or-newer than our floor. Upgrade-only — a
          // newer host is left untouched.
          if (cmpSemver(v, MIN_HOST_VERSION) >= 0) {
            clearUpdateWatchdog();
            cs.resetUpdateAttempt();
            setStatus('connected');
            requestSessionList();
            break;
          }

          // Host is too old. Either it can't self-update, or we already tried once
          // this session and it still mismatches → stop and ask for a manual update.
          if (cmpSemver(v, SELF_UPDATE_MIN_VERSION) < 0 || cs.updateAttempted) {
            clearUpdateWatchdog();
            cs.setNeedsManualUpdate({ target: MIN_HOST_VERSION, current: v });
            setStatus('disconnected');
            break;
          }

          // Capable of self-update and not yet attempted → fire one silent update.
          // The host installs the target, re-wires its manifest, and exits; the
          // native-disconnect → respawn → fresh connection:ready path re-runs this.
          cs.markUpdateAttempted();
          setStatus('connecting');
          send({ type: 'host:update', targetVersion: MIN_HOST_VERSION });
          armUpdateWatchdog();
          break;
        }

        case 'host:update:result': {
          const cs = useConnectionStore.getState();
          if (!msg.success) {
            clearUpdateWatchdog();
            cs.setNeedsManualUpdate({ target: MIN_HOST_VERSION, current: null, reason: msg.reason });
            setStatus('disconnected');
          }
          // On success the host is exiting; do nothing here — the respawn path
          // drives reconnection and re-checks the version. Watchdog stays armed
          // until that fresh connection:ready (or it times out).
          break;
        }

        case 'session:list': {
          // Host already scoped the list to this website's project folder
          // (single source of truth = Claude Code on disk). No client-side filter.
          store.setSessions(msg.sessions);
          break;
        }

        case 'session:created': {
          // Migrate the pending bucket onto the real Claude Code session id, then
          // refresh the (project-scoped) list. No extension-side session registry.
          if (msg.clientRequestId) {
            store.migratePendingToSession(msg.clientRequestId, msg.sessionId);
          }
          bumpStat('sessionCount');
          requestSessionList();
          break;
        }

        case 'session:messages': {
          const loaded: ChatMessage[] = [];
          for (let i = 0; i < msg.messages.length; i++) {
            const m = msg.messages[i];
            if (m.role === 'assistant' && m.blocks && m.blocks.length > 0) {
              for (let j = 0; j < m.blocks.length; j++) {
                const block = m.blocks[j];
                loaded.push({
                  id: `hist-${msg.sessionId}-${i}-${j}`,
                  role: 'assistant',
                  content: block.content,
                  timestamp: m.timestamp ?? Date.now(),
                  kind: block.kind,
                });
              }
            } else {
              loaded.push({
                id: `hist-${msg.sessionId}-${i}`,
                role: m.role as 'user' | 'assistant',
                content: m.content,
                timestamp: m.timestamp ?? Date.now(),
              });
            }
          }
          // Merge disk history into the bucket. If we have authoritative history
          // already (observed live since session:created, or already loaded once),
          // this is a no-op. Otherwise disk replaces the history prefix and any
          // in-progress streaming tail is preserved.
          store.loadSessionHistory(msg.sessionId, loaded);
          break;
        }

        case 'chat:stream': {
          const key = routeKey(msg);
          if (!key) break;
          const kind = msg.kind ?? 'text';
          const state = useChatStore.getState();
          const bucket = state.sessionStates[key] ?? state.pendingNewChats[key];
          const msgs = bucket?.messages ?? [];
          const last = msgs[msgs.length - 1];
          let targetId: string;

          if (last && last.kind === kind && last.role === 'assistant') {
            targetId = last.id;
            // Re-open if it was sealed off (e.g., a same-kind block re-opens after
            // a brief kind interlude in the same SDK message uuid).
            if (!last.isStreaming) store.setMessageStreaming(key, targetId, true);
          } else {
            // Kind transition or first message in bucket: seal off the prior partial
            // (target only — sibling streams in other turns stay open) and start fresh.
            if (last && last.isStreaming) {
              store.setMessageStreaming(key, last.id, false);
            }
            targetId = msg.messageId;
            store.startAssistantMessage(key, targetId, kind);
          }

          store.appendDelta(key, targetId, msg.delta);
          break;
        }

        case 'agent:tool_use': {
          const key = routeKey(msg);
          if (!key) break;
          if (msg.toolName === '_update_') {
            store.updateLastToolUse(key, msg.summary);
          } else {
            store.addToolUseMessage(key, msg.summary);
          }
          break;
        }

        case 'chat:complete': {
          const key = routeKey(msg);
          if (!key) break;
          store.completeMessage(key, msg.messageId, msg.result);
          store.setSessionRunning(key, false);
          // Refresh session list (title may have been generated)
          requestSessionList();
          break;
        }

        case 'chat:error': {
          const key = routeKey(msg);
          if (!key) break;
          const isInterrupt = msg.error.includes('interrupted') || msg.error.includes('Interrupted');
          const sysMsg: ChatMessage = isInterrupt
            ? { id: `int-${Date.now()}`, role: 'system', content: '_interrupted_', timestamp: Date.now() }
            : { id: `err-${Date.now()}`, role: 'system', content: `Error: ${msg.error}`, timestamp: Date.now() };
          if (isInterrupt) {
            console.info('[ccb] session interrupted', { key, message: msg.error });
          } else {
            console.error('[ccb] chat:error', { key, error: msg.error });
          }
          store.addSystemMessage(key, sysMsg);
          store.setSessionRunning(key, false);
          break;
        }

        case 'agent:status': {
          const key = routeKey(msg);
          if (!key) break;
          store.setSessionRunning(key, msg.status === 'running');
          break;
        }

        case 'health':
          break;

        case 'commands:list':
          window.dispatchEvent(new CustomEvent('ccb:commands', { detail: msg.commands }));
          break;

        case 'sources:set':
          // Store sources in chrome.storage.local, keyed by domain
          chrome.storage.local.set({ [`ccb-sources-${msg.domain}`]: msg.paths });
          window.dispatchEvent(new CustomEvent('ccb:sources-updated'));
          break;

        case 'browser:request': {
          const tid = useConnectionStore.getState().targetTabId;
          if (!tid) {
            send({ type: 'browser:response', requestId: msg.requestId, error: 'No target tab' } as unknown as ClientMessage);
            break;
          }
          handleBrowserRequest({
            requestId: msg.requestId,
            action: msg.action,
            params: msg.params,
          }, tid).then((response) => send(response as unknown as ClientMessage));
          break;
        }

        case 'pong':
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      console.error('[CCB] Service worker port disconnected');
      portRef.current = null;
      setStatus('disconnected');
      // Clear running state across all buckets so the input box leaves stop-button
      // mode while we reconnect.
      useChatStore.getState().markAllSessionsIdle();
      // Reconnect after a short delay
      setTimeout(connect, 2000);
    });
  }, [setStatus, send]);

  useEffect(() => {
    connect();
    return () => {
      portRef.current?.disconnect();
    };
  }, [connect]);

  // Track THIS panel's own tab (from the URL), and refresh its url on navigation.
  // Replaces the SW's old global _target_tab push — each panel watches only its tab.
  useEffect(() => {
    const myTab = MY_TAB_ID;
    if (myTab == null) return;
    const refresh = () => {
      chrome.tabs.get(myTab, (tab) => {
        if (chrome.runtime.lastError || !tab) return;
        useConnectionStore.getState().setTargetTab(myTab, tab.url ?? '');
      });
    };
    refresh();
    const onUpdated = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (tabId === myTab && (info.status === 'complete' || info.url)) refresh();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => chrome.tabs.onUpdated.removeListener(onUpdated);
  }, []);

  return { send };
}
