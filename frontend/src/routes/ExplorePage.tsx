import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { ReplListHeader, ReplRow } from "@/components/ReplCard";
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
        toast.error(`Failed to load: ${errorMessage(e)}`);
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
    <div className="space-y-8">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-xl">
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">Explore</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Public repls from people on this server. Open one to read the code, or fork it to make your own copy.
          </p>
        </div>
        <div className="relative sm:w-72">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            placeholder="Search by name, language or owner"
            aria-label="Search public repls"
            className="pl-9"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>
      {!repls ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading public repls…
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-muted-foreground">
          {q.trim() ? `Nothing matches "${q.trim()}". Try a language name.` : "No public repls yet. Make one public from its Share dialog."}
        </p>
      ) : (
        <div className="space-y-1">
          <ReplListHeader />
          <ul className="space-y-1">
            {filtered.map((r) => (
              <ReplRow key={r.id} repl={r} showOwner onFork={fork} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
