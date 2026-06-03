import { create } from 'zustand';
import type {
  ServerMessage, ElementAnchor, EditJournalEntry, SessionMessage,
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

/** A task surface. Files live project-wide (see workspace-store), so a task
 *  owns only its conversation and an optional Browser preview. */
export type Surface = 'conv' | 'browser';

export interface Task {
  id: string;
  title: string;
  createdAt: number;
  sessionId?: string;
  clientRequestId?: string;
  blocks: Block[];
  /** Which surfaces are currently *visible* in the tab bar. Closing the
   *  conv tab flips conv to false (chat history stays in `blocks` — it's
   *  hidden, not destroyed); closeBrowserSurface flips browser similarly. */
  surfaces: { conv: boolean; browser: boolean };
  activeSurface: Surface;
  artifacts: Artifact[];
  progress: ProgressStep[];
  running: boolean;
  lastToolBlockId?: string;
  /** Pulses the Browser pill in the tab bar until the user clicks it. */
  surfaceHint?: 'browser';
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
  /** Spawn a new task (a conversation) and make it active. */
  newTask(): string;
  /** "+ New conversation" action — spawns a fresh task. */
  newConversation(): string;
  selectTask(id: string): void;
  /** Rename a task's title. No-op on empty / whitespace input. */
  renameTask(taskId: string, title: string): void;
  /** Remove a task. Reassigns activeId to the previous sibling first so the
   *  UI never transiently sees `selectActiveTask() === undefined`. */
  deleteTask(taskId: string): void;
  setActiveSurface(taskId: string, surface: Surface): void;
  clearSurfaceHint(taskId: string): void;

  /** Close the Preview/Browser tab. Switches active surface back to conversation if needed. */
  closeBrowserSurface(taskId: string): void;

  send(args: SendArgs): void;
  /** Open a prior on-disk Claude Code session as a task and request its
   *  history (server replies with `session:messages`). Returns the task id
   *  so the caller can focus it. If a task is already bound to this session,
   *  that one is reused. */
  resumeSession(info: { id: string; title: string }): string;
  handleServer(msg: ServerMessage): void;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

const FILE_PATH_RE = /`([^`]+)`/;

/** Pick the next surface to focus when the current one closes. Preference
 *  order: conv → browser → conv (final fallback so `activeSurface` is always
 *  valid even if all surfaces are gone; the cascade-deleter handles that case
 *  immediately after). */
function pickNextSurface(t: { surfaces: { conv: boolean; browser: boolean } }): Surface {
  if (t.surfaces.conv) return 'conv';
  if (t.surfaces.browser) return 'browser';
  return 'conv';
}

/** Returns true if the task has zero visible tabs. */
function isTaskEmpty(t: { surfaces: { conv: boolean; browser: boolean } }): boolean {
  return !t.surfaces.conv && !t.surfaces.browser;
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
    surfaces: { conv: true, browser: false },
    activeSurface: 'conv',
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

/** Mirror an agent-touched file into the project-wide workspace so it shows
 *  up as a clickable tab. Lazy import — workspace-store imports this module. */
function mirrorFileToWorkspace(path: string): void {
  setTimeout(() => {
    void import('./workspace-store.js').then(({ useWorkspaceStore }) => {
      if (!useWorkspaceStore.getState().fileBuffers[path]) {
        void useWorkspaceStore.getState().openFile(path);
      }
    });
  }, 0);
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
      // "+ New task" (opening a file from the tree is project-wide and needs
      // no task at all).
    },

    resetTasks: () => {
      // Wipe all tasks on project close. The next project open lands the
      // user on the empty hero, not a pre-fabricated chat.
      set({ tasks: [], activeId: null });
    },

    newTask: () => {
      const t = newEmptyTask();
      set((s) => ({ tasks: [t, ...s.tasks], activeId: t.id }));
      return t.id;
    },

    newConversation: () => get().newTask(),

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

    closeBrowserSurface: (taskId) => {
      mutate(taskId, (t) => ({
        ...t,
        surfaces: { ...t.surfaces, browser: false },
        surfaceHint: t.surfaceHint === 'browser' ? undefined : t.surfaceHint,
        activeSurface: t.activeSurface === 'browser' ? pickNextSurface({ ...t, surfaces: { ...t.surfaces, browser: false } }) : t.activeSurface,
      }));
      maybeCascadeEmpty(get, taskId);
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

    resumeSession: ({ id, title }) => {
      // Reuse an already-open task for this session rather than duplicating it.
      const existing = get().tasks.find((t) => t.sessionId === id);
      if (existing) { set({ activeId: existing.id }); return existing.id; }
      // Land the resumed history in a fresh task. Bind sessionId *before*
      // sending so the incoming `session:messages` (keyed by sessionId)
      // resolves back to this task via findTaskId.
      const taskId = get().newTask();
      mutate(taskId, (t) => ({ ...t, sessionId: id, title: title || t.title, running: true }));
      window.ccb.send({ type: 'session:resume', sessionId: id });
      return taskId;
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
          const id = findTaskId(msg.sessionId);
          if (!id) break;
          mutate(id, (t) => ({ ...t, blocks: sessionMessagesToBlocks(msg.messages), running: false }));
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

              const next: Task = { ...t, blocks };
              const lastTool = lastId
                ? (t.blocks.find((b) => b.id === lastId) as { toolName?: string } | undefined)
                : undefined;
              const toolN = lastTool?.toolName ?? '';
              if (isFileTool(toolN)) {
                const p = extractPath(summary);
                if (p) {
                  if (toolN === 'Edit' || toolN === 'Write' || toolN === 'MultiEdit') {
                    next.artifacts = [...next.artifacts, { path: p, kind: toolN === 'Write' ? 'write' : 'edit', ts: Date.now() }];
                  }
                  // Files are project-wide — surface them as a workspace tab.
                  mirrorFileToWorkspace(p);
                }
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

            // Auto-light the Browser surface if the tool signals it (file tools
            // are project-wide now and don't touch task surfaces).
            const surfaces = { ...t.surfaces };
            let surfaceHint = t.surfaceHint;
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

/* ── Session-history reconstruction ───────────────────────────────────── */

/** Rebuild a task's `blocks` from an on-disk session's stored messages.
 *  Tool blocks carry only their summary text (the disk format doesn't retain
 *  the tool name), so they render as a generic "tool" row. */
function sessionMessagesToBlocks(messages: SessionMessage[]): Block[] {
  const blocks: Block[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      blocks.push({ id: uid(), kind: 'user', content: m.content });
      continue;
    }
    // assistant
    if (m.blocks && m.blocks.length > 0) {
      for (const b of m.blocks) {
        if (b.kind === 'thinking') blocks.push({ id: uid(), kind: 'thinking', content: b.content });
        else if (b.kind === 'tool_use') blocks.push({ id: uid(), kind: 'tool', toolName: 'Tool use', summary: b.content });
        else blocks.push({ id: uid(), kind: 'assistant', content: b.content });
      }
    } else {
      blocks.push({ id: uid(), kind: 'assistant', content: m.content });
    }
  }
  return blocks;
}

/* ── Selectors (stable refs) ──────────────────────────────────────────── */

export const EMPTY_BLOCKS: Block[] = [];
export const EMPTY_ARTIFACTS: Artifact[] = [];
export const EMPTY_PROGRESS: ProgressStep[] = [];

export function selectActiveTask(s: TasksState): Task | null {
  return s.activeId ? s.tasks.find((t) => t.id === s.activeId) ?? null : null;
}
