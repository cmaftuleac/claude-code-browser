import { create } from 'zustand';

/** Manual-update prompt details, shown by SetupScreen when auto-update isn't
 *  possible (host too old to self-update) or failed (npm/permission error). */
export interface ManualUpdateInfo {
  /** Version the user must install. */
  target: string;
  /** Version currently reported by the host, if known. */
  current: string | null;
  /** Why automatic update wasn't done / failed (shown to the user). */
  reason?: string;
}

interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'connected';
  serverUrl: string;
  targetTabId: number | null;
  targetTabUrl: string;
  /** True while a host:update request is in flight (drives the "Updating bridge…"
   *  UI). Persists across the update-triggered disconnect→respawn until a fresh
   *  connection:ready resolves the outcome. */
  hostUpdating: boolean;
  /** Loop guard: at most one silent auto-update attempt per side-panel session.
   *  Lives here (module-singleton store) so it survives the useNativePort hook
   *  re-running on reconnect. Reset only on a matching connection:ready. */
  updateAttempted: boolean;
  /** Set when the user must update the host by hand. Non-null → SetupScreen shows
   *  the manual-update variant instead of the generic setup steps. */
  needsManualUpdate: ManualUpdateInfo | null;
  setStatus: (status: ConnectionState['status']) => void;
  setServerUrl: (url: string) => void;
  setTargetTab: (tabId: number | null, url?: string) => void;
  /** Record that we've fired one auto-update and entered the updating state. */
  markUpdateAttempted: () => void;
  /** Clear all update bookkeeping (host is compatible again). */
  resetUpdateAttempt: () => void;
  /** Switch to the manual-update screen. */
  setNeedsManualUpdate: (info: ManualUpdateInfo) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  serverUrl: 'ws://localhost:9315/ws',
  targetTabId: null,
  targetTabUrl: '',
  hostUpdating: false,
  updateAttempted: false,
  needsManualUpdate: null,
  setStatus: (status) => set({ status }),
  setServerUrl: (serverUrl) => set({ serverUrl }),
  setTargetTab: (tabId, url) => set({ targetTabId: tabId, targetTabUrl: url ?? '' }),
  markUpdateAttempted: () => set({ updateAttempted: true, hostUpdating: true, needsManualUpdate: null }),
  resetUpdateAttempt: () => set({ updateAttempted: false, hostUpdating: false, needsManualUpdate: null }),
  setNeedsManualUpdate: (info) => set({ needsManualUpdate: info, hostUpdating: false }),
}));
