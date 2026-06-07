import { create } from 'zustand';
import type { UpdaterEvent } from '@fineguide-tesseract/shared';

/**
 * Tracks the desktop auto-update lifecycle for the (deliberately subtle) update
 * pill. The main process broadcasts `updater:event`; we keep the latest phase
 * and the downloaded version. Only the `downloaded` phase surfaces UI — the
 * update is already staged and will apply on next quit regardless.
 */
type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready';

interface UpdateState {
  phase: UpdatePhase;
  /** Download progress 0–100, while `phase === 'downloading'`. */
  percent: number;
  /** Version that has been downloaded and is ready to apply. */
  readyVersion: string | null;
  /** User dismissed the pill — stays hidden until the next launch. */
  dismissed: boolean;
  apply(event: UpdaterEvent): void;
  dismiss(): void;
  /** Quit + apply the staged update now, then relaunch. */
  installNow(): void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  phase: 'idle',
  percent: 0,
  readyVersion: null,
  dismissed: false,
  apply: (event) => set((s) => {
    switch (event.kind) {
      case 'checking': return { phase: 'checking' };
      case 'available': return { phase: 'available' };
      case 'progress': return { phase: 'downloading', percent: event.percent };
      case 'downloaded': return { phase: 'ready', readyVersion: event.version, dismissed: false };
      // none/error don't surface UI; keep whatever's already staged (a prior
      // 'ready' must survive a later check that finds nothing new).
      case 'none':
      case 'error': return s.phase === 'ready' ? s : { phase: 'idle' };
      default: return s;
    }
  }),
  dismiss: () => set({ dismissed: true }),
  installNow: () => { void window.ccb.updater.installNow(); },
}));

/** Wire the main-process update broadcast into the store. Call once at app root. */
export function initUpdateListener(): () => void {
  // Replay any event that fired before this renderer mounted.
  void window.ccb.updater.state().then((event) => {
    if (event) useUpdateStore.getState().apply(event);
  });
  return window.ccb.updater.onEvent((event) => useUpdateStore.getState().apply(event));
}
