import { create } from 'zustand';
import { useEditorStore } from './editor-store';
import { useClosedTabsStore } from './closed-tabs-store';

function normalizeUrl(input: string): string {
  const v = input.trim();
  if (!v) return v;
  if (/^https?:\/\//i.test(v) || /^file:\/\//i.test(v) || /^about:/i.test(v)) return v;
  if (/^localhost(:\d+)?/i.test(v) || /^\d+\.\d+\.\d+\.\d+/.test(v)) return `http://${v}`;
  return `https://${v}`;
}

/** Stable per-instance id. `crypto.randomUUID` needs a secure context (web mode
 *  over plain http may not have one), so fall back to a random+time string. */
let seq = 0;
function newBrowserId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* non-secure context — fall through */ }
  return `b-${Math.random().toString(36).slice(2)}-${(seq++).toString(36)}`;
}

/** One embedded browser tab. Multiple coexist — each owns its page, history,
 *  address bar, and (via editor-store slices) its visual-editor state. */
export interface BrowserInstance {
  id: string;
  /** Text in the address input (may differ from loadedUrl while typing). */
  addressBar: string;
  /** The committed URL that drives `<webview src>`. Set ONLY by an explicit
   *  navigate()/reload — never by did-navigate — so in-page/link navigation
   *  doesn't rewrite src (which would reload the page). Empty = blank. */
  loadedUrl: string;
  /** The live location the guest is actually showing (from did-navigate). Drives
   *  the address bar + "current url" context; may differ from loadedUrl. */
  currentUrl: string;
  /** Page <title>, for the tab label. */
  title: string;
  /** Pulses the tab until focused. */
  hint: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** True while the user is typing in the address input — suppresses live URL
   *  sync from did-navigate so we don't clobber what they're typing. */
  addressEditing?: boolean;
  /** Memory: when true the <webview> is unmounted (its renderer process freed);
   *  it reloads `loadedUrl` on resume. Set by the idle sweep / memory governor. */
  suspended?: boolean;
  /** Whether this tab is currently on-screen (BrowserOverlay's rAF loop reports
   *  it). Only hidden (!visible) tabs are eligible for suspension. */
  visible?: boolean;
  /** Last time this instance was the focused browser — LRU key for the idle sweep. */
  lastActiveAt: number;
}

interface BrowserState {
  instances: Record<string, BrowserInstance>;
  /** Creation order — drives tab ordering, reconcile stability, label fallbacks. */
  order: string[];
  /** The focused browser (pane focus / tab click). Used as the default binding
   *  target and as "the browser the user is looking at". */
  activeId: string | null;

  /** Create a browser instance. Blank by default (address bar focused, nothing
   *  loaded). Returns the new id. */
  openBrowser(opts?: { url?: string; hint?: boolean; focus?: boolean }): string;
  closeBrowser(id: string): void;
  /** Tear down every instance (project close / open-folder). */
  closeAllBrowsers(): void;
  navigate(id: string, url: string): void;
  setAddressBar(id: string, v: string): void;
  setTitle(id: string, title: string): void;
  /** Sync live navigation state from the guest (`did-navigate`). */
  setNav(id: string, info: { url?: string; canGoBack?: boolean; canGoForward?: boolean }): void;
  /** Flag the address input as being edited (suppresses did-navigate URL sync). */
  setAddressEditing(id: string, editing: boolean): void;
  clearHint(id: string): void;
  setActive(id: string): void;
  /** Unload a hidden tab's <webview> to free its renderer process. Never the
   *  active tab; reloads `loadedUrl` on resume. */
  suspend(id: string): void;
  /** Re-mount a suspended tab's <webview> (reloads `loadedUrl`). */
  resume(id: string): void;
  /** Track on-screen visibility (BrowserOverlay rAF loop). Becoming visible
   *  also un-suspends, since a shown tab must never be blank. */
  setVisible(id: string, visible: boolean): void;
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  instances: {},
  order: [],
  activeId: null,

  openBrowser: (opts) => {
    const id = newBrowserId();
    const url = opts?.url ? normalizeUrl(opts.url) : '';
    const inst: BrowserInstance = {
      id,
      addressBar: url, // blank tab → '' (input shows placeholder + autofocuses)
      loadedUrl: url,
      currentUrl: url,
      title: '',
      hint: !!opts?.hint,
      canGoBack: false,
      canGoForward: false,
      lastActiveAt: Date.now(),
    };
    set((s) => ({
      instances: { ...s.instances, [id]: inst },
      order: [...s.order, id],
      activeId: opts?.focus === false ? s.activeId : id,
    }));
    useEditorStore.getState().ensureSlice(id);
    return id;
  },

  closeBrowser: (id) => {
    // Record for Reopen Closed Tab (Cmd+Shift+T) — keep its URL so it can be
    // restored. A blank/never-loaded tab has nothing to restore, so skip it.
    const inst = get().instances[id];
    const url = inst?.currentUrl || inst?.loadedUrl || '';
    if (url) useClosedTabsStore.getState().push({ kind: 'browser', url, title: inst?.title || undefined });
    useEditorStore.getState().disposeSlice(id);
    set((s) => {
      if (!s.instances[id]) return s;
      const instances = { ...s.instances };
      delete instances[id];
      const order = s.order.filter((x) => x !== id);
      const activeId = s.activeId === id ? (order[order.length - 1] ?? null) : s.activeId;
      return { instances, order, activeId };
    });
  },

  closeAllBrowsers: () => {
    const ed = useEditorStore.getState();
    for (const id of get().order) ed.disposeSlice(id);
    set({ instances: {}, order: [], activeId: null });
  },

  navigate: (id, url) => {
    const normalized = normalizeUrl(url);
    set((s) => {
      const inst = s.instances[id];
      if (!inst) return s;
      return { instances: { ...s.instances, [id]: { ...inst, loadedUrl: normalized, currentUrl: normalized, addressBar: normalized } } };
    });
  },

  setAddressBar: (id, addressBar) => set((s) => {
    const inst = s.instances[id];
    if (!inst) return s;
    return { instances: { ...s.instances, [id]: { ...inst, addressBar } } };
  }),

  setTitle: (id, title) => set((s) => {
    const inst = s.instances[id];
    if (!inst || inst.title === title) return s;
    return { instances: { ...s.instances, [id]: { ...inst, title } } };
  }),

  setNav: (id, info) => set((s) => {
    const inst = s.instances[id];
    if (!inst) return s;
    const next = { ...inst };
    if (info.url != null) {
      // Track the live location ONLY — never loadedUrl (the committed <webview
      // src>), or React would rewrite src on every navigation and reload the page.
      next.currentUrl = info.url;
      // Don't overwrite the address bar while the user is typing in it.
      if (!inst.addressEditing) next.addressBar = info.url;
    }
    if (info.canGoBack != null) next.canGoBack = info.canGoBack;
    if (info.canGoForward != null) next.canGoForward = info.canGoForward;
    return { instances: { ...s.instances, [id]: next } };
  }),

  setAddressEditing: (id, addressEditing) => set((s) => {
    const inst = s.instances[id];
    if (!inst || !!inst.addressEditing === addressEditing) return s;
    return { instances: { ...s.instances, [id]: { ...inst, addressEditing } } };
  }),

  clearHint: (id) => set((s) => {
    const inst = s.instances[id];
    if (!inst || !inst.hint) return s;
    return { instances: { ...s.instances, [id]: { ...inst, hint: false } } };
  }),

  setActive: (id) => set((s) => {
    const inst = s.instances[id];
    if (!inst) return s;
    // Already active and not suspended → no structural change (avoid re-render churn).
    if (s.activeId === id && !inst.suspended) return s;
    // Activating a tab bumps its LRU timestamp and always un-suspends it.
    return {
      instances: { ...s.instances, [id]: { ...inst, lastActiveAt: Date.now(), suspended: false } },
      activeId: id,
    };
  }),

  suspend: (id) => set((s) => {
    const inst = s.instances[id];
    // Never suspend the active tab or a blank/unloaded one (nothing to reload).
    if (!inst || inst.suspended || s.activeId === id || !inst.loadedUrl) return s;
    return { instances: { ...s.instances, [id]: { ...inst, suspended: true } } };
  }),

  resume: (id) => set((s) => {
    const inst = s.instances[id];
    if (!inst || !inst.suspended) return s;
    return { instances: { ...s.instances, [id]: { ...inst, suspended: false, lastActiveAt: Date.now() } } };
  }),

  setVisible: (id, visible) => set((s) => {
    const inst = s.instances[id];
    if (!inst || !!inst.visible === visible) return s;
    const next: BrowserInstance = { ...inst, visible };
    if (visible && inst.suspended) { next.suspended = false; next.lastActiveAt = Date.now(); }
    return { instances: { ...s.instances, [id]: next } };
  }),
}));

/** Imperative webview controls, registered by BrowserCanvas on dom-ready. Kept
 *  out of reactive state (no re-render on register); button enabled-state lives
 *  on the instance (canGoBack/canGoForward) and IS reactive. */
export interface BrowserControl { goBack(): void; goForward(): void; reload(): void; }
const controllers = new Map<string, BrowserControl>();
export function registerBrowserControl(id: string, ctrl: BrowserControl | null): void {
  if (ctrl) controllers.set(id, ctrl); else controllers.delete(id);
}
export function browserControl(id: string): BrowserControl | undefined {
  return controllers.get(id);
}

/** The instance for an id (or undefined). */
export function useBrowserInstance(id: string | null | undefined): BrowserInstance | undefined {
  return useBrowserStore((s) => (id ? s.instances[id] : undefined));
}

/** The focused browser instance (or undefined). */
export function useActiveBrowser(): BrowserInstance | undefined {
  return useBrowserStore((s) => (s.activeId ? s.instances[s.activeId] : undefined));
}
