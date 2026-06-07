import { create } from 'zustand';
import type { ElementAnchor, EditJournalEntry, DomTreeNode } from '@fineguide-tesseract/shared';

/** Sends a host→guest message over a specific <webview>. Registered per instance by BrowserCanvas. */
type GuestSend = (channel: string, payload?: unknown) => void;

/** Which right-side panel (if any) is open over a browser instance. */
export type RightPanel = 'closed' | 'tree' | 'style';

/** Cap on retained edit-journal entries per browser (renderer memory). */
const JOURNAL_CAP = 200;

/** Visual-editor state for ONE browser instance. */
export interface EditorSlice {
  mode: 'browse' | 'edit';
  selected: ElementAnchor | null;
  styles: Record<string, string>;
  attributes: Record<string, string>;
  journal: EditJournalEntry[];
  guestSend: GuestSend | null;
  /** Components sidebar: full DOM tree of the guest page (null until fetched). */
  domTree: DomTreeNode | null;
  /** Dot-path of the node to auto-select/scroll-to in the tree (e.g. after a pick). */
  selectedPath: string | null;
  /** True while a tree fetch is in flight. */
  treeLoading: boolean;
  /** Which right panel is open (tabbed Tree | Style); 'closed' by default. */
  rightPanel: RightPanel;
}

function defaultSlice(): EditorSlice {
  return {
    mode: 'browse', selected: null, styles: {}, attributes: {}, journal: [], guestSend: null,
    domTree: null, selectedPath: null, treeLoading: false, rightPanel: 'closed',
  };
}

/** Stable empty slice for selectors reading an id with no slice yet. */
const EMPTY_SLICE: EditorSlice = defaultSlice();

interface EditorState {
  /** browserId → its editor slice. */
  slices: Record<string, EditorSlice>;

  ensureSlice(id: string): void;
  disposeSlice(id: string): void;
  registerGuestSend(id: string, fn: GuestSend | null): void;

  setMode(id: string, mode: 'browse' | 'edit'): void;
  setSelection(id: string, anchor: ElementAnchor, styles: Record<string, string>, attributes: Record<string, string>): void;
  clearSelection(id: string): void;
  setJournal(id: string, journal: EditJournalEntry[]): void;

  // Components sidebar (DOM tree) + picker — all ride the guestSend bridge.
  setRightPanel(id: string, panel: RightPanel): void;
  requestTree(id: string): void;
  setTree(id: string, tree: DomTreeNode | null): void;
  setSelectedPath(id: string, path: string | null): void;
  clearTree(id: string): void;
  highlight(id: string, selector: string, xpath: string): void;
  removeHighlight(id: string): void;
  activatePicker(id: string): void;
  cancelPicker(id: string): void;

  // round-trip to the guest editor
  applyStyle(id: string, property: string, value: string): void;
  applyAttr(id: string, name: string, value: string): void;
  runAction(id: string, action: string): void;
  selectBySelector(id: string, selector: string): void;
  clearJournal(id: string): void;
}

export const useEditorStore = create<EditorState>((set, get) => {
  const patch = (id: string, fn: (s: EditorSlice) => EditorSlice): void => {
    const cur = get().slices[id];
    if (!cur) return;
    set((st) => ({ slices: { ...st.slices, [id]: fn(st.slices[id]) } }));
  };
  const sendTo = (id: string, channel: string, payload?: unknown): void => {
    get().slices[id]?.guestSend?.(channel, payload);
  };

  return {
    slices: {},

    ensureSlice: (id) => set((s) => (s.slices[id] ? s : { slices: { ...s.slices, [id]: defaultSlice() } })),
    disposeSlice: (id) => set((s) => {
      if (!s.slices[id]) return s;
      const slices = { ...s.slices };
      delete slices[id];
      return { slices };
    }),
    registerGuestSend: (id, fn) => patch(id, (sl) => ({ ...sl, guestSend: fn })),

    setMode: (id, mode) => {
      patch(id, (sl) => ({ ...sl, mode }));
      sendTo(id, 'editor:setMode', mode);
      if (mode === 'browse') get().clearSelection(id);
    },
    setSelection: (id, selected, styles, attributes) => patch(id, (sl) => ({ ...sl, selected, styles, attributes })),
    clearSelection: (id) => patch(id, (sl) => ({ ...sl, selected: null, styles: {}, attributes: {} })),
    // Keep only the most recent journal entries in renderer memory.
    setJournal: (id, journal) => patch(id, (sl) => ({ ...sl, journal: journal.length > JOURNAL_CAP ? journal.slice(-JOURNAL_CAP) : journal })),

    // Leaving the Components tab frees the (potentially 50–100 MB) DOM tree; it
    // is re-fetched on reopen. The single biggest always-on renderer reclaim.
    setRightPanel: (id, rightPanel) => patch(id, (sl) => ({
      ...sl,
      rightPanel,
      ...(rightPanel !== 'tree' ? { domTree: null, selectedPath: null } : {}),
    })),
    requestTree: (id) => { patch(id, (sl) => ({ ...sl, treeLoading: true })); sendTo(id, 'editor:getTree'); },
    setTree: (id, domTree) => patch(id, (sl) => ({ ...sl, domTree, treeLoading: false })),
    setSelectedPath: (id, selectedPath) => patch(id, (sl) => ({ ...sl, selectedPath })),
    clearTree: (id) => patch(id, (sl) => ({ ...sl, domTree: null, selectedPath: null })),
    highlight: (id, selector, xpath) => sendTo(id, 'editor:highlight', { selector, xpath }),
    removeHighlight: (id) => sendTo(id, 'editor:removeHighlight'),
    activatePicker: (id) => sendTo(id, 'editor:activatePicker'),
    cancelPicker: (id) => sendTo(id, 'editor:cancelPicker'),

    applyStyle: (id, property, value) => sendTo(id, 'editor:applyStyle', { property, value }),
    applyAttr: (id, name, value) => sendTo(id, 'editor:applyAttr', { name, value }),
    runAction: (id, action) => sendTo(id, 'editor:action', { action }),
    selectBySelector: (id, selector) => sendTo(id, 'editor:selectBySelector', selector),
    clearJournal: (id) => { sendTo(id, 'editor:clearJournal'); patch(id, (sl) => ({ ...sl, journal: [] })); },
  };
});

/** A browser instance's editor slice (stable empty fallback before ensureSlice). */
export function useEditorSlice(id: string | null | undefined): EditorSlice {
  return useEditorStore((s) => (id ? s.slices[id] ?? EMPTY_SLICE : EMPTY_SLICE));
}

/** browserId → the taskId that last activated that browser's picker. Kept off
 *  reactive state (like browser-store's controllers) so recording a trigger
 *  doesn't re-render; lets a pick route to the originating conversation even
 *  across split panes. Cleared by BrowserCanvas on guest teardown. */
const pickerTriggers = new Map<string, string>();
export function setPickerTrigger(browserId: string, taskId: string): void {
  pickerTriggers.set(browserId, taskId);
}
export function takePickerTrigger(browserId: string): string | undefined {
  const taskId = pickerTriggers.get(browserId);
  pickerTriggers.delete(browserId);
  return taskId;
}
export function clearPickerTrigger(browserId: string): void {
  pickerTriggers.delete(browserId);
}
