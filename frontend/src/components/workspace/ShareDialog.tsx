import { useCallback, useEffect, useState } from "react";
import { Copy, Loader2, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { initials } from "@/components/UserMenu";
import { errorMessage } from "@/lib/api";
import { replsApi } from "@/lib/repls";
import type { Collaborator } from "@/lib/types";
import { useWorkspace } from "@/stores/workspace";

export function ShareDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const repl = useWorkspace((s) => s.repl)!;
  const isOwner = repl.role === "owner";
  const [collabs, setCollabs] = useState<Collaborator[] | null>(null);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("editor");
  const [busy, setBusy] = useState(false);
  const link = `${location.origin}/repl/${repl.id}`;

  const load = useCallback(() => {
    if (!isOwner) return;
    replsApi
      .collaborators(repl.id)
      .then(setCollabs)
      .catch((e) => {
        setCollabs([]);
        toast.error(`Couldn't load collaborators: ${errorMessage(e)}`);
      });
  }, [repl.id, isOwner]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const add = async () => {
    if (!username.trim()) return;
    setBusy(true);
    try {
      await replsApi.addCollaborator(repl.id, username.trim().replace(/^@/, ""), role);
      setUsername("");
      toast.success("Collaborator added");
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (c: Collaborator, newRole: "viewer" | "editor") => {
    try {
      await replsApi.addCollaborator(repl.id, c.user.username, newRole);
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const remove = async (c: Collaborator) => {
    try {
      await replsApi.removeCollaborator(repl.id, c.user.id);
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const togglePublic = async (isPublic: boolean) => {
    try {
      const updated = await replsApi.update(repl.id, { is_public: isPublic });
      useWorkspace.getState().setRepl({ ...repl, ...updated, role: repl.role });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share {repl.name}</DialogTitle>
          <DialogDescription>Invite people to code with you in real time.</DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Input readOnly value={link} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(link);
              toast.success("Link copied");
            }}
          >
            <Copy /> Copy
          </Button>
        </div>

        {isOwner && (
          <>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="share-public">Public</Label>
                <p className="text-xs text-muted-foreground">Anyone with the link can view and fork it.</p>
              </div>
              <Switch id="share-public" checked={repl.is_public} onCheckedChange={togglePublic} />
            </div>
            <Separator />
            <div className="space-y-2">
              <Label>Invite by username</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void add()}
                />
                <Select value={role} onValueChange={(v) => setRole(v as "viewer" | "editor")}>
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="editor">Editor</SelectItem>
                    <SelectItem value="viewer">Viewer</SelectItem>
                  </SelectContent>
                </Select>
                <Button onClick={add} disabled={!username.trim() || busy}>
                  {busy ? <Loader2 className="animate-spin" /> : <UserPlus />} Invite
                </Button>
              </div>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-3 rounded-md p-2">
                <Avatar className="size-7">
                  <AvatarFallback className="bg-primary/20 text-primary">
                    {initials(repl.owner.display_name || repl.owner.username)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 text-sm">
                  {repl.owner.display_name || repl.owner.username}{" "}
                  <span className="text-muted-foreground">@{repl.owner.username}</span>
                </div>
                <span className="text-xs text-muted-foreground">Owner</span>
              </div>
              {collabs === null ? (
                <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Loading…
                </div>
              ) : (
                collabs.map((c) => (
                  <div key={c.user.id} className="flex items-center gap-3 rounded-md p-2 hover:bg-accent/40">
                    <Avatar className="size-7">
                      <AvatarFallback>{initials(c.user.display_name || c.user.username)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1 truncate text-sm">
                      {c.user.display_name || c.user.username}{" "}
                      <span className="text-muted-foreground">@{c.user.username}</span>
                    </div>
                    <Select value={c.role} onValueChange={(v) => void changeRole(c, v as "viewer" | "editor")}>
                      <SelectTrigger size="sm" className="w-24">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="editor">Editor</SelectItem>
                        <SelectItem value="viewer">Viewer</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="ghost" size="icon-sm" title="Remove" onClick={() => void remove(c)}>
                      <Trash2 />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
