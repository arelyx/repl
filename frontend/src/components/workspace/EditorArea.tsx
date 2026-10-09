import { useEffect } from "react";
import { Code2, X } from "lucide-react";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { CodeEditor } from "@/components/workspace/CodeEditor";
import { LspStatusBar } from "@/components/workspace/LspStatusBar";
import { LspManager, setActiveManager, useLspStore } from "@/lib/lsp";
import { cn } from "@/lib/utils";
import { canEdit, useWorkspace } from "@/stores/workspace";

export function EditorArea() {
  const repl = useWorkspace((s) => s.repl)!;
  const openTabs = useWorkspace((s) => s.openTabs);
  const activePath = useWorkspace((s) => s.activePath);
  const fsEpoch = useWorkspace((s) => s.fsEpoch);
  const container = useWorkspace((s) => s.container);
  const { openFile, closeFile } = useWorkspace.getState();
  const editable = canEdit(repl);
  const manager = useLspStore((s) => s.manager);

  // One language-server manager per repl for editors; viewers get none (the
  // bridge requires the editor role). Servers start lazily per language.
  useEffect(() => {
    if (!editable) return;
    const m = new LspManager(repl.id);
    setActiveManager(m);
    return () => {
      setActiveManager(null);
      void m.dispose();
    };
  }, [repl.id, editable]);

  useEffect(() => {
    manager?.setContainerRunning(container === "running");
  }, [manager, container]);

  useEffect(() => {
    manager?.syncOpenTabs(openTabs);
  }, [manager, openTabs]);

  return (
    <div className="flex h-full flex-col bg-editor">
      <ScrollArea className="shrink-0 bg-card">
        <div className="flex h-11 items-center gap-1 px-2">
          {openTabs.map((p) => {
            const name = p.split("/").pop();
            return (
              <div
                key={p}
                title={p}
                onClick={() => openFile(p)}
                onAuxClick={(e) => e.button === 1 && closeFile(p)}
                className={cn(
                  "group flex h-8 cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-2.5 text-[13px] whitespace-nowrap",
                  p === activePath
                    ? "bg-mist font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {name}
                <button
                  className="rounded-sm p-1 opacity-60 hover:bg-background hover:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeFile(p);
                  }}
                  aria-label={`Close ${name}`}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
      <div className="min-h-0 flex-1">
        {activePath ? (
          <CodeEditor key={`${activePath}#${fsEpoch}`} replId={repl.id} path={activePath} readOnly={!editable} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
            <Code2 className="size-8 opacity-40" aria-hidden />
            <p className="max-w-[28ch]">Open a file from Files to start editing.</p>
          </div>
        )}
      </div>
      <LspStatusBar path={activePath} readOnly={!editable} />
    </div>
  );
}
