import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export interface PromptOptions {
  title: string;
  description?: string;
  initial?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void | Promise<void>;
}

export function PromptDialog({ prompt, onClose }: { prompt: PromptOptions | null; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (prompt) setValue(prompt.initial ?? "");
  }, [prompt]);

  const submit = async () => {
    if (!prompt || !value.trim()) return;
    setBusy(true);
    try {
      await prompt.onSubmit(value.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!prompt} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{prompt?.title}</DialogTitle>
          {prompt?.description && <DialogDescription>{prompt.description}</DialogDescription>}
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          onFocus={(e) => {
            const v = e.target.value;
            const slash = v.lastIndexOf("/") + 1;
            const dot = v.lastIndexOf(".");
            e.target.setSelectionRange(slash, dot > slash ? dot : v.length);
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!value.trim() || busy}>
            {prompt?.confirmLabel ?? "OK"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
