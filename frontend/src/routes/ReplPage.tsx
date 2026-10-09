import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Panel, Group, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import {
  AlertTriangle,
  Code2,
  Files,
  GitBranch,
  Globe,
  Loader2,
  Monitor,
  SquareTerminal,
  Terminal,
  type LucideIcon,
} from "lucide-react";
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
import { useMediaQuery } from "@/hooks/useMediaQuery";
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
      <div className="flex min-h-screen flex-col items-start justify-center gap-4 px-6 sm:items-center sm:text-center">
        <AlertTriangle className="size-8 text-destructive" aria-hidden />
        <h1 className="text-xl font-semibold">
          {error.status === 404
            ? "This repl doesn't exist"
            : error.status === 401 || error.status === 403
              ? "You don't have access to this repl"
              : "Couldn't open this repl"}
        </h1>
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
            <Link to="/dashboard">Back to your repls</Link>
          </Button>
        </div>
      </div>
    );
  }
  if (!repl || repl.id !== id) return <FullPageSpinner label="Opening repl…" />;
  return <Workspace />;
}

type MobileView = "files" | "code" | ToolTab;

const TOOL_TABS: { value: ToolTab; label: string; short: string; icon: LucideIcon }[] = [
  { value: "console", label: "Console", short: "Console", icon: Terminal },
  { value: "shell", label: "Shell", short: "Shell", icon: SquareTerminal },
  { value: "webview", label: "Webview", short: "Web", icon: Globe },
  { value: "display", label: "Display", short: "Display", icon: Monitor },
];

const MOBILE_TABS: { value: MobileView; label: string; icon: LucideIcon }[] = [
  { value: "files", label: "Files", icon: Files },
  { value: "code", label: "Code", icon: Code2 },
  ...TOOL_TABS.map((t) => ({ value: t.value as MobileView, label: t.short, icon: t.icon })),
];

function Workspace() {
  const repl = useWorkspace((s) => s.repl)!;
  const container = useWorkspace((s) => s.container);
  const containerError = useWorkspace((s) => s.containerError);
  const toolTab = useWorkspace((s) => s.toolTab);
  const setToolTab = useWorkspace((s) => s.setToolTab);
  const activePath = useWorkspace((s) => s.activePath);
  const focus = useWorkspace((s) => s.focus);
  const [sideTab, setSideTab] = useState<"files" | "git">("files");
  const [displayVisited, setDisplayVisited] = useState(toolTab === "display");
  const editable = canEdit(repl);
  const desktop = useMediaQuery("(min-width: 768px)");
  const [mobileView, setMobileView] = useState<MobileView>("code");
  const filesPanel = useRef<PanelImperativeHandle | null>(null);
  const toolsPanel = useRef<PanelImperativeHandle | null>(null);

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

  // Phone: follow the tool tab when something else switches it (Run, a new web server).
  const toolTabSeq = useWorkspace((s) => s.toolTabSeq);
  const lastSeq = useRef(toolTabSeq);
  useEffect(() => {
    if (toolTabSeq === lastSeq.current) return;
    lastSeq.current = toolTabSeq;
    setMobileView(useWorkspace.getState().toolTab);
  }, [toolTabSeq]);

  // Phone: opening a file from the tree shows the editor.
  const lastPath = useRef(activePath);
  useEffect(() => {
    if (activePath && activePath !== lastPath.current) setMobileView((v) => (v === "files" ? "code" : v));
    lastPath.current = activePath;
  }, [activePath]);

  // Desktop focus mode: collapse the side panes around the editor.
  useEffect(() => {
    if (!desktop) return;
    if (focus) {
      filesPanel.current?.collapse();
      toolsPanel.current?.collapse();
    } else {
      filesPanel.current?.expand();
      toolsPanel.current?.expand();
    }
  }, [focus, desktop]);

  // Ctrl/Cmd+Shift+F toggles focus mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        const ws = useWorkspace.getState();
        ws.setFocus(!ws.focus);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const showMobile = (v: MobileView) => {
    setMobileView(v);
    if (v !== "files" && v !== "code") setToolTab(v);
  };

  const tabTrigger =
    "h-8 flex-none gap-1.5 rounded-md border-0 px-2.5 text-[13px] font-medium text-muted-foreground shadow-none hover:text-foreground data-[state=active]:bg-mist data-[state=active]:text-foreground data-[state=active]:shadow-none dark:text-muted-foreground dark:data-[state=active]:bg-mist dark:data-[state=active]:text-foreground dark:data-[state=active]:border-transparent";
  const paneCls = "mt-0 min-h-0 flex-1 data-[state=inactive]:hidden";
  const island = "flex h-full min-h-0 flex-col overflow-hidden bg-card md:rounded-[14px]";

  const sidebar = (
    <Tabs value={sideTab} onValueChange={(v) => setSideTab(v as "files" | "git")} className="h-full gap-0">
      <TabsList className="h-11 w-full shrink-0 justify-start gap-1 rounded-none bg-transparent px-2">
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
  );

  const toolVisible = (t: ToolTab) => toolTab === t && (desktop || mobileView === t);
  const tools = (
    <Tabs value={toolTab} onValueChange={(v) => setToolTab(v as ToolTab)} className="h-full gap-0">
      <TabsList
        className={cn(
          "h-11 w-full shrink-0 justify-start gap-1 overflow-x-auto rounded-none bg-transparent px-2",
          !desktop && "hidden",
        )}
      >
        {TOOL_TABS.map((t) => (
          <TabsTrigger
            key={t.value}
            value={t.value}
            className={cn(tabTrigger, t.value === "display" && repl.config?.gui && "text-primary dark:text-primary")}
          >
            <t.icon /> {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="console" forceMount className={paneCls}>
        <ConsolePane visible={toolVisible("console")} />
      </TabsContent>
      <TabsContent value="shell" forceMount className={paneCls}>
        <ShellPane visible={toolVisible("shell")} />
      </TabsContent>
      <TabsContent value="webview" forceMount className={paneCls}>
        <WebviewPane />
      </TabsContent>
      <TabsContent value="display" forceMount className={paneCls}>
        {displayVisited && <DisplayPane />}
      </TabsContent>
    </Tabs>
  );

  const banner = "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 text-[13px]";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <TopBar onStartContainer={() => void startContainer()} />

      <div aria-live="polite">
        {container === "starting" && (
          <div className={cn(banner, "text-muted-foreground md:justify-center")}>
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Starting your container. This usually takes a few
            seconds.
          </div>
        )}
        {container === "error" && (
          <div className={cn(banner, "text-destructive md:justify-center")}>
            <AlertTriangle className="size-3.5" aria-hidden /> The container didn't start: {containerError}
            <Button size="xs" variant="outline" onClick={() => void startContainer()}>
              Try again
            </Button>
          </div>
        )}
        {(container === "stopped" || container === "missing") && editable && (
          <div className={cn(banner, "text-muted-foreground md:justify-center")}>
            The container is stopped. Files are saved; start it to run code.
            <Button size="xs" variant="outline" onClick={() => void startContainer()}>
              Start container
            </Button>
          </div>
        )}
      </div>

      {desktop ? (
        <Group orientation="horizontal" className="min-h-0 flex-1 px-1.5 pb-1.5">
          <Panel
            panelRef={filesPanel}
            defaultSize="18%"
            minSize="10%"
            collapsible
            collapsedSize={0}
            className="flex flex-col"
          >
            <div className={island}>{sidebar}</div>
          </Panel>
          <Separator className={cn("pane-gutter", focus && "pointer-events-none")} />
          <Panel defaultSize="47%" minSize="20%">
            <div className={cn("h-full", focus && "mx-auto max-w-[1080px]")}>
              <div className={island}>
                <EditorArea />
              </div>
            </div>
          </Panel>
          <Separator className={cn("pane-gutter", focus && "pointer-events-none")} />
          <Panel
            panelRef={toolsPanel}
            defaultSize="35%"
            minSize="15%"
            collapsible
            collapsedSize={0}
            className="flex flex-col"
          >
            <div className={island}>{tools}</div>
          </Panel>
        </Group>
      ) : (
        <>
          <div className="relative min-h-0 flex-1">
            <div className={cn("absolute inset-0", mobileView !== "files" && "hidden")}>
              <div className={island}>{sidebar}</div>
            </div>
            <div className={cn("absolute inset-0", mobileView !== "code" && "hidden")}>
              <div className={island}>
                <EditorArea />
              </div>
            </div>
            <div className={cn("absolute inset-0", (mobileView === "files" || mobileView === "code") && "hidden")}>
              <div className={island}>{tools}</div>
            </div>
          </div>
          <nav
            aria-label="Workspace panes"
            className="grid shrink-0 grid-cols-6 bg-background px-1 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]"
          >
            {MOBILE_TABS.map((t) => {
              const active = mobileView === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => showMobile(t.value)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-14 flex-col items-center justify-center gap-1 rounded-[10px] text-[11px] font-medium",
                    active ? "bg-card text-foreground" : "text-muted-foreground",
                  )}
                >
                  <t.icon className="size-5" aria-hidden />
                  {t.label}
                </button>
              );
            })}
          </nav>
        </>
      )}
    </div>
  );
}
