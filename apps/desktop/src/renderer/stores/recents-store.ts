import { create } from 'zustand';

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: number;
}

interface RecentsState {
  items: RecentProject[];
  loaded: boolean;
  load(): Promise<void>;
  add(path: string, name: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export const useRecentsStore = create<RecentsState>((set) => ({
  items: [],
  loaded: false,

  load: async () => {
    const items = await window.ccb.recents.list();
    set({ items, loaded: true });
  },

  add: async (path, name) => {
    const items = await window.ccb.recents.add(path, name);
    set({ items, loaded: true });
  },

  remove: async (path) => {
    const items = await window.ccb.recents.remove(path);
    set({ items });
  },
}));
