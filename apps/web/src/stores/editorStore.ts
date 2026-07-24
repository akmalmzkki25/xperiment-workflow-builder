import { create } from 'zustand';

/** Canvas-local UI state only — server data stays in TanStack Query. */
interface EditorUIState {
  selectedNodeId: string | null;
  libraryOpen: boolean;
  dirty: boolean;
  select: (id: string | null) => void;
  setLibraryOpen: (open: boolean) => void;
  markDirty: () => void;
  clearDirty: () => void;
  reset: () => void;
}

export const useEditorStore = create<EditorUIState>()((set) => ({
  selectedNodeId: null,
  libraryOpen: true,
  dirty: false,
  select: (id) => set({ selectedNodeId: id }),
  setLibraryOpen: (open) => set({ libraryOpen: open }),
  markDirty: () => set({ dirty: true }),
  clearDirty: () => set({ dirty: false }),
  reset: () => set({ selectedNodeId: null, libraryOpen: true, dirty: false }),
}));
