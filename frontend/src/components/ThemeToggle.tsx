import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTheme } from "@/stores/theme";

/** Switches between the daylight and dusk themes. */
export function ThemeToggle({ className }: { className?: string }) {
  const mode = useTheme((s) => s.mode);
  const toggle = useTheme((s) => s.toggle);
  const label = mode === "dusk" ? "Switch to daylight" : "Switch to dusk";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label={label} className={cn("text-muted-foreground", className)}>
          {mode === "dusk" ? <Sun /> : <Moon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
