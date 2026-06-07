/**
 * Host registry store (web/cloud).
 *
 * A "host" is something that runs the agent + browsers + session store: the
 * cloud server, or one of the user's Electron machines that registered itself
 * (Mode B). The web client picks which host its agent/browser/signal traffic
 * targets. Backed by the multiplexed control WS via `window.ccb.host`.
 *
 * On desktop, `window.ccb.host` reports just "this computer" and selection is
 * inert — the picker simply shows one entry.
 */
import { create } from 'zustand';
import type { HostInfo } from '@fineguide-tesseract/shared';

interface HostState {
  hosts: HostInfo[];
  /** null = the backend's default host (the cloud server). */
  selectedHostId: string | null;
  init: () => void;
  refresh: () => void;
  select: (hostId: string | null) => void;
}

let initialized = false;

export const useHostStore = create<HostState>((set) => ({
  hosts: [],
  selectedHostId: null,
  init: () => {
    if (initialized) return;
    initialized = true;
    window.ccb.host.onChange((hosts) => set({ hosts }));
    void window.ccb.host.list().then((hosts) => set({ hosts }));
    set({ selectedHostId: window.ccb.host.selected() });
  },
  refresh: () => { void window.ccb.host.list().then((hosts) => set({ hosts })); },
  select: (hostId) => {
    window.ccb.host.select(hostId);
    set({ selectedHostId: hostId });
  },
}));

/** The server host is the implicit default — treat a null selection as "server". */
export function isSelected(host: HostInfo, selectedHostId: string | null): boolean {
  if (selectedHostId == null) return host.kind === 'server';
  return host.hostId === selectedHostId;
}
