import { create } from 'zustand';

/**
 * Cross-component clipboard for the file tree. Holds absolute paths that the
 * user has Cut or Copied. Paste uses these plus a destination directory.
 * "Cut" paths are also rendered faded in the tree as a visual cue.
 */
export type ClipboardMode = 'copy' | 'cut';

interface FileClipboardState {
  mode: ClipboardMode | null;
  paths: string[];
  /** Stamp updated every time the clipboard changes — used to bust the
   *  Set memoization for `is-cut` highlight lookups inside FileTreeNode. */
  rev: number;
  set(mode: ClipboardMode, paths: string[]): void;
  clear(): void;
  has(path: string): boolean;
}

export const useFileClipboardStore = create<FileClipboardState>((set, get) => ({
  mode: null,
  paths: [],
  rev: 0,
  set: (mode, paths) => set({ mode, paths: [...paths], rev: get().rev + 1 }),
  clear: () => set({ mode: null, paths: [], rev: get().rev + 1 }),
  has: (path: string) => get().paths.includes(path),
}));
