import { create } from 'zustand';
import { defaultViewMode, fileKind, type ViewMode } from '../lib/file-kind';

interface FileViewModesState {
  /** path → user-chosen view mode (overrides per-kind default). */
  modes: Record<string, ViewMode>;
  /** Per-path resolver: explicit user choice if present, otherwise the
   *  kind+isBinary default. `isBinary` is optional — callers that don't have a
   *  buffer yet pass nothing and get the binary-leaning default. */
  get(path: string, isBinary?: boolean): ViewMode;
  set(path: string, mode: ViewMode): void;
}

export const useFileViewModesStore = create<FileViewModesState>((set, get) => ({
  modes: {},
  get: (path, isBinary = false) => get().modes[path] ?? defaultViewMode(fileKind(path), isBinary),
  set: (path, mode) => set((s) => ({ modes: { ...s.modes, [path]: mode } })),
}));
