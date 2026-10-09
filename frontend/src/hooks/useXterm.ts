import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { XTERM_THEMES } from "@/lib/fjordThemes";
import { useTheme } from "@/stores/theme";

const FONT = '"Fragment Mono", ui-monospace, Menlo, Consolas, monospace';

/** Mounts an xterm.js terminal into the returned ref and keeps it fitted to its container. */
export function useXterm(opts: { onResize?: (cols: number, rows: number) => void } = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [term, setTerm] = useState<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onResizeRef = useRef(opts.onResize);
  onResizeRef.current = opts.onResize;
  const mode = useTheme((s) => s.mode);
  const appliedMode = useRef<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const t = new Terminal({
      fontFamily: FONT,
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
      convertEol: false,
      scrollback: 5000,
      theme: XTERM_THEMES[(appliedMode.current = useTheme.getState().mode)],
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(el);
    fitRef.current = fit;
    let disposed = false;
    const doFit = () => {
      if (disposed || !el.offsetWidth || !el.offsetHeight) return;
      try {
        fit.fit();
      } catch {
        /* not visible yet */
      }
    };
    doFit();
    // Re-measure cells once the self-hosted mono face has loaded.
    void document.fonts?.load(`13px ${FONT}`).then(() => {
      if (disposed) return;
      doFit();
    });
    const sub = t.onResize(({ cols, rows }) => onResizeRef.current?.(cols, rows));
    const ro = new ResizeObserver(() => doFit());
    ro.observe(el);
    setTerm(t);
    return () => {
      disposed = true;
      ro.disconnect();
      sub.dispose();
      t.dispose();
      fitRef.current = null;
      setTerm(null);
    };
  }, []);

  // Daylight/dusk switch: only touch the renderer when the theme actually changed.
  useEffect(() => {
    if (!term || appliedMode.current === mode) return;
    appliedMode.current = mode;
    term.options.theme = XTERM_THEMES[mode];
  }, [term, mode]);

  const fit = () => {
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
  };

  return { containerRef, term, fit };
}
