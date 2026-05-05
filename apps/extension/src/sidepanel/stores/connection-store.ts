import { create } from 'zustand';

interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'connected';
  serverUrl: string;
  targetTabId: number | null;
  targetTabUrl: string;
  setStatus: (status: ConnectionState['status']) => void;
  setServerUrl: (url: string) => void;
  setTargetTab: (tabId: number | null, url?: string) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  serverUrl: 'ws://localhost:9315/ws',
  targetTabId: null,
  targetTabUrl: '',
  setStatus: (status) => set({ status }),
  setServerUrl: (serverUrl) => set({ serverUrl }),
  setTargetTab: (tabId, url) => set({ targetTabId: tabId, targetTabUrl: url ?? '' }),
}));
