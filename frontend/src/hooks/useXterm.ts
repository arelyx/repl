import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export const XTERM_THEME = {
  background: "#0e1525",
  foreground: "#f5f9fc",
  cursor: "#f26207",
  selectionBackground: "#3c445c",
  black: "#1c2333",
  brightBlack: "#5f6779",
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
    const t = new Terminal({
      fontFamily: '"JetBrains Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
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
    return () => {
      ro.disconnect();
      sub.dispose();
      t.dispose();
      fitRef.current = null;
      setTerm(null);
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
