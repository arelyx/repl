import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Panel, Group, Separator } from "react-resizable-panels";
import { AlertTriangle, Files, GitBranch, Globe, Loader2, Monitor, SquareTerminal, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FullPageSpinner } from "@/components/AuthGuard";
import { TopBar } from "@/components/workspace/TopBar";
import { FileTree } from "@/components/workspace/FileTree";
import { GitPanel } from "@/components/workspace/GitPanel";
import { EditorArea } from "@/components/workspace/EditorArea";
import { ConsolePane } from "@/components/workspace/ConsolePane";
import { ShellPane } from "@/components/workspace/ShellPane";
import { WebviewPane } from "@/components/workspace/WebviewPane";
import { DisplayPane } from "@/components/workspace/DisplayPane";
import { ApiError, errorMessage } from "@/lib/api";
import { replsApi } from "@/lib/repls";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { canEdit, useWorkspace, type ToolTab } from "@/stores/workspace";

export function ReplPage() {
  const { id } = useParams<{ id: string }>();
  const authLoaded = useAuthStore((s) => s.isLoaded);
  if (!id) return null;
  if (!authLoaded) return <FullPageSpinner />;
  return <ReplLoader key={id} id={id} />;
}

function ReplLoader({ id }: { id: string }) {
  const repl = useWorkspace((s) => s.repl);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    replsApi
      .get(id)
      .then((r) => {
        if (cancelled) return;
        useWorkspace.getState().reset(r);
        document.title = `${r.name} - Replot`;
      })
      .catch((e) => {
        if (!cancelled) setError({ status: e instanceof ApiError ? e.status : 0, message: errorMessage(e) });
      });
    return () => {
      cancelled = true;
      document.title = "Replot";
    };
  }, [id]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 text-center">
        <AlertTriangle className="size-10 text-primary" />
        <div className="text-lg font-semibold">
          {error.status === 404 ? "Repl not found" : error.status === 401 || error.status === 403 ? "You don't have access to this repl" : "Couldn't open this repl"}
        </div>
        <p className="max-w-md text-sm text-muted-foreground">{error.message}</p>
        <div className="flex gap-2">
          {error.status === 401 && (
            <Button asChild>
              <Link to="/login" state={{ from: { pathname: `/repl/${id}` } }}>
                Log in
              </Link>
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link to="/dashboard">Back to dashboard</Link>
          </Button>
        </div>
      </div>
    );
  }
  if (!repl || repl.id !== id) return <FullPageSpinner label="Opening repl…" />;
  return <Workspace />;
}

function Workspace() {
  const repl = useWorkspace((s) => s.repl)!;
  const container = useWorkspace((s) => s.container);
  const containerError = useWorkspace((s) => s.containerError);
  const toolTab = useWorkspace((s) => s.toolTab);
  const setToolTab = useWorkspace((s) => s.setToolTab);
  const [sideTab, setSideTab] = useState<"files" | "git">("files");
  const [displayVisited, setDisplayVisited] = useState(toolTab === "display");
  const editable = canEdit(repl);

  const startContainer = useCallback(async () => {
    const ws = useWorkspace.getState();
    ws.setContainer("starting");
    try {
      const res = await replsApi.start(repl.id);
      ws.setContainer(res.status === "running" ? "running" : res.status);
    } catch (e) {
      ws.setContainer("error", errorMessage(e));
    }
  }, [repl.id]);

  // Start the container on open (editor+); viewers just observe its status.
  useEffect(() => {
    if (editable) void startContainer();
    else
      replsApi
        .status(repl.id)
        .then((s) => useWorkspace.getState().setContainer(s.status))
        .catch(() => useWorkspace.getState().setContainer("missing"));
  }, [repl.id, editable, startContainer]);

  // Keep the container state honest (idle reaper, other users stopping it).
  useEffect(() => {
    const t = setInterval(async () => {
      const ws = useWorkspace.getState();
      if (ws.container === "starting") return;
      try {
        const s = await replsApi.status(repl.id);
        if (useWorkspace.getState().container !== "starting") ws.setContainer(s.status);
      } catch {
        /* ignore transient errors */
      }
    }, 15000);
    return () => clearInterval(t);
  }, [repl.id]);

  // Open the entrypoint by default.
  useEffect(() => {
    const entry = repl.config?.entrypoint;
    if (entry && useWorkspace.getState().openTabs.length === 0) useWorkspace.getState().openFile(entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repl.id]);

  useEffect(() => {
    if (toolTab === "display") setDisplayVisited(true);
  }, [toolTab]);

  const tabTrigger = "h-8 flex-none gap-1.5 rounded-none border-0 border-b-2 border-transparent px-3 text-xs data-[state=active]:border-b-primary data-[state=active]:bg-transparent dark:data-[state=active]:bg-transparent dark:data-[state=active]:border-b-primary data-[state=active]:shadow-none";
  const paneCls = "mt-0 min-h-0 flex-1 data-[state=inactive]:hidden";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <TopBar onStartContainer={() => void startContainer()} />

      {container === "starting" && (
        <div className="flex h-7 shrink-0 items-center justify-center gap-2 border-b bg-primary/10 text-xs text-primary">
          <Loader2 className="size-3 animate-spin" /> Starting container…
        </div>
      )}
      {container === "error" && (
        <div className="flex h-8 shrink-0 items-center justify-center gap-3 border-b bg-destructive/15 text-xs text-destructive">
          <AlertTriangle className="size-3.5" /> Container failed to start: {containerError}
          <Button size="xs" variant="outline" onClick={() => void startContainer()}>
            Retry
          </Button>
        </div>
      )}
      {(container === "stopped" || container === "missing") && editable && (
        <div className="flex h-8 shrink-0 items-center justify-center gap-3 border-b bg-muted text-xs text-muted-foreground">
          The container is stopped.
          <Button size="xs" variant="outline" onClick={() => void startContainer()}>
            Start it
          </Button>
        </div>
      )}

      <Group orientation="horizontal" className="min-h-0 flex-1">
        <Panel defaultSize="18%" minSize="10%" className="flex flex-col bg-sidebar">
          <Tabs value={sideTab} onValueChange={(v) => setSideTab(v as "files" | "git")} className="h-full gap-0">
            <TabsList className="h-9 w-full shrink-0 justify-start rounded-none border-b bg-sidebar p-0">
              <TabsTrigger value="files" className={tabTrigger}>
                <Files /> Files
              </TabsTrigger>
              <TabsTrigger value="git" className={tabTrigger}>
                <GitBranch /> Version control
              </TabsTrigger>
            </TabsList>
            <TabsContent value="files" forceMount className={paneCls}>
              <FileTree />
            </TabsContent>
            <TabsContent value="git" className={paneCls}>
              <GitPanel active={sideTab === "git"} />
            </TabsContent>
          </Tabs>
        </Panel>
        <Separator className="w-1 bg-border transition-colors hover:bg-primary/40 data-[separator=active]:bg-primary/60" />
        <Panel defaultSize="47%" minSize="20%">
          <EditorArea />
        </Panel>
        <Separator className="w-1 bg-border transition-colors hover:bg-primary/40 data-[separator=active]:bg-primary/60" />
        <Panel defaultSize="35%" minSize="15%" className="flex flex-col">
          <Tabs value={toolTab} onValueChange={(v) => setToolTab(v as ToolTab)} className="h-full gap-0">
            <TabsList className="h-9 w-full shrink-0 justify-start rounded-none border-b bg-card p-0">
              <TabsTrigger value="console" className={tabTrigger}>
                <Terminal /> Console
              </TabsTrigger>
              <TabsTrigger value="shell" className={tabTrigger}>
                <SquareTerminal /> Shell
              </TabsTrigger>
              <TabsTrigger value="webview" className={tabTrigger}>
                <Globe /> Webview
              </TabsTrigger>
              <TabsTrigger value="display" className={cn(tabTrigger, repl.config?.gui && "text-primary")}>
                <Monitor /> Display
              </TabsTrigger>
            </TabsList>
            <TabsContent value="console" forceMount className={paneCls}>
              <ConsolePane visible={toolTab === "console"} />
            </TabsContent>
            <TabsContent value="shell" forceMount className={paneCls}>
              <ShellPane visible={toolTab === "shell"} />
            </TabsContent>
            <TabsContent value="webview" forceMount className={paneCls}>
              <WebviewPane />
            </TabsContent>
            <TabsContent value="display" forceMount className={paneCls}>
              {displayVisited && <DisplayPane />}
            </TabsContent>
          </Tabs>
        </Panel>
      </Group>
    </div>
  );
}
