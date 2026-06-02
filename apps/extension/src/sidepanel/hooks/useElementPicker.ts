import { useEffect, useCallback } from 'react';
import { useChatStore } from '../stores/chat-store';
import type { DomTreeNode } from '../stores/dom-tree-store';
import { MY_TAB_ID, sendToMyTab } from '../tab';

export function useElementPicker() {
  const addAnchor = useChatStore((s) => s.addAnchor);

  useEffect(() => {
    const handler = (
      message: { type: string; anchor?: unknown; treePath?: string },
      sender: chrome.runtime.MessageSender,
      _sendResponse: (response?: unknown) => void,
    ) => {
      // Only consume picks from OUR tab — content scripts broadcast ELEMENT_SELECTED
      // to every open panel, so without this filter a pick on one tab would inject
      // an anchor into every panel.
      if (message.type === 'ELEMENT_SELECTED' && message.anchor && sender.tab?.id === MY_TAB_ID) {
        addAnchor(message.anchor as Parameters<typeof addAnchor>[0]);

        // Re-fetch the DOM tree (React may have changed it) then highlight the node.
        // Import lazily to avoid circular init issues.
        import('../stores/dom-tree-store').then(({ useDomTreeStore }) => {
          sendToMyTab({ type: 'GET_DOM_TREE' }, (response) => {
            const res = response as { tree?: DomTreeNode } | null;
            if (res?.tree) useDomTreeStore.getState().setTree(res.tree);
            if (message.treePath != null) useDomTreeStore.getState().setSelectedPath(message.treePath);
          });
        });
      }
    };

    // Also listen for Escape in the side panel to cancel the picker.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        sendToMyTab({ type: 'ACTIVATE_PICKER' });
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
    sendToMyTab({ type: 'ACTIVATE_PICKER' });
  }, []);

  return { activatePicker };
}
