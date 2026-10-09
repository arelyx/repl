import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import {
  AlertTriangle,
  Command,
  Copy,
  Files,
  GitBranch,
  GitFork,
  Globe,
  Monitor,
  PanelLeft,
  PanelRight,
  Pencil,
  Play,
  Power,
  Share2,
  Square,
  SquareTerminal,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FullPageSpinner } from "@/components/AuthGuard";
import { Kbd } from "@/components/Kbd";
import { TopBar } from "@/components/workspace/TopBar";
import { FileTree } from "@/components/workspace/FileTree";
import { GitPanel } from "@/components/workspace/GitPanel";
import { EditorArea } from "@/components/workspace/EditorArea";
import { ConsolePane } from "@/components/workspace/ConsolePane";
import { ShellPane } from "@/components/workspace/ShellPane";
import { WebviewPane } from "@/components/workspace/WebviewPane";
import { DisplayPane } from "@/components/workspace/DisplayPane";
import { StatusBar } from "@/components/workspace/StatusBar";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useRunControl } from "@/hooks/useRunControl";
import { ApiError, errorMessage } from "@/lib/api";
import { langAccent } from "@/lib/langAccent";
import { replsApi } from "@/lib/repls";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { inTextField, modKey, useCommands, usePalette } from "@/stores/palette";
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
        document.title = `${r.name} - Repl`;
      })
      .catch((e) => {
        if (!cancelled) setError({ status: e instanceof ApiError ? e.status : 0, message: errorMessage(e) });
      });
    return () => {
      cancelled = true;
      document.title = "Repl";
      // Leaving the workspace: the palette should stop offering this repl's files and commands.
      useWorkspace.setState({ repl: null, files: [], openTabs: [], activePath: null });
    };
  }, [id]);

  if (error) {
    return (
      <div className="flex min-h-dvh flex-col items-start justify-center gap-3 px-6 sm:items-center sm:text-center">
        <AlertTriangle className="size-8 text-fault" />
        <h1 className="font-display text-xl font-semibold">
          {error.status === 404
            ? "This repl doesn't exist"
            : error.status === 401 || error.status === 403
              ? "You don't have access to this repl"
              : "Couldn't open this repl"}
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {error.status === 404
            ? "It may have been deleted, or the link is wrong."
            : error.status === 401
              ? "Log in to open it. If it's private, the owner has to invite you."
              : error.message}
        </p>
        <div className="flex gap-2">
          {error.status === 401 && (
            <Button asChild>
              <Link to="/login" state={{ from: { pathname: `/repl/${id}` } }}>
                Log in
              </Link>
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link to="/dashboard">Back to my repls</Link>
          </Button>
        </div>
      </div>
    );
  }
  if (!repl || repl.id !== id) return <FullPageSpinner label="Opening repl…" />;
  return <Workspace />;
}

type SideView = "files" | "git";
type MobileView = "files" | "git" | "code" | "tools";

const TOOLS: { id: ToolTab; label: string; short: string; icon: typeof Terminal }[] = [
  { id: "console", label: "Console", short: "Console", icon: Terminal },
  { id: "shell", label: "Shell", short: "Shell", icon: SquareTerminal },
  { id: "webview", label: "Webview", short: "Web", icon: Globe },
  { id: "display", label: "Display", short: "Display", icon: Monitor },
];

function Workspace() {
  const repl = useWorkspace((s) => s.repl)!;
  const container = useWorkspace((s) => s.container);
  const containerError = useWorkspace((s) => s.containerError);
  const toolTab = useWorkspace((s) => s.toolTab);
  const setToolTab = useWorkspace((s) => s.setToolTab);
  const activePath = useWorkspace((s) => s.activePath);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [sideView, setSideView] = useState<SideView>("files");
  const [sideOpen, setSideOpen] = useState(true);
  const [toolsOpen, setToolsOpen] = useState(true);
  const [mobileView, setMobileView] = useState<MobileView>("code");
  const [shareOpen, setShareOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [displayVisited, setDisplayVisited] = useState(toolTab === "display");
  const sideRef = usePanelRef();
  const toolsRef = usePanelRef();
  const editable = canEdit(repl);

  // Paint the chrome in this repl's language color (status bar, active tab, tree selection).
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--lang", langAccent(repl.language));
    return () => {
      root.style.removeProperty("--lang");
    };
  }, [repl.language]);

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

  const baseCtl = useRunControl(() => void startContainer());
  // On phones, Run also brings the output forward.
  const ctl = useMemo(
    () => ({
      ...baseCtl,
      run: () => {
        const starting = !baseCtl.running && !baseCtl.disabled;
        baseCtl.run();
        if (starting && window.matchMedia("(max-width: 767px)").matches) setMobileView("tools");
      },
    }),
    [baseCtl],
  );

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

  // Phones: follow the action. Run or a new web server brings its tool forward; picking a file shows the code.
  const prevToolTab = useRef(toolTab);
  useEffect(() => {
    if (prevToolTab.current === toolTab) return;
    prevToolTab.current = toolTab;
    if (isMobile) setMobileView((v) => (v === "code" || v === "tools" ? "tools" : v));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolTab]);
  useEffect(() => {
    if (isMobile && activePath) setMobileView("code");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  const showSide = useCallback(
    (view: SideView | "toggle") => {
      if (isMobile) {
        if (view !== "toggle") setMobileView(view);
        return;
      }
      const panel = sideRef.current;
      if (view === "toggle") {
        if (panel?.isCollapsed()) panel.expand();
        else panel?.collapse();
        return;
      }
      if (sideOpen && sideView === view && !panel?.isCollapsed()) {
        panel?.collapse();
      } else {
        setSideView(view);
        panel?.expand();
      }
    },
    [isMobile, sideOpen, sideView, sideRef],
  );

  const showTool = useCallback(
    (t: ToolTab | "toggle") => {
      if (t === "toggle") {
        if (isMobile) {
          setMobileView((v) => (v === "tools" ? "code" : "tools"));
          return;
        }
        const panel = toolsRef.current;
        if (panel?.isCollapsed()) panel.expand();
        else panel?.collapse();
        return;
      }
      setToolTab(t);
      if (isMobile) setMobileView("tools");
      else toolsRef.current?.expand();
    },
    [isMobile, setToolTab, toolsRef],
  );

  // Workspace hotkeys (capture phase so they work from inside Monaco and xterm).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!modKey(e) || e.altKey || usePalette.getState().open) return;
      const k = e.key.toLowerCase();
      let handled = true;
      if (k === "enter" && !e.shiftKey) {
        if (inTextField(e.target)) return;
        ctl.run();
      } else if (k === "b" && !e.shiftKey) showSide("toggle");
      else if (k === "j" && !e.shiftKey) showTool("toggle");
      else if (k === "e" && e.shiftKey) showSide("files");
      else if (k === "g" && e.shiftKey) showSide("git");
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ctl, showSide, showTool]);

  useCommands(
    "workspace",
    () => [
      {
        id: "run:toggle",
        title: ctl.running ? "Stop" : container === "running" ? "Run" : "Start container and run",
        group: "Run",
        icon: ctl.running ? Square : Play,
        shortcut: ["mod", "Enter"],
        disabled: ctl.disabled,
        keywords: ["run", "stop", "execute", "start"],
        run: ctl.run,
      },
      ...(editable && container !== "running" && container !== "starting"
        ? [{ id: "run:start", title: "Start container", group: "Run", icon: Power, run: () => void startContainer() }]
        : []),
      { id: "view:files", title: "Show files", group: "View", icon: Files, shortcut: ["mod", "shift", "E"], run: () => showSide("files") },
      { id: "view:git", title: "Show version control", group: "View", icon: GitBranch, shortcut: ["mod", "shift", "G"], keywords: ["commit", "history", "diff"], run: () => showSide("git") },
      ...(isMobile
        ? [{ id: "view:code", title: "Show code", group: "View", icon: Files, run: () => setMobileView("code") }]
        : [
            { id: "view:sidebar", title: "Toggle sidebar", group: "View", icon: PanelLeft, shortcut: ["mod", "B"], run: () => showSide("toggle") },
            { id: "view:tools", title: "Toggle tools pane", group: "View", icon: PanelRight, shortcut: ["mod", "J"], run: () => showTool("toggle") },
          ]),
      ...TOOLS.map((t) => ({ id: `tool:${t.id}`, title: `Show ${t.label.toLowerCase()}`, group: "View", icon: t.icon, run: () => showTool(t.id) })),
      { id: "repl:share", title: "Share and invite…", group: "Repl", icon: Share2, keywords: ["collaborators", "public", "invite"], run: () => setShareOpen(true) },
      { id: "repl:fork", title: "Fork this repl", group: "Repl", icon: GitFork, run: () => void ctl.fork() },
      ...(repl.role === "owner"
        ? [{ id: "repl:rename", title: "Rename repl…", group: "Repl", icon: Pencil, run: () => setRenaming(true) }]
        : []),
      {
        id: "repl:copy-link",
        title: "Copy link to this repl",
        group: "Repl",
        icon: Copy,
        run: () => {
          void navigator.clipboard?.writeText(`${location.origin}/repl/${repl.id}`);
          toast.success("Link copied");
        },
      },
    ],
    [ctl.running, ctl.disabled, ctl.run, ctl.fork, container, editable, isMobile, showSide, showTool, repl.id, repl.role, startContainer],
  );

  const tools = (
    <Tabs value={toolTab} onValueChange={(v) => setToolTab(v as ToolTab)} className="h-full gap-0">
      <TabsList
        className={cn(
          "h-8 w-full shrink-0 justify-start rounded-none border-b bg-card p-0",
          isMobile && "hidden",
        )}
        aria-label="Tools"
      >
        {TOOLS.map((t) => (
          <TabsTrigger
            key={t.id}
            value={t.id}
            className={cn(
              "relative h-8 flex-none gap-1.5 rounded-none border-0 px-3 text-xs font-medium text-muted-foreground shadow-none data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-0 dark:data-[state=active]:bg-background data-[state=active]:before:absolute data-[state=active]:before:inset-x-0 data-[state=active]:before:top-0 data-[state=active]:before:h-0.5 data-[state=active]:before:bg-lang",
              t.id === "display" && repl.config?.gui && "text-foreground",
            )}
          >
            <t.icon className="size-3.5" /> {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="console" forceMount className={paneCls}>
        <ConsolePane visible={toolTab === "console" && (!isMobile || mobileView === "tools")} />
      </TabsContent>
      <TabsContent value="shell" forceMount className={paneCls}>
        <ShellPane visible={toolTab === "shell" && (!isMobile || mobileView === "tools")} />
      </TabsContent>
      <TabsContent value="webview" forceMount className={paneCls}>
        <WebviewPane />
      </TabsContent>
      <TabsContent value="display" forceMount className={paneCls}>
        {displayVisited && <DisplayPane />}
      </TabsContent>
    </Tabs>
  );

  const sidebar = (view: SideView) => (
    <div className="flex h-full flex-col bg-sidebar">
      <div className={cn("min-h-0 flex-1", view !== "files" && "hidden")}>
        <FileTree />
      </div>
      {view === "git" && (
        <div className="min-h-0 flex-1">
          <GitPanel active />
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <TopBar ctl={ctl} shareOpen={shareOpen} setShareOpen={setShareOpen} renaming={renaming} setRenaming={setRenaming} />

      {container === "error" && (
        <div role="alert" className="flex min-h-7 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-fault/15 px-3 py-1 text-xs text-foreground">
          <AlertTriangle className="size-3.5 text-fault" /> The container didn't start: {containerError}
          <Button size="xs" variant="outline" onClick={() => void startContainer()}>
            Try again
          </Button>
        </div>
      )}
      {(container === "stopped" || container === "missing") && editable && (
        <div className="flex min-h-7 shrink-0 items-center gap-3 border-b bg-card px-3 text-xs text-muted-foreground">
          The container is stopped. Files are saved; Run and the shell need it running.
          <Button size="xs" variant="outline" onClick={() => void startContainer()}>
            Start container
          </Button>
        </div>
      )}

      {isMobile ? (
        <div className="relative min-h-0 flex-1">
          <div className={cn("absolute inset-0", mobileView !== "files" && mobileView !== "git" && "hidden")}>
            {sidebar(mobileView === "git" ? "git" : "files")}
          </div>
          <div className={cn("absolute inset-0", mobileView !== "code" && "hidden")}>
            <EditorArea />
          </div>
          <div className={cn("absolute inset-0 flex flex-col", mobileView !== "tools" && "hidden")}>{tools}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ActivityBar
            sideView={sideOpen ? sideView : null}
            toolsOpen={toolsOpen}
            onSide={(v) => showSide(v)}
            onTools={() => showTool("toggle")}
          />
          <Group orientation="horizontal" className="min-h-0 flex-1">
            <Panel
              id="side"
              panelRef={sideRef}
              defaultSize="230px"
              minSize="160px"
              collapsible
              onResize={(s) => setSideOpen(s.inPixels > 0)}
              className="flex flex-col"
            >
              {sidebar(sideView)}
            </Panel>
            <Separator className={sepCls} />
            <Panel id="editor" minSize="280px">
              <EditorArea />
            </Panel>
            <Separator className={sepCls} />
            <Panel
              id="tools"
              panelRef={toolsRef}
              defaultSize="38%"
              minSize="240px"
              collapsible
              onResize={(s) => setToolsOpen(s.inPixels > 0)}
              className="flex flex-col"
            >
              {tools}
            </Panel>
          </Group>
        </div>
      )}

      {isMobile && (
        <nav aria-label="Workspace views" className="flex h-9 shrink-0 items-stretch overflow-x-auto border-t bg-card text-xs">
          {(
            [
              { key: "files", label: "Files", active: mobileView === "files", go: () => setMobileView("files") },
              { key: "code", label: "Code", active: mobileView === "code", go: () => setMobileView("code") },
              ...TOOLS.map((t) => ({
                key: t.id,
                label: t.short,
                active: mobileView === "tools" && toolTab === t.id,
                go: () => showTool(t.id),
              })),
              { key: "git", label: "Git", active: mobileView === "git", go: () => setMobileView("git") },
            ] as const
          ).map((v) => (
            <button
              key={v.key}
              onClick={v.go}
              aria-current={v.active ? "page" : undefined}
              className={cn(
                "relative flex min-w-12 flex-1 items-center justify-center px-2 font-medium",
                v.active
                  ? "bg-background text-foreground before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-lang"
                  : "text-muted-foreground",
              )}
            >
              {v.label}
            </button>
          ))}
        </nav>
      )}

      <StatusBar onStartContainer={() => void startContainer()} onOpenGit={() => showSide("git")} />
    </div>
  );
}

const paneCls = "mt-0 min-h-0 flex-1 data-[state=inactive]:hidden";
const sepCls = "w-px bg-border outline-none transition-colors hover:bg-caret/60 data-[separator=active]:bg-caret focus-visible:bg-caret";

function ActivityBar({
  sideView,
  toolsOpen,
  onSide,
  onTools,
}: {
  sideView: SideView | null;
  toolsOpen: boolean;
  onSide: (v: SideView) => void;
  onTools: () => void;
}) {
  const show = usePalette((s) => s.show);
  const item = (opts: {
    label: string;
    keys: string[];
    icon: typeof Files;
    active?: boolean;
    onClick: () => void;
  }) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={opts.onClick}
          aria-label={opts.label}
          aria-pressed={opts.active}
          className={cn(
            "relative flex size-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground",
            opts.active && "text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:bg-lang",
          )}
        >
          <opts.icon className="size-[18px]" strokeWidth={1.75} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="flex items-center gap-2">
        {opts.label} <Kbd keys={opts.keys} />
      </TooltipContent>
    </Tooltip>
  );
  return (
    <nav aria-label="Activity bar" className="flex w-10 shrink-0 flex-col border-r bg-card">
      {item({ label: "Files", keys: ["mod", "shift", "E"], icon: Files, active: sideView === "files", onClick: () => onSide("files") })}
      {item({ label: "Version control", keys: ["mod", "shift", "G"], icon: GitBranch, active: sideView === "git", onClick: () => onSide("git") })}
      <div className="mt-auto" />
      {item({ label: "Tools pane", keys: ["mod", "J"], icon: PanelRight, active: toolsOpen, onClick: onTools })}
      {item({ label: "Command palette", keys: ["mod", "K"], icon: Command, onClick: () => show("commands") })}
    </nav>
  );
}
