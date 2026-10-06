import { Code2, X } from "lucide-react";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { CodeEditor } from "@/components/workspace/CodeEditor";
import { cn } from "@/lib/utils";
import { canEdit, useWorkspace } from "@/stores/workspace";

export function EditorArea() {
  const repl = useWorkspace((s) => s.repl)!;
  const openTabs = useWorkspace((s) => s.openTabs);
  const activePath = useWorkspace((s) => s.activePath);
  const fsEpoch = useWorkspace((s) => s.fsEpoch);
  const { openFile, closeFile } = useWorkspace.getState();

  return (
    <div className="flex h-full flex-col bg-[#1e1e1e]">
      <ScrollArea className="shrink-0 border-b bg-card">
        <div className="flex h-9">
          {openTabs.map((p) => {
            const name = p.split("/").pop();
            return (
              <div
                key={p}
                title={p}
                onClick={() => openFile(p)}
                onAuxClick={(e) => e.button === 1 && closeFile(p)}
                className={cn(
                  "group flex cursor-pointer items-center gap-2 border-r px-3 text-sm whitespace-nowrap",
                  p === activePath
                    ? "border-t-2 border-t-primary bg-[#1e1e1e] text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {name}
                <button
                  className="rounded p-0.5 opacity-60 hover:bg-accent hover:opacity-100"
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
          <CodeEditor key={`${activePath}#${fsEpoch}`} replId={repl.id} path={activePath} readOnly={!canEdit(repl)} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Code2 className="size-10 opacity-30" />
            Open a file from the sidebar to start editing.
          </div>
        )}
      </div>
    </div>
  );
}
