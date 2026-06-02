const HOST_NAME = 'com.claude_code_browser';

/** One independent panel per tab: each tab pairs its side-panel port with its OWN
 *  dedicated native host process. The service worker is just a 1:1 multiplexer of
 *  these pairs — no global target tab, no shared host. */
interface PanelPair {
  tabId: number;
  /** The side-panel port for this tab. Null while the panel is closed/reloading
   *  (the host stays alive and we buffer until a panel reconnects). */
  panelPort: chrome.runtime.Port | null;
  /** This tab's dedicated native host connection. */
  nativePort: chrome.runtime.Port | null;
  /** The host's real connection:ready (carries serverVersion), replayed to a
   *  reconnecting panel. */
  lastConnectionReady: { type: string; serverVersion?: string } | null;
  /** Native messages received while no panel is attached. */
  buffer: unknown[];
}

const pairs = new Map<number, PanelPair>();
const panelToTab = new WeakMap<chrome.runtime.Port, number>();

// ── Disable side panel globally on startup ─────────────────────────────────
// Panels are enabled per-tab on action click (with a ?tab=<id> path), so they
// don't appear on tabs the user hasn't explicitly opened them on.
chrome.sidePanel.setOptions({ enabled: false });

// ── Initialize usage stats on install / update ─────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install' && reason !== 'update') return;
  chrome.storage.local.get('ccb-stats', (res) => {
    if (res['ccb-stats']) return;
    chrome.storage.local.set({
      'ccb-stats': { installedAt: Date.now(), messageCount: 0, sessionCount: 0 },
    });
  });
});

// ── Per-pair native host connection ─────────────────────────────────────────

function deliverToPanel(pair: PanelPair, msg: unknown) {
  if (pair.panelPort) {
    try { pair.panelPort.postMessage(msg); return; } catch { /* panel gone — buffer */ }
  }
  pair.buffer.push(msg);
  if (pair.buffer.length > 100) pair.buffer.shift();
}

function connectNativeForPair(pair: PanelPair) {
  let np: chrome.runtime.Port;
  try {
    np = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    deliverToPanel(pair, { type: '_native_status', connected: false, error: String(e) });
    return;
  }
  pair.nativePort = np;

  np.onMessage.addListener((msg: { type: string; domain?: string; paths?: string[]; serverVersion?: string }) => {
    // sources:set is persisted to shared storage keyed by domain (any panel on
    // that domain reads it) — handle once here.
    if (msg.type === 'sources:set' && msg.domain && msg.paths) {
      chrome.storage.local.set({ [`ccb-sources-${msg.domain}`]: msg.paths });
    }
    // connection:ready: cache per-pair (replayed on panel reconnect) and deliver
    // only to a live panel — never buffer, so a reconnecting panel doesn't get it
    // twice (cache replay + buffer flush).
    if (msg.type === 'connection:ready') {
      pair.lastConnectionReady = { type: msg.type, serverVersion: msg.serverVersion };
      if (pair.panelPort) { try { pair.panelPort.postMessage(msg); } catch { /* closed */ } }
      return;
    }
    deliverToPanel(pair, msg);
  });

  np.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message ?? 'disconnected';
    pair.nativePort = null;
    pair.lastConnectionReady = null;
    deliverToPanel(pair, { type: '_native_status', connected: false, error });
    // Reconnect only while this pair is still current (tab still open, not torn
    // down). Guard against racing a teardown or a concurrent reconnect.
    setTimeout(() => {
      if (pairs.get(pair.tabId) === pair && !pair.nativePort) connectNativeForPair(pair);
    }, 5000);
  });
}

/** Bind a (re)connecting panel to its tab's pair, spawning the host on first use
 *  and reusing it on panel reload. Host lifecycle is tied to the TAB, not the
 *  panel port, so closing/reopening the panel (or Chrome unloading it on tab
 *  switch) preserves in-flight work. */
function registerPair(tabId: number, panelPort: chrome.runtime.Port) {
  panelToTab.set(panelPort, tabId);
  let pair = pairs.get(tabId);
  if (pair) {
    pair.panelPort = panelPort;
    if (pair.lastConnectionReady) {
      try { panelPort.postMessage(pair.lastConnectionReady); } catch { /* closed */ }
    }
    const buffered = pair.buffer;
    pair.buffer = [];
    for (const m of buffered) {
      try { panelPort.postMessage(m); } catch { break; }
    }
    if (!pair.nativePort) connectNativeForPair(pair);
    return;
  }
  pair = { tabId, panelPort, nativePort: null, lastConnectionReady: null, buffer: [] };
  pairs.set(tabId, pair);
  connectNativeForPair(pair);
}

function teardownPair(tabId: number) {
  const pair = pairs.get(tabId);
  if (!pair) return;
  pairs.delete(tabId);
  // Disconnecting the native port closes the host's stdin → host main() hits EOF
  // → process.exit(0). No leaked host processes.
  try { pair.nativePort?.disconnect(); } catch { /* already gone */ }
  try { pair.panelPort?.disconnect(); } catch { /* already gone */ }
}

// ── Side Panel Connection ───────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;

  port.onMessage.addListener((msg: { type?: string; tabId?: number } & Record<string, unknown>) => {
    // First message from a panel identifies its tab (authoritative — port.sender
    // is unreliable for side panels).
    if (msg.type === '_panel_init' && typeof msg.tabId === 'number') {
      registerPair(msg.tabId, port);
      return;
    }
    // Forward everything else to this tab's host.
    const tabId = panelToTab.get(port);
    const pair = tabId != null ? pairs.get(tabId) : undefined;
    if (pair?.nativePort) {
      try { pair.nativePort.postMessage(msg); } catch { /* host gone */ }
    }
  });

  port.onDisconnect.addListener(() => {
    const tabId = panelToTab.get(port);
    panelToTab.delete(port);
    if (tabId == null) return;
    const pair = pairs.get(tabId);
    // Keep the host alive (the tab is still open) and buffer until a panel
    // reconnects. The host is only torn down when the tab closes.
    if (pair && pair.panelPort === port) pair.panelPort = null;
  });
});

// ── Extension Action — open an independent panel for the clicked tab ────────

chrome.action.onClicked.addListener((tab) => {
  if (tab.id == null) return;
  const tabId = tab.id;
  // Pass the tab id to the panel via its URL so it knows which tab it serves.
  // No old-tab disable — panels on other tabs stay open and independent.
  chrome.sidePanel.setOptions({ tabId, path: `sidepanel.html?tab=${tabId}`, enabled: true }, () => {
    void chrome.runtime.lastError;
    chrome.sidePanel.open({ tabId });
  });
});

// ── Tab closed — tear down only that tab's pair (and its host) ──────────────

chrome.tabs.onRemoved.addListener((tabId) => teardownPair(tabId));
