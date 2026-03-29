import { useEffect, useRef, useCallback } from 'react';
import type { ClientMessage, ServerMessage } from '@claude-code-browser/shared';
import { useConnectionStore } from '../stores/connection-store';
import { useChatStore } from '../stores/chat-store';
import { handleBrowserRequest } from '../browser-handler';

function sendNextFromQueue(send: (msg: ClientMessage) => void) {
  const store = useChatStore.getState();
  const next = store.dequeueMessage();
  if (!next) return;

  store.addUserMessage(next.content, next.anchors, next.images);
  store.setAgentRunning(true);

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0]?.url ?? '';
    let domain = 'unknown';
    try { domain = new URL(url).hostname; } catch { /* */ }

    // Load sources for this domain
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

      // Internal status message from service worker
      if (msg.type === '_native_status') {
        if (msg.connected) {
          // Native host connected but we wait for connection:ready
        } else {
          setStatus('disconnected');
        }
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

        case 'session:list':
          store.setSessions(msg.sessions);
          break;

        case 'session:created':
          store.setActiveSession(msg.sessionId);
          break;

        case 'session:messages': {
          const loaded = msg.messages.map((m, i) => ({
            id: `hist-${msg.sessionId}-${i}`,
            role: m.role as 'user' | 'assistant',
            content: m.content,
            timestamp: m.timestamp ?? Date.now(),
          }));
          useChatStore.setState({ messages: loaded });
          break;
        }

        case 'chat:stream': {
          const exists = store.messages.some((m) => m.id === msg.messageId);
          if (!exists) {
            store.startAssistantMessage(msg.messageId);
          }
          setTimeout(() => useChatStore.getState().appendDelta(msg.messageId, msg.delta), 0);
          break;
        }

        case 'chat:complete':
          useChatStore.getState().completeMessage(msg.messageId, msg.result);
          store.setAgentRunning(false);
          // Auto-send next queued message
          setTimeout(() => sendNextFromQueue(send), 100);
          break;

        case 'chat:error': {
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
          store.setAgentRunning(msg.status === 'running');
          break;

        case 'health':
          break;

        case 'commands:list':
          // Store commands for the slash menu — dispatch custom event
          window.dispatchEvent(new CustomEvent('ccb:commands', { detail: msg.commands }));
          break;

        case 'browser:request':
          handleBrowserRequest({
            requestId: msg.requestId,
            action: msg.action,
            params: msg.params,
          }).then((response) => send(response as unknown as ClientMessage));
          break;

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
