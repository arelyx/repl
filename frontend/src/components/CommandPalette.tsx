import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Compass, File, FolderGit2, Home, LayoutGrid, LogIn, LogOut, Plus, UserPlus } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd } from "@/components/Kbd";
import { LangIcon } from "@/components/LangIcon";
import { useTemplates } from "@/hooks/useTemplates";
import { replsApi } from "@/lib/repls";
import type { Repl } from "@/lib/types";
import { useAuthStore } from "@/stores/auth";
import { GROUP_ORDER, modKey, usePalette, type PaletteCommand } from "@/stores/palette";
import { useWorkspace } from "@/stores/workspace";

/** Opens on Ctrl/⌘ K, Ctrl/⌘ Shift P and F1; Ctrl/⌘ P jumps straight to files. */
function usePaletteHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const { show, open, setOpen } = usePalette.getState();
      let mode: "commands" | "files" | null = null;
      if (e.key === "F1") mode = "commands";
      else if (modKey(e) && !e.altKey && k === "k" && !e.shiftKey) mode = "commands";
      else if (modKey(e) && !e.altKey && k === "p" && e.shiftKey) mode = "commands";
      else if (modKey(e) && !e.altKey && k === "p" && !e.shiftKey) mode = useWorkspace.getState().repl ? "files" : "commands";
      if (!mode) return;
      e.preventDefault();
      e.stopPropagation();
      if (open && usePalette.getState().mode === mode) setOpen(false);
      else show(mode);
    };
    // Capture phase so Monaco's own Ctrl+K chord handling never sees it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

export function CommandPalette() {
  usePaletteHotkeys();
  const open = usePalette((s) => s.open);
  const mode = usePalette((s) => s.mode);
  const setOpen = usePalette((s) => s.setOpen);
  const sources = usePalette((s) => s.sources);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const files = useWorkspace((s) => s.files);
  const inRepl = useWorkspace((s) => !!s.repl);
  const { templates } = useTemplates();
  const navigate = useNavigate();
  const [repls, setRepls] = useState<Repl[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    if (user) replsApi.list().then((d) => setRepls([...d.owned, ...d.shared])).catch(() => setRepls([]));
  }, [open, user]);

  const groups = useMemo(() => {
    const cmds: PaletteCommand[] = [];
    if (mode === "files" || inRepl) {
      for (const f of files) {
        if (f.type !== "file") continue;
        const name = f.path.split("/").pop() ?? f.path;
        const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
        cmds.push({
          id: `file:${f.path}`,
          title: name,
          group: "Files",
          hint: dir,
          keywords: [f.path],
          icon: File,
          run: () => useWorkspace.getState().openFile(f.path),
        });
      }
    }
    if (mode === "commands") {
      for (const list of Object.values(sources)) cmds.push(...list);
      cmds.push(
        { id: "go:home", title: "Home", group: "Go to", icon: Home, run: () => navigate("/") },
        { id: "go:explore", title: "Explore public repls", group: "Go to", icon: Compass, run: () => navigate("/explore") },
      );
      if (user) {
        cmds.push(
          { id: "go:dashboard", title: "My repls", group: "Go to", icon: LayoutGrid, run: () => navigate("/dashboard") },
          { id: "repl:new", title: "New repl…", group: "Start a repl", icon: Plus, keywords: ["create"], run: () => navigate("/dashboard?new=1") },
          {
            id: "account:logout",
            title: "Log out",
            group: "Account",
            icon: LogOut,
            run: async () => {
              await logout();
              navigate("/");
            },
          },
        );
        for (const r of repls ?? []) {
          cmds.push({
            id: `open:${r.id}`,
            title: r.name,
            group: "Your repls",
            hint: r.role === "owner" ? r.template : `@${r.owner.username}`,
            keywords: [r.language, r.template, "open"],
            lead: <LangIcon language={r.language} className="size-5 text-[10px]" />,
            icon: FolderGit2,
            run: () => navigate(`/repl/${r.id}`),
          });
        }
      } else {
        cmds.push(
          { id: "account:login", title: "Log in", group: "Account", icon: LogIn, run: () => navigate("/login") },
          { id: "account:register", title: "Create an account", group: "Account", icon: UserPlus, run: () => navigate("/register") },
        );
      }
      for (const t of templates ?? []) {
        cmds.push({
          id: `tpl:${t.slug}`,
          title: `New ${t.name} repl`,
          group: "Start a repl",
          hint: t.description,
          keywords: [t.language, t.slug, "create", "new"],
          lead: <LangIcon language={t.language} label={t.name} className="size-5 text-[10px]" />,
          run: () => navigate(user ? `/dashboard?template=${encodeURIComponent(t.slug)}` : "/register"),
        });
      }
    }
    const byGroup = new Map<string, PaletteCommand[]>();
    for (const c of cmds) {
      if (!byGroup.has(c.group)) byGroup.set(c.group, []);
      byGroup.get(c.group)!.push(c);
    }
    const order = (g: string) => {
      const i = GROUP_ORDER.indexOf(g);
      return i === -1 ? GROUP_ORDER.length : i;
    };
    return [...byGroup.entries()].sort((a, b) => order(a[0]) - order(b[0]));
  }, [mode, inRepl, files, sources, user, repls, templates, navigate, logout]);

  // Without a query, keep long groups short so the palette opens on actions, not a wall of files.
  const trimmed = !query.trim();

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={mode === "files" ? "Go to file" : "Command palette"}
      description={mode === "files" ? "Search the files in this repl" : "Search commands, files and repls"}
      className="sm:max-w-[620px]"
      commandProps={{ loop: true }}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={mode === "files" ? "Go to file by name" : "Type a command, file, repl or language"}
        trailing={<Kbd keys={["esc"]} className="hidden sm:inline-flex" />}
      />
      <CommandList>
        <CommandEmpty>Nothing matches “{query}”. Try a file name, a language or a command like “run”.</CommandEmpty>
        {groups.map(([group, items]) => (
          <CommandGroup key={group} heading={group}>
            {(trimmed && (group === "Start a repl" || group === "Files" && mode === "commands") ? items.slice(0, 6) : items).map((c) => (
              <CommandItem
                key={c.id}
                value={`${c.title} ${c.id}`}
                keywords={c.keywords}
                disabled={c.disabled}
                onSelect={() => {
                  setOpen(false);
                  // Let the dialog close and return focus before the command moves it.
                  requestAnimationFrame(() => c.run());
                }}
              >
                {c.lead ?? (c.icon ? <c.icon /> : <span className="size-4" />)}
                <span className="truncate">{c.title}</span>
                {c.hint && <span className="min-w-0 truncate text-xs text-muted-foreground">{c.hint}</span>}
                {c.shortcut && (
                  <CommandShortcut>
                    <Kbd keys={c.shortcut} />
                  </CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      <div className="hidden items-center gap-4 border-t px-3 py-1.5 text-xs text-muted-foreground sm:flex">
        <span className="flex items-center gap-1.5">
          <Kbd keys={["up"]} />
          <Kbd keys={["down"]} /> move
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd keys={["enter"]} /> run
        </span>
        {mode === "commands" && inRepl && (
          <span className="ml-auto flex items-center gap-1.5">
            <Kbd keys={["mod", "P"]} /> files only
          </span>
        )}
      </div>
    </CommandDialog>
  );
}
