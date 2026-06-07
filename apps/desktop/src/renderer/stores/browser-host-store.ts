import { create } from 'zustand';

/**
 * Tracks, per browser instance, the DOM anchor its overlay should cover — the
 * empty placeholder rendered by whichever pane currently holds that instance's
 * tab. One anchor per open instance at steady state; two coexist for the single
 * React commit that moves a tab between split groups.
 *
 * "set on truthy, clear only if still mine" — PER ID: during a move commit React
 * may fire the departing anchor's ref(null) cleanup AFTER the new anchor's
 * ref(el) for the same id, so we ignore null sets and only let an anchor clear
 * itself by identity. A late cleanup from the old pane therefore can't wipe the
 * freshly-mounted anchor for the same instance.
 */
interface BrowserHostState {
  anchors: Record<string, HTMLElement>;
  setAnchor: (id: string, el: HTMLElement | null) => void;
  clearAnchor: (id: string, el: HTMLElement) => void;
}

export const useBrowserHostStore = create<BrowserHostState>((set) => ({
  anchors: {},
  setAnchor: (id, el) => { if (el) set((s) => ({ anchors: { ...s.anchors, [id]: el } })); },
  clearAnchor: (id, el) => set((s) => {
    if (s.anchors[id] !== el) return s;
    const anchors = { ...s.anchors };
    delete anchors[id];
    return { anchors };
  }),
}));
