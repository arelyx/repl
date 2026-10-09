import { create } from "zustand";
import type { ClientStatus } from "./client";
import type { LspManager } from "./manager";
import type { Diagnostic } from "./protocol";

export interface FileDiagnostics {
  uri: string;
  path: string;
  server: string;
  items: Diagnostic[];
}

interface LspUiState {
  /** The manager for the open repl, or null for viewers / no repl. */
  manager: LspManager | null;
  statuses: Record<string, ClientStatus>;
  /** Keyed by normalized file URI. */
  diagnostics: Record<string, FileDiagnostics>;

  setManager: (m: LspManager | null) => void;
  setStatus: (server: string, s: ClientStatus) => void;
  setDiagnostics: (d: FileDiagnostics) => void;
  clearDiagnostics: (uri: string) => void;
  clearServerDiagnostics: (server: string) => void;
}

export const useLspStore = create<LspUiState>((set) => ({
  manager: null,
  statuses: {},
  diagnostics: {},

  setManager: (manager) => set({ manager, statuses: {}, diagnostics: {} }),
  setStatus: (server, s) => set((st) => ({ statuses: { ...st.statuses, [server]: s } })),
  setDiagnostics: (d) =>
    set((st) => {
      const next = { ...st.diagnostics };
      if (d.items.length) next[d.uri] = d;
      else delete next[d.uri];
      return { diagnostics: next };
    }),
  clearDiagnostics: (uri) =>
    set((st) => {
      if (!(uri in st.diagnostics)) return st;
      const next = { ...st.diagnostics };
      delete next[uri];
      return { diagnostics: next };
    }),
  clearServerDiagnostics: (server) =>
    set((st) => ({
      diagnostics: Object.fromEntries(Object.entries(st.diagnostics).filter(([, d]) => d.server !== server)),
    })),
}));
