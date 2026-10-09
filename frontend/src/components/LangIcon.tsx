import { cn } from "@/lib/utils";
import { langAbbr, langAccent, langName } from "@/lib/langAccent";

/**
 * Language chip: two letters on the language accent. Templates pass their own name as
 * `label` so Flask reads "Fl" in Python's color.
 */
export function LangIcon({
  language,
  label,
  className,
}: {
  language: string;
  /** Kept for API compatibility with template emoji icons; dense-pro ignores emoji. */
  icon?: string | null;
  label?: string;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={label ?? langName(language)}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] leading-none font-bold tracking-tight",
        className,
      )}
      style={{ backgroundColor: langAccent(language), color: "#14171d" }}
    >
      {langAbbr(language || "?", label)}
    </span>
  );
}
