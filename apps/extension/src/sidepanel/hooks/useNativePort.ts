import { useEffect, useRef, useCallback } from 'react';
import type { ClientMessage, ServerMessage } from '@claude-code-browser/shared';
import { useConnectionStore } from '../stores/connection-store';
import { useChatStore } from '../stores/chat-store';
import { handleBrowserRequest } from '../browser-handler';

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
        case 'connection:ready':
          setStatus('connected');
          send({ type: 'session:list' });
          break;

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
          break;

        case 'chat:error':
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
          store.setAgentRunning(false);
          break;

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
