import { create } from 'zustand';

function normalizeUrl(input: string): string {
  const v = input.trim();
  if (!v) return v;
  if (/^https?:\/\//i.test(v) || /^file:\/\//i.test(v) || /^about:/i.test(v)) return v;
  if (/^localhost(:\d+)?/i.test(v) || /^\d+\.\d+\.\d+\.\d+/.test(v)) return `http://${v}`;
  return `https://${v}`;
}

interface BrowserState {
  addressBar: string;
  loadedUrl: string;
  setAddressBar(v: string): void;
  navigate(url: string): void;
}

export const useBrowserStore = create<BrowserState>((set) => ({
  addressBar: 'http://localhost:3000',
  loadedUrl: '',
  setAddressBar: (addressBar) => set({ addressBar }),
  navigate: (url) => {
    const normalized = normalizeUrl(url);
    set({ loadedUrl: normalized, addressBar: normalized });
  },
}));
