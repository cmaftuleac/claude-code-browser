import { create } from 'zustand';
import type {
  ServerMessage, ElementAnchor, EditJournalEntry, SessionMessage, AttachedFile,
  PermissionModeSetting, EffortSetting,
} from '@fineguide-tesseract/shared';
import { useBrowserStore } from './browser-store';
import { useUiStore } from './ui-store';
import { useSettingsStore } from './settings-store';
import { useClosedTabsStore } from './closed-tabs-store';

/* ── Block / Task / Artifact / Progress models ─────────────────────────── */

export type Block =
  | { id: string; kind: 'user'; content: string; anchors?: ElementAnchor[]; images?: string[]; files?: AttachedFile[] }
  | { id: string; kind: 'assistant'; content: string; streaming?: boolean; cost?: number }
  | { id: string; kind: 'thinking'; content: string; streaming?: boolean }
  | { id: string; kind: 'tool'; toolName: string; summary: string }
  | { id: string; kind: 'system'; content: string }
  /** A tool the agent is waiting for the user to approve (canUseTool, non-bypass
   *  modes). Interactive until `decided` is set (the user clicked, or the turn
   *  ended). */
  | {
      id: string;
      kind: 'permission';
      requestId: string;
      toolName: string;
      title?: string;
      displayName?: string;
      description?: string;
      input: Record<string, unknown>;
      blockedPath?: string;
      decided?: 'allow' | 'deny' | 'expired';
    };

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

/** A task is purely a conversation. Files and the Browser preview are
 *  project-wide surfaces (see workspace-store / browser-store), independent
 *  of any conversation. */
export interface Task {
  id: string;
  title: string;
  createdAt: number;
  sessionId?: string;
  clientRequestId?: string;
  blocks: Block[];
  artifacts: Artifact[];
  progress: ProgressStep[];
  running: boolean;
  lastToolBlockId?: string;
  /** The browser instance this conversation's agent drives. Unset → the agent
   *  uses the focused browser (resolved at send time). Set via bindBrowser. */
  browserId?: string;
  /** Element anchors staged for the NEXT message — accumulated from the picker
   *  and Components-tree clicks, rendered as removable chips in the Composer,
   *  merged into chat:send.anchors at submit, then cleared. */
  draftAnchors: ElementAnchor[];
  /** Per-conversation run mode (the Composer's mode picker). Seeded from the
   *  user's saved agent settings at creation; sent on chat:send and switched live
   *  via agent:set_mode. permissionMode + model take effect immediately on a live
   *  session; effort applies from the next new conversation (no live SDK setter). */
  permissionMode: PermissionModeSetting;
  effort: EffortSetting;
  model: string;
}

interface SendArgs {
  /** The conversation to send to. Composer passes its own pane's task id so a
   *  message always lands in the right chat even when several are open in
   *  split panes; falls back to the active task when omitted. */
  taskId?: string;
  message: string;
  url?: string;
  anchors?: ElementAnchor[];
  projectDir?: string;
  sources?: string[];
  editJournal?: EditJournalEntry[];
  /** Base64 data URLs (data:image/…;base64,…); host writes them to /tmp and
   *  references the file paths in the user prompt. */
  images?: string[];
  /** Generic (non-image) file attachments; host writes them to /tmp and
   *  references the paths in the user prompt. */
  files?: AttachedFile[];
  /** Override the conversation's connected browser for this message (else the
   *  task's binding, else the focused browser). */
  browserId?: string;
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
  /** Re-insert a previously-deleted conversation snapshot at its old position
   *  (Reopen Closed Tab). Never restored as running — its live session was
   *  interrupted on delete; the next message resumes via the saved sessionId. */
  restoreTask(task: Task, index: number): void;

  send(args: SendArgs): void;
  /** Stage an element anchor on a conversation's draft (picker / tree click). */
  addDraftAnchor(taskId: string, anchor: ElementAnchor): void;
  removeDraftAnchor(taskId: string, index: number): void;
  clearDraftAnchors(taskId: string): void;
  /** Connect a conversation to a specific browser instance (null → use focused). */
  bindBrowser(taskId: string, browserId: string | null): void;
  /** Update a conversation's run mode (Composer picker). permissionMode + model
   *  switch a live session immediately (agent:set_mode); effort applies next turn. */
  setRunMode(taskId: string, patch: { permissionMode?: PermissionModeSetting; effort?: EffortSetting; model?: string }): void;
  /** Reply to a pending tool-permission request (the in-chat approval card). */
  respondPermission(taskId: string, requestId: string, decision: { behavior: 'allow' | 'deny'; persist?: boolean }): void;
  /** Open a prior on-disk Claude Code session as a task and request its
   *  history (server replies with `session:messages`). Returns the task id
   *  so the caller can focus it. If a task is already bound to this session,
   *  that one is reused. */
  resumeSession(info: { id: string; title: string }): string;
  handleServer(msg: ServerMessage): void;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

const FILE_PATH_RE = /`([^`]+)`/;

/** Per-renderer (per-window) prefix so ids — notably clientRequestId, which is
 *  broadcast to all windows and matched before the canonical sessionId resolves —
 *  can't collide across windows. */
const RUNTIME_ID = Math.random().toString(36).slice(2, 8);
function uid(): string {
  return `${RUNTIME_ID}${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function newEmptyTask(title = 'New task'): Task {
  // Seed the run mode from the user's saved defaults (DEFAULT_SETTINGS until the
  // settings store hydrates — same bypassPermissions default as before).
  const ag = useSettingsStore.getState().settings.agent;
  return {
    id: uid(),
    title,
    createdAt: Date.now(),
    blocks: [],
    artifacts: [],
    progress: [],
    running: false,
    draftAnchors: [],
    permissionMode: ag.permissionMode,
    effort: ag.effort,
    model: ag.model,
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
        // Background open — don't yank focus off the user's active conversation.
        void useWorkspaceStore.getState().openFile(path, { focus: false });
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

  /** Find or create an assistant/thinking streaming block, append delta.
   *
   *  The SDK emits a *fresh* uuid for every stream event (one per text chunk),
   *  so `messageId` is NOT stable across a single assistant message — keying the
   *  block on it fragments every delta into its own block (each chunk renders as
   *  a separate paragraph with a gap). Instead we grow the tail block as long as
   *  it's the same kind, exactly like the extension's chat-store. A user/tool
   *  block or a text↔thinking transition naturally caps the run and starts a
   *  fresh block. */
  const appendDelta = (taskId: string, messageId: string, kind: string | undefined, delta: string) => {
    const blockKind: 'assistant' | 'thinking' = kind === 'thinking' ? 'thinking' : 'assistant';
    mutate(taskId, (t) => {
      const last = t.blocks[t.blocks.length - 1];
      if (last && last.kind === blockKind) {
        const blocks = [...t.blocks];
        blocks[blocks.length - 1] = { ...last, content: last.content + delta, streaming: true };
        return { ...t, blocks };
      }
      const block: Block = blockKind === 'thinking'
        ? { id: `${messageId}:thinking`, kind: 'thinking', content: delta, streaming: true }
        : { id: `${messageId}:assistant`, kind: 'assistant', content: delta, streaming: true };
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
      // Focus the new conversation tab (mirrors openFile/resumeSession). Stashes
      // pendingFocus so the reconcile effect — which re-runs because `tasks`
      // changed — switches to it once it's inserted into the layout.
      useUiStore.getState().setActiveTab({ kind: 'conv', taskId: t.id });
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
        const removed = s.tasks[idx];
        // Snapshot for Reopen Closed Tab (Cmd+Shift+T) — the full conversation
        // (history + sessionId) at its list position, so it reopens intact.
        useClosedTabsStore.getState().push({ kind: 'conv', task: removed, index: idx });
        // Interrupt a still-streaming session so we don't orphan the host's
        // Claude Code process (mirrors closeProject). Done inside the updater so
        // it stays correct under the forEach(deleteTask) close-all loops.
        if (removed.running && removed.sessionId) {
          window.ccb.send({ type: 'agent:interrupt', sessionId: removed.sessionId });
        }
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

    restoreTask: (task, index) => {
      set((s) => {
        if (s.tasks.some((t) => t.id === task.id)) return { ...s, activeId: task.id };
        const tasks = [...s.tasks];
        const i = Math.min(Math.max(0, index), tasks.length);
        tasks.splice(i, 0, { ...task, running: false });
        return { ...s, tasks, activeId: task.id };
      });
    },

    send: ({ taskId: explicitId, message, url, anchors, projectDir, sources, editJournal, images, files, browserId: argBrowserId }) => {
      let taskId = explicitId ?? get().activeId;
      if (!taskId) taskId = get().newTask();

      // An explicit taskId can be stale (its task was deleted/closed). Don't
      // dereference undefined — fall back to a fresh conversation.
      let task = get().tasks.find((t) => t.id === taskId);
      if (!task) { taskId = get().newTask(); task = get().tasks.find((t) => t.id === taskId); }
      if (!task) return;
      const sessionId = task.sessionId;
      const clientRequestId = sessionId ? undefined : (task.clientRequestId ?? uid());
      // The browser this turn drives: explicit override → the conversation's
      // pinned browser (only if it still exists) → the focused browser. May be
      // undefined (no browser open). A binding to a since-closed browser falls
      // through rather than routing to a dead id.
      const bs = useBrowserStore.getState();
      const boundValid = task.browserId && bs.instances[task.browserId] ? task.browserId : undefined;
      const browserId = argBrowserId ?? boundValid ?? bs.activeId ?? undefined;

      // Anchors this turn = the conversation's staged draft anchors (picker /
      // tree clicks) + any live edit-mode selection the Composer passes in.
      const mergedAnchors = [...task.draftAnchors, ...(anchors ?? [])];

      const userBlock: Block = {
        id: uid(),
        kind: 'user',
        content: message,
        ...(mergedAnchors.length > 0 ? { anchors: mergedAnchors } : {}),
        ...(images && images.length > 0 ? { images } : {}),
        ...(files && files.length > 0 ? { files } : {}),
      };

      mutate(taskId, (t) => ({
        ...t,
        title: t.blocks.length === 0 && t.title === 'New task' ? message.trim().slice(0, 60) || 'New task' : t.title,
        blocks: [...t.blocks, userBlock],
        running: true,
        clientRequestId: clientRequestId ?? t.clientRequestId,
        draftAnchors: [], // staged anchors are now in flight
      }));

      // Sending a selected element implies a browser. If none is open yet,
      // create one (otherwise the existing instance(s) already cover it).
      if (mergedAnchors.length > 0 && bs.order.length === 0) bs.openBrowser({ hint: true });

      window.ccb.send({
        type: 'chat:send',
        message,
        url: url ?? '',
        sessionId,
        clientRequestId,
        anchors: mergedAnchors.length > 0 ? mergedAnchors : undefined,
        projectDir,
        sources,
        editJournal,
        images,
        files,
        browserId,
        // Per-conversation run mode (the Composer picker). Backend uses these over
        // its saved-settings default.
        permissionMode: task.permissionMode,
        effort: task.effort,
        model: task.model,
      });
    },

    addDraftAnchor: (taskId, anchor) => mutate(taskId, (t) => ({ ...t, draftAnchors: [...t.draftAnchors, anchor] })),
    removeDraftAnchor: (taskId, index) => mutate(taskId, (t) => ({ ...t, draftAnchors: t.draftAnchors.filter((_, i) => i !== index) })),
    clearDraftAnchors: (taskId) => mutate(taskId, (t) => ({ ...t, draftAnchors: [] })),

    bindBrowser: (taskId, browserId) => {
      mutate(taskId, (t) => ({ ...t, browserId: browserId ?? undefined }));
    },

    setRunMode: (taskId, patch) => {
      const task = get().tasks.find((t) => t.id === taskId);
      if (!task) return;
      mutate(taskId, (t) => ({ ...t, ...patch }));
      // Switch a live (session-resolved) conversation immediately. permissionMode
      // + model take effect on the running Query; effort has no live setter, so it
      // only rides the next chat:send (no agent:set_mode needed for it).
      if (task.sessionId && (patch.permissionMode !== undefined || patch.model !== undefined)) {
        window.ccb.send({
          type: 'agent:set_mode',
          sessionId: task.sessionId,
          ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
          ...(patch.model !== undefined ? { model: patch.model } : {}),
        });
      }
    },

    respondPermission: (taskId, requestId, decision) => {
      window.ccb.send({ type: 'chat:permission', requestId, behavior: decision.behavior, persist: decision.persist });
      // Mark the card resolved so it stops being interactive (keeps the row as a
      // record of the decision).
      mutate(taskId, (t) => ({
        ...t,
        blocks: t.blocks.map((b) =>
          b.kind === 'permission' && b.requestId === requestId ? { ...b, decided: decision.behavior } : b),
      }));
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
          // The Browser is a project-wide surface; auto-open it outside the
          // task mutate (which only tracks the conversation).
          let openBrowser = false;

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
                openBrowser = true;
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

            if (isBrowserTool(toolName, summary)) openBrowser = true;

            return {
              ...t,
              blocks,
              progress,
              lastToolBlockId: toolName === '_notice_' ? t.lastToolBlockId : blockId,
            };
          });

          if (openBrowser) {
            const bs = useBrowserStore.getState();
            if (bs.order.length === 0) bs.openBrowser({ hint: true });
          }
          break;
        }

        case 'agent:permission_request': {
          const id = findTaskId(msg.sessionId, msg.clientRequestId);
          if (!id) break;
          mutate(id, (t) => ({
            ...t,
            blocks: [...t.blocks, {
              id: uid(),
              kind: 'permission',
              requestId: msg.requestId,
              toolName: msg.toolName,
              title: msg.title,
              displayName: msg.displayName,
              description: msg.description,
              input: msg.input,
              blockedPath: msg.blockedPath,
            }],
          }));
          break;
        }

        case 'chat:complete': {
          const id = findTaskId(msg.sessionId, msg.clientRequestId);
          if (!id) break;
          mutate(id, (t) => {
            // Cost is per-turn; attach it to the final assistant block. (The
            // result uuid never matches a stream block's id, so we locate the
            // tail assistant block by position instead.)
            let lastAssistantIdx = -1;
            for (let i = t.blocks.length - 1; i >= 0; i--) {
              if (t.blocks[i].kind === 'assistant') { lastAssistantIdx = i; break; }
            }
            return {
              ...t,
              running: false,
              blocks: t.blocks.map((b, i) =>
                b.kind === 'assistant' || b.kind === 'thinking'
                  ? { ...b, streaming: false, ...(i === lastAssistantIdx ? { cost: msg.costUsd } : {}) }
                  : b.kind === 'permission' && !b.decided ? { ...b, decided: 'expired' as const } : b),
              progress: t.progress.map((s) => (s.state === 'active' ? { ...s, state: 'done' as const } : s)),
            };
          });
          break;
        }

        case 'chat:error': {
          const id = findTaskId(msg.sessionId, msg.clientRequestId);
          if (!id) break;
          mutate(id, (t) => ({
            ...t,
            running: false,
            blocks: [
              ...t.blocks.map((b) => (b.kind === 'permission' && !b.decided ? { ...b, decided: 'expired' as const } : b)),
              { id: uid(), kind: 'system', content: msg.error },
            ],
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
