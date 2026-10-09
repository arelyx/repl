import { useEffect, useRef, useState } from "react";
import { ExternalLink, Globe, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { replsApi } from "@/lib/repls";
import { useWorkspace } from "@/stores/workspace";

/** Web preview: polls the container's listening ports and shows one in an iframe. */
export function WebviewPane() {
  const repl = useWorkspace((s) => s.repl)!;
  const container = useWorkspace((s) => s.container);
  const [ports, setPorts] = useState<number[]>([]);
  const [base, setBase] = useState<string | null>(null);
  const [port, setPort] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const seen = useRef<Set<number>>(new Set());
  const autoSwitched = useRef(false);

  useEffect(() => {
    if (container !== "running") {
      setPorts([]);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await replsApi.ports(repl.id);
        if (cancelled) return;
        setBase(res.preview_base);
        const list = [...res.ports].sort((a, b) => a - b);
        setPorts(list);
        const fresh = list.filter((p) => !seen.current.has(p));
        fresh.forEach((p) => seen.current.add(p));
        if (fresh.length > 0) {
          const preferred = repl.config?.port && fresh.includes(repl.config.port) ? repl.config.port : fresh[0]!;
          setPort((cur) => (cur && list.includes(cur) ? cur : preferred));
          if (!autoSwitched.current) {
            autoSwitched.current = true;
            useWorkspace.getState().setToolTab("webview");
          }
        }
        setPort((cur) => (cur && !list.includes(cur) ? (list[0] ?? null) : cur));
      } catch {
        /* container may be restarting */
      }
    };
    void poll();
    const t = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [repl.id, repl.config?.port, container]);

  const url = base && port ? base.replace("{port}", String(port)) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b bg-card px-1.5">
        <Button variant="ghost" size="icon-xs" title="Reload" disabled={!url} onClick={() => setNonce((n) => n + 1)}>
          <RotateCw />
        </Button>
        <div className="flex h-5 min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-background px-2 font-mono text-xs text-muted-foreground">
          <Globe className="size-3 shrink-0" />
          <span className="truncate">{url ?? "No web server"}</span>
        </div>
        {ports.length > 0 && (
          <Select value={port ? String(port) : undefined} onValueChange={(v) => setPort(Number(v))}>
            <SelectTrigger size="sm" className="h-6 w-24 text-xs">
              <SelectValue placeholder="Port" />
            </SelectTrigger>
            <SelectContent>
              {ports.map((p) => (
                <SelectItem key={p} value={String(p)}>
                  :{p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button variant="ghost" size="icon-xs" title="Open in new tab" disabled={!url} asChild={!!url}>
          {url ? (
            <a href={url} target="_blank" rel="noreferrer">
              <ExternalLink />
            </a>
          ) : (
            <ExternalLink />
          )}
        </Button>
      </div>
      {url ? (
        <iframe
          key={`${url}#${nonce}`}
          src={url}
          title="Webview"
          className="min-h-0 flex-1 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
          <Globe className="size-8 opacity-40" />
          No web server yet. Start one (Run does it for web templates) and it opens here.
        </div>
      )}
    </div>
  );
}
