import { useCallback, useEffect, useState } from "react";
import { GitBranch, GitCommitHorizontal, History, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { DiffView } from "@/components/workspace/DiffView";
import { timeAgo } from "@/components/ReplCard";
import { errorMessage } from "@/lib/api";
import { replsApi } from "@/lib/repls";
import type { GitCommit, GitStatus } from "@/lib/types";
import { canEdit, useWorkspace } from "@/stores/workspace";

// The API reports words ("modified"); show the familiar one-letter git codes.
const STATUS_LETTERS: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "C",
};

function statusLetter(status: string): string {
  const s = status.trim();
  return STATUS_LETTERS[s] ?? (s.length <= 2 ? s : s[0].toUpperCase()) ?? "M";
}

const STATUS_COLORS: Record<string, string> = {
  M: "text-yellow-400",
  A: "text-green-400",
  D: "text-red-400",
  R: "text-sky-400",
  "?": "text-green-400",
  "??": "text-green-400",
  U: "text-green-400",
};

export function GitPanel({ active }: { active: boolean }) {
  const repl = useWorkspace((s) => s.repl)!;
  const editable = canEdit(repl);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitCommit[] | null>(null);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [selected, setSelected] = useState<GitCommit | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [workingDiff, setWorkingDiff] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([replsApi.gitStatus(repl.id), replsApi.gitLog(repl.id, 50)]);
      setStatus(s);
      setLog(l);
    } catch (e) {
      toast.error(`Git: ${errorMessage(e)}`);
    }
  }, [repl.id]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const t = setInterval(() => void refresh(), 10000);
    return () => clearInterval(t);
  }, [active, refresh]);

  const commit = async () => {
    if (!message.trim()) return;
    setCommitting(true);
    try {
      await replsApi.gitCommit(repl.id, message.trim());
      setMessage("");
      toast.success("Committed");
      await refresh();
    } catch (e) {
      toast.error(`Commit failed: ${errorMessage(e)}`);
    } finally {
      setCommitting(false);
    }
  };

  const openCommit = async (c: GitCommit | null) => {
    setSelected(c);
    setWorkingDiff(!c);
    setDiff(null);
    try {
      const res = await replsApi.gitDiff(repl.id, c?.sha);
      setDiff(res.diff);
    } catch (e) {
      setDiff("");
      toast.error(`Diff failed: ${errorMessage(e)}`);
    }
  };

  const restore = async () => {
    if (!selected) return;
    setRestoring(true);
    try {
      await replsApi.gitRestore(repl.id, selected.sha);
      toast.success(`Restored to ${selected.short_sha}`);
      setConfirmRestore(false);
      setSelected(null);
      const ws = useWorkspace.getState();
      await Promise.all([refresh(), ws.loadFiles()]);
      ws.bumpFsEpoch();
    } catch (e) {
      toast.error(`Restore failed: ${errorMessage(e)}`);
    } finally {
      setRestoring(false);
    }
  };

  const changes = status?.changes ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <span className="mr-auto text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          Version control
        </span>
        {status && (
          <Badge variant="outline" className="gap-1 font-mono text-[10px]">
            <GitBranch className="size-3" />
            {status.branch}
          </Badge>
        )}
        <Button variant="ghost" size="icon-xs" title="Refresh" onClick={() => void refresh()}>
          <RefreshCw />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          <section className="space-y-2">
            <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
              <span>Changes ({changes.length})</span>
              {changes.length > 0 && (
                <button className="text-primary hover:underline" onClick={() => void openCommit(null)}>
                  view diff
                </button>
              )}
            </div>
            {changes.length === 0 ? (
              <p className="text-xs text-muted-foreground">Working tree clean.</p>
            ) : (
              <ul className="space-y-0.5">
                {changes.map((c) => (
                  <li
                    key={c.path}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 text-xs hover:bg-accent"
                    onClick={() => useWorkspace.getState().openFile(c.path)}
                  >
                    <span className={`w-5 shrink-0 font-mono font-semibold ${STATUS_COLORS[statusLetter(c.status)] ?? "text-muted-foreground"}`}>
                      {statusLetter(c.status) || "M"}
                    </span>
                    <span className="truncate">{c.path}</span>
                  </li>
                ))}
              </ul>
            )}
            {editable && (
              <div className="space-y-2 pt-1">
                <Textarea
                  placeholder="Commit message"
                  className="min-h-14 text-xs"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commit();
                  }}
                />
                <Button size="sm" className="w-full" onClick={commit} disabled={!message.trim() || committing || changes.length === 0}>
                  {committing ? <Loader2 className="animate-spin" /> : <GitCommitHorizontal />} Commit all changes
                </Button>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <History className="size-3.5" /> History
            </div>
            {!log ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> Loading…
              </div>
            ) : log.length === 0 ? (
              <p className="text-xs text-muted-foreground">No commits yet.</p>
            ) : (
              <ul className="space-y-1">
                {log.map((c) => (
                  <li
                    key={c.sha}
                    className="cursor-pointer rounded border border-transparent p-1.5 hover:border-border hover:bg-accent/50"
                    onClick={() => void openCommit(c)}
                  >
                    <div className="truncate text-xs font-medium">{c.message}</div>
                    <div className="flex gap-2 text-[11px] text-muted-foreground">
                      <span className="font-mono text-primary/80">{c.short_sha}</span>
                      <span className="truncate">{c.author_name}</span>
                      <span className="ml-auto shrink-0">{timeAgo(c.date)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </ScrollArea>

      <Dialog
        open={!!selected || workingDiff}
        onOpenChange={(o) => {
          if (!o) {
            setSelected(null);
            setWorkingDiff(false);
          }
        }}
      >
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="truncate">{selected ? selected.message : "Uncommitted changes"}</DialogTitle>
            <DialogDescription>
              {selected
                ? `${selected.short_sha} · ${selected.author_name} · ${new Date(selected.date).toLocaleString()}`
                : "Working tree compared to the last commit."}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-background">
            {diff === null ? (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading diff…
              </div>
            ) : (
              <DiffView diff={diff} />
            )}
          </div>
          {selected && editable && (
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmRestore(true)}>
                <RotateCcw /> Restore to this version
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmRestore} onOpenChange={setConfirmRestore}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore to {selected?.short_sha}?</AlertDialogTitle>
            <AlertDialogDescription>
              All files will be reset to how they were in this commit, and a new "Restore" commit will be made.
              Uncommitted changes will be overwritten.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void restore();
              }}
              disabled={restoring}
            >
              {restoring && <Loader2 className="animate-spin" />} Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
