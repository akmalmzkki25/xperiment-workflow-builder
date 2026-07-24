import { create } from 'zustand';

/** Canvas-local UI state only — server data stays in TanStack Query. */
interface EditorUIState {
  selectedNodeId: string | null;
  libraryOpen: boolean;
  dirty: boolean;
  /** Monotonic edit counter — lets a save know whether edits landed mid-flight. */
  editSeq: number;
  select: (id: string | null) => void;
  setLibraryOpen: (open: boolean) => void;
  markDirty: () => void;
  /** Clears dirty only if no edits happened after the given sequence number. */
  clearDirtyUpTo: (seq: number) => void;
  reset: () => void;
}

export const useEditorStore = create<EditorUIState>()((set) => ({
  selectedNodeId: null,
  libraryOpen: true,
  dirty: false,
  editSeq: 0,
  select: (id) => set({ selectedNodeId: id }),
  setLibraryOpen: (open) => set({ libraryOpen: open }),
  markDirty: () => set((s) => ({ dirty: true, editSeq: s.editSeq + 1 })),
  clearDirtyUpTo: (seq) => set((s) => (s.editSeq === seq ? { dirty: false } : {})),
  reset: () => set({ selectedNodeId: null, libraryOpen: true, dirty: false, editSeq: 0 }),
}));
