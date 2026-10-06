import { create } from "zustand";
import { replsApi } from "@/lib/repls";
import type { FileNode, Repl } from "@/lib/types";

export type ToolTab = "console" | "shell" | "webview" | "display";
export type ContainerState = "unknown" | "starting" | "running" | "stopped" | "missing" | "error";

export interface RunStatus {
  running: boolean;
  exitCode: number | null;
  command: string;
}

interface WorkspaceState {
  repl: Repl | null;
  container: ContainerState;
  containerError: string | null;
  runStatus: RunStatus | null;
  runConnected: boolean;
  /** Sends a JSON message on the shared /run socket; set by the Console pane. */
  runSend: ((msg: object) => boolean) | null;

  files: FileNode[];
  filesLoaded: boolean;
  openTabs: string[];
  activePath: string | null;
  toolTab: ToolTab;
  /** Bumped after commits/restores so file views reload from disk. */
  fsEpoch: number;

  reset: (repl: Repl) => void;
  setRepl: (repl: Repl) => void;
  setContainer: (s: ContainerState, error?: string | null) => void;
  setRunStatus: (s: RunStatus | null) => void;
  setRunConnection: (connected: boolean, send: ((msg: object) => boolean) | null) => void;
  loadFiles: () => Promise<void>;
  openFile: (path: string) => void;
  closeFile: (path: string) => void;
  onPathRenamed: (from: string, to: string) => void;
  onPathDeleted: (path: string) => void;
  setToolTab: (t: ToolTab) => void;
  bumpFsEpoch: () => void;
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + "/");

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  repl: null,
  container: "unknown",
  containerError: null,
  runStatus: null,
  runConnected: false,
  runSend: null,
  files: [],
  filesLoaded: false,
  openTabs: [],
  activePath: null,
  toolTab: "console",
  fsEpoch: 0,

  reset: (repl) =>
    set({
      repl,
      container: "unknown",
      containerError: null,
      runStatus: null,
      runConnected: false,
      runSend: null,
      files: [],
      filesLoaded: false,
      openTabs: [],
      activePath: null,
      toolTab: repl.config?.gui ? "display" : "console",
      fsEpoch: 0,
    }),
  setRepl: (repl) => set({ repl }),
  setContainer: (container, error = null) => set({ container, containerError: error }),
  setRunStatus: (runStatus) => set({ runStatus }),
  setRunConnection: (runConnected, runSend) => set({ runConnected, runSend }),

  loadFiles: async () => {
    const repl = get().repl;
    if (!repl) return;
    const files = await replsApi.files(repl.id);
    if (get().repl?.id !== repl.id) return;
    set({ files, filesLoaded: true });
  },

  openFile: (path) => {
    const { openTabs } = get();
    set({
      openTabs: openTabs.includes(path) ? openTabs : [...openTabs, path],
      activePath: path,
    });
  },
  closeFile: (path) => {
    const { openTabs, activePath } = get();
    const idx = openTabs.indexOf(path);
    const next = openTabs.filter((p) => p !== path);
    let active = activePath;
    if (activePath === path) active = next[Math.min(idx, next.length - 1)] ?? null;
    set({ openTabs: next, activePath: active });
  },
  onPathRenamed: (from, to) => {
    const map = (p: string) => (under(p, from) ? to + p.slice(from.length) : p);
    const { openTabs, activePath } = get();
    set({ openTabs: openTabs.map(map), activePath: activePath ? map(activePath) : null });
  },
  onPathDeleted: (path) => {
    const { openTabs, activePath } = get();
    const next = openTabs.filter((p) => !under(p, path));
    set({
      openTabs: next,
      activePath: activePath && under(activePath, path) ? (next[0] ?? null) : activePath,
    });
  },
  setToolTab: (toolTab) => set({ toolTab }),
  bumpFsEpoch: () => set((s) => ({ fsEpoch: s.fsEpoch + 1 })),
}));

export const canEdit = (repl: Repl | null) => !!repl && repl.role !== "viewer";
