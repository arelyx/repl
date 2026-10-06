import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronLeft, GitFork, Globe, Loader2, Lock, Play, Share2, Square } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LogoMark } from "@/components/Logo";
import { UserMenu } from "@/components/UserMenu";
import { ShareDialog } from "@/components/workspace/ShareDialog";
import { errorMessage } from "@/lib/api";
import { replsApi } from "@/lib/repls";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { canEdit, useWorkspace } from "@/stores/workspace";

function ContainerBadge() {
  const container = useWorkspace((s) => s.container);
  const running = useWorkspace((s) => s.runStatus?.running);
  const map: Record<string, { label: string; dot: string }> = {
    unknown: { label: "checking", dot: "bg-muted-foreground" },
    starting: { label: "starting", dot: "bg-yellow-500 animate-pulse" },
    running: { label: running ? "running" : "ready", dot: running ? "bg-green-500 animate-pulse" : "bg-green-500" },
    stopped: { label: "stopped", dot: "bg-muted-foreground" },
    missing: { label: "not started", dot: "bg-muted-foreground" },
    error: { label: "error", dot: "bg-red-500" },
  };
  const s = map[container] ?? map.unknown!;
  return (
    <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
      <span className={cn("size-2 rounded-full", s.dot)} />
      {s.label}
    </Badge>
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
    if (!running) ws.setToolTab(repl.config?.gui ? "display" : "console");
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

  const runDisabled = !editable || container === "starting" || (container === "running" && !runConnected) || pending;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-card px-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" asChild>
            <Link to={user ? "/dashboard" : "/"}>
              <ChevronLeft />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Back to my repls</TooltipContent>
      </Tooltip>
      <LogoMark className="size-5" />
      <div className="flex min-w-0 items-center gap-2">
        {!isOwner && <span className="hidden text-sm text-muted-foreground sm:inline">@{repl.owner.username} /</span>}
        {editingName ? (
          <Input
            autoFocus
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
            className="h-7 w-56"
          />
        ) : (
          <button
            className={cn(
              "truncate rounded px-1.5 py-0.5 text-sm font-medium",
              isOwner && "hover:bg-accent",
            )}
            title={isOwner ? "Click to rename" : repl.name}
            onClick={() => isOwner && setEditingName(true)}
          >
            {repl.name}
          </button>
        )}
        {repl.is_public ? (
          <Globe className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Lock className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </div>

      <div className="mx-auto flex items-center gap-3">
        <Button
          onClick={run}
          disabled={runDisabled}
          className={cn(
            "h-8 min-w-24 font-semibold text-white",
            running ? "bg-red-600 hover:bg-red-600/90" : "bg-[#f26207] hover:bg-[#f26207]/90",
          )}
          title={editable ? (running ? "Stop" : "Run") : "Fork this repl to run it"}
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
        <ContainerBadge />
      </div>

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={fork} disabled={forking}>
          {forking ? <Loader2 className="animate-spin" /> : <GitFork />}
          <span className="hidden md:inline">Fork</span>
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setShareOpen(true)}>
          <Share2 /> <span className="hidden md:inline">Share</span>
        </Button>
        <UserMenu />
      </div>
      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} />
    </header>
  );
}
