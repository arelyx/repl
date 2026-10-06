import { useState } from "react";
import { Monitor, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canEdit, useWorkspace } from "@/stores/workspace";

/** Display: the container's X display via noVNC. Only mounted once the tab is first shown. */
export function DisplayPane() {
  const repl = useWorkspace((s) => s.repl)!;
  const container = useWorkspace((s) => s.container);
  const [nonce, setNonce] = useState(0);
  const id = repl.id;
  const src = `/ws/repls/${id}/vnc/vnc.html?autoconnect=1&resize=remote&reconnect=1&path=ws/repls/${id}/vnc/websockify`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs text-muted-foreground">
        <Monitor className="size-3.5" /> Display (1280×720)
        <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setNonce((n) => n + 1)}>
          <RotateCw /> Reload
        </Button>
      </div>
      {!canEdit(repl) ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          Only editors can view the display.
        </div>
      ) : container !== "running" ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          Waiting for container…
        </div>
      ) : (
        <iframe key={nonce} src={src} title="Display" className="min-h-0 flex-1 border-0 bg-black" />
      )}
    </div>
  );
}
