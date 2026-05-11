import { useEffect, useRef, useCallback } from 'react';
import type { ClientMessage, ServerMessage } from '@claude-code-browser/shared';
import { useConnectionStore } from '../stores/connection-store';
import { useChatStore, bumpStat, type ChatMessage } from '../stores/chat-store';
import { handleBrowserRequest } from '../browser-handler';

/** Get target tab URL and domain from the pinned tab */
function getTargetTabInfo(callback: (url: string, domain: string) => void) {
  const tabId = useConnectionStore.getState().targetTabId;
  if (!tabId) {
    callback('', 'unknown');
    return;
  }
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      callback('', 'unknown');
      return;
    }
    const url = tab.url ?? '';
    let domain = 'unknown';
    try { domain = new URL(url).hostname; } catch { /* */ }
    callback(url, domain);
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
          setStatus('connected');
          send({ type: 'session:list' });
          break;
        }

        case 'session:list': {
          // Filter sessions to only those registered for the target tab's domain
          getTargetTabInfo((_url, domain) => {
            if (!domain || domain === 'unknown') {
              store.setSessions(msg.sessions);
              return;
            }
            chrome.storage.local.get(`ccb-sessions-${domain}`, (result) => {
              const domainSessionIds = (result[`ccb-sessions-${domain}`] as string[] | undefined) ?? [];
              if (domainSessionIds.length === 0) {
                store.setSessions([]);
              } else {
                const domainSet = new Set(domainSessionIds);
                store.setSessions(msg.sessions.filter((s) => domainSet.has(s.id)));
              }
            });
          });
          break;
        }

        case 'session:created': {
          if (msg.clientRequestId) {
            store.migratePendingToSession(msg.clientRequestId, msg.sessionId);
          }
          bumpStat('sessionCount');
          // Register this session for the target tab's domain, then refresh session list
          getTargetTabInfo((_url, domain) => {
            if (!domain || domain === 'unknown') return;
            const key = `ccb-sessions-${domain}`;
            chrome.storage.local.get(key, (result) => {
              const ids = (result[key] as string[] | undefined) ?? [];
              if (!ids.includes(msg.sessionId)) {
                chrome.storage.local.set({ [key]: [...ids, msg.sessionId] }, () => {
                  send({ type: 'session:list' });
                });
              }
            });
          });
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
          send({ type: 'session:list' });
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

  return { send };
}
