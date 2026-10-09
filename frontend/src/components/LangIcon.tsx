import { cn } from "@/lib/utils";

const COLORS: Record<string, string> = {
  python: "#3572A5",
  nodejs: "#8cc84b",
  javascript: "#f1e05a",
  typescript: "#3178c6",
  java: "#b07219",
  kotlin: "#A97BFF",
  c: "#555555",
  cpp: "#f34b7d",
  csharp: "#178600",
  go: "#00ADD8",
  rust: "#dea584",
  ruby: "#701516",
  php: "#4F5D95",
  lua: "#000080",
  perl: "#0298c3",
  bash: "#89e051",
  haskell: "#5e5086",
  r: "#198CE7",
  fortran: "#4d41b1",
  pascal: "#E3F171",
  nasm: "#6E4C13",
  assembly: "#6E4C13",
  scheme: "#1e4aec",
  "common-lisp": "#3fb68b",
  lisp: "#3fb68b",
  html: "#e34c26",
};

function isEmoji(s: string) {
  return /\p{Extended_Pictographic}/u.test(s);
}

export function langColor(language: string) {
  return COLORS[(language || "").toLowerCase()] ?? "#2D6177";
}

/**
 * Soft language tile: the language's own color diluted into the surface, with a solid swatch along the
 * bottom edge. The label stays in the body color, so it passes contrast whatever the language color is.
 */
export function LangIcon({
  language,
  icon,
  className,
}: {
  language: string;
  icon?: string | null;
  className?: string;
}) {
  const color = langColor(language);
  const tint = { backgroundColor: `color-mix(in oklab, ${color} 18%, var(--card))` };
  if (icon && isEmoji(icon)) {
    return (
      <span
        className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg text-base", className)}
        style={tint}
        aria-hidden
      >
        {icon}
      </span>
    );
  }
  const key = (language || "").toLowerCase();
  const label =
    (key === "cpp" ? "C++" : key === "csharp" ? "C#" : key.charAt(0).toUpperCase() + key.slice(1, 2)) || "?";
  return (
    <span
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg text-[12px] font-semibold text-foreground",
        className,
      )}
      style={tint}
      aria-hidden
    >
      {label}
      <span className="absolute inset-x-0 bottom-0 h-[3px]" style={{ backgroundColor: color }} />
    </span>
  );
}
