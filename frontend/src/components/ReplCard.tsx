import { Link } from "react-router-dom";
import { GitFork, Globe, Lock, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LangIcon } from "@/components/LangIcon";
import type { Repl } from "@/lib/types";
import { cn } from "@/lib/utils";

export function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Column template shared by the list header and each row. */
export const REPL_ROW_GRID =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 md:grid-cols-[auto_minmax(0,1fr)_8rem_6.5rem_5.5rem_2rem]";

export function ReplListHeader() {
  return (
    <div className={cn(REPL_ROW_GRID, "hidden px-4 pb-1 text-xs text-muted-foreground md:grid")} aria-hidden>
      <span className="w-8" />
      <span>Name</span>
      <span>Template</span>
      <span>Updated</span>
      <span>Visibility</span>
      <span />
    </div>
  );
}

/** One repl as a row in a list. The whole row opens the repl; the menu holds fork/delete. */
export function ReplRow({
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
    <li
      className={cn(
        REPL_ROW_GRID,
        "group relative min-h-16 rounded-xl bg-card px-4 py-3 transition-colors hover:bg-[color-mix(in_oklab,var(--card),var(--fjord)_5%)] has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-ring",
      )}
    >
      <LangIcon language={repl.language} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to={`/repl/${repl.id}`}
            className="truncate font-medium outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']"
          >
            {repl.name}
          </Link>
          {repl.role !== "owner" && (
            <span className="shrink-0 rounded-sm bg-mist px-1.5 py-px text-xs text-muted-foreground">{repl.role}</span>
          )}
          {repl.forked_from && (
            <span className="flex shrink-0 items-center gap-1 rounded-sm bg-mist px-1.5 py-px text-xs text-muted-foreground">
              <GitFork className="size-3" aria-hidden /> fork
            </span>
          )}
        </div>
        {(showOwner || repl.description) && (
          <p className="truncate text-sm text-muted-foreground">
            {showOwner && <span className="text-foreground/80">@{repl.owner.username}</span>}
            {showOwner && repl.description && <span className="px-1.5" />}
            {repl.description}
          </p>
        )}
        {/* Phone: template and time fold under the name. */}
        <p className="flex gap-3 text-xs text-muted-foreground md:hidden">
          <span>{repl.template}</span>
          <span>{timeAgo(repl.updated_at)}</span>
          <span className="flex items-center gap-1">
            {repl.is_public ? <Globe className="size-3" aria-hidden /> : <Lock className="size-3" aria-hidden />}
            {repl.is_public ? "Public" : "Private"}
          </span>
        </p>
      </div>
      <span className="hidden truncate text-sm text-muted-foreground md:block">{repl.template}</span>
      <span className="hidden text-sm text-muted-foreground md:block">{timeAgo(repl.updated_at)}</span>
      <span className="hidden items-center gap-1.5 text-sm text-muted-foreground md:flex">
        {repl.is_public ? <Globe className="size-3.5" aria-hidden /> : <Lock className="size-3.5" aria-hidden />}
        {repl.is_public ? "Public" : "Private"}
      </span>
      {onFork || onDelete ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="relative z-10" aria-label={`Actions for ${repl.name}`}>
              <MoreHorizontal />
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
      ) : (
        <span />
      )}
    </li>
  );
}
