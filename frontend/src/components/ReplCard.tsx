import { Link } from "react-router-dom";
import { GitFork, Globe, Lock, MoreVertical, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LangIcon } from "@/components/LangIcon";
import type { Repl } from "@/lib/types";

export function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ReplCard({
  repl,
  showOwner,
  onFork,
  onDelete,
}: {
  repl: Repl;
  showOwner?: boolean;
  onFork?: (repl: Repl) => void;
  onDelete?: (repl: Repl) => void;
}) {
  return (
    <div className="group relative flex flex-col rounded-lg border bg-card p-4 transition-colors hover:border-primary/60">
      <Link to={`/repl/${repl.id}`} className="absolute inset-0 z-0" aria-label={`Open ${repl.name}`} />
      <div className="flex items-start gap-3">
        <LangIcon language={repl.language} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{repl.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {showOwner ? `@${repl.owner.username} · ` : ""}
            {repl.template} · {timeAgo(repl.updated_at)}
          </div>
        </div>
        {(onFork || onDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" className="relative z-10">
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onFork && (
                <DropdownMenuItem onSelect={() => onFork(repl)}>
                  <GitFork /> Fork
                </DropdownMenuItem>
              )}
              {onDelete && (
                <DropdownMenuItem variant="destructive" onSelect={() => onDelete(repl)}>
                  <Trash2 /> Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {repl.description && (
        <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{repl.description}</p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Badge variant="secondary" className="gap-1">
          {repl.is_public ? <Globe className="size-3" /> : <Lock className="size-3" />}
          {repl.is_public ? "Public" : "Private"}
        </Badge>
        {repl.role !== "owner" && <Badge variant="outline">{repl.role}</Badge>}
        {repl.forked_from && (
          <Badge variant="outline" className="gap-1">
            <GitFork className="size-3" /> fork
          </Badge>
        )}
      </div>
    </div>
  );
}
