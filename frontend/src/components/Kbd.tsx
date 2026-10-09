import { cn } from "@/lib/utils";
import { isMac } from "@/stores/palette";

const LABELS: Record<string, string> = {
  mod: isMac ? "⌘" : "Ctrl",
  shift: isMac ? "⇧" : "Shift",
  alt: isMac ? "⌥" : "Alt",
  enter: "Enter",
  esc: "Esc",
  up: "↑",
  down: "↓",
};

export const keyLabel = (k: string) => LABELS[k.toLowerCase()] ?? k;

/** Keyboard shortcut hint rendered as keycaps. Hidden from screen readers unless `announce`. */
export function Kbd({ keys, className, announce }: { keys: string[]; className?: string; announce?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} aria-hidden={announce ? undefined : true}>
      {keys.map((k) => (
        <kbd key={k} className="kbd">
          {keyLabel(k)}
        </kbd>
      ))}
    </span>
  );
}
