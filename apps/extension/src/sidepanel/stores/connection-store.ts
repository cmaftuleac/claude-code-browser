import { create } from 'zustand';

interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'connected';
  serverUrl: string;
  setStatus: (status: ConnectionState['status']) => void;
  setServerUrl: (url: string) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  serverUrl: 'ws://localhost:9315/ws',
  setStatus: (status) => set({ status }),
  setServerUrl: (serverUrl) => set({ serverUrl }),
}));
