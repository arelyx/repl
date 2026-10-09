import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { MonacoBinding } from "y-monaco";
import { FileQuestion, Loader2, Users, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { myColor, openCollab, type CollabSession } from "@/lib/collab";
import { imageMime, languageForPath } from "@/lib/languages";
import { pathToUri, useLspStore } from "@/lib/lsp";
import { replsApi } from "@/lib/repls";
import { useAuthStore } from "@/stores/auth";
import { useTheme } from "@/stores/theme";
import { MONACO_THEME } from "@/lib/fjordThemes";

type Phase = "loading" | "connecting" | "collab" | "rest" | "binary" | "error";
type SaveState = "saved" | "dirty" | "saving" | "error";

const COLLAB_TIMEOUT_MS = 3000;
const SAVE_DEBOUNCE_MS = 800;

/**
 * Editor for one file. Prefers live collaboration over Hocuspocus (Y.Text "content"
 * bound with y-monaco); if the room isn't synced within 3s, or the socket drops,
 * falls back to REST load/save (debounced, plus Ctrl+S).
 */
export function CodeEditor({ replId, path, readOnly }: { replId: string; path: string; readOnly: boolean }) {
  const user = useAuthStore((s) => s.user);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [binary, setBinary] = useState<{ content: string } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [peers, setPeers] = useState(0);
  const [mounted, setMounted] = useState(false);
  const lsp = useLspStore((s) => s.manager);
  const themeMode = useTheme((s) => s.mode);

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const collabRef = useRef<CollabSession | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);
  const restContentRef = useRef<string>("");
  const phaseRef = useRef<Phase>("loading");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyingRef = useRef(false);

  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const save = useCallback(
    async (silent = true) => {
      if (readOnly) return;
      const ed = editorRef.current;
      if (!ed) return;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const content = ed.getValue();
      setSaveState("saving");
      try {
        await replsApi.writeFile(replId, path, content);
        setSaveState("saved");
        useLspStore.getState().manager?.didSave(path);
        if (!silent) toast.success(`Saved ${path}`, { duration: 1200 });
      } catch (e) {
        setSaveState("error");
        toast.error(`Save failed: ${errorMessage(e)}`);
      }
    },
    [replId, path, readOnly],
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  /** Put the editor into REST mode with the given text (or keep its current text). */
  const enterRest = useCallback((text?: string) => {
    bindingRef.current?.destroy();
    bindingRef.current = null;
    collabRef.current?.destroy();
    collabRef.current = null;
    setPeers(0);
    const ed = editorRef.current;
    if (ed && text !== undefined && ed.getValue() !== text) {
      applyingRef.current = true;
      ed.setValue(text);
      applyingRef.current = false;
    }
    setPhaseBoth("rest");
  }, []);

  const tryBind = useCallback(() => {
    const ed = editorRef.current;
    const collab = collabRef.current;
    if (!ed || !collab || bindingRef.current || phaseRef.current !== "collab") return;
    const model = ed.getModel();
    if (!model) return;
    applyingRef.current = true;
    bindingRef.current = new MonacoBinding(collab.ytext, model, new Set([ed]), collab.provider.awareness ?? undefined);
    applyingRef.current = false;
  }, []);

  // Load the file, then try to join the collaboration room.
  useEffect(() => {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    setPhaseBoth("loading");

    (async () => {
      let file;
      try {
        file = await replsApi.readFile(replId, path);
      } catch (e) {
        if (!cancelled) {
          setError(errorMessage(e));
          setPhaseBoth("error");
        }
        return;
      }
      if (cancelled) return;
      if (file.encoding === "base64") {
        setBinary({ content: file.content });
        setPhaseBoth("binary");
        return;
      }
      restContentRef.current = file.content;
      setPhaseBoth("connecting");

      const name = user?.display_name || user?.username || "anonymous";
      const session = openCollab(replId, path, { name, color: myColor() }, {
        onSynced: () => {
          if (cancelled || collabRef.current !== session) return;
          if (timeout) clearTimeout(timeout);
          if (phaseRef.current === "connecting") {
            setPhaseBoth("collab");
            tryBind();
          }
        },
        onDisconnect: () => {
          if (cancelled || collabRef.current !== session) return;
          if (phaseRef.current === "collab") {
            toast.warning("Lost live collaboration; saving directly to disk.");
            enterRest();
            void saveRef.current();
          }
        },
        onAuthFailed: () => {
          if (cancelled || collabRef.current !== session) return;
          if (phaseRef.current === "connecting") enterRest(restContentRef.current);
        },
      });
      collabRef.current = session;
      session.provider.awareness?.on("change", () => {
        setPeers(Math.max(0, (session.provider.awareness?.getStates().size ?? 1) - 1));
      });
      timeout = setTimeout(() => {
        if (!cancelled && phaseRef.current === "connecting") enterRest(restContentRef.current);
      }, COLLAB_TIMEOUT_MS);
    })();

    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      bindingRef.current?.destroy();
      bindingRef.current = null;
      collabRef.current?.destroy();
      collabRef.current = null;
    };
  }, [replId, path, user, tryBind, enterRest]);

  const onMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;
    if (phaseRef.current === "rest") {
      ed.setValue(restContentRef.current);
    } else {
      tryBind();
    }
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current(false));
    ed.focus();
    setMounted(true);
  };

  // When we fall back to REST before the editor mounted its content, seed it.
  useEffect(() => {
    if (phase === "rest" && editorRef.current && editorRef.current.getValue() === "" && restContentRef.current) {
      applyingRef.current = true;
      editorRef.current.setValue(restContentRef.current);
      applyingRef.current = false;
    }
    if (phase === "collab") tryBind();
  }, [phase, tryBind]);

  // Language server: register the document once the model holds the real text
  // (after the Yjs binding or the REST load). Viewers never connect.
  useEffect(() => {
    if (!lsp || readOnly || !mounted || (phase !== "collab" && phase !== "rest")) return;
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model || (phase === "collab" && !bindingRef.current)) return;
    const sub = lsp.attach(ed, model, path);
    return () => sub.dispose();
  }, [lsp, readOnly, mounted, phase, path]);

  const onChange = () => {
    if (applyingRef.current || readOnly || phaseRef.current !== "rest") return;
    setSaveState("dirty");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveRef.current(), SAVE_DEBOUNCE_MS);
  };

  if (phase === "loading") {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading {path}…
      </div>
    );
  }
  if (phase === "error") {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        Couldn't open {path}: {error}
      </div>
    );
  }
  if (phase === "binary" && binary) {
    const mime = imageMime(path);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto p-6 text-sm text-muted-foreground">
        {mime ? (
          <img
            src={`data:${mime};base64,${binary.content}`}
            alt={path}
            className="max-h-[80%] max-w-full rounded border bg-[repeating-conic-gradient(var(--mist)_0%_25%,var(--card)_0%_50%)] bg-[length:16px_16px]"
          />
        ) : (
          <>
            <FileQuestion className="size-10 opacity-50" />
            <span>{path} is a binary file and can't be displayed.</span>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="pointer-events-none absolute right-5 bottom-3 z-10 flex items-center gap-1.5 rounded-full bg-card/90 px-2.5 py-0.5 text-xs text-muted-foreground">
        {phase === "connecting" && (
          <>
            <Loader2 className="size-3 animate-spin" aria-hidden /> Connecting
          </>
        )}
        {phase === "collab" && (
          <>
            <Users className="size-3 text-live" aria-hidden /> {peers > 0 ? `Live with ${peers} other${peers === 1 ? "" : "s"}` : "Live"}
          </>
        )}
        {phase === "rest" && (
          <>
            <WifiOff className="size-3" aria-hidden /> Not live:{" "}
            {readOnly ? "read-only" : saveState === "saving" ? "saving…" : saveState === "dirty" ? "unsaved changes" : saveState === "error" ? "save failed" : "saved to disk"}
          </>
        )}
        {readOnly && phase !== "rest" && <span>, read-only</span>}
      </div>
      <Editor
        height="100%"
        theme={MONACO_THEME[themeMode]}
        language={languageForPath(path)}
        path={pathToUri(path)}
        defaultValue=""
        onMount={onMount}
        onChange={onChange}
        options={{
          readOnly: readOnly || phase === "connecting",
          fontSize: 14,
          fontFamily: '"Fragment Mono", ui-monospace, Menlo, monospace',
          lineHeight: 22,
          fontLigatures: false,
          renderLineHighlight: "line",
          lineNumbersMinChars: 3,
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
          overviewRulerBorder: false,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          minimap: { enabled: false },
          automaticLayout: true,
          scrollBeyondLastLine: false,
          tabSize: 4,
          renderWhitespace: "selection",
          padding: { top: 12, bottom: 12 },
          formatOnType: true,
          fixedOverflowWidgets: true,
          suggest: { showStatusBar: true, preview: true },
        }}
      />
    </div>
  );
}
