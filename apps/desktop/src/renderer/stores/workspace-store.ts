import { create } from 'zustand';
import { useUiStore } from './ui-store';
import { useRecentsStore } from './recents-store';
import { useTasksStore } from './tasks-store';
import { useNavStore } from './nav-store';

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** An open file's buffer state. Text files carry their content; binary files
 *  just track size — HexView / DataGridView fetch chunks on demand. */
export type FileBuffer =
  | { kind: 'text'; content: string; saved: string; conflict?: boolean; size: number }
  | { kind: 'binary'; size: number };

interface WorkspaceState {
  root: string | null;
  name: string | null;
  /** dir path → its entries (lazy-loaded cache) */
  children: Record<string, DirEntry[]>;
  expanded: Record<string, boolean>;
  /** Transient banner — last error from openFolder, cleared on next navigation. */
  openError: string | null;
  /** Transient request to start an inline "new file/folder" row under `dir`.
   *  Consumed by the matching tree node (or ContextPanel for the project root).
   *  Lets the File → New File menu drive the tree's existing create flow. */
  pendingCreate: { dir: string; kind: 'file' | 'folder' } | null;

  // ── Project-wide open files (used to live per-task, now shared across
  //    all conversation tabs in the project so opening a file doesn't depend
  //    on which conversation is currently focused).
  workingFiles: string[];
  fileBuffers: Record<string, FileBuffer>;
  activeFile: string | null;

  /** Open a folder. With no arg → native picker. With explicit path → open directly (recents / new-project). */
  openFolder(explicitPath?: string): Promise<void>;
  /** Close the current project and return to the Home view. */
  closeProject(): void;
  loadDir(path: string): Promise<void>;
  toggleDir(path: string): Promise<void>;
  refreshDir(path: string): Promise<void>;
  clearOpenError(): void;
  /** Ask the tree to open an inline create row under `dir`. */
  requestCreate(dir: string, kind: 'file' | 'folder'): void;
  clearPendingCreate(): void;

  // ── File-tab operations (project-wide).
  /** Open a file and make it the active file tab. Idempotent — re-opens the
   *  buffer if it's not loaded yet, or just re-focuses if it is. */
  openFile(path: string): Promise<void>;
  closeFile(path: string): void;
  closeAllFiles(): void;
  closeOthers(keepPath: string): void;
  closeToRight(keepPath: string): void;
  setActiveFile(path: string | null): void;
  setFileContent(path: string, content: string): void;
  saveFile(path: string): Promise<void>;
  saveAll(): Promise<void>;
  applyDiskChange(path: string, content: string): void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  root: null,
  name: null,
  children: {},
  expanded: {},
  openError: null,
  pendingCreate: null,
  workingFiles: [],
  fileBuffers: {},
  activeFile: null,

  openFolder: async (explicitPath) => {
    const result = await window.ccb.fs.openFolder(explicitPath);
    if (!result) {
      if (explicitPath) {
        // Likely a recent whose folder was moved/deleted — prune it.
        void useRecentsStore.getState().remove(explicitPath);
        set({ openError: `Couldn't open "${explicitPath}" — folder no longer exists. Removed from recents.` });
      }
      return;
    }
    set({
      root: result.root,
      name: result.name,
      children: {},
      expanded: { [result.root]: true },
      openError: null,
      pendingCreate: null,
      workingFiles: [],
      fileBuffers: {},
      activeFile: null,
    });
    window.ccb.send({ type: 'config:set', projectDir: result.root });
    void useRecentsStore.getState().add(result.root, result.name);
    useUiStore.getState().setView('workspace');
    await get().loadDir(result.root);
  },

  closeProject: () => {
    // Interrupt any running agent sessions before wiping tasks so we don't
    // orphan a still-streaming Claude Code process.
    for (const t of useTasksStore.getState().tasks) {
      if (t.running && t.sessionId) {
        window.ccb.send({ type: 'agent:interrupt', sessionId: t.sessionId });
      }
    }
    set({
      root: null,
      name: null,
      children: {},
      expanded: {},
      pendingCreate: null,
      workingFiles: [],
      fileBuffers: {},
      activeFile: null,
    });
    window.ccb.send({ type: 'config:set', projectDir: undefined });
    useTasksStore.getState().resetTasks();
    useUiStore.getState().clearActiveTab();
    // Arriving at Home — flush any back/forward stops left over from the
    // previous project so the titlebar arrows start fresh.
    useNavStore.getState().reset();
    useUiStore.getState().setView('home');
  },

  loadDir: async (path) => {
    const entries = await window.ccb.fs.readDir(path);
    set((s) => ({ children: { ...s.children, [path]: entries } }));
  },

  toggleDir: async (path) => {
    const open = !get().expanded[path];
    set((s) => ({ expanded: { ...s.expanded, [path]: open } }));
    if (open && !get().children[path]) await get().loadDir(path);
  },

  refreshDir: async (path) => {
    if (get().children[path]) await get().loadDir(path);
  },

  clearOpenError: () => set({ openError: null }),

  requestCreate: (dir, kind) => set({ pendingCreate: { dir, kind } }),
  clearPendingCreate: () => set({ pendingCreate: null }),

  // ── File operations ────────────────────────────────────────────────

  openFile: async (path) => {
    const s = get();
    if (s.fileBuffers[path]) {
      // Already loaded — just focus.
      set({ activeFile: path });
      useUiStore.getState().setActiveTab({ kind: 'file', path });
      return;
    }
    // Pre-flight: figure out text vs binary BEFORE reading multi-MB strings
    // over IPC (which would hang Monaco / the renderer).
    const info = await window.ccb.fs.statFile(path);
    if (info.error || info.size == null) return;
    const size = info.size;
    let buf: FileBuffer;
    if (info.isBinary) {
      buf = { kind: 'binary', size };
    } else {
      const res = await window.ccb.fs.readFile(path);
      if (res.error || res.content == null) {
        buf = { kind: 'binary', size };
      } else {
        buf = { kind: 'text', content: res.content, saved: res.content, size };
      }
    }
    set((cur) => ({
      // Prepend new files so newly-opened tabs land on the *left* of the tab
      // bar — matches the same "newest first" rule conv tabs already use.
      workingFiles: cur.workingFiles.includes(path) ? cur.workingFiles : [path, ...cur.workingFiles],
      fileBuffers: { ...cur.fileBuffers, [path]: buf },
      activeFile: path,
    }));
    useUiStore.getState().setActiveTab({ kind: 'file', path });
  },

  closeFile: (path) => {
    set((s) => {
      const buffers = { ...s.fileBuffers };
      delete buffers[path];
      const workingFiles = s.workingFiles.filter((p) => p !== path);
      const wasActive = s.activeFile === path;
      const activeFile = wasActive ? (workingFiles[workingFiles.length - 1] ?? null) : s.activeFile;
      return { ...s, fileBuffers: buffers, workingFiles, activeFile };
    });
    // If the closed file was the focused tab, drop the activeTab back to
    // the next sensible target (next file, then the first task, then null).
    const ui = useUiStore.getState();
    if (ui.activeTab?.kind === 'file' && ui.activeTab.path === path) {
      const nextFile = get().activeFile;
      if (nextFile) ui.setActiveTab({ kind: 'file', path: nextFile });
      else {
        const firstTask = useTasksStore.getState().tasks[0];
        if (firstTask) ui.setActiveTab({ kind: 'conv', taskId: firstTask.id });
        else ui.clearActiveTab();
      }
    }
  },

  closeAllFiles: () => {
    set({ workingFiles: [], fileBuffers: {}, activeFile: null });
    const ui = useUiStore.getState();
    if (ui.activeTab?.kind === 'file') {
      const firstTask = useTasksStore.getState().tasks[0];
      if (firstTask) ui.setActiveTab({ kind: 'conv', taskId: firstTask.id });
      else ui.clearActiveTab();
    }
  },

  closeOthers: (keepPath) => {
    set((s) => {
      const buf = s.fileBuffers[keepPath];
      const buffers = buf ? { [keepPath]: buf } : {};
      const workingFiles = s.workingFiles.includes(keepPath) ? [keepPath] : [];
      return { ...s, fileBuffers: buffers, workingFiles, activeFile: keepPath };
    });
  },

  closeToRight: (keepPath) => {
    set((s) => {
      const idx = s.workingFiles.indexOf(keepPath);
      if (idx < 0) return s;
      const keep = s.workingFiles.slice(0, idx + 1);
      const buffers: typeof s.fileBuffers = {};
      for (const p of keep) if (s.fileBuffers[p]) buffers[p] = s.fileBuffers[p];
      const activeFile = s.activeFile && keep.includes(s.activeFile) ? s.activeFile : keepPath;
      return { ...s, workingFiles: keep, fileBuffers: buffers, activeFile };
    });
  },

  setActiveFile: (path) => {
    set({ activeFile: path });
    if (path) useUiStore.getState().setActiveTab({ kind: 'file', path });
  },

  setFileContent: (path, content) => {
    set((s) => {
      const buf = s.fileBuffers[path];
      if (!buf || buf.kind !== 'text') return s;
      return { ...s, fileBuffers: { ...s.fileBuffers, [path]: { ...buf, content, conflict: false } } };
    });
  },

  saveFile: async (path) => {
    const buf = get().fileBuffers[path];
    if (!buf || buf.kind !== 'text') return;
    const res = await window.ccb.fs.writeFile(path, buf.content);
    if (res.ok) {
      set((s) => {
        const b = s.fileBuffers[path];
        if (!b || b.kind !== 'text') return s;
        return { ...s, fileBuffers: { ...s.fileBuffers, [path]: { ...b, saved: b.content, conflict: false } } };
      });
    }
  },

  saveAll: async () => {
    const dirty: string[] = [];
    for (const [p, b] of Object.entries(get().fileBuffers)) {
      if (b.kind === 'text' && b.content !== b.saved) dirty.push(p);
    }
    for (const p of dirty) await get().saveFile(p);
  },

  applyDiskChange: (path, content) => {
    set((s) => {
      const buf = s.fileBuffers[path];
      if (!buf || buf.kind !== 'text') return s;
      const dirty = buf.content !== buf.saved;
      if (dirty) {
        // Mark conflict — user has unsaved changes that disagree with disk.
        return { ...s, fileBuffers: { ...s.fileBuffers, [path]: { ...buf, saved: content, conflict: true } } };
      }
      // Clean buffer — just adopt the disk content.
      return { ...s, fileBuffers: { ...s.fileBuffers, [path]: { ...buf, content, saved: content } } };
    });
  },
}));
