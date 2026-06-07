/**
 * Renderer-side memory reclaim: an always-on idle-tab sweep plus a handler for
 * OS memory-pressure escalations broadcast by the main-process governor.
 *
 * The heavy renderer lever is suspending hidden browser tabs — each <webview> is
 * a full Chromium renderer process, so unmounting it (browser-store.suspend) frees
 * that process. We only ever suspend tabs that are hidden, not the active one, and
 * not bound to a running agent turn; they reload on focus. (Off-panel DOM-tree
 * eviction and Monaco model disposal are handled elsewhere / always-on.)
 */
import { useBrowserStore } from '../stores/browser-store';
import { useTasksStore } from '../stores/tasks-store';

/** Unload a hidden tab after this long without being the active tab. */
const TAB_IDLE_MS = 20 * 60 * 1000;
/** How often the idle sweep runs. */
const SWEEP_INTERVAL_MS = 30 * 1000;

/** Browsers bound to a conversation with a turn in flight — never suspend these. */
function runningBoundBrowserIds(): Set<string> {
  const ids = new Set<string>();
  for (const t of useTasksStore.getState().tasks) if (t.running && t.browserId) ids.add(t.browserId);
  return ids;
}

/** Hidden, non-active, non-agent-driven, loaded tabs eligible to suspend. When
 *  `requireIdleMs` is set, also require that long since the tab was last active. */
function suspendCandidates(requireIdleMs?: number): string[] {
  const bs = useBrowserStore.getState();
  const protectedIds = runningBoundBrowserIds();
  const now = Date.now();
  return bs.order.filter((id) => {
    const inst = bs.instances[id];
    if (!inst || inst.suspended || !inst.loadedUrl) return false;
    if (id === bs.activeId || inst.visible) return false;
    if (protectedIds.has(id)) return false;
    if (requireIdleMs != null && now - inst.lastActiveAt < requireIdleMs) return false;
    return true;
  });
}

function suspendHiddenTabs(requireIdleMs?: number): number {
  const bs = useBrowserStore.getState();
  const ids = suspendCandidates(requireIdleMs);
  ids.forEach((id) => bs.suspend(id));
  return ids.length;
}

function forceGc(): void {
  // Exposed via the main process's --js-flags=--expose-gc; no-op if absent.
  try { (globalThis as { gc?: () => void }).gc?.(); } catch { /* not exposed */ }
}

function onPressure(level: 'moderate' | 'critical'): void {
  if (level === 'critical') {
    // Unload every hidden tab (frees their renderer processes) + collect.
    suspendHiddenTabs();
    forceGc();
  } else {
    // moderate: main already reaped long-idle sessions + cleared caches, and
    // off-panel DOM trees are freed on tab close; a light GC is all we add here.
    forceGc();
  }
}

/** Install the renderer reclaim (idle sweep + pressure handler). Returns cleanup.
 *  No-op outside Electron (web mode has no webview renderer processes to free). */
export function installMemoryReclaim(): () => void {
  if (!window.ccb.isElectron) return () => { /* nothing to do */ };
  const sweep = setInterval(() => { suspendHiddenTabs(TAB_IDLE_MS); }, SWEEP_INTERVAL_MS);
  const off = typeof window.ccb.onMemoryPressure === 'function'
    ? window.ccb.onMemoryPressure(onPressure)
    : () => { /* no pressure channel */ };
  return () => { clearInterval(sweep); off(); };
}
