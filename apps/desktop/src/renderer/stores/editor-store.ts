import { create } from 'zustand';
import type { ElementAnchor, EditJournalEntry } from '@claude-code-browser/shared';

/** Sends a host→guest message over the <webview>. Registered by BrowserCanvas. */
type GuestSend = (channel: string, payload?: unknown) => void;

interface EditorState {
  mode: 'browse' | 'edit';
  selected: ElementAnchor | null;
  styles: Record<string, string>;
  attributes: Record<string, string>;
  journal: EditJournalEntry[];
  guestSend: GuestSend | null;

  registerGuestSend(fn: GuestSend | null): void;
  setMode(mode: 'browse' | 'edit'): void;
  setSelection(anchor: ElementAnchor, styles: Record<string, string>, attributes: Record<string, string>): void;
  clearSelection(): void;
  setJournal(journal: EditJournalEntry[]): void;

  // actions that round-trip to the guest editor
  applyStyle(property: string, value: string): void;
  applyAttr(name: string, value: string): void;
  runAction(action: string): void;
  selectBySelector(selector: string): void;
  clearJournal(): void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  mode: 'browse',
  selected: null,
  styles: {},
  attributes: {},
  journal: [],
  guestSend: null,

  registerGuestSend: (fn) => set({ guestSend: fn }),
  setMode: (mode) => {
    set({ mode });
    get().guestSend?.('editor:setMode', mode);
    if (mode === 'browse') get().clearSelection();
  },
  setSelection: (selected, styles, attributes) => set({ selected, styles, attributes }),
  clearSelection: () => set({ selected: null, styles: {}, attributes: {} }),
  setJournal: (journal) => set({ journal }),

  applyStyle: (property, value) => get().guestSend?.('editor:applyStyle', { property, value }),
  applyAttr: (name, value) => get().guestSend?.('editor:applyAttr', { name, value }),
  runAction: (action) => get().guestSend?.('editor:action', { action }),
  selectBySelector: (selector) => get().guestSend?.('editor:selectBySelector', selector),
  clearJournal: () => {
    get().guestSend?.('editor:clearJournal');
    set({ journal: [] });
  },
}));
