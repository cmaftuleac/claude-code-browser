import { create } from 'zustand';

export interface SlashCommand {
  name: string;
  description: string;
  hint?: string;
}

interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'connected';
  serverVersion: string | null;
  claudeAuthenticated: boolean;
  commands: SlashCommand[];
  setStatus(status: ConnectionState['status']): void;
  setReady(serverVersion: string): void;
  setHealth(authenticated: boolean): void;
  setCommands(commands: SlashCommand[]): void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'connecting',
  serverVersion: null,
  claudeAuthenticated: false,
  commands: [],
  setStatus: (status) => set({ status }),
  setReady: (serverVersion) => set({ status: 'connected', serverVersion }),
  setHealth: (claudeAuthenticated) => set({ claudeAuthenticated }),
  setCommands: (commands) => set({ commands }),
}));
