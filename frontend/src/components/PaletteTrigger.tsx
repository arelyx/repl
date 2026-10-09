import { Search } from "lucide-react";
import { Kbd } from "@/components/Kbd";
import { cn } from "@/lib/utils";
import { usePalette } from "@/stores/palette";

/** The title-bar search field that opens the command palette. Collapses to an icon on phones. */
export function PaletteTrigger({ label, className }: { label: string; className?: string }) {
  const show = usePalette((s) => s.show);
  return (
    <button
      type="button"
      onClick={() => show("commands")}
      aria-label={`${label} (command palette)`}
      aria-keyshortcuts="Control+K Meta+K"
      className={cn(
        "flex h-7 min-w-0 items-center gap-2 rounded-md border border-input bg-background/60 px-2 text-left text-sm text-muted-foreground transition-colors hover:border-[#4a5366] hover:text-foreground",
        "max-sm:size-8 max-sm:justify-center max-sm:border-transparent max-sm:bg-transparent max-sm:px-0",
        className,
      )}
    >
      <Search className="size-3.5 shrink-0" />
      <span className="truncate max-sm:sr-only">{label}</span>
      <Kbd keys={["mod", "K"]} className="ml-auto max-sm:hidden" />
    </button>
  );
}
