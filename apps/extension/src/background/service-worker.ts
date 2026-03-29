const HOST_NAME = 'com.claude_code_browser';
let nativePort: chrome.runtime.Port | null = null;
let sidePanelPort: chrome.runtime.Port | null = null;
let nativeMessages: unknown[] = []; // Buffer messages before sidepanel connects

// ── Native Host Connection ──────────────────────────────────────────────────

function connectNativeHost() {
  if (nativePort) return;

  console.log('[CCB-SW] Attempting connectNative to:', HOST_NAME);

  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
    console.log('[CCB-SW] connectNative returned port:', !!nativePort);
  } catch (e) {
    console.error('[CCB-SW] Failed to connect to native host:', e);
    notifySidePanel({ type: '_native_status', connected: false, error: String(e) });
    return;
  }

  nativePort.onMessage.addListener((msg: { type: string; domain?: string; paths?: string[] }) => {
    // Handle sources:set directly in service worker — write to storage immediately
    if (msg.type === 'sources:set' && msg.domain && msg.paths) {
      chrome.storage.local.set({ [`ccb-sources-${msg.domain}`]: msg.paths });
      console.log('[CCB-SW] Sources stored for', msg.domain, msg.paths.length, 'paths');
    }
    // Forward all messages to side panel
    notifySidePanel(msg);
  });

  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message ?? 'disconnected';
    console.error('[CCB-SW] Native host disconnected:', error);
    nativePort = null;
    notifySidePanel({ type: '_native_status', connected: false, error });

    // Retry after 5 seconds
    setTimeout(connectNativeHost, 5000);
  });
}

function notifySidePanel(msg: unknown) {
  if (sidePanelPort) {
    try {
      sidePanelPort.postMessage(msg);
    } catch {
      // Side panel not connected
    }
  } else {
    // Buffer for when sidepanel connects
    nativeMessages.push(msg);
    if (nativeMessages.length > 50) nativeMessages.shift();
  }
}

// ── Side Panel Connection ───────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    sidePanelPort = port;

    // If native host is already connected, send connection:ready to sidepanel
    if (nativePort) {
      port.postMessage({ type: 'connection:ready', serverVersion: '0.1.0' });
    }

    // Flush any buffered messages
    for (const msg of nativeMessages) {
      try { port.postMessage(msg); } catch { break; }
    }
    nativeMessages = [];

    // Connect native host if not already
    if (!nativePort) {
      connectNativeHost();
    }

    port.onMessage.addListener((msg) => {
      // Forward messages from side panel to native host
      if (nativePort) {
        try {
          nativePort.postMessage(msg);
        } catch {
          console.error('[CCB-SW] Failed to send to native host');
        }
      }
    });

    port.onDisconnect.addListener(() => {
      sidePanelPort = null;
    });
  }
});

// ── Extension Action ────────────────────────────────────────────────────────

chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null) {
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

// ── Content Script Message Relay ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ACTIVATE_PICKER') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      const url = tabs[0]?.url ?? '';
      if (!tabId || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;

      chrome.tabs.sendMessage(tabId, { type: 'ACTIVATE_PICKER' }, () => {
        if (chrome.runtime.lastError) {
          // Content script not injected — inject it now, then retry
          chrome.scripting.executeScript(
            { target: { tabId }, files: ['content-script.js'] },
            () => {
              void chrome.runtime.lastError;
              chrome.scripting.insertCSS(
                { target: { tabId }, files: ['element-picker.css'] },
                () => {
                  void chrome.runtime.lastError;
                  // Retry after injection
                  chrome.tabs.sendMessage(tabId, { type: 'ACTIVATE_PICKER' }, () => void chrome.runtime.lastError);
                },
              );
            },
          );
        }
      });
    });
    return;
  }

  if (
    message.type === 'GET_DOM_TREE' ||
    message.type === 'GET_SUBTREE' ||
    message.type === 'HIGHLIGHT_ELEMENT' ||
    message.type === 'REMOVE_HIGHLIGHT'
  ) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      const url = tabs[0]?.url ?? '';
      if (!tabId || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
        sendResponse(null);
        return;
      }
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          // Content script not injected — inject and retry
          chrome.scripting.executeScript(
            { target: { tabId }, files: ['content-script.js'] },
            () => {
              void chrome.runtime.lastError;
              chrome.scripting.insertCSS({ target: { tabId }, files: ['element-picker.css'] }, () => void chrome.runtime.lastError);
              chrome.tabs.sendMessage(tabId, message, (retryResponse) => {
                sendResponse(chrome.runtime.lastError ? null : retryResponse);
              });
            },
          );
          return;
        }
        sendResponse(response);
      });
    });
    return true;
  }

  if (message.type === 'ELEMENT_SELECTED' && sender.tab) {
    return;
  }
});
