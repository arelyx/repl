import { useMemo, useState } from "react";
import { AlertTriangle, CircleX, Info, Lightbulb, Loader2, RotateCw, Sparkles, ZapOff } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { languageForPath } from "@/lib/languages";
import { pathToUri, serverForPath, SERVERS, useLspStore } from "@/lib/lsp";
import type { Diagnostic } from "@/lib/lsp/protocol";
import { toRange } from "@/lib/lsp/convert";
import { cn } from "@/lib/utils";

const prettyLanguage = (path: string) => {
  const id = languageForPath(path);
  if (id === "plaintext") return "plain text";
  return id.charAt(0).toUpperCase() + id.slice(1);
};

function SeverityIcon({ severity, className }: { severity: Diagnostic["severity"]; className?: string }) {
  if (severity === 2) return <AlertTriangle className={cn("size-3.5 text-warn", className)} />;
  if (severity === 3) return <Info className={cn("size-3.5 text-primary", className)} />;
  if (severity === 4) return <Lightbulb className={cn("size-3.5 text-muted-foreground", className)} />;
  return <CircleX className={cn("size-3.5 text-destructive", className)} />;
}

/** The strip under the editor: language-server state and the Problems list. */
export function LspStatusBar({ path, readOnly }: { path: string | null; readOnly: boolean }) {
  const manager = useLspStore((s) => s.manager);
  const statuses = useLspStore((s) => s.statuses);
  const diagnostics = useLspStore((s) => s.diagnostics);
  const [open, setOpen] = useState(false);

  const route = path ? serverForPath(path) : null;
  const status = route ? statuses[route.server] : undefined;
  const label = route ? (SERVERS[route.server]?.label ?? route.server) : "";

  const current = path ? diagnostics[pathToUri(path)]?.items ?? [] : [];
  const errors = current.filter((d) => (d.severity ?? 1) === 1).length;
  const warnings = current.filter((d) => d.severity === 2).length;

  const files = useMemo(
    () =>
      Object.values(diagnostics)
        .map((f) => ({
          ...f,
          items: [...f.items].sort(
            (a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line,
          ),
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    [diagnostics],
  );
  const total = files.reduce((n, f) => n + f.items.length, 0);

  if (!path) return null;

  let state: React.ReactNode;
  if (readOnly || !manager) {
    state = (
      <span className="flex items-center gap-1.5">
        <ZapOff className="size-3" /> Read-only, no intellisense
      </span>
    );
  } else if (!route) {
    state = (
      <span className="flex items-center gap-1.5">
        <ZapOff className="size-3" /> No intellisense for {prettyLanguage(path)}
      </span>
    );
  } else if (!status || status.state === "connecting" || status.state === "initializing") {
    state = (
      <span className="flex items-center gap-1.5">
        <Loader2 className="size-3 animate-spin" /> Starting {label}…
      </span>
    );
  } else if (status.state === "idle") {
    state = (
      <span className="flex items-center gap-1.5">
        <Loader2 className="size-3 animate-spin" /> {label}: waiting for the container
      </span>
    );
  } else if (status.state === "reconnecting") {
    state = (
      <span className="flex items-center gap-1.5">
        <Loader2 className="size-3 animate-spin" /> Reconnecting to {label}…
      </span>
    );
  } else if (status.state === "unavailable") {
    state = (
      <span className="flex items-center gap-1.5" title={status.message ?? undefined}>
        <ZapOff className="size-3" /> No intellisense for {label}
        {status.message && status.message !== "not installed" && (
          <button
            className="ml-1 flex items-center gap-1 rounded px-1 hover:bg-accent hover:text-foreground"
            onClick={() => manager.retry(route.server)}
          >
            <RotateCw className="size-3" /> retry
          </button>
        )}
      </span>
    );
  } else if (status.state === "ready" && status.busy) {
    state = (
      <span className="flex min-w-0 items-center gap-1.5" title={status.message ?? undefined}>
        <Loader2 className="size-3 shrink-0 animate-spin" />
        <span className="truncate">
          {label}: {status.message}
        </span>
      </span>
    );
  } else if (status.state === "ready") {
    state = (
      <span className="flex items-center gap-1.5">
        <Sparkles className="size-3 text-live" /> {label}
      </span>
    );
  }

  return (
    <div className="flex h-8 shrink-0 items-center justify-between gap-3 bg-card px-4 text-xs text-muted-foreground">
      <div className="min-w-0" data-testid="lsp-status" data-state={status?.state ?? (route ? "none" : "unsupported")}>
        {state}
      </div>
      {manager && !readOnly && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              className="flex shrink-0 items-center gap-2 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
              title={`${total} problem${total === 1 ? "" : "s"} in open files`}
              data-testid="lsp-problems"
            >
              <span className="flex items-center gap-1">
                <CircleX className={cn("size-3", errors ? "text-destructive" : "")} aria-hidden /> {errors}
              </span>
              <span className="flex items-center gap-1">
                <AlertTriangle className={cn("size-3", warnings ? "text-warn" : "")} aria-hidden /> {warnings}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" side="top" className="w-[min(36rem,90vw)] p-0">
            <div className="border-b px-3 py-2 text-xs font-medium">
              Problems <span className="text-muted-foreground">({total})</span>
            </div>
            {total === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">No problems in open files.</div>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                <div className="py-1">
                  {files.map((f) => (
                    <div key={f.uri}>
                      <div className="sticky top-0 bg-popover px-3 py-1 text-xs font-medium text-foreground">
                        {f.path} <span className="text-muted-foreground">({f.items.length})</span>
                      </div>
                      {f.items.map((d, i) => (
                        <button
                          key={i}
                          className="flex w-full items-start gap-2 px-3 py-1 text-left text-xs hover:bg-accent"
                          onClick={() => {
                            setOpen(false);
                            manager.reveal(f.uri, toRange(d.range));
                          }}
                        >
                          <SeverityIcon severity={d.severity} className="mt-0.5 shrink-0" />
                          <span className="min-w-0 flex-1 break-words">
                            {d.message}
                            {(d.source || d.code !== undefined) && (
                              <span className="ml-1 text-muted-foreground">
                                {d.source}
                                {d.code !== undefined ? `(${d.code})` : ""}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 text-muted-foreground">
                            [{d.range.start.line + 1}, {d.range.start.character + 1}]
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
