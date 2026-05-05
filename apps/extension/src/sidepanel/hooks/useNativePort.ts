import { useEffect, useRef, useCallback } from 'react';
import type { ClientMessage, ServerMessage } from '@claude-code-browser/shared';
import { useConnectionStore } from '../stores/connection-store';
import { useChatStore, bumpStat } from '../stores/chat-store';
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

/** Drop server events whose sessionId doesn't match the active session.
 *  Brand-new sessions have activeSessionId=null until session:created arrives — pass those.
 *  Some events (e.g. session:list) carry no sessionId — pass those too. */
function isForActiveSession(msgSessionId?: string): boolean {
  const active = useChatStore.getState().activeSessionId;
  if (!active) return true;
  if (!msgSessionId) return true;
  return msgSessionId === active;
}

function sendNextFromQueue(send: (msg: ClientMessage) => void) {
  const store = useChatStore.getState();
  const next = store.dequeueMessage();
  if (!next) return;

  store.addUserMessage(next.content, next.anchors, next.images);
  store.setAgentRunning(true);

  getTargetTabInfo((url, domain) => {
    chrome.storage.local.get(`ccb-sources-${domain}`, (result) => {
      const sources = result[`ccb-sources-${domain}`] as string[] | undefined;
      const sessionId = useChatStore.getState().activeSessionId;
      send({
        type: 'chat:send',
        sessionId: sessionId ?? undefined,
        message: next.content,
        anchors: next.anchors,
        images: next.images,
        url,
        sources: sources?.length ? sources : undefined,
      });
    });
  });
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

    port.onMessage.addListener((msg: ServerMessage & { type: string; connected?: boolean; error?: string }) => {
      const store = useChatStore.getState();

      // Internal status messages from service worker
      if (msg.type === '_native_status') {
        if (msg.connected) {
          // Native host connected but we wait for connection:ready
        } else {
          setStatus('disconnected');
        }
        return;
      }

      if (msg.type === '_target_tab') {
        useConnectionStore.getState().setTargetTab(
          (msg as { tabId: number | null }).tabId,
          (msg as { url?: string }).url,
        );
        return;
      }

      switch (msg.type) {
        case 'connection:ready': {
          setStatus('connected');
          send({ type: 'session:list' });

          // Auto-resume: if we were running when disconnected, resend the last user message
          const currentStore = useChatStore.getState();
          if (currentStore.isAgentRunning) {
            const lastUserMsg = [...currentStore.messages].reverse().find((m) => m.role === 'user');
            if (lastUserMsg && currentStore.activeSessionId) {
              send({
                type: 'chat:send',
                sessionId: currentStore.activeSessionId,
                message: lastUserMsg.content,
                url: '',
              });
            }
          }
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
          store.setActiveSession(msg.sessionId);
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
          if (!isForActiveSession(msg.sessionId)) break;
          const loaded: Array<{
            id: string;
            role: 'user' | 'assistant' | 'system';
            content: string;
            timestamp: number;
            kind?: 'text' | 'thinking' | 'tool_use';
          }> = [];
          for (let i = 0; i < msg.messages.length; i++) {
            const m = msg.messages[i];
            if (m.role === 'assistant' && m.blocks && m.blocks.length > 0) {
              // Expand blocks into separate messages for proper rendering
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
          useChatStore.setState({ messages: loaded });
          break;
        }

        case 'chat:stream': {
          if (!isForActiveSession(msg.sessionId)) break;
          const kind = msg.kind ?? 'text';
          const msgs = useChatStore.getState().messages;
          const last = msgs[msgs.length - 1];
          let targetId: string;

          // Merge into last message if same kind and still part of this turn
          if (last && last.kind === kind && last.role === 'assistant') {
            targetId = last.id;
            // Re-open if it was closed (e.g. thinking was auto-closed)
            if (!last.isStreaming) {
              useChatStore.setState({
                messages: msgs.map((m) => m.id === targetId ? { ...m, isStreaming: true } : m),
              });
            }
          } else {
            // Different kind or no messages — create a new section
            // Close the previous streaming message first
            if (last && last.isStreaming) {
              useChatStore.setState({
                messages: msgs.map((m) => m.id === last.id ? { ...m, isStreaming: false } : m),
              });
            }
            targetId = msg.messageId;
            useChatStore.getState().startAssistantMessage(targetId, kind);
          }

          useChatStore.getState().appendDelta(targetId, msg.delta);
          break;
        }

        case 'agent:tool_use': {
          if (!isForActiveSession(msg.sessionId)) break;
          if (msg.toolName === '_update_') {
            // Update the last tool_use message with the full summary
            const msgs = useChatStore.getState().messages;
            const lastTool = [...msgs].reverse().find((m) => m.kind === 'tool_use');
            if (lastTool) {
              useChatStore.setState({
                messages: msgs.map((m) => m.id === lastTool.id ? { ...m, content: msg.summary } : m),
              });
            }
          } else {
            store.addToolUseMessage(msg.toolName, msg.summary);
          }
          break;
        }

        case 'chat:complete':
          if (!isForActiveSession(msg.sessionId)) break;
          useChatStore.getState().completeMessage(msg.messageId, msg.result);
          store.setAgentRunning(false);
          // Refresh session list (title may have been generated)
          send({ type: 'session:list' });
          // Auto-send next queued message
          setTimeout(() => sendNextFromQueue(send), 100);
          break;

        case 'chat:error': {
          if (!isForActiveSession(msg.sessionId)) break;
          const isInterrupt = msg.error.includes('interrupted') || msg.error.includes('Interrupted');
          if (isInterrupt) {
            // Show subtle italic "interrupted" like Claude Code
            useChatStore.setState({
              messages: [
                ...useChatStore.getState().messages,
                {
                  id: `int-${Date.now()}`,
                  role: 'system',
                  content: '_interrupted_',
                  timestamp: Date.now(),
                },
              ],
            });
          } else {
            useChatStore.setState({
              messages: [
                ...useChatStore.getState().messages,
                {
                  id: `err-${Date.now()}`,
                  role: 'system',
                  content: `Error: ${msg.error}`,
                  timestamp: Date.now(),
                },
              ],
            });
          }
          store.setAgentRunning(false);
          // Auto-send next from queue, but NOT after user-initiated interrupt
          if (!isInterrupt) {
            setTimeout(() => sendNextFromQueue(send), 100);
          }
          break;
        }

        case 'agent:status':
          if (!isForActiveSession(msg.sessionId)) break;
          store.setAgentRunning(msg.status === 'running');
          break;

        case 'health':
          break;

        case 'commands:list':
          window.dispatchEvent(new CustomEvent('ccb:commands', { detail: msg.commands }));
          break;

        case 'sources:set':
          // Store sources in chrome.storage.local, keyed by domain
          chrome.storage.local.set({ [`ccb-sources-${msg.domain}`]: msg.paths });
          // Notify SourcesPanel to reload
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
