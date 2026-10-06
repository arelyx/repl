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
import { ReplCard } from "@/components/ReplCard";
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
    <div className="space-y-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">My repls</h1>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus /> Create repl
        </Button>
      </div>

      {!data ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          {data.owned.length === 0 ? (
            <div className="rounded-lg border border-dashed p-10 text-center">
              <p className="text-muted-foreground">You don't have any repls yet.</p>
              <Button className="mt-4" onClick={() => setCreateOpen(true)}>
                <Plus /> Create your first repl
              </Button>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.owned.map((r) => (
                <ReplCard key={r.id} repl={r} onFork={fork} onDelete={setToDelete} />
              ))}
            </div>
          )}

          <section className="space-y-4">
            <h2 className="text-lg font-semibold">Shared with me</h2>
            {data.shared.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing shared with you yet.</p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {data.shared.map((r) => (
                  <ReplCard key={r.id} repl={r} showOwner onFork={fork} />
                ))}
              </div>
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
