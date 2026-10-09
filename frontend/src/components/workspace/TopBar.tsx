import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, GitFork, Globe, Loader2, Lock, Play, Share2, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/Kbd";
import { LogoMark } from "@/components/Logo";
import { PaletteTrigger } from "@/components/PaletteTrigger";
import { UserMenu } from "@/components/UserMenu";
import { ShareDialog } from "@/components/workspace/ShareDialog";
import type { RunControl } from "@/hooks/useRunControl";
import { errorMessage } from "@/lib/api";
import { replsApi } from "@/lib/repls";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { useWorkspace } from "@/stores/workspace";

export function TopBar({
  ctl,
  shareOpen,
  setShareOpen,
  renaming,
  setRenaming,
}: {
  ctl: RunControl;
  shareOpen: boolean;
  setShareOpen: (o: boolean) => void;
  renaming: boolean;
  setRenaming: (r: boolean) => void;
}) {
  const repl = useWorkspace((s) => s.repl)!;
  const container = useWorkspace((s) => s.container);
  const user = useAuthStore((s) => s.user);
  const isOwner = repl.role === "owner";
  const [name, setName] = useState(repl.name);

  useEffect(() => setName(repl.name), [repl.name]);

  const saveName = async () => {
    setRenaming(false);
    const next = name.trim();
    if (!next || next === repl.name) {
      setName(repl.name);
      return;
    }
    try {
      const updated = await replsApi.update(repl.id, { name: next });
      useWorkspace.getState().setRepl({ ...repl, ...updated, role: repl.role });
      toast.success(`Renamed to ${updated.name}`);
    } catch (e) {
      setName(repl.name);
      toast.error(`Rename failed: ${errorMessage(e)}`);
    }
  };

  const { run, running, pending, disabled, editable, fork, forking } = ctl;
  const busy = pending || container === "starting";

  return (
    <header className="flex h-[38px] shrink-0 items-center gap-1.5 border-b bg-card px-1.5 sm:gap-2 sm:px-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="touch-target" asChild>
            <Link to={user ? "/dashboard" : "/"} aria-label="Back to my repls">
              <ChevronLeft />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Back to my repls</TooltipContent>
      </Tooltip>
      <LogoMark className="hidden size-4 sm:block" />
      <div className="flex min-w-0 items-center gap-1 text-sm">
        {!isOwner && <span className="hidden text-muted-foreground lg:inline">{repl.owner.username} /</span>}
        {renaming ? (
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
                setRenaming(false);
              }
            }}
            className="h-6 w-40 px-1.5 sm:w-56"
          />
        ) : (
          <button
            className={cn("truncate rounded-md px-1.5 py-0.5 font-medium", isOwner && "hover:bg-accent")}
            title={isOwner ? "Rename" : repl.name}
            onClick={() => isOwner && setRenaming(true)}
            disabled={!isOwner}
          >
            {repl.name}
          </button>
        )}
        <span className="shrink-0 text-muted-foreground" title={repl.is_public ? "Public" : "Private"}>
          {repl.is_public ? <Globe className="size-3.5" aria-label="Public" /> : <Lock className="size-3.5" aria-label="Private" />}
        </span>
      </div>

      <PaletteTrigger label="Search files and commands" className="ml-auto w-full max-w-sm md:mx-auto" />

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={run}
              disabled={disabled}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              title={editable ? undefined : "Fork this repl to run it"}
              className={cn(
                "h-7 min-w-[4.75rem] gap-1.5 px-2.5 font-semibold",
                running
                  ? "bg-fault text-[#1c0a0b] hover:bg-fault/90"
                  : "bg-ignition text-ignition-ink hover:bg-ignition/90",
              )}
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : running ? (
                <Square className="size-3 fill-current" />
              ) : (
                <Play className="size-3 fill-current" />
              )}
              {container === "starting" ? "Starting" : running ? "Stop" : "Run"}
            </Button>
          </TooltipTrigger>
          <TooltipContent className="flex items-center gap-2">
            {editable ? (running ? "Stop" : "Run") : "Fork this repl to run it"} {editable && <Kbd keys={["mod", "enter"]} />}
          </TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="sm" onClick={() => void fork()} disabled={forking} className="max-sm:px-1.5" aria-label="Fork">
          {forking ? <Loader2 className="animate-spin" /> : <GitFork />}
          <span className="hidden md:inline">Fork</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setShareOpen(true)} className="max-sm:px-1.5" aria-label="Share">
          <Share2 /> <span className="hidden md:inline">Share</span>
        </Button>
        <UserMenu />
      </div>
      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} />
    </header>
  );
}
