import { create } from 'zustand';
import type { TabKey } from '../lib/tab-key';

/** Where a dragged tab will land. `index === null` means "the pane body" (append
 *  to that group); a number is an insertion slot in the group's tab strip. */
export interface DropTarget {
  groupId: string;
  index: number | null;
}

/**
 * State for a custom pointer-based tab drag (move/reorder between split panes).
 * We don't use HTML5 drag-and-drop: framer-motion's motion.div tab + native
 * `draggable` proved unreliable, and pointer dragging gives a controllable drag
 * ghost and clean drop detection over the webview. `x`/`y` drive the ghost
 * (updated every move); `target` is de-duped by the controller so panes/strips
 * only re-render when the drop slot actually changes.
 */
interface TabDragState {
  key: TabKey | null;
  x: number;
  y: number;
  target: DropTarget | null;
  begin: (key: TabKey, x: number, y: number) => void;
  setPos: (x: number, y: number) => void;
  setTarget: (target: DropTarget | null) => void;
  end: () => void;
}

export const useTabDragStore = create<TabDragState>((set) => ({
  key: null,
  x: 0,
  y: 0,
  target: null,
  begin: (key, x, y) => set({ key, x, y, target: null }),
  setPos: (x, y) => set({ x, y }),
  setTarget: (target) => set({ target }),
  end: () => set({ key: null, target: null }),
}));
