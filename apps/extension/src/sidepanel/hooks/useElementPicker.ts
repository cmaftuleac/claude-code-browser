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

    // Also listen for Escape in the side panel to cancel picker
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        chrome.runtime.sendMessage({ type: 'ACTIVATE_PICKER' }); // toggles off if active
      }
    };

    chrome.runtime.onMessage.addListener(handler);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      chrome.runtime.onMessage.removeListener(handler);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [addAnchor]);

  const activatePicker = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'ACTIVATE_PICKER' });
  }, []);

  return { activatePicker };
}
