import { create } from "zustand";

export type EditorPhase = "loading" | "connecting" | "collab" | "rest" | "binary" | "error";
export type SaveState = "saved" | "dirty" | "saving" | "error";

/** What the active editor reports to the status bar. */
interface EditorStatus {
  path: string | null;
  phase: EditorPhase | null;
  saveState: SaveState;
  peers: number;
  line: number;
  column: number;
  selected: number;
  set: (s: Partial<Omit<EditorStatus, "set" | "clear">>) => void;
  clear: (path: string) => void;
}

export const useEditorStatus = create<EditorStatus>((set, get) => ({
  path: null,
  phase: null,
  saveState: "saved",
  peers: 0,
  line: 1,
  column: 1,
  selected: 0,
  set: (s) => set(s),
  clear: (path) => {
    if (get().path === path) set({ path: null, phase: null, saveState: "saved", peers: 0, line: 1, column: 1, selected: 0 });
  },
}));
