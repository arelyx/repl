import { cn } from "@/lib/utils";

/** Renders a unified diff with colored +/- lines and file headers. */
export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return <div className="p-4 text-sm text-muted-foreground">No changes.</div>;
  }
  const lines = diff.replace(/\n$/, "").split("\n");
  return (
    <pre className="font-mono text-xs leading-5">
      {lines.map((line, i) => {
        let cls = "text-muted-foreground";
        if (line.startsWith("diff --git")) cls = "mt-3 border-t bg-muted/60 font-semibold text-foreground first:mt-0 first:border-t-0";
        else if (line.startsWith("+++") || line.startsWith("---")) cls = "text-foreground/80 font-semibold";
        else if (line.startsWith("@@")) cls = "bg-sky-500/10 text-sky-400";
        else if (line.startsWith("+")) cls = "bg-green-500/15 text-green-400";
        else if (line.startsWith("-")) cls = "bg-red-500/15 text-red-400";
        else if (/^(index|new file|deleted file|similarity|rename|Binary)/.test(line)) cls = "text-muted-foreground/70";
        else cls = "text-foreground/80";
        return (
          <div key={i} className={cn("px-3 whitespace-pre-wrap break-all", cls)}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
