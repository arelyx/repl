import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { replsApi } from "@/lib/repls";
import { useAuthStore } from "@/stores/auth";
import { canEdit, useWorkspace } from "@/stores/workspace";

/** Run/Stop and Fork for the open repl, shared by the title bar, the palette and the hotkeys. */
export function useRunControl(onStartContainer: () => void) {
  const repl = useWorkspace((s) => s.repl)!;
  const container = useWorkspace((s) => s.container);
  const runStatus = useWorkspace((s) => s.runStatus);
  const runConnected = useWorkspace((s) => s.runConnected);
  const runSend = useWorkspace((s) => s.runSend);
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const editable = canEdit(repl);
  const [pending, setPending] = useState(false);
  const [forking, setForking] = useState(false);

  useEffect(() => setPending(false), [runStatus]);

  const running = !!runStatus?.running;
  const disabled = !editable || container === "starting" || (container === "running" && !runConnected) || pending;

  const run = () => {
    if (disabled) return;
    if (container !== "running") {
      onStartContainer();
      return;
    }
    const ws = useWorkspace.getState();
    if (!running) ws.setToolTab(repl.config?.gui ? "display" : "console");
    if (runSend?.({ type: running ? "stop" : "start" })) {
      setPending(true);
      setTimeout(() => setPending(false), 4000);
    } else {
      toast.error("The console isn't connected yet. Try again in a moment.");
    }
  };

  const fork = async () => {
    if (!user) {
      navigate("/login", { state: { from: { pathname: `/repl/${repl.id}` } } });
      return;
    }
    setForking(true);
    try {
      const forked = await replsApi.fork(repl.id);
      toast.success(`Forked into ${forked.name}`);
      navigate(`/repl/${forked.id}`);
    } catch (e) {
      toast.error(`Fork failed: ${errorMessage(e)}`);
    } finally {
      setForking(false);
    }
  };

  return { run, running, pending, disabled, editable, fork, forking };
}

export type RunControl = ReturnType<typeof useRunControl>;
