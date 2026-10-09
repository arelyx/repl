import { useEffect, useState } from "react";
import { AlertTriangle, Circle, CircleDot, GitBranch, Loader2, Users, WifiOff } from "lucide-react";
import { keyLabel } from "@/components/Kbd";
import { LspStatusItem, ProblemsButton, statusItem } from "@/components/workspace/LspStatusBar";
import { langName } from "@/lib/langAccent";
import { languageForPath } from "@/lib/languages";
import { replsApi } from "@/lib/repls";
import { cn } from "@/lib/utils";
import { useEditorStatus } from "@/stores/editorStatus";
import { usePalette } from "@/stores/palette";
import { canEdit, useWorkspace } from "@/stores/workspace";

function ContainerItem({ onStart }: { onStart: () => void }) {
  const container = useWorkspace((s) => s.container);
  const running = useWorkspace((s) => s.runStatus?.running);
  const exitCode = useWorkspace((s) => s.runStatus?.exitCode);
  const editable = canEdit(useWorkspace((s) => s.repl));

  let icon = <Circle className="size-2.5" />;
  let label = "Checking container";
  if (container === "starting") {
    icon = <Loader2 className="size-3 animate-spin" />;
    label = "Starting container";
  } else if (container === "running") {
    icon = running ? <CircleDot className="size-3" /> : <Circle className="size-2.5 fill-current" />;
    label = running ? "Running" : exitCode != null ? `Exited ${exitCode}` : "Ready";
  } else if (container === "stopped" || container === "missing") {
    label = container === "stopped" ? "Container stopped" : "Container not started";
  } else if (container === "error") {
    icon = <AlertTriangle className="size-3" />;
    label = "Container error";
  }
  const canStart = editable && (container === "stopped" || container === "missing" || container === "error");
  return canStart ? (
    <button className={statusItem} onClick={onStart} title="Start the container">
      {icon} {label}
      <span className="underline underline-offset-2">Start</span>
    </button>
  ) : (
    <span className={cn(statusItem, "hover:bg-transparent")} aria-live="polite">
      {icon} {label}
    </span>
  );
}

function BranchItem({ onOpen }: { onOpen: () => void }) {
  const repl = useWorkspace((s) => s.repl)!;
  const fsEpoch = useWorkspace((s) => s.fsEpoch);
  const [git, setGit] = useState<{ branch: string; changes: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      replsApi
        .gitStatus(repl.id)
        .then((s) => !cancelled && setGit({ branch: s.branch, changes: s.changes.length }))
        .catch(() => {});
    void load();
    const t = setInterval(load, 20000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [repl.id, fsEpoch]);

  if (!git) return null;
  return (
    <button className={cn(statusItem, "max-md:hidden")} onClick={onOpen} title="Open version control">
      <GitBranch className="size-3" />
      {git.branch}
      {git.changes > 0 && <span className="tabular">{git.changes} changed</span>}
    </button>
  );
}

function EditorItems() {
  const phase = useEditorStatus((s) => s.phase);
  const saveState = useEditorStatus((s) => s.saveState);
  const peers = useEditorStatus((s) => s.peers);
  const line = useEditorStatus((s) => s.line);
  const column = useEditorStatus((s) => s.column);
  const selected = useEditorStatus((s) => s.selected);
  const path = useEditorStatus((s) => s.path);
  const readOnly = !canEdit(useWorkspace((s) => s.repl));
  if (!path || !phase || phase === "loading" || phase === "error" || phase === "binary") return null;

  let sync: React.ReactNode = null;
  if (phase === "connecting")
    sync = (
      <>
        <Loader2 className="size-3 animate-spin" /> Connecting
      </>
    );
  else if (phase === "collab")
    sync = (
      <>
        <Users className="size-3" /> {peers > 0 ? `Live with ${peers}` : "Live"}
      </>
    );
  else if (phase === "rest")
    sync = (
      <>
        <WifiOff className="size-3" />
        {readOnly
          ? "Read-only"
          : saveState === "saving"
            ? "Saving…"
            : saveState === "dirty"
              ? "Unsaved"
              : saveState === "error"
                ? "Save failed"
                : "Saved to disk"}
      </>
    );

  return (
    <>
      <span className={cn(statusItem, "hover:bg-transparent max-lg:hidden")} title="Collaboration and save state">
        {sync}
        {readOnly && phase !== "rest" && " (read-only)"}
      </span>
      <span className={cn(statusItem, "tabular hover:bg-transparent max-sm:hidden")}>
        Ln {line}, Col {column}
        {selected > 0 && ` (${selected} selected)`}
      </span>
      <span className={cn(statusItem, "hover:bg-transparent max-xl:hidden")}>{langName(languageForPath(path))}</span>
    </>
  );
}

/**
 * The language-colored bar under the workspace: repl language, container and run state,
 * branch, language server, collaboration, cursor and problems.
 */
export function StatusBar({ onStartContainer, onOpenGit }: { onStartContainer: () => void; onOpenGit: () => void }) {
  const repl = useWorkspace((s) => s.repl)!;
  const activePath = useWorkspace((s) => s.activePath);
  const readOnly = !canEdit(repl);
  const show = usePalette((s) => s.show);

  return (
    <footer
      className="lang-fill flex h-6 shrink-0 items-stretch overflow-hidden text-xs font-medium"
      aria-label="Status bar"
    >
      <button
        className={cn(statusItem, "bg-black/10 pr-2.5 font-bold")}
        onClick={() => show("commands")}
        title="Open the command palette"
      >
        {langName(repl.language)}
      </button>
      <ContainerItem onStart={onStartContainer} />
      <BranchItem onOpen={onOpenGit} />
      <div className="flex min-w-0 max-sm:hidden">
        <LspStatusItem path={activePath} readOnly={readOnly} />
      </div>
      <div className="ml-auto flex items-stretch">
        <EditorItems />
        <ProblemsButton path={activePath} readOnly={readOnly} />
        <button className={cn(statusItem, "max-md:hidden")} onClick={() => show("commands")}>
          {keyLabel("mod")} K
        </button>
      </div>
    </footer>
  );
}
