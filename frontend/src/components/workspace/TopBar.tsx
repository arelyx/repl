import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronLeft, GitFork, Globe, Loader2, Lock, Maximize2, Minimize2, Play, Share2, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LogoMark } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { UserMenu } from "@/components/UserMenu";
import { ShareDialog } from "@/components/workspace/ShareDialog";
import { errorMessage } from "@/lib/api";
import { replsApi } from "@/lib/repls";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { canEdit, useWorkspace } from "@/stores/workspace";

function ContainerBadge({ compact }: { compact?: boolean }) {
  const container = useWorkspace((s) => s.container);
  const running = useWorkspace((s) => s.runStatus?.running);
  const map: Record<string, { label: string; dot: string }> = {
    unknown: { label: "Checking", dot: "bg-muted-foreground/60" },
    starting: { label: "Starting", dot: "bg-muted-foreground animate-pulse" },
    running: { label: running ? "Running" : "Ready", dot: running ? "bg-live ring-4 ring-live/20" : "bg-live" },
    stopped: { label: "Stopped", dot: "bg-muted-foreground/60" },
    missing: { label: "Not started", dot: "bg-muted-foreground/60" },
    error: { label: "Error", dot: "bg-destructive" },
  };
  const s = map[container] ?? map.unknown!;
  return (
    <span className="flex shrink-0 items-center gap-2 text-[13px] text-muted-foreground" title={`Container: ${s.label}`}>
      <span className={cn("size-2 rounded-full", s.dot)} aria-hidden />
      <span className={cn(compact && "sr-only")}>{s.label}</span>
    </span>
  );
}

export function TopBar({ onStartContainer }: { onStartContainer: () => void }) {
  const repl = useWorkspace((s) => s.repl)!;
  const container = useWorkspace((s) => s.container);
  const runStatus = useWorkspace((s) => s.runStatus);
  const runConnected = useWorkspace((s) => s.runConnected);
  const runSend = useWorkspace((s) => s.runSend);
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const editable = canEdit(repl);
  const isOwner = repl.role === "owner";
  const [name, setName] = useState(repl.name);
  const [editingName, setEditingName] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [forking, setForking] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => setName(repl.name), [repl.name]);
  useEffect(() => setPending(false), [runStatus]);

  const saveName = async () => {
    setEditingName(false);
    const next = name.trim();
    if (!next || next === repl.name) {
      setName(repl.name);
      return;
    }
    try {
      const updated = await replsApi.update(repl.id, { name: next });
      useWorkspace.getState().setRepl({ ...repl, ...updated, role: repl.role });
    } catch (e) {
      setName(repl.name);
      toast.error(`Rename failed: ${errorMessage(e)}`);
    }
  };

  const running = !!runStatus?.running;
  const run = () => {
    if (container !== "running") {
      onStartContainer();
      return;
    }
    const ws = useWorkspace.getState();
    if (!running) {
      ws.setToolTab(repl.config?.gui ? "display" : "console");
      // Output needs somewhere to show: leave focus mode when a run starts.
      ws.setFocus(false);
    }
    if (runSend?.({ type: running ? "stop" : "start" })) {
      setPending(true);
      setTimeout(() => setPending(false), 4000);
    } else {
      toast.error("Console isn't connected yet");
    }
  };

  const fork = async () => {
    if (!user) {
      navigate("/login", { state: { from: { pathname: `/repl/${repl.id}` } } });
      return;
    }
    setForking(true);
    try {
      const forked = await replsApi.fork(repl.id);
      toast.success(`Forked into ${forked.name}`);
      navigate(`/repl/${forked.id}`);
    } catch (e) {
      toast.error(`Fork failed: ${errorMessage(e)}`);
    } finally {
      setForking(false);
    }
  };

  const focus = useWorkspace((s) => s.focus);
  const setFocus = useWorkspace((s) => s.setFocus);
  const runDisabled = !editable || container === "starting" || (container === "running" && !runConnected) || pending;

  return (
    <header className="flex h-14 shrink-0 items-center gap-1.5 px-2 sm:gap-2 sm:px-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" asChild>
            <Link to={user ? "/dashboard" : "/"} aria-label={user ? "Back to your repls" : "Back to Replot"}>
              <ChevronLeft />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{user ? "Back to your repls" : "Back to Replot"}</TooltipContent>
      </Tooltip>
      <LogoMark className="hidden size-5 sm:block" />
      <div className="flex min-w-0 items-center gap-1.5">
        {!isOwner && (
          <span className="hidden shrink-0 text-sm text-muted-foreground lg:inline">@{repl.owner.username} /</span>
        )}
        {editingName ? (
          <Input
            autoFocus
            aria-label="Repl name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveName();
              if (e.key === "Escape") {
                setName(repl.name);
                setEditingName(false);
              }
            }}
            className="h-8 w-40 sm:w-56"
          />
        ) : (
          <button
            className={cn(
              "truncate rounded-md px-1.5 py-1 text-[15px] font-semibold tracking-[-0.01em]",
              isOwner ? "hover:bg-snow" : "cursor-default",
            )}
            title={isOwner ? "Rename" : repl.name}
            onClick={() => isOwner && setEditingName(true)}
          >
            {repl.name}
          </button>
        )}
        {repl.is_public ? (
          <Globe className="hidden size-3.5 shrink-0 text-muted-foreground sm:block" aria-label="Public" />
        ) : (
          <Lock className="hidden size-3.5 shrink-0 text-muted-foreground sm:block" aria-label="Private" />
        )}
        <span className="ml-2 hidden md:block">
          <ContainerBadge />
        </span>
      </div>

      <div className="ml-auto flex items-center gap-2 md:mx-auto">
        <span className="md:hidden">
          <ContainerBadge compact />
        </span>
        <Button
          onClick={run}
          disabled={runDisabled}
          className={cn(
            "h-9 min-w-[5.5rem] rounded-[10px] px-4 font-semibold",
            running
              ? "bg-destructive text-white hover:bg-destructive/90 dark:text-[#2A1210]"
              : "bg-live text-live-foreground hover:bg-live/90",
          )}
          title={editable ? (running ? "Stop the program" : "Run the program") : "Fork this repl to run it"}
        >
          {pending || container === "starting" ? (
            <Loader2 className="animate-spin" />
          ) : running ? (
            <Square className="fill-current" />
          ) : (
            <Play className="fill-current" />
          )}
          {container === "starting" ? "Starting" : running ? "Stop" : "Run"}
        </Button>
      </div>

      <div className="flex items-center gap-0.5 md:ml-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={focus ? "secondary" : "ghost"}
              size="sm"
              className="hidden md:inline-flex"
              onClick={() => setFocus(!focus)}
              aria-pressed={focus}
            >
              {focus ? <Minimize2 /> : <Maximize2 />}
              <span className="hidden lg:inline">{focus ? "Leave focus" : "Focus"}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {focus ? "Bring back the side panes" : "Hide everything but the editor"} (Ctrl+Shift+F)
          </TooltipContent>
        </Tooltip>
        {!focus && (
          <>
            <Button variant="ghost" size="sm" onClick={fork} disabled={forking} aria-label="Fork">
              {forking ? <Loader2 className="animate-spin" /> : <GitFork />}
              <span className="hidden lg:inline">Fork</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShareOpen(true)} aria-label="Share">
              <Share2 /> <span className="hidden lg:inline">Share</span>
            </Button>
            <ThemeToggle className="hidden md:inline-flex" />
            <UserMenu />
          </>
        )}
      </div>
      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} />
    </header>
  );
}
