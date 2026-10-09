import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { LangIcon } from "@/components/LangIcon";
import { CATEGORY_LABELS, CATEGORY_ORDER, useTemplates } from "@/hooks/useTemplates";
import { errorMessage } from "@/lib/api";
import { replsApi } from "@/lib/repls";
import { cn } from "@/lib/utils";

const ADJ = ["quick", "brave", "sunny", "witty", "fuzzy", "lucky", "shiny", "cosmic", "gentle", "spicy"];
const NOUN = ["otter", "panda", "falcon", "comet", "pickle", "waffle", "nebula", "cactus", "badger", "tofu"];
const randomName = () =>
  `${ADJ[Math.floor(Math.random() * ADJ.length)]}-${NOUN[Math.floor(Math.random() * NOUN.length)]}-${Math.floor(Math.random() * 100)}`;

export function CreateReplDialog({
  open,
  onOpenChange,
  initialTemplate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTemplate?: string | null;
}) {
  const { templates, error } = useTemplates();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(initialTemplate ?? null);
  const [name, setName] = useState(randomName);
  const [isPublic, setIsPublic] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(randomName());
      setQuery("");
      setSelected(initialTemplate ?? null);
    }
  }, [open, initialTemplate]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (templates ?? []).filter(
      (t) =>
        !q ||
        t.name.toLowerCase().includes(q) ||
        t.language.toLowerCase().includes(q) ||
        t.slug.includes(q) ||
        t.description.toLowerCase().includes(q),
    );
    const cats = [...CATEGORY_ORDER, ...new Set(list.map((t) => t.category))].filter(
      (c, i, a) => a.indexOf(c) === i,
    );
    return cats
      .map((c) => ({ category: c, items: list.filter((t) => t.category === c) }))
      .filter((g) => g.items.length > 0);
  }, [templates, query]);

  const create = async () => {
    if (!selected || !name.trim()) return;
    setBusy(true);
    try {
      const repl = await replsApi.create({ name: name.trim(), template: selected, is_public: isPublic });
      onOpenChange(false);
      navigate(`/repl/${repl.id}`);
    } catch (e) {
      toast.error(`Couldn't create repl: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold tracking-[-0.01em]">New repl</DialogTitle>
          <DialogDescription>Pick a template and give it a name. Double-click a template to create it right away.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            placeholder="Search languages and frameworks"
            aria-label="Search templates"
            className="pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <ScrollArea className="h-[45vh] rounded-[14px] bg-background">
          <div className="space-y-6 p-3 sm:p-4">
            {error && <p className="text-sm text-destructive">Failed to load templates: {error}</p>}
            {!templates && !error && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading templates…
              </div>
            )}
            {templates && grouped.length === 0 && (
              <p className="text-sm text-muted-foreground">No templates match "{query}".</p>
            )}
            {grouped.map((g) => (
              <div key={g.category}>
                <div className="mb-2 px-1 text-sm font-medium text-muted-foreground">
                  {CATEGORY_LABELS[g.category] ?? g.category}
                </div>
                <div className="grid grid-cols-1 gap-1.5 min-[420px]:grid-cols-2 md:grid-cols-3">
                  {g.items.map((t) => (
                    <button
                      key={t.slug}
                      type="button"
                      aria-pressed={selected === t.slug}
                      onClick={() => setSelected(t.slug)}
                      onDoubleClick={() => {
                        setSelected(t.slug);
                        void create();
                      }}
                      className={cn(
                        "flex items-center gap-3 rounded-[10px] bg-card p-2.5 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--card),var(--fjord)_6%)]",
                        selected === t.slug && "bg-[color-mix(in_oklab,var(--card),var(--fjord)_12%)] ring-2 ring-primary ring-inset",
                      )}
                    >
                      <LangIcon language={t.language} icon={t.icon} />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{t.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{t.description}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <Label htmlFor="repl-name">Name</Label>
            <Input
              id="repl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void create()}
            />
          </div>
          <div className="flex h-9 items-center gap-2">
            <Switch id="repl-public" checked={isPublic} onCheckedChange={setIsPublic} />
            <Label htmlFor="repl-public">Public</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={create} disabled={!selected || !name.trim() || busy}>
            {busy && <Loader2 className="animate-spin" />} Create repl
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
