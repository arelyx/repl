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
import { langAccent } from "@/lib/langAccent";
import type { Repl } from "@/lib/types";

export function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Dense list of repls: one row each, with a stripe in the repl's language color. */
export function ReplTable({
  repls,
  showOwner,
  showRole = true,
  onFork,
  onDelete,
  label,
}: {
  repls: Repl[];
  showOwner?: boolean;
  /** Show the viewer/editor chip; off on Explore, where every row is "viewer". */
  showRole?: boolean;
  onFork?: (repl: Repl) => void;
  onDelete?: (repl: Repl) => void;
  label: string;
}) {
  const th = "h-7 px-3 text-left text-xs font-medium text-muted-foreground";
  return (
    <div className="overflow-hidden rounded-md border bg-card">
      <table className="w-full table-fixed border-collapse text-sm" aria-label={label}>
        <thead className="border-b">
          <tr>
            <th scope="col" className={th}>
              Name
            </th>
            <th scope="col" className={`${th} hidden w-36 md:table-cell`}>
              Template
            </th>
            {showOwner && (
              <th scope="col" className={`${th} hidden w-36 sm:table-cell`}>
                Owner
              </th>
            )}
            <th scope="col" className={`${th} hidden w-28 md:table-cell`}>
              Visibility
            </th>
            <th scope="col" className={`${th} w-24 text-right sm:w-28`}>
              Updated
            </th>
            {(onFork || onDelete) && (
              <th scope="col" className={`${th} w-11`}>
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {repls.map((r) => (
            <tr
              key={r.id}
              className="relative border-b last:border-b-0 hover:bg-accent/60 has-[a:focus-visible]:bg-accent/60"
            >
              <td className="h-10 px-3" style={{ boxShadow: `inset 3px 0 0 ${langAccent(r.language)}` }}>
                <div className="flex min-w-0 items-center gap-2.5">
                  <LangIcon language={r.language} className="size-5 text-[10px]" />
                  <Link
                    to={`/repl/${r.id}`}
                    className="truncate font-medium text-foreground rounded-sm after:absolute after:inset-0"
                  >
                    {r.name}
                  </Link>
                  {r.forked_from && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground" title="Forked from another repl">
                      <GitFork className="size-3" />
                      <span className="sr-only">fork</span>
                    </span>
                  )}
                  {showRole && r.role !== "owner" && (
                    <span className="shrink-0 rounded-sm border px-1 text-[11px] text-muted-foreground">{r.role}</span>
                  )}
                  {r.description && (
                    <span className="hidden min-w-0 truncate text-xs text-muted-foreground lg:inline">{r.description}</span>
                  )}
                </div>
              </td>
              <td className="hidden truncate px-3 text-xs text-muted-foreground md:table-cell">{r.template}</td>
              {showOwner && (
                <td className="hidden truncate px-3 text-muted-foreground sm:table-cell">@{r.owner.username}</td>
              )}
              <td className="hidden px-3 text-muted-foreground md:table-cell">
                <span className="flex items-center gap-1.5 text-xs">
                  {r.is_public ? <Globe className="size-3.5" /> : <Lock className="size-3.5" />}
                  {r.is_public ? "Public" : "Private"}
                </span>
              </td>
              <td className="tabular px-3 text-right text-xs text-muted-foreground">{timeAgo(r.updated_at)}</td>
              {(onFork || onDelete) && (
                <td className="px-1.5">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-xs" className="relative z-10 touch-target" aria-label={`Actions for ${r.name}`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {onFork && (
                        <DropdownMenuItem onSelect={() => onFork(r)}>
                          <GitFork /> Fork
                        </DropdownMenuItem>
                      )}
                      {onDelete && (
                        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(r)}>
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
