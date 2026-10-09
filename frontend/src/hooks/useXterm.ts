import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

/** "Graphite" terminal theme: the editor's ground, ANSI colors drawn from the language accents. */
export const XTERM_THEME = {
  background: "#1c2029",
  foreground: "#dce1ea",
  cursor: "#82aaff",
  cursorAccent: "#1c2029",
  selectionBackground: "#82aaff4d",
  black: "#2c3240",
  red: "#f07178",
  green: "#a6d86e",
  yellow: "#e8cf62",
  blue: "#82aaff",
  magenta: "#c3a6ff",
  cyan: "#5ed6c4",
  white: "#c6ccd7",
  brightBlack: "#7f899b",
  brightRed: "#ff9aa0",
  brightGreen: "#c2ec8f",
  brightYellow: "#f7e08a",
  brightBlue: "#a8c4ff",
  brightMagenta: "#d9c4ff",
  brightCyan: "#8ee8da",
  brightWhite: "#f1f4f9",
};

/** Mounts an xterm.js terminal into the returned ref and keeps it fitted to its container. */
export function useXterm(opts: { onResize?: (cols: number, rows: number) => void } = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [term, setTerm] = useState<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onResizeRef = useRef(opts.onResize);
  onResizeRef.current = opts.onResize;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cleanup: (() => void) | null = null;
    let cancelled = false;

    const mount = () => {
      if (cancelled) return;
      const t = new Terminal({
        fontFamily: '"Red Hat Mono Variable", ui-monospace, Menlo, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.15,
        cursorBlink: true,
        convertEol: false,
        scrollback: 5000,
        theme: XTERM_THEME,
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(el);
      fitRef.current = fit;
      const doFit = () => {
        if (!el.offsetWidth || !el.offsetHeight) return;
        try {
          fit.fit();
        } catch {
          /* not visible yet */
        }
      };
      doFit();
      const sub = t.onResize(({ cols, rows }) => onResizeRef.current?.(cols, rows));
      const ro = new ResizeObserver(() => doFit());
      ro.observe(el);
      setTerm(t);
      cleanup = () => {
        ro.disconnect();
        sub.dispose();
        t.dispose();
        fitRef.current = null;
        setTerm(null);
      };
    };

    // Open the terminal once the mono face is available so xterm measures the real glyphs.
    const fonts = document.fonts;
    if (fonts?.check('13px "Red Hat Mono Variable"')) mount();
    else if (fonts) void fonts.load('13px "Red Hat Mono Variable"').catch(() => {}).finally(mount);
    else mount();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  const fit = () => {
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
  };

  return { containerRef, term, fit };
}
