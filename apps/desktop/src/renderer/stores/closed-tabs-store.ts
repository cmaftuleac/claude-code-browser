import { create } from 'zustand';
import type { Task } from './tasks-store';

/**
 * A recently-closed tab, captured with enough state to recreate it. Browser →
 * its URL; file → its path; conversation → the full Task snapshot (+ its list
 * index, so it reopens where it was); settings → nothing (singleton).
 *
 * This store is a LEAF — it imports no other store, so the close methods that
 * push here (browser/workspace/tasks/ui) never create an import cycle. The
 * matching reopen logic lives in ui-store (which already owns tab focus).
 */
export type ClosedTab =
  | { kind: 'browser'; url: string; title?: string }
  | { kind: 'file'; path: string }
  | { kind: 'conv'; task: Task; index: number }
  | { kind: 'settings' };

/** Cap the history so close-all loops can't grow it unbounded. */
const MAX = 25;

interface ClosedTabsState {
  /** Most-recently-closed last (a stack — pop from the end). */
  stack: ClosedTab[];
  push(entry: ClosedTab): void;
  /** Remove and return the most-recently-closed entry (LIFO), or undefined. */
  pop(): ClosedTab | undefined;
}

export const useClosedTabsStore = create<ClosedTabsState>((set, get) => ({
  stack: [],
  push: (entry) => set((s) => ({ stack: [...s.stack, entry].slice(-MAX) })),
  pop: () => {
    const { stack } = get();
    if (stack.length === 0) return undefined;
    const entry = stack[stack.length - 1];
    set({ stack: stack.slice(0, -1) });
    return entry;
  },
}));
