/**
 * Browser-style back/forward history of "where am I in the app".
 *
 * A `Location` is the current (view, active task, active surface). The
 * `useNavWatcher` hook subscribes to those stores and pushes a new entry every
 * time the user navigates — except when `applying` is true (back/forward in
 * progress), in which case we skip the push.
 *
 * `back()` / `forward()` walk the cursor and apply the destination by calling
 * the public store actions. Entries whose target task no longer exists are
 * skipped (auto-prune on traversal).
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { useUiStore, type AppView } from './ui-store';
import { useTasksStore, selectActiveTask, type Surface } from './tasks-store';

export interface Location {
  view: AppView;
  taskId?: string;
  surface?: Surface;
}

const CAP = 64;
/** Set to true while back()/forward() is mutating other stores — the watcher checks this. */
let applying = false;

export function isApplying(): boolean { return applying; }

interface NavState {
  history: Location[];
  cursor: number;
  pushIfChanged(loc: Location): void;
  back(): void;
  forward(): void;
  canBack(): boolean;
  canForward(): boolean;
  /** Wipe history. Called when entering the Home screen so the arrows
   *  don't carry stale destinations from the previous project. */
  reset(): void;
}

function sameLoc(a: Location | undefined, b: Location): boolean {
  if (!a) return false;
  return a.view === b.view && a.taskId === b.taskId && a.surface === b.surface;
}

function apply(loc: Location): void {
  applying = true;
  try {
    useUiStore.getState().setView(loc.view);
    if (loc.view === 'workspace' && loc.taskId) {
      const tasks = useTasksStore.getState().tasks;
      // If the task is gone (closed project / reset), fall back to whatever task exists.
      const target = tasks.find((t) => t.id === loc.taskId) ?? tasks[0];
      if (target) {
        useTasksStore.getState().selectTask(target.id);
        if (loc.surface) useTasksStore.getState().setActiveSurface(target.id, loc.surface);
      }
    }
  } finally {
    setTimeout(() => { applying = false; }, 0);
  }
}

export const useNavStore = create<NavState>((set, get) => ({
  history: [],
  cursor: -1,

  pushIfChanged: (loc) => {
    if (applying) return;
    const { history, cursor } = get();
    if (sameLoc(history[cursor], loc)) return;
    const trimmed = history.slice(0, cursor + 1);
    trimmed.push(loc);
    const next = trimmed.length > CAP ? trimmed.slice(trimmed.length - CAP) : trimmed;
    set({ history: next, cursor: next.length - 1 });
  },

  back: () => {
    const { history, cursor } = get();
    if (cursor <= 0) return;
    set({ cursor: cursor - 1 });
    apply(history[cursor - 1]);
  },

  forward: () => {
    const { history, cursor } = get();
    if (cursor >= history.length - 1) return;
    set({ cursor: cursor + 1 });
    apply(history[cursor + 1]);
  },

  canBack: () => get().cursor > 0,
  canForward: () => get().cursor < get().history.length - 1,

  reset: () => set({ history: [], cursor: -1 }),
}));

/**
 * Mount once at the App root. Watches the current (view, taskId, surface)
 * tuple and pushes a history entry whenever it changes — except while a
 * back/forward navigation is in flight.
 */
export function useNavWatcher(): void {
  const view = useUiStore((s) => s.view);
  const activeId = useTasksStore((s) => s.activeId);
  const surface = useTasksStore((s) => selectActiveTask(s)?.activeSurface);
  useEffect(() => {
    useNavStore.getState().pushIfChanged({
      view,
      taskId: activeId ?? undefined,
      surface,
    });
  }, [view, activeId, surface]);
}
