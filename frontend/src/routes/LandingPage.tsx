import { Link, useNavigate } from "react-router-dom";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { Logo } from "@/components/Logo";
import { Kbd } from "@/components/Kbd";
import { LangIcon } from "@/components/LangIcon";
import { UserMenu } from "@/components/UserMenu";
import { useTemplates } from "@/hooks/useTemplates";
import { useAuthStore } from "@/stores/auth";

const prefersFinePointer = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches;

export function LandingPage() {
  const user = useAuthStore((s) => s.user);
  const { templates } = useTemplates();
  const navigate = useNavigate();

  const start = (slug: string) => {
    if (user) navigate(`/dashboard?template=${encodeURIComponent(slug)}`);
    else navigate("/register", { state: { template: slug } });
  };

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex h-[38px] shrink-0 items-center gap-3 border-b bg-card px-3">
        <Logo to={user ? "/dashboard" : "/"} />
        <Link to="/explore" className="rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:text-foreground">
          Explore
        </Link>
        <div className="ml-auto">
          <UserMenu />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[42rem] flex-1 px-4 pt-[9vh] pb-16 sm:pt-[13vh]">
        <h1 className="font-display text-[2.25rem] leading-[1.08] font-semibold tracking-[-0.02em] text-balance sm:text-[2.75rem]">
          Type a language.
          <br />
          Get a Linux box.
        </h1>
        <p className="mt-4 max-w-[34rem] text-base text-muted-foreground">
          Replot runs your code in a real container from a browser tab. Every repl comes with a console, a bash
          shell, a web preview, a GUI display, git and live multiplayer.
        </p>

        <CommandPrimitive
          label="Start a repl"
          loop
          className="mt-8 overflow-hidden rounded-lg border bg-popover shadow-md"
        >
          <div className="flex h-12 items-center gap-2.5 border-b px-3.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <CommandPrimitive.Input
              autoFocus={prefersFinePointer()}
              placeholder="Start a repl: try python, flask or rust"
              aria-label="Search languages and frameworks"
              className="h-full w-full bg-transparent text-base outline-none placeholder:text-muted-foreground focus-visible:outline-none"
            />
            <Kbd keys={["enter"]} className="hidden sm:inline-flex" />
          </div>
          <CommandPrimitive.List className="max-h-[17.5rem] overflow-y-auto p-1">
            <CommandPrimitive.Empty className="px-3 py-6 text-sm text-muted-foreground">
              No template by that name. Pick the closest language; every repl has a full shell to install the rest.
            </CommandPrimitive.Empty>
            {!templates && <div className="px-3 py-6 text-sm text-muted-foreground">Loading templates…</div>}
            {(templates ?? []).map((t) => (
              <CommandPrimitive.Item
                key={t.slug}
                value={`${t.name} ${t.slug}`}
                keywords={[t.language, t.category, t.description]}
                onSelect={() => start(t.slug)}
                className="group flex min-h-9 cursor-default items-center gap-3 rounded-md px-2.5 py-1.5 text-sm data-[selected=true]:bg-accent pointer-coarse:min-h-11"
              >
                <LangIcon language={t.language} label={t.name} />
                <span className="w-32 shrink-0 truncate font-medium sm:w-40">{t.name}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{t.description}</span>
                <span className="hidden shrink-0 text-xs text-muted-foreground group-data-[selected=true]:sm:inline">
                  {user ? "Create" : "Sign up and create"}
                </span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.List>
        </CommandPrimitive>

        <p className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-2 text-sm text-muted-foreground pointer-coarse:hidden">
          The same palette runs the whole IDE: press <Kbd keys={["mod", "K"]} /> anywhere.
        </p>
        <p className="mt-10 text-sm text-muted-foreground">
          Not sure what to build?{" "}
          <Link to="/explore" className="text-primary hover:underline">
            Fork a public repl
          </Link>
          .
        </p>
      </main>

      <footer className="flex h-6 shrink-0 items-center gap-4 border-t bg-card px-3 text-xs text-muted-foreground">
        <span>Self-hosted Replot</span>
        {templates && <span className="tabular ml-auto">{templates.length} templates</span>}
      </footer>
    </div>
  );
}
