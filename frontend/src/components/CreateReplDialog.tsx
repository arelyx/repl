import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Command as CommandPrimitive } from "cmdk";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Kbd } from "@/components/Kbd";
import { LangIcon } from "@/components/LangIcon";
import { CATEGORY_LABELS, CATEGORY_ORDER, useTemplates } from "@/hooks/useTemplates";
import { errorMessage } from "@/lib/api";
import { langName } from "@/lib/langAccent";
import { replsApi } from "@/lib/repls";

const ADJ = ["quick", "brave", "sunny", "witty", "fuzzy", "lucky", "shiny", "cosmic", "gentle", "spicy"];
const NOUN = ["otter", "panda", "falcon", "comet", "pickle", "waffle", "nebula", "cactus", "badger", "tofu"];
const randomName = () =>
  `${ADJ[Math.floor(Math.random() * ADJ.length)]}-${NOUN[Math.floor(Math.random() * NOUN.length)]}-${Math.floor(Math.random() * 100)}`;

/**
 * Template picker in the palette idiom: type to filter, arrows to choose, Enter to create.
 */
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
  const [selected, setSelected] = useState<string>(initialTemplate ?? "");
  const [name, setName] = useState(randomName);
  const [isPublic, setIsPublic] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(randomName());
      setSelected(initialTemplate ?? templates?.[0]?.slug ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTemplate]);

  useEffect(() => {
    if (open && !selected && templates?.length) setSelected(templates[0]!.slug);
  }, [open, selected, templates]);

  const grouped = useMemo(() => {
    const list = templates ?? [];
    const cats = [...CATEGORY_ORDER, ...new Set(list.map((t) => t.category))].filter((c, i, a) => a.indexOf(c) === i);
    return cats
      .map((c) => ({ category: c, items: list.filter((t) => t.category === c) }))
      .filter((g) => g.items.length > 0);
  }, [templates]);

  const tpl = templates?.find((t) => t.slug === selected) ?? null;

  const create = async (slug = selected) => {
    if (!slug || !name.trim() || busy) return;
    setBusy(true);
    try {
      const repl = await replsApi.create({ name: name.trim(), template: slug, is_public: isPublic });
      onOpenChange(false);
      navigate(`/repl/${repl.id}`);
    } catch (e) {
      toast.error(`Couldn't create the repl: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-4 py-3 text-left">
          <DialogTitle className="text-[15px]">New repl</DialogTitle>
          <DialogDescription className="text-xs">
            Pick a template and name it. From the keyboard: type to filter, arrows to choose, Enter to create.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <CommandPrimitive
            label="Templates"
            value={selected}
            onValueChange={setSelected}
            loop
            className="flex min-h-0 flex-1 flex-col sm:border-r"
          >
            <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <CommandPrimitive.Input
                autoFocus
                placeholder="Search languages and frameworks"
                aria-label="Search templates"
                className="h-full w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground focus-visible:outline-none"
              />
            </div>
            <CommandPrimitive.List className="h-[34dvh] overflow-y-auto p-1 sm:h-[46dvh] [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground">
              {error && <p className="p-3 text-sm text-destructive">Couldn't load templates: {error}</p>}
              {!templates && !error && (
                <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Loading templates…
                </div>
              )}
              <CommandPrimitive.Empty className="p-3 text-sm text-muted-foreground">
                No template matches. Pick the closest language; the shell can install the rest.
              </CommandPrimitive.Empty>
              {grouped.map((g) => (
                <CommandPrimitive.Group key={g.category} heading={CATEGORY_LABELS[g.category] ?? g.category}>
                  {g.items.map((t) => (
                    <CommandPrimitive.Item
                      key={t.slug}
                      value={t.slug}
                      keywords={[t.name, t.language, t.description]}
                      onSelect={() => void create(t.slug)}
                      className="flex min-h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 py-1 text-sm data-[selected=true]:bg-accent pointer-coarse:min-h-10"
                    >
                      <LangIcon language={t.language} label={t.name} className="size-5 text-[10px]" />
                      <span className="w-28 shrink-0 truncate font-medium">{t.name}</span>
                      <span className="min-w-0 truncate text-xs text-muted-foreground">{t.description}</span>
                    </CommandPrimitive.Item>
                  ))}
                </CommandPrimitive.Group>
              ))}
            </CommandPrimitive.List>
          </CommandPrimitive>

          <div className="flex shrink-0 flex-col gap-4 border-t p-4 sm:w-64 sm:border-t-0">
            {tpl && (
              <div className="hidden space-y-1.5 sm:block">
                <div className="flex items-center gap-2">
                  <LangIcon language={tpl.language} label={tpl.name} />
                  <div className="min-w-0">
                    <div className="truncate font-medium">{tpl.name}</div>
                    {langName(tpl.language) !== tpl.name && (
                      <div className="text-xs text-muted-foreground">{langName(tpl.language)}</div>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{tpl.description}</p>
                <p className="text-xs text-muted-foreground">
                  Run command <code className="font-mono text-foreground">{tpl.run}</code>
                </p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="repl-name">Name</Label>
              <Input
                id="repl-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void create()}
              />
            </div>
            <div className="flex items-start gap-2.5">
              <Switch id="repl-public" checked={isPublic} onCheckedChange={setIsPublic} aria-describedby="repl-public-help" />
              <div>
                <Label htmlFor="repl-public">Public</Label>
                <p id="repl-public-help" className="text-xs text-muted-foreground">
                  Anyone can view and fork it.
                </p>
              </div>
            </div>
            <Button className="mt-auto w-full" onClick={() => void create()} disabled={!selected || !name.trim() || busy}>
              {busy && <Loader2 className="animate-spin" />}
              {tpl ? `Create ${tpl.name} repl` : "Create repl"}
              <Kbd keys={["enter"]} className="ml-auto hidden opacity-80 sm:inline-flex" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
