import { create } from 'zustand';
import { useUiStore } from './ui-store';
import { useRecentsStore } from './recents-store';
import { useTasksStore } from './tasks-store';
import { useBrowserStore } from './browser-store';
import { useNavStore } from './nav-store';
import { useClosedTabsStore } from './closed-tabs-store';
import { UNTITLED_PREFIX, isUntitledPath, untitledName } from '../lib/untitled';
import { parentDir, joinPath } from '../lib/path-util';

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** PyCharm default "Save files if the IDE is idle for N seconds" = 15s. The
 *  timer is (re)armed on every edit and disarmed whenever a save runs. */
const IDLE_SAVE_MS = 15_000;
let idleSaveTimer: ReturnType<typeof setTimeout> | null = null;
function clearIdleSave(): void {
  if (idleSaveTimer) { clearTimeout(idleSaveTimer); idleSaveTimer = null; }
}

/** Monotonic counter for untitled scratch-file paths (`untitled:1`, …). */
let untitledSeq = 0;

/** Disk-always-wins flush: write a dirty buffer back ONLY if the file still
 *  exists on disk. If it was deleted (externally or via the in-app trash) while
 *  the buffer held edits, autosave/close must NOT recreate it — the watcher's
 *  ENOENT path closes the tab instead. */
async function writeIfNotDeleted(path: string, content: string): Promise<boolean> {
  const pre = await window.ccb.fs.statFile(path);
  if (pre.error && /ENOENT|no such file/i.test(pre.error)) return false;
  const res = await window.ccb.fs.writeFile(path, content);
  return res.ok;
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
  /** path → revision counter, bumped on each on-disk reload. Media viewers
   *  key their stream URL off this to bust Chromium's cache; HexView resets
   *  its chunk cache when it changes. (absent ⇒ 0) */
  fileRevs: Record<string, number>;
  /** path → human-readable reason a file couldn't be opened/read. When set,
   *  the tab shows an informative message (with details) instead of a viewer.
   *  Cleared once the file opens successfully. */
  fileErrors: Record<string, string>;

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
   *  buffer if it's not loaded yet, or just re-focuses if it is. Pass
   *  `{ focus: false }` for background opens (e.g. an agent-touched file) so it
   *  appears as a tab without stealing focus from the active conversation. */
  openFile(path: string, opts?: { focus?: boolean }): Promise<void>;
  /** Create a new in-memory "Untitled-N" scratch buffer and return its synthetic
   *  path. Does NOT focus (the caller places + focuses it, e.g. in a split). */
  newUntitledFile(): string;
  /** Hot-exit restore: recreate an untitled scratch buffer at its persisted
   *  synthetic path (`openFile` can't — the path is not real). Advances the
   *  untitled counter past N so a later newUntitledFile() can't collide. */
  restoreScratch(path: string, content: string): void;
  /** Hot-exit restore: re-apply persisted unsaved edits onto a freshly-opened
   *  real file. Keeps `saved` as the current on-disk bytes (buffer reads
   *  dirty-vs-disk; the watcher's echo-check can't clobber it) and flags
   *  `conflict` if the disk changed while we were away. */
  applyUnsaved(path: string, content: string, savedAtCapture: string): void;
  /** Close a file tab. Flushes unsaved edits first (PyCharm-style) unless
   *  `opts.flush === false` — used when the file is being deleted/moved, where
   *  a write would recreate it at the old path. */
  closeFile(path: string, opts?: { flush?: boolean }): void;
  closeAllFiles(): void;
  closeOthers(keepPath: string): void;
  closeToRight(keepPath: string): void;
  setActiveFile(path: string | null): void;
  setFileContent(path: string, content: string): void;
  saveFile(path: string): Promise<void>;
  saveAll(): Promise<void>;
  /** Re-read an open file from disk after a watcher event. Disk always wins:
   *  for text buffers the disk content replaces the buffer (undo-ably, via
   *  Monaco's controlled value); for binary buffers the size is refreshed and
   *  the revision bumped so viewers re-fetch. */
  reloadFromDisk(path: string): Promise<void>;
  /** Undo the most recent in-app file deletion (main keeps the per-window stack);
   *  refreshes the tree and reopens the restored file. Shared by the Cmd+Z
   *  keydown and the guest-forwarded menu:undoDelete. */
  undoDelete(): Promise<void>;
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
  fileRevs: {},
  fileErrors: {},

  openFolder: async (explicitPath) => {
    // Flush unsaved edits in the CURRENT project before switching (PyCharm saves
    // on project switch). Must complete BEFORE fs:openFolder, which re-points
    // main's currentRoot to the new root — after that, writes to old paths fail
    // isInsideRoot. Await so the writes land against the still-current root.
    clearIdleSave();
    const dirty = Object.entries(get().fileBuffers)
      .filter(([p, b]) => b.kind === 'text' && b.content !== b.saved && !isUntitledPath(p));
    if (dirty.length > 0) {
      await Promise.all(dirty.map(([p, b]) => window.ccb.fs.writeFile(p, (b as { content: string }).content)));
    }

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
      fileRevs: {},
      fileErrors: {},
    });
    window.ccb.send({ type: 'config:set', projectDir: result.root });
    useBrowserStore.getState().closeAllBrowsers();
    void useRecentsStore.getState().add(result.root, result.name);
    useUiStore.getState().setView('workspace');
    await get().loadDir(result.root);
  },

  closeProject: () => {
    // Flush any unsaved edits before tearing the project down (PyCharm saves
    // on project close). Fire-and-forget — the buffers are about to be wiped.
    clearIdleSave();
    for (const [p, b] of Object.entries(get().fileBuffers)) {
      if (b.kind === 'text' && b.content !== b.saved && !isUntitledPath(p)) void window.ccb.fs.writeFile(p, b.content);
    }
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
      fileRevs: {},
      fileErrors: {},
    });
    window.ccb.send({ type: 'config:set', projectDir: undefined });
    // Drop this window's fs root + watcher in main (stop the watcher firing and
    // de-authorize writes against the now-closed project's root).
    void window.ccb.fs.releaseRoot();
    useTasksStore.getState().resetTasks();
    useBrowserStore.getState().closeAllBrowsers();
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

  openFile: async (path, opts) => {
    const focus = opts?.focus !== false;
    const s = get();
    if (s.fileBuffers[path] && !s.fileErrors[path]) {
      // Already loaded — just focus. (A prior error re-attempts the open.)
      if (focus) {
        set({ activeFile: path });
        useUiStore.getState().setActiveTab({ kind: 'file', path });
      }
      return;
    }
    // Pre-flight: figure out text vs binary BEFORE reading multi-MB strings
    // over IPC (which would hang Monaco / the renderer).
    const info = await window.ccb.fs.statFile(path);
    let buf: FileBuffer | null = null;
    let error: string | null = null;
    if (info.error || info.size == null) {
      error = info.error ?? 'Could not read this file.';
    } else if (info.isBinary) {
      buf = { kind: 'binary', size: info.size };
    } else {
      const res = await window.ccb.fs.readFile(path);
      if (res.error || res.content == null) {
        error = res.error ?? 'Could not read this file.';
      } else {
        buf = { kind: 'text', content: res.content, saved: res.content, size: info.size };
      }
    }
    set((cur) => {
      // Prepend new files so newly-opened tabs land on the *left* of the tab
      // bar — matches the same "newest first" rule conv tabs already use.
      const fileBuffers = { ...cur.fileBuffers };
      const fileErrors = { ...cur.fileErrors };
      if (buf) { fileBuffers[path] = buf; delete fileErrors[path]; }
      else { delete fileBuffers[path]; fileErrors[path] = error!; }
      return {
        workingFiles: cur.workingFiles.includes(path) ? cur.workingFiles : [path, ...cur.workingFiles],
        fileBuffers,
        fileErrors,
        // Background opens (focus:false, e.g. an agent-touched file) must not
        // grab the project-wide active-file pointer (tree selection / Save / Delete target).
        activeFile: focus ? path : cur.activeFile,
      };
    });
    if (focus) useUiStore.getState().setActiveTab({ kind: 'file', path });
  },

  newUntitledFile: () => {
    const path = `${UNTITLED_PREFIX}${++untitledSeq}`;
    set((s) => ({
      workingFiles: [...s.workingFiles, path],
      fileBuffers: { ...s.fileBuffers, [path]: { kind: 'text', content: '', saved: '', size: 0 } },
    }));
    return path;
  },

  restoreScratch: (path, content) => {
    const n = Number(path.slice(UNTITLED_PREFIX.length));
    if (Number.isFinite(n)) untitledSeq = Math.max(untitledSeq, n);
    set((s) => {
      if (s.fileBuffers[path]) return s;
      return {
        ...s,
        workingFiles: s.workingFiles.includes(path) ? s.workingFiles : [...s.workingFiles, path],
        fileBuffers: { ...s.fileBuffers, [path]: { kind: 'text', content, saved: '', size: new TextEncoder().encode(content).length } },
      };
    });
  },

  applyUnsaved: (path, content, savedAtCapture) => {
    set((s) => {
      const buf = s.fileBuffers[path];
      if (!buf || buf.kind !== 'text' || content === buf.content) return s;
      // `buf.saved` is the just-read disk content (openFile set it). Keep it as
      // the baseline so the buffer reads dirty-vs-disk; flag conflict if the
      // disk diverged from what we were editing against at capture time.
      return { ...s, fileBuffers: { ...s.fileBuffers, [path]: { ...buf, content, conflict: buf.saved !== savedAtCapture } } };
    });
  },

  closeFile: (path, opts) => {
    // Flush unsaved edits before dropping the buffer (PyCharm saves on close).
    // Fire-and-forget; the follow-up fs:changed is ignored once the buffer is gone.
    // Skipped (flush:false) when the file is being deleted/moved — writing it
    // back would recreate it at the old path.
    if (opts?.flush !== false) {
      const b0 = get().fileBuffers[path];
      if (b0?.kind === 'text' && b0.content !== b0.saved && !isUntitledPath(path)) void writeIfNotDeleted(path, b0.content);
      // Record a genuine tab-close for Reopen Closed Tab (Cmd+Shift+T). Skipped
      // when flush:false (delete/move — the path is gone) and for untitled
      // scratch buffers (no path to reopen from).
      if (get().workingFiles.includes(path) && !isUntitledPath(path)) {
        useClosedTabsStore.getState().push({ kind: 'file', path });
      }
    }
    set((s) => {
      const buffers = { ...s.fileBuffers };
      delete buffers[path];
      const revs = { ...s.fileRevs };
      delete revs[path];
      const errs = { ...s.fileErrors };
      delete errs[path];
      const workingFiles = s.workingFiles.filter((p) => p !== path);
      const wasActive = s.activeFile === path;
      const activeFile = wasActive ? (workingFiles[workingFiles.length - 1] ?? null) : s.activeFile;
      return { ...s, fileBuffers: buffers, fileRevs: revs, fileErrors: errs, workingFiles, activeFile };
    });
    // Layout focus follows automatically: dropping the file from workingFiles
    // triggers the reconcile effect, which prunes the tab from its group and
    // snaps that group's active tab to a neighbor.
  },

  closeAllFiles: () => {
    for (const [p, b] of Object.entries(get().fileBuffers)) {
      if (b.kind === 'text' && b.content !== b.saved && !isUntitledPath(p)) void writeIfNotDeleted(p, b.content);
    }
    set({ workingFiles: [], fileBuffers: {}, activeFile: null, fileRevs: {}, fileErrors: {} });
  },

  closeOthers: (keepPath) => {
    for (const [p, b] of Object.entries(get().fileBuffers)) {
      if (p !== keepPath && b.kind === 'text' && b.content !== b.saved && !isUntitledPath(p)) void window.ccb.fs.writeFile(p, b.content);
    }
    set((s) => {
      const buf = s.fileBuffers[keepPath];
      const buffers = buf ? { [keepPath]: buf } : {};
      const rev = s.fileRevs[keepPath];
      const revs = rev != null ? { [keepPath]: rev } : {};
      const err = s.fileErrors[keepPath];
      const errs = err != null ? { [keepPath]: err } : {};
      const workingFiles = s.workingFiles.includes(keepPath) ? [keepPath] : [];
      return { ...s, fileBuffers: buffers, fileRevs: revs, fileErrors: errs, workingFiles, activeFile: keepPath };
    });
  },

  closeToRight: (keepPath) => {
    set((s) => {
      const idx = s.workingFiles.indexOf(keepPath);
      if (idx < 0) return s;
      const keep = s.workingFiles.slice(0, idx + 1);
      // Flush unsaved edits in the tabs being closed (those to the right).
      for (const p of s.workingFiles.slice(idx + 1)) {
        const b = s.fileBuffers[p];
        if (b?.kind === 'text' && b.content !== b.saved && !isUntitledPath(p)) void window.ccb.fs.writeFile(p, b.content);
      }
      const buffers: typeof s.fileBuffers = {};
      const revs: typeof s.fileRevs = {};
      const errs: typeof s.fileErrors = {};
      for (const p of keep) {
        if (s.fileBuffers[p]) buffers[p] = s.fileBuffers[p];
        if (s.fileRevs[p] != null) revs[p] = s.fileRevs[p];
        if (s.fileErrors[p] != null) errs[p] = s.fileErrors[p];
      }
      const activeFile = s.activeFile && keep.includes(s.activeFile) ? s.activeFile : keepPath;
      return { ...s, workingFiles: keep, fileBuffers: buffers, fileRevs: revs, fileErrors: errs, activeFile };
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
    // PyCharm-style idle auto-save: (re)arm the 15s timer on every edit.
    clearIdleSave();
    idleSaveTimer = setTimeout(() => { idleSaveTimer = null; void get().saveAll(); }, IDLE_SAVE_MS);
  },

  saveFile: async (path) => {
    const buf = get().fileBuffers[path];
    if (!buf || buf.kind !== 'text') return;

    // Untitled scratch buffer → Save As: pick a real path, write, then promote
    // the tab in place (workingFiles + buffer re-keyed; the layout tab re-keyed
    // via ui-store) so future saves go straight to disk.
    if (isUntitledPath(path)) {
      const root = get().root;
      const def = root ? joinPath(root, `${untitledName(path)}.txt`) : `${untitledName(path)}.txt`;
      const target = await window.ccb.fs.saveDialog(def);
      if (!target) return;
      const latest = get().fileBuffers[path];
      const content = latest?.kind === 'text' ? latest.content : buf.content;
      const res = await window.ccb.fs.writeFile(target, content);
      if (!res.ok) {
        // Save As failed (e.g. the chosen path is outside any writable root).
        // Keep the untitled buffer intact — it stays dirty and labelled "not
        // saved" so the user's text isn't silently lost — and log the reason.
        console.error('Save As failed:', target, res.error);
        return;
      }
      // Re-read after the async write: if a keystroke landed while the dialog/
      // write was in flight, keep it (content) but mark `saved` as the bytes we
      // actually wrote, so the promoted tab correctly shows unsaved if it drifted.
      const after = get().fileBuffers[path];
      const finalContent = after?.kind === 'text' ? after.content : content;
      set((s) => {
        const fileBuffers = { ...s.fileBuffers };
        delete fileBuffers[path];
        fileBuffers[target] = { kind: 'text', content: finalContent, saved: content, size: new TextEncoder().encode(finalContent).length };
        const fileRevs = { ...s.fileRevs }; delete fileRevs[path];
        const fileErrors = { ...s.fileErrors }; delete fileErrors[path];
        return {
          ...s,
          fileBuffers,
          fileRevs,
          fileErrors,
          workingFiles: s.workingFiles.map((p) => (p === path ? target : p)),
          activeFile: s.activeFile === path ? target : s.activeFile,
        };
      });
      useUiStore.getState().renameTab(`file:${path}`, `file:${target}`);
      const dir = parentDir(target);
      if (dir) void get().refreshDir(dir);
      return;
    }

    // Disk-always-wins: skip the write if the file was deleted while dirty (the
    // watcher's ENOENT path closes the tab) so autosave never resurrects it.
    const ok = await writeIfNotDeleted(path, buf.content);
    if (ok) {
      set((s) => {
        const b = s.fileBuffers[path];
        if (!b || b.kind !== 'text') return s;
        return { ...s, fileBuffers: { ...s.fileBuffers, [path]: { ...b, saved: b.content, conflict: false } } };
      });
    }
  },

  saveAll: async () => {
    clearIdleSave();
    const dirty: string[] = [];
    for (const [p, b] of Object.entries(get().fileBuffers)) {
      // Skip untitled scratch buffers — they need an interactive Save As, which
      // must never be triggered by the idle-save timer.
      if (b.kind === 'text' && b.content !== b.saved && !isUntitledPath(p)) dirty.push(p);
    }
    for (const p of dirty) await get().saveFile(p);
  },

  undoDelete: async () => {
    const res = await window.ccb.fs.undoDelete();
    if (!res.ok || !res.path) return;
    const parent = parentDir(res.path);
    if (parent) void get().refreshDir(parent);
    if (!res.isDir) void get().openFile(res.path);
  },

  reloadFromDisk: async (path) => {
    const buf = get().fileBuffers[path];
    if (!buf) return;
    const info = await window.ccb.fs.statFile(path);
    const bumpRev = (s: WorkspaceState): Record<string, number> =>
      ({ ...s.fileRevs, [path]: (s.fileRevs[path] ?? 0) + 1 });
    const clearErr = (s: WorkspaceState): Record<string, string> => {
      const e = { ...s.fileErrors }; delete e[path]; return e;
    };

    if (info.error || info.size == null) {
      const reason = info.error ?? 'Could not read this file.';
      // Deleted on disk → auto-close the tab. Don't flush: a write would
      // recreate the file we're closing because it no longer exists.
      if (/ENOENT|no such file/i.test(reason)) {
        get().closeFile(path, { flush: false });
        return;
      }
      // Other failure (perms, etc.) — drop the buffer and surface the reason in
      // its place. Re-clicking the tab re-attempts the open.
      set((s) => {
        const fileBuffers = { ...s.fileBuffers }; delete fileBuffers[path];
        return { ...s, fileBuffers, fileErrors: { ...s.fileErrors, [path]: reason }, fileRevs: bumpRev(s) };
      });
      return;
    }
    const size = info.size;

    if (!info.isBinary) {
      // Reads as text on disk. Pull the content; disk always wins.
      const res = await window.ccb.fs.readFile(path);
      // Re-check the buffer (it may have closed/changed during the async read).
      const cur = get().fileBuffers[path];
      if (!cur) return;
      if (res.error || res.content == null) {
        // Now unreadable as text (e.g. crossed the size limit) — treat as binary.
        set((s) => ({ ...s, fileBuffers: { ...s.fileBuffers, [path]: { kind: 'binary', size } }, fileRevs: bumpRev(s), fileErrors: clearErr(s) }));
        return;
      }
      const content = res.content;
      if (cur.kind === 'text' && content === cur.saved) {
        // Disk matches our last-saved baseline — nothing external diverged.
        // This is the echo of our own save (which may race ahead of newer
        // keystrokes), so do nothing: no buffer churn, no rev bump, and no
        // clobbering of in-flight edits. A genuine external change always
        // differs from `saved`, so it still falls through to disk-wins below.
        return;
      }
      set((s) => ({
        ...s,
        fileBuffers: { ...s.fileBuffers, [path]: { kind: 'text', content, saved: content, size } },
        fileRevs: bumpRev(s),
        fileErrors: clearErr(s),
      }));
      return;
    }

    // Binary on disk. Always replace the buffer object (new identity re-runs
    // DataGridView even when the size is unchanged) and bump the revision so
    // the media URL busts its cache and HexView drops its chunk cache.
    set((s) => ({ ...s, fileBuffers: { ...s.fileBuffers, [path]: { kind: 'binary', size } }, fileRevs: bumpRev(s), fileErrors: clearErr(s) }));
  },
}));
