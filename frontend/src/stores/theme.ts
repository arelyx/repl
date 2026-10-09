import { create } from "zustand";

export type ThemeMode = "daylight" | "dusk";
const KEY = "replot.theme";

function initialMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "daylight" || saved === "dusk") return saved;
  } catch {
    /* storage blocked */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dusk" : "daylight";
}

function apply(mode: ThemeMode) {
  document.documentElement.classList.toggle("dark", mode === "dusk");
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", mode === "dusk" ? "#161E23" : "#E8EDEF");
}

interface ThemeState {
  mode: ThemeMode;
  toggle: () => void;
}

export const useTheme = create<ThemeState>((set, get) => {
  const mode = initialMode();
  apply(mode);
  return {
    mode,
    toggle: () => {
      const next: ThemeMode = get().mode === "dusk" ? "daylight" : "dusk";
      apply(next);
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* storage blocked */
      }
      set({ mode: next });
    },
  };
});
