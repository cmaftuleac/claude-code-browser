/** This side-panel document's own tab, read from its URL (?tab=<id>) — set by the
 *  service worker when it opened the panel. Each panel is independently bound to
 *  one tab, so all content-script messaging targets THIS tab directly (no global
 *  target tab, no service-worker relay). Fixed for the document's lifetime. */
export const MY_TAB_ID: number | null = (() => {
  try {
    const t = new URLSearchParams(self.location.search).get('tab');
    const n = t ? parseInt(t, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
})();

/** Send a message to this panel's own tab's content script, injecting the content
 *  script + CSS on first use if it isn't loaded yet (mirrors the old SW relay,
 *  but scoped to MY_TAB_ID instead of a shared global target tab). */
export function sendToMyTab(message: unknown, callback?: (response: unknown) => void): void {
  if (MY_TAB_ID == null) { callback?.(null); return; }
  const tabId = MY_TAB_ID;
  chrome.tabs.sendMessage(tabId, message, (response) => {
    if (chrome.runtime.lastError) {
      // Content script not injected yet — inject it, then retry once.
      chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] }, () => {
        void chrome.runtime.lastError;
        chrome.scripting.insertCSS({ target: { tabId }, files: ['element-picker.css'] }, () => {
          void chrome.runtime.lastError;
          chrome.tabs.sendMessage(tabId, message, (retry) => {
            callback?.(chrome.runtime.lastError ? null : retry);
          });
        });
      });
      return;
    }
    callback?.(response);
  });
}
