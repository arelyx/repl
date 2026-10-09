import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { CreateReplDialog } from "@/components/CreateReplDialog";
import { ReplListHeader, ReplRow } from "@/components/ReplCard";
import { errorMessage } from "@/lib/api";
import { replsApi } from "@/lib/repls";
import type { Repl } from "@/lib/types";

export function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const initialTemplate = params.get("template");
  const [createOpen, setCreateOpen] = useState(!!initialTemplate);
  const [data, setData] = useState<{ owned: Repl[]; shared: Repl[] } | null>(null);
  const [toDelete, setToDelete] = useState<Repl | null>(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    replsApi
      .list()
      .then(setData)
      .catch((e) => {
        toast.error(`Failed to load repls: ${errorMessage(e)}`);
        setData({ owned: [], shared: [] });
      });
  }, []);

  useEffect(load, [load]);

  const fork = async (repl: Repl) => {
    try {
      const forked = await replsApi.fork(repl.id);
      navigate(`/repl/${forked.id}`);
    } catch (e) {
      toast.error(`Fork failed: ${errorMessage(e)}`);
    }
  };

  const doDelete = async () => {
    if (!toDelete) return;
    try {
      await replsApi.remove(toDelete.id);
      toast.success(`Deleted ${toDelete.name}`);
      load();
    } catch (e) {
      toast.error(`Delete failed: ${errorMessage(e)}`);
    } finally {
      setToDelete(null);
    }
  };

  return (
    <div className="space-y-12">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">Your repls</h1>
          {data && data.owned.length > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">
              {data.owned.length} {data.owned.length === 1 ? "repl" : "repls"}, most recently edited first
            </p>
          )}
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus /> New repl
        </Button>
      </div>

      {!data ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading your repls…
        </div>
      ) : (
        <>
          {data.owned.length === 0 ? (
            <div className="rounded-[18px] bg-card px-6 py-12 text-center sm:px-10">
              <p className="text-lg font-medium">No repls yet</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                Pick a language and you'll have a running container and an editor in a few seconds.
              </p>
              <Button className="mt-6" onClick={() => setCreateOpen(true)}>
                <Plus /> New repl
              </Button>
            </div>
          ) : (
            <div className="space-y-1">
              <ReplListHeader />
              <ul className="space-y-1">
                {[...data.owned]
                  .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
                  .map((r) => (
                    <ReplRow key={r.id} repl={r} onFork={fork} onDelete={setToDelete} />
                  ))}
              </ul>
            </div>
          )}

          <section className="space-y-3">
            <h2 className="text-lg font-semibold tracking-[-0.01em]">Shared with you</h2>
            {data.shared.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                When someone invites you to a repl, it shows up here.
              </p>
            ) : (
              <ul className="space-y-1">
                {data.shared.map((r) => (
                  <ReplRow key={r.id} repl={r} showOwner onFork={fork} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <CreateReplDialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o && initialTemplate) setParams({}, { replace: true });
        }}
        initialTemplate={initialTemplate}
      />

      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {toDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the repl, its files, its history, and its container. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={doDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
