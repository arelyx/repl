import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { ReplTable } from "@/components/ReplCard";
import { errorMessage } from "@/lib/api";
import { replsApi } from "@/lib/repls";
import type { Repl } from "@/lib/types";
import { useAuthStore } from "@/stores/auth";

export function ExplorePage() {
  const [repls, setRepls] = useState<Repl[] | null>(null);
  const [q, setQ] = useState("");
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();

  useEffect(() => {
    replsApi
      .explore()
      .then(setRepls)
      .catch((e) => {
        toast.error(`Couldn't load public repls: ${errorMessage(e)}`);
        setRepls([]);
      });
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (repls ?? []).filter(
      (r) =>
        !s ||
        r.name.toLowerCase().includes(s) ||
        r.language.toLowerCase().includes(s) ||
        r.owner.username.toLowerCase().includes(s),
    );
  }, [repls, q]);

  const fork = async (repl: Repl) => {
    if (!user) {
      navigate("/login");
      return;
    }
    try {
      const forked = await replsApi.fork(repl.id);
      toast.success(`Forked ${repl.name}`);
      navigate(`/repl/${forked.id}`);
    } catch (e) {
      toast.error(`Fork failed: ${errorMessage(e)}`);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight">Explore</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Public repls from everyone on this server. Open one to read it, fork it to run your own copy.
          </p>
        </div>
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter by name, language or owner"
            aria-label="Filter public repls"
            className="pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>
      {!repls ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading public repls…
        </div>
      ) : repls.length === 0 ? (
        <p className="text-sm text-muted-foreground">No public repls yet. Make one of yours public from its Share dialog.</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No public repls match “{q}”.</p>
      ) : (
        <ReplTable repls={filtered} showOwner showRole={false} onFork={fork} label="Public repls" />
      )}
    </div>
  );
}
