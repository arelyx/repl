import { useEffect, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSocket, type SocketState } from "@/lib/agentSocket";
import { wsBase } from "@/lib/api";
import { useXterm } from "@/hooks/useXterm";
import { canEdit, useWorkspace } from "@/stores/workspace";

/** Shell: a fresh bash PTY per connection on /ws/repls/{id}/shell. */
export function ShellPane({ visible }: { visible: boolean }) {
  const repl = useWorkspace((s) => s.repl)!;
  const container = useWorkspace((s) => s.container);
  const editable = canEdit(repl);
  const sockRef = useRef<AgentSocket | null>(null);
  const [state, setState] = useState<SocketState>("closed");
  const [session, setSession] = useState(0);
  const { containerRef, term, fit } = useXterm({
    onResize: (cols, rows) => sockRef.current?.send({ type: "resize", cols, rows }),
  });

  useEffect(() => {
    if (visible) requestAnimationFrame(fit);
  }, [visible, fit]);

  useEffect(() => {
    if (!term || !editable || container !== "running") return;
    term.reset();
    // No auto-reconnect: each connection is a new bash session; the user reconnects explicitly.
    const sock = new AgentSocket(
      `${wsBase()}/ws/repls/${repl.id}/shell`,
      {
        onMessage: (msg) => {
          if (msg.type === "output" && typeof msg.data === "string") term.write(msg.data);
        },
        onState: (s) => {
          setState(s);
          if (s === "open") {
            sock.send({ type: "resize", cols: term.cols, rows: term.rows });
            term.focus();
          } else if (s === "closed") {
            term.write("\r\n\x1b[90m[shell disconnected — click Reconnect]\x1b[0m\r\n");
          }
        },
      },
      { reconnect: false },
    );
    sockRef.current = sock;
    const sub = term.onData((data) => sock.send({ type: "input", data }));
    return () => {
      sub.dispose();
      sock.dispose();
      sockRef.current = null;
    };
  }, [term, editable, container, repl.id, session]);

  if (!editable) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Only editors can use the shell. Fork this repl to get your own.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs text-muted-foreground">
        <span
          className={
            "size-2 rounded-full " +
            (state === "open" ? "bg-green-500" : state === "connecting" ? "bg-yellow-500" : "bg-red-500/70")
          }
        />
        <span>
          {container !== "running"
            ? "Waiting for container…"
            : state === "open"
              ? "bash"
              : state === "connecting"
                ? "Connecting…"
                : "Disconnected"}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          onClick={() => setSession((n) => n + 1)}
          disabled={container !== "running"}
        >
          <RotateCw /> Reconnect
        </Button>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 bg-background" />
    </div>
  );
}
