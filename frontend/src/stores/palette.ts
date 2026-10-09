import { useEffect } from "react";
import type { LucideIcon } from "lucide-react";
import { create } from "zustand";

export interface PaletteCommand {
  id: string;
  title: string;
  /** Group heading in the palette. Groups appear in the order of GROUP_ORDER. */
  group: string;
  keywords?: string[];
  /** Shortcut keys, e.g. ["mod", "Enter"]. "mod" renders as ⌘ on macOS and Ctrl elsewhere. */
  shortcut?: string[];
  icon?: LucideIcon;
  /** Small trailing text, e.g. a file's folder. */
  hint?: string;
  /** Rendered before the title instead of an icon (e.g. a language chip). */
  lead?: React.ReactNode;
  disabled?: boolean;
  run: () => void;
}

export type PaletteMode = "commands" | "files";

interface PaletteState {
  open: boolean;
  mode: PaletteMode;
  sources: Record<string, PaletteCommand[]>;
  show: (mode?: PaletteMode) => void;
  setOpen: (open: boolean) => void;
  register: (source: string, cmds: PaletteCommand[]) => void;
  unregister: (source: string) => void;
}

export const usePalette = create<PaletteState>((set) => ({
  open: false,
  mode: "commands",
  sources: {},
  show: (mode = "commands") => set({ open: true, mode }),
  setOpen: (open) => set(open ? { open } : { open, mode: "commands" }),
  register: (source, cmds) => set((s) => ({ sources: { ...s.sources, [source]: cmds } })),
  unregister: (source) =>
    set((s) => {
      const next = { ...s.sources };
      delete next[source];
      return { sources: next };
    }),
}));

/** Registers palette commands while the calling component is mounted. */
export function useCommands(source: string, factory: () => PaletteCommand[], deps: React.DependencyList) {
  useEffect(() => {
    usePalette.getState().register(source, factory());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => () => usePalette.getState().unregister(source), [source]);
}

export const GROUP_ORDER = ["Run", "View", "Files", "File actions", "Repl", "Version control", "Go to", "Your repls", "Start a repl", "Account"];

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** True when a key event is the platform's primary modifier (⌘ on macOS, Ctrl elsewhere). */
export const modKey = (e: KeyboardEvent | React.KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

/** True when the event target is a text field other than Monaco's hidden input. */
export function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.closest?.(".monaco-editor") || el.closest?.(".xterm")) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}
