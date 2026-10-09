import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Loader2, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Kbd } from "@/components/Kbd";
import { LangIcon } from "@/components/LangIcon";
import { ReplTable } from "@/components/ReplCard";
import { useTemplates } from "@/hooks/useTemplates";
import { errorMessage } from "@/lib/api";
import { replsApi } from "@/lib/repls";
import type { Repl } from "@/lib/types";
import { inTextField } from "@/stores/palette";

const QUICK = ["python", "nodejs", "flask", "html-css-js", "react-vite", "go", "rust", "java"];

const matches = (r: Repl, q: string) =>
  !q ||
  r.name.toLowerCase().includes(q) ||
  r.language.toLowerCase().includes(q) ||
  r.template.toLowerCase().includes(q) ||
  r.owner.username.toLowerCase().includes(q);

export function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const paramTemplate = params.get("template");
  const [preset, setPreset] = useState<string | null>(paramTemplate);
  const [createOpen, setCreateOpen] = useState(!!paramTemplate || params.has("new"));
  const [data, setData] = useState<{ owned: Repl[]; shared: Repl[] } | null>(null);
  const [toDelete, setToDelete] = useState<Repl | null>(null);
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { templates } = useTemplates();

  // The palette can send ?template= or ?new=1 while we're already on this page.
  useEffect(() => {
    if (paramTemplate || params.has("new")) {
      setPreset(paramTemplate);
      setCreateOpen(true);
    }
  }, [paramTemplate, params]);

  const load = useCallback(() => {
    replsApi
      .list()
      .then(setData)
      .catch((e) => {
        toast.error(`Couldn't load your repls: ${errorMessage(e)}`);
        setData({ owned: [], shared: [] });
      });
  }, []);

  useEffect(load, [load]);

  // N: new repl, /: filter. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || inTextField(e.target) || document.querySelector("[role=dialog]")) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setPreset(null);
        setCreateOpen(true);
      } else if (e.key === "/") {
        e.preventDefault();
        filterRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const quick = useMemo(
    () => QUICK.map((slug) => templates?.find((t) => t.slug === slug)).filter((t) => !!t),
    [templates],
  );

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

  const openCreate = (slug: string | null) => {
    setPreset(slug);
    setCreateOpen(true);
  };

  const q = filter.trim().toLowerCase();
  const owned = (data?.owned ?? []).filter((r) => matches(r, q));
  const shared = (data?.shared ?? []).filter((r) => matches(r, q));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-xl font-semibold tracking-tight">My repls</h1>
        <Button onClick={() => openCreate(null)} aria-keyshortcuts="N">
          <Plus /> New repl
          <Kbd keys={["N"]} className="-mr-1 hidden opacity-80 sm:inline-flex" />
        </Button>
      </div>

      <section aria-labelledby="quick-start" className="flex flex-wrap items-center gap-1.5">
        <h2 id="quick-start" className="mr-1.5 text-sm text-muted-foreground">
          Start from
        </h2>
        {quick.map((t) => (
          <button
            key={t.slug}
            type="button"
            onClick={() => openCreate(t.slug)}
            className="flex h-7 items-center gap-1.5 rounded-md border bg-card pr-2.5 pl-1 text-sm transition-colors hover:border-[#4a5366] hover:bg-accent touch-target"
          >
            <LangIcon language={t.language} label={t.name} className="size-5 text-[10px]" />
            {t.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => openCreate(null)}
          className="h-7 rounded-md px-2 text-sm text-primary hover:underline touch-target"
        >
          All templates
        </button>
      </section>

      <div className="relative max-w-xs">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={filterRef}
          placeholder="Filter by name, language or owner"
          aria-label="Filter repls"
          className="pr-8 pl-8"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setFilter("")}
        />
        <Kbd keys={["/"]} className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 max-sm:hidden" />
      </div>

      {!data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading your repls…
        </div>
      ) : (
        <>
          {data.owned.length === 0 ? (
            <div className="rounded-md border border-dashed px-6 py-10">
              <p className="font-medium">No repls yet.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Pick a language above, or press <Kbd keys={["N"]} /> to see every template.
              </p>
            </div>
          ) : owned.length === 0 ? (
            <p className="text-sm text-muted-foreground">None of your repls match “{filter}”.</p>
          ) : (
            <ReplTable repls={owned} onFork={fork} onDelete={setToDelete} label="My repls" />
          )}

          <section className="space-y-2" aria-labelledby="shared-heading">
            <h2 id="shared-heading" className="text-[15px] font-semibold">
              Shared with me <span className="tabular font-normal text-muted-foreground">{data.shared.length}</span>
            </h2>
            {data.shared.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                When someone invites you to a repl, it shows up here.
              </p>
            ) : shared.length === 0 ? (
              <p className="text-sm text-muted-foreground">No shared repls match “{filter}”.</p>
            ) : (
              <ReplTable repls={shared} showOwner onFork={fork} label="Shared with me" />
            )}
          </section>
        </>
      )}

      <CreateReplDialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o && (params.has("template") || params.has("new"))) setParams({}, { replace: true });
        }}
        initialTemplate={preset}
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
            <AlertDialogAction className="bg-destructive text-[#1c0a0b] hover:bg-destructive/90" onClick={doDelete}>
              Delete repl
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
