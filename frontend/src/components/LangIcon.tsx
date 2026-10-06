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

/** Small colored badge for a template/repl language. Uses the template's icon if it's an emoji. */
export function LangIcon({
  language,
  icon,
  className,
}: {
  language: string;
  icon?: string | null;
  className?: string;
}) {
  if (icon && isEmoji(icon)) {
    return (
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-lg", className)}>
        {icon}
      </span>
    );
  }
  const key = (language || "").toLowerCase();
  const color = COLORS[key] ?? "#f26207";
  const label = (key === "cpp" ? "C++" : key === "csharp" ? "C#" : key.slice(0, 2)) || "?";
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md text-[11px] font-bold uppercase text-white",
        className,
      )}
      style={{ backgroundColor: color, textShadow: "0 1px 1px rgba(0,0,0,.4)" }}
    >
      {label}
    </span>
  );
}
