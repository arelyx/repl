import { useEffect, useRef } from "react";
import { Eraser } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSocket } from "@/lib/agentSocket";
import { wsBase } from "@/lib/api";
import { useXterm } from "@/hooks/useXterm";
import { canEdit, useWorkspace } from "@/stores/workspace";

/** Console: xterm attached to the shared Run process over /ws/repls/{id}/run. */
export function ConsolePane({ visible }: { visible: boolean }) {
  const repl = useWorkspace((s) => s.repl)!;
  const container = useWorkspace((s) => s.container);
  const runStatus = useWorkspace((s) => s.runStatus);
  const runConnected = useWorkspace((s) => s.runConnected);
  const editable = canEdit(repl);
  const sockRef = useRef<AgentSocket | null>(null);
  const { containerRef, term, fit } = useXterm({
    onResize: (cols, rows) => sockRef.current?.send({ type: "resize", cols, rows }),
  });

  useEffect(() => {
    if (visible) requestAnimationFrame(fit);
  }, [visible, fit]);

  useEffect(() => {
    if (!term || container !== "running") return;
    const { setRunStatus, setRunConnection } = useWorkspace.getState();
    const sock = new AgentSocket(`${wsBase()}/ws/repls/${repl.id}/run`, {
      onMessage: (msg) => {
        if (msg.type === "output" && typeof msg.data === "string") {
          term.write(msg.data);
        } else if (msg.type === "status") {
          setRunStatus({
            running: !!msg.running,
            exitCode: (msg.exitCode as number | null) ?? null,
            command: String(msg.command ?? ""),
          });
        }
      },
      onState: (state) => {
        if (state === "open") {
          // The agent replays scrollback on every connect, so start from a clean screen.
          term.reset();
          sock.send({ type: "resize", cols: term.cols, rows: term.rows });
          setRunConnection(true, (m) => sock.send(m));
        } else if (state === "closed") {
          setRunConnection(false, null);
        }
      },
    });
    sockRef.current = sock;
    const inputSub = term.onData((data) => {
      if (editable) sock.send({ type: "input", data });
    });
    return () => {
      inputSub.dispose();
      sock.dispose();
      sockRef.current = null;
      setRunConnection(false, null);
    };
  }, [term, container, repl.id, editable]);

  let statusText = "Not connected";
  if (container !== "running") statusText = container === "starting" ? "Starting container…" : "Container not running";
  else if (!runConnected) statusText = "Connecting…";
  else if (runStatus?.running) statusText = `Running: ${runStatus.command}`;
  else if (runStatus && runStatus.exitCode !== null) statusText = `Exited with code ${runStatus.exitCode}`;
  else statusText = "Ready. Press Run to start your program.";

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 px-4 text-[13px] text-muted-foreground">
        <span
          aria-hidden
          className={
            "size-2 shrink-0 rounded-full " +
            (runStatus?.running ? "bg-live" : runConnected ? "bg-muted-foreground/60" : "bg-destructive/70")
          }
        />
        <span className="truncate">{statusText}</span>
        <Button variant="ghost" size="icon-xs" className="ml-auto" title="Clear console" aria-label="Clear console" onClick={() => term?.clear()}>
          <Eraser />
        </Button>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 bg-card pl-2" />
    </div>
  );
}
