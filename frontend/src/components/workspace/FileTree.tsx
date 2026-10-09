import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PromptDialog, type PromptOptions } from "@/components/PromptDialog";
import { errorMessage } from "@/lib/api";
import { replsApi } from "@/lib/repls";
import type { FileNode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { canEdit, useWorkspace } from "@/stores/workspace";

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children: TreeNode[];
}

function buildTree(files: FileNode[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "dir", children: [] };
  const dirs = new Map<string, TreeNode>([["", root]]);
  const ensureDir = (path: string): TreeNode => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const idx = path.lastIndexOf("/");
    const parent = ensureDir(idx === -1 ? "" : path.slice(0, idx));
    const node: TreeNode = { name: path.slice(idx + 1), path, type: "dir", children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };
  for (const f of files) {
    const path = f.path.replace(/\/+$/, "");
    if (!path) continue;
    if (f.type === "dir") {
      ensureDir(path);
    } else {
      const idx = path.lastIndexOf("/");
      const parent = ensureDir(idx === -1 ? "" : path.slice(0, idx));
      parent.children.push({ name: path.slice(idx + 1), path, type: "file", children: [] });
    }
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

export function FileTree() {
  const repl = useWorkspace((s) => s.repl)!;
  const files = useWorkspace((s) => s.files);
  const filesLoaded = useWorkspace((s) => s.filesLoaded);
  const activePath = useWorkspace((s) => s.activePath);
  const { loadFiles, openFile, onPathRenamed, onPathDeleted } = useWorkspace.getState();
  const editable = canEdit(repl);
  const tree = useMemo(() => buildTree(files), [files]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState<PromptOptions | null>(null);
  const [toDelete, setToDelete] = useState<TreeNode | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadDir = useRef("");

  const refresh = () => loadFiles().catch((e) => toast.error(`Couldn't list files: ${errorMessage(e)}`));

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void loadFiles().catch(() => {}), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repl.id]);

  // Reveal the active file's folders.
  useEffect(() => {
    if (!activePath) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let p = parentOf(activePath);
      while (p) {
        next.add(p);
        p = parentOf(p);
      }
      return next;
    });
  }, [activePath]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const create = (dir: string, type: "file" | "dir") =>
    setPrompt({
      title: type === "file" ? "New file" : "New folder",
      description: dir ? `In ${dir}/` : "In the repl root",
      confirmLabel: "Create",
      onSubmit: async (name) => {
        const path = join(dir, name.replace(/^\/+/, ""));
        try {
          await replsApi.createFile(repl.id, path, type);
          await refresh();
          if (dir) setExpanded((p) => new Set(p).add(dir));
          if (type === "file") openFile(path);
          else setExpanded((p) => new Set(p).add(path));
        } catch (e) {
          toast.error(errorMessage(e));
          throw e;
        }
      },
    });

  const rename = (node: TreeNode) =>
    setPrompt({
      title: `Rename ${node.type === "dir" ? "folder" : "file"}`,
      initial: node.path,
      confirmLabel: "Rename",
      onSubmit: async (to) => {
        if (to === node.path) return;
        try {
          await replsApi.rename(repl.id, node.path, to);
          onPathRenamed(node.path, to);
          await refresh();
        } catch (e) {
          toast.error(errorMessage(e));
          throw e;
        }
      },
    });

  const doDelete = async () => {
    const node = toDelete;
    setToDelete(null);
    if (!node) return;
    try {
      await replsApi.deleteFile(repl.id, node.path);
      onPathDeleted(node.path);
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const startUpload = (dir: string) => {
    uploadDir.current = dir;
    uploadRef.current?.click();
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    for (const f of list) {
      try {
        await replsApi.upload(repl.id, f, uploadDir.current);
      } catch (err) {
        toast.error(`Upload of ${f.name} failed: ${errorMessage(err)}`);
      }
    }
    if (list.length) {
      toast.success(`Uploaded ${list.length} file${list.length > 1 ? "s" : ""}`);
      await refresh();
    }
  };

  const nodeMenu = (node: TreeNode) => {
    const dir = node.type === "dir" ? node.path : parentOf(node.path);
    return [
      { label: "New file", icon: FilePlus, run: () => create(dir, "file") },
      { label: "New folder", icon: FolderPlus, run: () => create(dir, "dir") },
      { label: "Upload here", icon: Upload, run: () => startUpload(dir) },
      null,
      { label: "Rename", icon: Pencil, run: () => rename(node) },
      { label: "Delete", icon: Trash2, run: () => setToDelete(node), destructive: true },
    ];
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const isOpen = expanded.has(node.path);
    const row = (
      <div
        className={cn(
          "group mx-1.5 flex h-8 cursor-pointer items-center gap-1.5 rounded-md pr-1 text-sm text-sidebar-foreground select-none hover:bg-mist/60 md:h-7",
          activePath === node.path && "bg-mist font-medium text-foreground",
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => (node.type === "dir" ? toggle(node.path) : openFile(node.path))}
        title={node.path}
      >
        {node.type === "dir" ? (
          <>
            {isOpen ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
            {isOpen ? (
              <FolderOpen className="size-4 shrink-0 text-primary" />
            ) : (
              <Folder className="size-4 shrink-0 text-primary" />
            )}
          </>
        ) : (
          <>
            <span className="w-3.5 shrink-0" />
            <File className="size-4 shrink-0 text-muted-foreground" />
          </>
        )}
        <span className="truncate">{node.name}</span>
        {editable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${node.name}`}
                className="ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-60">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
              {nodeMenu(node).map((item, i) =>
                item ? (
                  <DropdownMenuItem
                    key={item.label}
                    variant={item.destructive ? "destructive" : "default"}
                    onSelect={item.run}
                  >
                    <item.icon /> {item.label}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuSeparator key={i} />
                ),
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
    return (
      <div key={node.path}>
        {editable ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
            <ContextMenuContent>
              {nodeMenu(node).map((item, i) =>
                item ? (
                  <ContextMenuItem
                    key={item.label}
                    variant={item.destructive ? "destructive" : "default"}
                    onSelect={item.run}
                  >
                    <item.icon /> {item.label}
                  </ContextMenuItem>
                ) : (
                  <ContextMenuSeparator key={i} />
                ),
              )}
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          row
        )}
        {node.type === "dir" && isOpen && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-0.5 px-2">
        <span className="mr-auto" />
        {editable && (
          <>
            <Button variant="ghost" size="icon-xs" title="New file" aria-label="New file" onClick={() => create("", "file")}>
              <FilePlus />
            </Button>
            <Button variant="ghost" size="icon-xs" title="New folder" aria-label="New folder" onClick={() => create("", "dir")}>
              <FolderPlus />
            </Button>
            <Button variant="ghost" size="icon-xs" title="Upload files" aria-label="Upload files" onClick={() => startUpload("")}>
              <Upload />
            </Button>
          </>
        )}
        <Button variant="ghost" size="icon-xs" title="Download as zip" aria-label="Download as zip" asChild>
          <a href={replsApi.downloadUrl(repl.id)} download>
            <Download />
          </a>
        </Button>
        <Button variant="ghost" size="icon-xs" title="Refresh" aria-label="Refresh files" onClick={() => void refresh()}>
          <RefreshCw />
        </Button>
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={!editable}>
          <div className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="py-1">
                {!filesLoaded ? (
                  <div className="px-4 py-2 text-[13px] text-muted-foreground">Loading files…</div>
                ) : tree.length === 0 ? (
                  <div className="px-4 py-2 text-[13px] text-muted-foreground">No files yet. Create one with the + button.</div>
                ) : (
                  tree.map((n) => renderNode(n, 0))
                )}
              </div>
            </ScrollArea>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => create("", "file")}>
            <FilePlus /> New file
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => create("", "dir")}>
            <FolderPlus /> New folder
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => startUpload("")}>
            <Upload /> Upload files
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <input ref={uploadRef} type="file" multiple hidden onChange={onUpload} />
      <PromptDialog prompt={prompt} onClose={() => setPrompt(null)} />
      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {toDelete?.path}?</AlertDialogTitle>
            <AlertDialogDescription>
              {toDelete?.type === "dir" ? "The folder and everything in it will be deleted." : "The file will be deleted."}{" "}
              You can restore it from version control if it was committed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={doDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
