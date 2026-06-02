import { create } from 'zustand';
import type {
  ServerMessage, ElementAnchor, EditJournalEntry,
} from '@claude-code-browser/shared';

/* ── Block / Task / Artifact / Progress models ─────────────────────────── */

export type Block =
  | { id: string; kind: 'user'; content: string }
  | { id: string; kind: 'assistant'; content: string; streaming?: boolean; cost?: number }
  | { id: string; kind: 'thinking'; content: string; streaming?: boolean }
  | { id: string; kind: 'tool'; toolName: string; summary: string }
  | { id: string; kind: 'system'; content: string };

export interface Artifact {
  path: string;
  kind: 'edit' | 'write' | 'read';
  ts: number;
}

export interface ProgressStep {
  id: string;
  label: string;
  state: 'active' | 'done';
}

export type Surface = 'conv' | 'code' | 'browser';

/** A file tab's buffer state. Text files carry their content; binary files
 *  just track size — the HexView (and DataGridView) fetch chunks on demand
 *  and cache them locally. */
export type FileBuffer =
  | { kind: 'text'; content: string; saved: string; conflict?: boolean; size: number }
  | { kind: 'binary'; size: number };

export interface Task {
  id: string;
  title: string;
  createdAt: number;
  sessionId?: string;
  clientRequestId?: string;
  blocks: Block[];
  /** Which surfaces are currently *visible* in the tab bar. Closing the
   *  conv tab flips conv to false (chat history stays in `blocks` — it's
   *  hidden, not destroyed); closeBrowserSurface flips browser similarly;
   *  `code` is "true if there are any workingFiles open" and isn't stored. */
  surfaces: { conv: boolean; code: boolean; browser: boolean };
  activeSurface: Surface;
  workingFiles: string[];
  /** Open files in the Code surface, keyed by absolute path. */
  fileBuffers: Record<string, FileBuffer>;
  /** Currently focused file in the Code surface. */
  activeFile?: string;
  artifacts: Artifact[];
  progress: ProgressStep[];
  running: boolean;
  lastToolBlockId?: string;
  /** Pulses a pill in ModePills until the user clicks it (or sends a new turn). */
  surfaceHint?: 'code' | 'browser';
}

interface SendArgs {
  message: string;
  url?: string;
  anchors?: ElementAnchor[];
  projectDir?: string;
  sources?: string[];
  editJournal?: EditJournalEntry[];
  /** Base64 data URLs (data:image/…;base64,…); host writes them to /tmp and
   *  references the file paths in the user prompt. */
  images?: string[];
}

interface TasksState {
  tasks: Task[];
  activeId: string | null;

  init(): void;
  resetTasks(): void;
  /** Spawn a new task and make it active. `withConv` defaults to true; pass
   *  false when the task is being auto-created by a file-open (so opening
   *  a file from an empty workspace doesn't gift the user a conv tab they
   *  didn't ask for). */
  newTask(opts?: { withConv?: boolean }): string;
  /** Smart "+ New Task" / "+ New Conversation" action. If the active task
   *  has no conv tab (e.g. it was auto-created by opening a file), this
   *  *adds* a conv to that task instead of spawning a separate one — so the
   *  user's open files stay visible. Otherwise, it spawns a fresh task. */
  newConversation(): string;
  /** Return the active task id; if none exists yet, spawn a new task (with
   *  conv hidden) and return its id. Used by file-open call sites so the
   *  empty workspace is never a dead end. */
  ensureActiveTask(): string;
  selectTask(id: string): void;
  /** Rename a task's title. No-op on empty / whitespace input. */
  renameTask(taskId: string, title: string): void;
  /** Remove a task. Reassigns activeId to the previous sibling first so the
   *  UI never transiently sees `selectActiveTask() === undefined`. */
  deleteTask(taskId: string): void;
  setActiveSurface(taskId: string, surface: Surface): void;
  clearSurfaceHint(taskId: string): void;

  // File buffer actions (Code surface)
  openFile(taskId: string, path: string): Promise<void>;
  closeFile(taskId: string, path: string): void;
  /** Close every file open in the task. */
  closeAllFiles(taskId: string): void;
  /** Close every file except `keepPath`. */
  closeOthers(taskId: string, keepPath: string): void;
  /** Close every file whose index is greater than `keepPath`'s in `workingFiles`. */
  closeToRight(taskId: string, keepPath: string): void;
  setActiveFile(taskId: string, path: string): void;
  setFileContent(taskId: string, path: string, content: string): void;
  saveFile(taskId: string, path: string): Promise<void>;
  /** Save every dirty (content !== saved) text buffer in the task. */
  saveAll(taskId: string): Promise<void>;
  applyDiskChange(taskId: string, path: string, content: string): void;

  /** Close the Preview/Browser tab. Switches active surface back to conversation if needed. */
  closeBrowserSurface(taskId: string): void;
  /** Hide the Conversation tab (chat history stays in `blocks`). Falls back
   *  to a visible surface (file → browser); if none, cascades to delete-task. */
  closeConvSurface(taskId: string): void;
  /** Close whatever tab is currently active in `taskId`. Used by Cmd+W and
   *  any "close the active tab" UI affordance. Cascades to deleteTask /
   *  closeProject when the workspace empties out. */
  closeActiveTab(taskId: string): void;

  send(args: SendArgs): void;
  handleServer(msg: ServerMessage): void;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

const FILE_PATH_RE = /`([^`]+)`/;

/** Pick the next surface to focus when the current one closes. Preference
 *  order: files (code) → conv → browser → conv (final fallback so
 *  `activeSurface` is always a valid value even if all surfaces are gone;
 *  the cascade-deleter handles that case immediately after). */
function pickNextSurface(t: { surfaces: { conv: boolean; code: boolean; browser: boolean }; workingFiles: string[] }): Surface {
  if (t.workingFiles.length > 0) return 'code';
  if (t.surfaces.conv) return 'conv';
  if (t.surfaces.browser) return 'browser';
  return 'conv';
}

/** Returns true if the task has zero visible tabs. */
function isTaskEmpty(t: { surfaces: { conv: boolean; browser: boolean }; workingFiles: string[] }): boolean {
  return !t.surfaces.conv && !t.surfaces.browser && t.workingFiles.length === 0;
}

/** Called after every individual close. If the task has no surfaces left,
 *  delete the task. We deliberately STOP THERE — when the last task is
 *  deleted, TaskWorkspace renders the empty hero ("Ready when you are" +
 *  New task CTA) and the project stays loaded. Closing the project is only
 *  ever done explicitly (LayoutGrid button, File → Close Project, menu). */
function maybeCascadeEmpty(get: () => TasksState, taskId: string): void {
  const t = get().tasks.find((x) => x.id === taskId);
  if (!t || !isTaskEmpty(t)) return;
  get().deleteTask(taskId);
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function newEmptyTask(title = 'New task'): Task {
  return {
    id: uid(),
    title,
    createdAt: Date.now(),
    blocks: [],
    surfaces: { conv: true, code: false, browser: false },
    activeSurface: 'conv',
    workingFiles: [],
    fileBuffers: {},
    artifacts: [],
    progress: [],
    running: false,
  };
}

/** Truthy if the tool name refers to a file the agent is editing/reading. */
function isFileTool(name: string): boolean {
  return name === 'Read' || name === 'Edit' || name === 'Write' || name === 'MultiEdit';
}

function isBrowserTool(name: string, summary: string): boolean {
  if (name.startsWith('browser_')) return true;
  if (name === 'Bash' && /browser-cli/.test(summary)) return true;
  // Tool detail lines like "Running browser snapshot" / "Running navigate"
  return /browser[ _-]?(navigate|snapshot|screenshot|click|evaluate)/i.test(summary);
}

function extractPath(summary: string): string | null {
  const m = FILE_PATH_RE.exec(summary);
  return m ? m[1] : null;
}

/* ── Store ────────────────────────────────────────────────────────────── */

export const useTasksStore = create<TasksState>((set, get) => {
  /** Locate a task in current state by sessionId or clientRequestId. */
  const findTaskId = (sessionId?: string, clientRequestId?: string): string | null => {
    const { tasks } = get();
    if (sessionId) {
      const t = tasks.find((x) => x.sessionId === sessionId);
      if (t) return t.id;
    }
    if (clientRequestId) {
      const t = tasks.find((x) => x.clientRequestId === clientRequestId);
      if (t) return t.id;
    }
    return null;
  };

  /** Apply a mutator to one task by id, returning a new tasks array. */
  const mutate = (taskId: string, fn: (t: Task) => Task) => {
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? fn(t) : t)) }));
  };

  /** Find or create an assistant/thinking streaming block, append delta. */
  const appendDelta = (taskId: string, messageId: string, kind: string | undefined, delta: string) => {
    const blockKind: 'assistant' | 'thinking' = kind === 'thinking' ? 'thinking' : 'assistant';
    const blockId = `${messageId}:${blockKind}`;
    mutate(taskId, (t) => {
      const idx = t.blocks.findIndex((b) => b.id === blockId);
      if (idx >= 0) {
        const blocks = [...t.blocks];
        const b = blocks[idx];
        if (b.kind === 'assistant' || b.kind === 'thinking') {
          blocks[idx] = { ...b, content: b.content + delta };
        }
        return { ...t, blocks };
      }
      const block: Block = blockKind === 'thinking'
        ? { id: blockId, kind: 'thinking', content: delta, streaming: true }
        : { id: blockId, kind: 'assistant', content: delta, streaming: true };
      return { ...t, blocks: [...t.blocks, block] };
    });
  };

  return {
    tasks: [],
    activeId: null,

    init: () => {
      // No auto-task on boot. The user explicitly creates one with
      // "+ New task" (or by opening a file from the tree, which uses
      // ensureActiveTask to silently spawn a conv-less task).
    },

    resetTasks: () => {
      // Wipe all tasks on project close. The next project open lands the
      // user on the empty hero, not a pre-fabricated chat.
      set({ tasks: [], activeId: null });
    },

    newTask: (opts) => {
      const withConv = opts?.withConv !== false;
      const base = newEmptyTask();
      const t: Task = withConv
        ? base
        : { ...base, surfaces: { ...base.surfaces, conv: false }, activeSurface: 'code' };
      set((s) => ({ tasks: [t, ...s.tasks], activeId: t.id }));
      return t.id;
    },

    ensureActiveTask: () => {
      const cur = get().activeId;
      if (cur) return cur;
      return get().newTask({ withConv: false });
    },

    newConversation: () => {
      const activeId = get().activeId;
      if (activeId) {
        const t = get().tasks.find((x) => x.id === activeId);
        if (t && !t.surfaces.conv) {
          // Adopt the existing task: enable conv + switch to it. This
          // preserves any open files / browser surface in that task.
          mutate(activeId, (tt) => ({
            ...tt,
            surfaces: { ...tt.surfaces, conv: true },
            activeSurface: 'conv',
          }));
          return activeId;
        }
      }
      // No active task or active task already has conv → fresh task.
      return get().newTask();
    },

    selectTask: (id) => set({ activeId: id }),

    renameTask: (taskId, title) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      mutate(taskId, (t) => ({ ...t, title: trimmed }));
    },

    deleteTask: (taskId) => {
      set((s) => {
        const idx = s.tasks.findIndex((t) => t.id === taskId);
        if (idx < 0) return s;
        const remaining = s.tasks.filter((t) => t.id !== taskId);
        // If we removed the active task, snap to the previous sibling (or
        // the next if there's no previous), or null when the list empties.
        let nextActive: string | null = s.activeId;
        if (s.activeId === taskId) {
          nextActive = remaining[Math.max(0, idx - 1)]?.id ?? remaining[0]?.id ?? null;
        }
        return { ...s, tasks: remaining, activeId: nextActive };
      });
    },

    setActiveSurface: (taskId, surface) => mutate(taskId, (t) => ({ ...t, activeSurface: surface, surfaceHint: undefined })),

    clearSurfaceHint: (taskId) => mutate(taskId, (t) => ({ ...t, surfaceHint: undefined })),

    openFile: async (taskId, path) => {
      const task = get().tasks.find((t) => t.id === taskId);
      if (!task) return;
      if (task.fileBuffers[path]) {
        mutate(taskId, (t) => ({ ...t, activeFile: path, activeSurface: 'code', surfaceHint: undefined }));
        return;
      }
      // Pre-flight: figure out whether this is text or binary BEFORE reading
      // multi-MB strings over IPC (which would hang Monaco / the renderer).
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
      mutate(taskId, (t) => ({
        ...t,
        workingFiles: t.workingFiles.includes(path) ? t.workingFiles : [...t.workingFiles, path],
        fileBuffers: { ...t.fileBuffers, [path]: buf },
        activeFile: path,
        activeSurface: 'code',
        surfaceHint: undefined,
      }));
    },

    closeFile: (taskId, path) => {
      mutate(taskId, (t) => {
        const buffers = { ...t.fileBuffers };
        delete buffers[path];
        const workingFiles = t.workingFiles.filter((p) => p !== path);
        const wasActive = t.activeFile === path;
        const activeFile = wasActive ? workingFiles[workingFiles.length - 1] : t.activeFile;
        // If we were viewing the closed file and there's no replacement,
        // pick the next visible surface (conv if open; browser; or fallback).
        const tentative = { ...t, fileBuffers: buffers, workingFiles, activeFile };
        const activeSurface = wasActive && activeFile == null && t.activeSurface === 'code'
          ? pickNextSurface(tentative)
          : t.activeSurface;
        return { ...tentative, activeSurface };
      });
      maybeCascadeEmpty(get, taskId);
    },

    closeAllFiles: (taskId) => {
      mutate(taskId, (t) => {
        const tentative = { ...t, fileBuffers: {}, workingFiles: [], activeFile: undefined };
        return {
          ...tentative,
          activeSurface: t.activeSurface === 'code' ? pickNextSurface(tentative) : t.activeSurface,
        };
      });
      maybeCascadeEmpty(get, taskId);
    },

    closeOthers: (taskId, keepPath) => {
      mutate(taskId, (t) => {
        const buf = t.fileBuffers[keepPath];
        const buffers = buf ? { [keepPath]: buf } : {};
        const workingFiles = t.workingFiles.includes(keepPath) ? [keepPath] : [];
        return { ...t, fileBuffers: buffers, workingFiles, activeFile: keepPath };
      });
    },

    closeToRight: (taskId, keepPath) => {
      mutate(taskId, (t) => {
        const idx = t.workingFiles.indexOf(keepPath);
        if (idx < 0) return t;
        const keep = t.workingFiles.slice(0, idx + 1);
        const keptSet = new Set(keep);
        const buffers: typeof t.fileBuffers = {};
        for (const p of keep) if (t.fileBuffers[p]) buffers[p] = t.fileBuffers[p];
        const activeFile = t.activeFile && keptSet.has(t.activeFile) ? t.activeFile : keepPath;
        return { ...t, workingFiles: keep, fileBuffers: buffers, activeFile };
      });
    },

    setActiveFile: (taskId, path) => mutate(taskId, (t) => ({ ...t, activeFile: path })),

    setFileContent: (taskId, path, content) => {
      mutate(taskId, (t) => {
        const buf = t.fileBuffers[path];
        if (!buf || buf.kind !== 'text') return t;
        return { ...t, fileBuffers: { ...t.fileBuffers, [path]: { ...buf, content, conflict: false } } };
      });
    },

    saveFile: async (taskId, path) => {
      const t = get().tasks.find((x) => x.id === taskId);
      const buf = t?.fileBuffers[path];
      if (!buf || buf.kind !== 'text') return;
      const res = await window.ccb.fs.writeFile(path, buf.content);
      if (res.ok) {
        mutate(taskId, (tt) => {
          const b = tt.fileBuffers[path];
          if (!b || b.kind !== 'text') return tt;
          return { ...tt, fileBuffers: { ...tt.fileBuffers, [path]: { ...b, saved: b.content, conflict: false } } };
        });
      }
    },

    saveAll: async (taskId) => {
      const t = get().tasks.find((x) => x.id === taskId);
      if (!t) return;
      const dirty: string[] = [];
      for (const [p, b] of Object.entries(t.fileBuffers)) {
        if (b.kind === 'text' && b.content !== b.saved) dirty.push(p);
      }
      // Sequential write — the host watcher fires per file; the existing
      // applyDiskChange handler will reconcile. Parallel would be fine too
      // but order helps if any one fails (the rest still go).
      for (const p of dirty) await get().saveFile(taskId, p);
    },

    closeBrowserSurface: (taskId) => {
      mutate(taskId, (t) => ({
        ...t,
        surfaces: { ...t.surfaces, browser: false },
        surfaceHint: t.surfaceHint === 'browser' ? undefined : t.surfaceHint,
        activeSurface: t.activeSurface === 'browser' ? pickNextSurface({ ...t, surfaces: { ...t.surfaces, browser: false } }) : t.activeSurface,
      }));
      maybeCascadeEmpty(get, taskId);
    },

    closeConvSurface: (taskId) => {
      mutate(taskId, (t) => ({
        ...t,
        surfaces: { ...t.surfaces, conv: false },
        activeSurface: t.activeSurface === 'conv' ? pickNextSurface({ ...t, surfaces: { ...t.surfaces, conv: false } }) : t.activeSurface,
      }));
      maybeCascadeEmpty(get, taskId);
    },

    closeActiveTab: (taskId) => {
      const t = get().tasks.find((x) => x.id === taskId);
      if (!t) return;
      const surface = t.activeSurface;
      if (surface === 'code' && t.activeFile) {
        get().closeFile(taskId, t.activeFile);
      } else if (surface === 'conv') {
        get().closeConvSurface(taskId);
      } else if (surface === 'browser') {
        get().closeBrowserSurface(taskId);
      }
    },

    applyDiskChange: (taskId, path, content) => {
      mutate(taskId, (t) => {
        const buf = t.fileBuffers[path];
        if (!buf || buf.kind !== 'text') return t;
        const dirty = buf.content !== buf.saved;
        if (dirty) {
          return { ...t, fileBuffers: { ...t.fileBuffers, [path]: { ...buf, saved: content, conflict: true } } };
        }
        return { ...t, fileBuffers: { ...t.fileBuffers, [path]: { kind: 'text', content, saved: content, size: content.length } } };
      });
    },

    send: ({ message, url, anchors, projectDir, sources, editJournal, images }) => {
      let taskId = get().activeId;
      if (!taskId) taskId = get().newTask();

      const task = get().tasks.find((t) => t.id === taskId)!;
      const sessionId = task.sessionId;
      const clientRequestId = sessionId ? undefined : (task.clientRequestId ?? uid());

      const userBlock: Block = { id: uid(), kind: 'user', content: message };

      mutate(taskId, (t) => ({
        ...t,
        title: t.blocks.length === 0 && t.title === 'New task' ? message.trim().slice(0, 60) || 'New task' : t.title,
        blocks: [...t.blocks, userBlock],
        running: true,
        clientRequestId: clientRequestId ?? t.clientRequestId,
        // Browser surface auto-lights if the user passed an anchor or there's a loaded url they referenced.
        ...(anchors && anchors.length > 0
          ? { surfaces: { ...t.surfaces, browser: true }, surfaceHint: t.surfaces.browser ? t.surfaceHint : 'browser' }
          : {}),
      }));

      window.ccb.send({
        type: 'chat:send',
        message,
        url: url ?? '',
        sessionId,
        clientRequestId,
        anchors,
        projectDir,
        sources,
        editJournal,
        images,
      });
    },

    handleServer: (msg) => {
      switch (msg.type) {
        case 'session:created': {
          const id = findTaskId(undefined, msg.clientRequestId);
          if (!id) break;
          mutate(id, (t) => ({ ...t, sessionId: msg.sessionId, clientRequestId: undefined }));
          break;
        }

        case 'session:messages': {
          // Loading a session into a task (not used in v1 — sessions are bound to in-memory tasks).
          break;
        }

        case 'chat:stream': {
          const id = findTaskId(msg.sessionId, msg.clientRequestId);
          if (id) appendDelta(id, msg.messageId, msg.kind, msg.delta);
          break;
        }

        case 'agent:tool_use': {
          const id = findTaskId(msg.sessionId, msg.clientRequestId);
          if (!id) break;
          const { toolName, summary } = msg;

          mutate(id, (t) => {
            // _update_ → replace summary on the most recent tool block.
            if (toolName === '_update_') {
              const lastId = t.lastToolBlockId;
              const blocks = lastId
                ? t.blocks.map((b) => (b.id === lastId && b.kind === 'tool' ? { ...b, summary } : b))
                : t.blocks;

              // Surface heuristics from the resolved tool detail.
              const next: Task = { ...t, blocks };
              const lastTool = lastId
                ? (t.blocks.find((b) => b.id === lastId) as { toolName?: string } | undefined)
                : undefined;
              const toolN = lastTool?.toolName ?? '';
              if (isFileTool(toolN)) {
                const p = extractPath(summary);
                if (p) {
                  if (!next.workingFiles.includes(p)) next.workingFiles = [...next.workingFiles, p];
                  if (toolN === 'Edit' || toolN === 'Write' || toolN === 'MultiEdit') {
                    next.artifacts = [...next.artifacts, { path: p, kind: toolN === 'Write' ? 'write' : 'edit', ts: Date.now() }];
                  }
                  // Mirror into project-level workspace so the file appears as a
                  // proper tab the user can click — files are now project-wide.
                  setTimeout(() => {
                    // Lazy import — workspace-store imports this module.
                    void import('./workspace-store.js').then(({ useWorkspaceStore }) => {
                      if (!useWorkspaceStore.getState().fileBuffers[p]) {
                        void useWorkspaceStore.getState().openFile(p);
                      }
                    });
                  }, 0);
                }
                if (!next.surfaces.code) { next.surfaces = { ...next.surfaces, code: true }; next.surfaceHint = next.surfaceHint ?? 'code'; }
              } else if (isBrowserTool(toolN, summary)) {
                if (!next.surfaces.browser) { next.surfaces = { ...next.surfaces, browser: true }; next.surfaceHint = next.surfaceHint ?? 'browser'; }
              }
              return next;
            }

            // Real tool start (or _notice_) → push a tool block.
            const blockId = uid();
            const block: Block = { id: blockId, kind: 'tool', toolName, summary };
            const blocks = [...t.blocks, block];

            // Progress: mark previous active step done; push a new active one (only for real tools, not notices).
            let progress = t.progress;
            if (toolName !== '_notice_' && toolName !== '_update_') {
              progress = progress.map((s) => (s.state === 'active' ? { ...s, state: 'done' as const } : s));
              progress = [...progress, { id: blockId, label: toolName, state: 'active' as const }];
            }

            // Auto-light surfaces immediately if the tool name signals it.
            const surfaces = { ...t.surfaces };
            let surfaceHint = t.surfaceHint;
            if (isFileTool(toolName) && !surfaces.code) { surfaces.code = true; surfaceHint = surfaceHint ?? 'code'; }
            if (isBrowserTool(toolName, summary) && !surfaces.browser) { surfaces.browser = true; surfaceHint = surfaceHint ?? 'browser'; }

            return {
              ...t,
              blocks,
              progress,
              surfaces,
              surfaceHint,
              lastToolBlockId: toolName === '_notice_' ? t.lastToolBlockId : blockId,
            };
          });
          break;
        }

        case 'chat:complete': {
          const id = findTaskId(msg.sessionId, msg.clientRequestId);
          if (!id) break;
          mutate(id, (t) => ({
            ...t,
            running: false,
            blocks: t.blocks.map((b) =>
              b.kind === 'assistant' || b.kind === 'thinking'
                ? { ...b, streaming: false, ...(b.kind === 'assistant' && b.id === `${msg.messageId}:assistant` ? { cost: msg.costUsd } : {}) }
                : b),
            progress: t.progress.map((s) => (s.state === 'active' ? { ...s, state: 'done' as const } : s)),
          }));
          break;
        }

        case 'chat:error': {
          const id = findTaskId(msg.sessionId, msg.clientRequestId);
          if (!id) break;
          mutate(id, (t) => ({
            ...t,
            running: false,
            blocks: [...t.blocks, { id: uid(), kind: 'system', content: msg.error }],
            progress: t.progress.map((s) => (s.state === 'active' ? { ...s, state: 'done' as const } : s)),
          }));
          break;
        }

        case 'agent:status': {
          const id = findTaskId(msg.sessionId, msg.clientRequestId);
          if (id) mutate(id, (t) => ({ ...t, running: msg.status === 'running' }));
          break;
        }
      }
    },
  };
});

/* ── Selectors (stable refs) ──────────────────────────────────────────── */

export const EMPTY_BLOCKS: Block[] = [];
export const EMPTY_ARTIFACTS: Artifact[] = [];
export const EMPTY_PROGRESS: ProgressStep[] = [];
export const EMPTY_STRS: string[] = [];

export function selectActiveTask(s: TasksState): Task | null {
  return s.activeId ? s.tasks.find((t) => t.id === s.activeId) ?? null : null;
}
