import { useEffect, useCallback } from 'react';
import { useChatStore } from '../stores/chat-store';

export function useElementPicker() {
  const addAnchor = useChatStore((s) => s.addAnchor);

  useEffect(() => {
    const handler = (
      message: { type: string; anchor?: unknown; treePath?: string },
      _sender: chrome.runtime.MessageSender,
      _sendResponse: (response?: unknown) => void,
    ) => {
      if (message.type === 'ELEMENT_SELECTED' && message.anchor) {
        addAnchor(message.anchor as Parameters<typeof addAnchor>[0]);

        // Re-fetch the DOM tree (React may have changed it) then highlight the node
        // Import lazily to avoid circular init issues
        import('../stores/dom-tree-store').then(({ useDomTreeStore }) => {
          chrome.runtime.sendMessage({ type: 'GET_DOM_TREE' }, (response) => {
            if (response?.tree) {
              useDomTreeStore.getState().setTree(response.tree);
            }
            if (message.treePath != null) {
              useDomTreeStore.getState().setSelectedPath(message.treePath);
            }
          });
        });
      }
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [addAnchor]);

  const activatePicker = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'ACTIVATE_PICKER' });
  }, []);

  return { activatePicker };
}
