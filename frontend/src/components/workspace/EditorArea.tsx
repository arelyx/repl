import { Fragment, useEffect } from "react";
import { ChevronRight, X } from "lucide-react";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Kbd } from "@/components/Kbd";
import { CodeEditor } from "@/components/workspace/CodeEditor";
import { LspManager, setActiveManager, useLspStore } from "@/lib/lsp";
import { cn } from "@/lib/utils";
import { usePalette } from "@/stores/palette";
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

  const crumbs = activePath ? activePath.split("/") : [];

  return (
    <div className="flex h-full flex-col bg-background">
      <ScrollArea className="shrink-0 border-b bg-card">
        <div className="flex h-8" role="tablist" aria-label="Open files">
          {openTabs.map((p) => {
            const name = p.split("/").pop();
            const active = p === activePath;
            return (
              <div
                key={p}
                title={p}
                onAuxClick={(e) => e.button === 1 && closeFile(p)}
                className={cn(
                  "group relative flex items-center border-r text-sm whitespace-nowrap",
                  active
                    ? "bg-background text-foreground before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-lang"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <button
                  role="tab"
                  aria-selected={active}
                  className="h-full pr-1 pl-3 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  onClick={() => openFile(p)}
                >
                  {name}
                </button>
                <button
                  className={cn(
                    "mr-1.5 rounded-sm p-0.5 hover:bg-accent hover:text-foreground focus-visible:opacity-100",
                    active ? "opacity-70" : "opacity-0 group-hover:opacity-70 pointer-coarse:opacity-70",
                  )}
                  onClick={() => closeFile(p)}
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
      {activePath && (
        <nav
          aria-label="Breadcrumb"
          className="flex h-6 shrink-0 items-center gap-0.5 overflow-hidden px-3 text-xs whitespace-nowrap text-muted-foreground"
        >
          <span className="truncate">{repl.name}</span>
          {crumbs.map((c, i) => (
            <Fragment key={i}>
              <ChevronRight className="size-3 shrink-0 opacity-60" />
              <span className={cn("truncate", i === crumbs.length - 1 && "text-foreground")}>{c}</span>
            </Fragment>
          ))}
        </nav>
      )}
      <div className="min-h-0 flex-1">
        {activePath ? (
          <CodeEditor key={`${activePath}#${fsEpoch}`} replId={repl.id} path={activePath} readOnly={!editable} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
            <p>No file open.</p>
            <button
              className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-foreground hover:bg-accent"
              onClick={() => usePalette.getState().show("files")}
            >
              Go to file <Kbd keys={["mod", "P"]} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
