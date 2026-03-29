import { create } from 'zustand';

export interface DomTreeNode {
  tagName: string;
  id: string;
  classes: string;
  path: string;
  childCount: number;
  children: DomTreeNode[];
  truncated: boolean;
  anchor: {
    selector: string;
    xpath: string;
    domPath: string;
    tagName: string;
    textPreview: string;
    htmlSnippet: string;
    boundingRect: { x: number; y: number; width: number; height: number };
  };
}

interface DomTreeState {
  tree: DomTreeNode | null;
  selectedPath: string | null;
  isLoading: boolean;

  setTree: (tree: DomTreeNode | null) => void;
  setSelectedPath: (path: string | null) => void;
  setLoading: (loading: boolean) => void;
}

export const useDomTreeStore = create<DomTreeState>((set) => ({
  tree: null,
  selectedPath: null,
  isLoading: false,

  setTree: (tree) => set({ tree }),
  setSelectedPath: (path) => set({ selectedPath: path }),
  setLoading: (loading) => set({ isLoading: loading }),
}));
