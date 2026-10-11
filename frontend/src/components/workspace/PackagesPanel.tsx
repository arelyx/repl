import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2, Package, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentSocket, type SocketState } from "@/lib/agentSocket";
import { wsBase } from "@/lib/api";
import { getActiveManager } from "@/lib/lsp/manager";
import { cn } from "@/lib/utils";
import { canEdit, useWorkspace } from "@/stores/workspace";

/** One package manager the agent offers for this repl (runner/agent/packager.py). */
interface PkgManager {
  id: string;
  label: string;
  tool: string;
  registry: string;
  manifest: string | null;
  nameHint: string;
  versioned: boolean;
  note: string | null;
  packages: InstalledPkg[];
}

interface InstalledPkg {
  name: string;
  spec: string;
  version: string | null;
  declared: boolean;
  dev?: boolean;
}

interface SearchHit {
  name: string;
  version: string | null;
  description: string | null;
  downloads?: number | null;
  url?: string | null;
}

interface Busy {
  op: "add" | "remove";
  manager: string;
  name: string;
}

// Tool output is written for a terminal: drop colour codes and keep only what
// a carriage return leaves on each line (progress bars).
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[=>]/g;
function plainLog(raw: string): string {
  return raw
    .replace(ANSI, "")
    .split("\n")
    .map((line) => {
      const parts = line.replace(/\r+$/, "").split("\r");
      return parts[parts.length - 1];
    })
    .join("\n");
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** `name@1.2.3` (or `name==1.2.3`) typed in the search box → name and version. */
function parseSpec(text: string, versioned: boolean): { name: string; version: string } {
  const t = text.trim();
  if (!versioned) return { name: t, version: "" };
  const eq = t.indexOf("==");
  if (eq > 0) return { name: t.slice(0, eq).trim(), version: t.slice(eq + 2).trim() };
  const at = t.lastIndexOf("@");
  if (at > 0) return { name: t.slice(0, at).trim(), version: t.slice(at + 1).trim() };
  return { name: t, version: "" };
}

export function PackagesPanel({ active }: { active: boolean }) {
  const repl = useWorkspace((s) => s.repl)!;
  const container = useWorkspace((s) => s.container);
  const editable = canEdit(repl);
  const sockRef = useRef<AgentSocket | null>(null);
  const [sockState, setSockState] = useState<SocketState>("closed");
  const [managers, setManagers] = useState<PkgManager[] | null>(null);
  const [available, setAvailable] = useState<{ id: string; label: string }[]>([]);
  const [guessImports, setGuessImports] = useState(true);
  const [managerId, setManagerId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [log, setLog] = useState("");
  const [logOpen, setLogOpen] = useState(false);
  const searchSeq = useRef(0);
  const logRef = useRef<HTMLPreElement>(null);

  const live = active && editable && container === "running";

  useEffect(() => {
    if (!live) return;
    const sock = new AgentSocket(`${wsBase()}/ws/repls/${repl.id}/pkg`, {
      onState: (s) => {
        setSockState(s);
        if (s === "open") sock.send({ type: "info" });
      },
      onMessage: (msg) => {
        switch (msg.type) {
          case "info": {
            const m = msg as unknown as { managers: PkgManager[]; available: { id: string; label: string }[]; guessImports: boolean; busy: Busy | null };
            setManagers(m.managers ?? []);
            setAvailable(m.available ?? []);
            setGuessImports(m.guessImports !== false);
            setBusy(m.busy ?? null);
            break;
          }
          case "results": {
            const r = msg as unknown as { id: number; items: SearchHit[]; error?: string };
            if (r.id !== searchSeq.current) return; // a newer query is in flight
            setHits(r.items ?? []);
            setSearchError(r.error ?? null);
            setSearching(false);
            break;
          }
          case "busy": {
            const b = msg as unknown as { busy: Busy; log?: string };
            setBusy(b.busy);
            setLog(b.log ?? "");
            setLogOpen(true);
            break;
          }
          case "log":
            setLog((l) => (l + String(msg.data ?? "")).slice(-200_000));
            break;
          case "done": {
            const d = msg as unknown as Busy & { ok: boolean };
            setBusy(null);
            if (d.ok) {
              toast.success(d.op === "add" ? `Installed ${d.name}` : `Removed ${d.name}`);
              // The manifest may be new or changed, and language servers
              // only see new packages after a restart.
              void useWorkspace.getState().loadFiles();
              getActiveManager()?.restartAll();
            } else {
              toast.error(d.op === "add" ? `Couldn't install ${d.name}` : `Couldn't remove ${d.name}`, {
                description: "See the log in the Packages panel.",
              });
              setLogOpen(true);
            }
            break;
          }
          case "error":
            toast.error(String(msg.message ?? "Package operation failed"));
            break;
        }
      },
    });
    sockRef.current = sock;
    return () => {
      sock.dispose();
      sockRef.current = null;
    };
  }, [live, repl.id]);

  // Default to the repl's main language; keep a choice the user made.
  useEffect(() => {
    if (!managers) return;
    if (managerId && (managers.some((m) => m.id === managerId) || available.some((a) => a.id === managerId))) return;
    setManagerId(managers[0]?.id ?? available[0]?.id ?? null);
  }, [managers, available, managerId]);

  const manager = useMemo<PkgManager | null>(() => {
    if (!managerId) return null;
    const found = managers?.find((m) => m.id === managerId);
    if (found) return found;
    const a = available.find((x) => x.id === managerId);
    return a
      ? { id: a.id, label: a.label, tool: "", registry: "", manifest: null, nameHint: "package name", versioned: true, note: null, packages: [] }
      : null;
  }, [managerId, managers, available]);

  // Debounced registry search.
  useEffect(() => {
    const text = query.trim();
    if (!manager || !text || sockState !== "open") {
      setHits(null);
      setSearching(false);
      setSearchError(null);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      const id = ++searchSeq.current;
      sockRef.current?.send({ type: "search", id, manager: manager.id, query: parseSpec(text, manager.versioned).name });
    }, 350);
    return () => clearTimeout(t);
  }, [query, manager, sockState]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, logOpen]);

  const change = useCallback(
    (op: "add" | "remove", name: string, version = "") => {
      if (!manager || busy) return;
      const ok = sockRef.current?.send({ type: op, manager: manager.id, name, version });
      if (!ok) {
        toast.error("Not connected to the repl");
        return;
      }
      setLog("");
      setLogOpen(true);
      setBusy({ op, manager: manager.id, name });
    },
    [manager, busy],
  );

  const installTyped = () => {
    if (!manager || !query.trim()) return;
    const { name, version } = parseSpec(query, manager.versioned);
    if (name) change("add", name, version);
  };

  const installed = manager?.packages ?? [];
  const installedNames = useMemo(() => new Set(installed.map((p) => p.name.toLowerCase())), [installed]);
  const otherManagers = available.filter((a) => !managers?.some((m) => m.id === a.id));

  let body: React.ReactNode;
  if (!editable) {
    body = <Hint>Only editors can manage packages. Fork this repl to get your own.</Hint>;
  } else if (container !== "running") {
    body = <Hint>Start the container to manage packages.</Hint>;
  } else if (!managers) {
    body = (
      <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> {sockState === "open" ? "Reading packages…" : "Connecting…"}
      </div>
    );
  } else if (!manager) {
    body = <Hint>No package manager applies to this repl.</Hint>;
  } else {
    body = (
      <div className="space-y-4 p-3">
        <div className="space-y-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") installTyped();
                if (e.key === "Escape") setQuery("");
              }}
              placeholder={`Search ${manager.registry || "packages"}`}
              aria-label={`Search ${manager.registry || "packages"}`}
              className="h-7 pr-7 pl-7 text-xs"
            />
            {query && (
              <button
                className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setQuery("")}
                aria-label="Clear search"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          {query.trim() && (
            <p className="text-[11px] text-muted-foreground">
              Enter installs <span className="font-mono text-foreground">{query.trim()}</span>
              {manager.versioned && !/[@=]/.test(query.slice(1)) && <> (add <span className="font-mono">@version</span> to pin one)</>}
            </p>
          )}
        </div>

        {query.trim() ? (
          <section className="space-y-1" aria-label="Search results">
            {searching && !hits ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> Searching {manager.registry}…
              </div>
            ) : searchError ? (
              <p className="text-xs text-fault">{searchError}</p>
            ) : hits && hits.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nothing found. Enter installs the name as typed ({manager.nameHint}).
              </p>
            ) : (
              <ul className={cn("space-y-1", searching && "opacity-60")}>
                {hits?.map((h) => {
                  const have = installedNames.has(h.name.toLowerCase());
                  return (
                    <li key={h.name} className="group rounded border border-transparent p-1.5 hover:border-border hover:bg-accent/50">
                      <div className="flex items-start gap-1.5">
                        {/* Names often differ only at the end (requests-oauthlib, requests-toolbelt): wrap, don't truncate. */}
                        <span className="min-w-0 font-mono text-xs font-medium break-all text-foreground">{h.name}</span>
                        {h.url && (
                          <a
                            href={h.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            aria-label={`${h.name} on ${manager.registry}`}
                          >
                            <ExternalLink className="size-3" />
                          </a>
                        )}
                        <Button
                          size="xs"
                          variant={have ? "ghost" : "outline"}
                          className="ml-auto shrink-0"
                          disabled={!!busy || have}
                          onClick={() => change("add", h.name)}
                        >
                          {busy?.name === h.name ? <Loader2 className="animate-spin" /> : have ? null : <Plus />}
                          {have ? "Installed" : "Install"}
                        </Button>
                      </div>
                      {(h.description || h.downloads || h.version) && (
                        <div className="flex gap-2 text-[11px] text-muted-foreground">
                          <span className="line-clamp-2">
                            {h.version && <span className="font-mono">{h.version}</span>}
                            {h.version && h.description && " · "}
                            {h.description}
                          </span>
                          {h.downloads ? (
                            <span className="ml-auto shrink-0 tabular" title="Downloads">
                              {compact.format(h.downloads)}↓
                            </span>
                          ) : null}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}

        <section className="space-y-1.5" aria-label="Installed packages">
          <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span>
              Installed <span className="tabular">{installed.length}</span>
            </span>
            {manager.manifest && (
              <button
                className="truncate font-mono text-[11px] text-primary hover:underline"
                onClick={() => manager.manifest && !manager.manifest.includes("*") && useWorkspace.getState().openFile(manager.manifest)}
                title={`Open ${manager.manifest}`}
              >
                {manager.manifest}
              </button>
            )}
          </div>
          {installed.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              None yet. Search above, or import a package in your code and press Run.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {installed.map((p) => (
                <li key={`${p.name}:${p.dev ? "dev" : ""}`} className="group flex items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-accent">
                  <Package className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono">{p.name}</span>
                  {p.dev && <Badge variant="outline" className="h-4 px-1 text-[10px]">dev</Badge>}
                  {!p.declared && (
                    <Badge variant="outline" className="h-4 px-1 text-[10px]" title={`Installed in the shell; not listed in ${manager.manifest}`}>
                      unlisted
                    </Badge>
                  )}
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground" title={p.spec ? `wants ${p.spec}` : undefined}>
                    {p.version ?? (p.spec || "not installed")}
                  </span>
                  <button
                    className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-fault focus-visible:opacity-100 disabled:opacity-30"
                    disabled={!!busy}
                    onClick={() => change("remove", p.name)}
                    aria-label={`Remove ${p.name}`}
                    title={`Remove ${p.name}`}
                  >
                    {busy?.op === "remove" && busy.name === p.name ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {manager.note && <p className="text-[11px] text-muted-foreground">{manager.note}</p>}
        </section>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {guessImports
            ? "Run installs what the manifest lists and what your code imports. "
            : "Run installs what the manifest lists. "}
          Packages live in <span className="font-mono">.repl/</span> and stay installed when the repl restarts.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 px-2">
        <span className="mr-auto text-xs font-semibold text-foreground">Packages</span>
        {managers && manager && (
          <Select value={manager.id} onValueChange={setManagerId}>
            <SelectTrigger size="sm" className="h-6 max-w-36 gap-1 px-2 text-xs" aria-label="Package manager">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                {managers.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-xs">
                    {m.label}
                    <span className="text-muted-foreground">{m.tool}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
              {otherManagers.length > 0 && (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel className="text-[11px]">Other languages</SelectLabel>
                    {otherManagers.map((m) => (
                      <SelectItem key={m.id} value={m.id} className="text-xs">
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </>
              )}
            </SelectContent>
          </Select>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          title="Refresh"
          disabled={sockState !== "open"}
          onClick={() => sockRef.current?.send({ type: "info" })}
        >
          <RefreshCw />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">{body}</ScrollArea>
      {(busy || log) && (
        <div className="shrink-0 border-t">
          <button
            className="flex h-7 w-full items-center gap-1.5 px-2 text-left text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setLogOpen((o) => !o)}
            aria-expanded={logOpen}
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            <span className="truncate">
              {busy ? `${busy.op === "add" ? "Installing" : "Removing"} ${busy.name}…` : "Last package log"}
            </span>
            <span className="ml-auto">{logOpen ? "Hide" : "Show"}</span>
          </button>
          {logOpen && (
            <pre
              ref={logRef}
              className="max-h-56 overflow-auto bg-background px-2 py-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap text-muted-foreground"
            >
              {plainLog(log) || "Waiting for output…"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="p-3 text-xs text-muted-foreground">{children}</p>;
}
