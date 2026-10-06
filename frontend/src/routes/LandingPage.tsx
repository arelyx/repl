import { Link } from "react-router-dom";
import { ArrowRight, Globe, Monitor, Terminal, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { LangIcon } from "@/components/LangIcon";
import { UserMenu } from "@/components/UserMenu";
import { useTemplates } from "@/hooks/useTemplates";
import { useAuthStore } from "@/stores/auth";

const FEATURES = [
  { icon: Terminal, title: "A real Linux box", text: "Every repl gets its own container with a console and a full bash shell." },
  { icon: Globe, title: "Instant web hosting", text: "Start any web server and it shows up in the Webview with a shareable URL." },
  { icon: Monitor, title: "GUI apps too", text: "Tkinter, Swing and pygame render right in your browser over VNC." },
  { icon: Users, title: "Multiplayer", text: "Code together in real time and see each other's cursors. Git built in." },
];

export function LandingPage() {
  const user = useAuthStore((s) => s.user);
  const { templates } = useTemplates();

  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4">
        <Logo />
        <Link to="/explore" className="text-sm text-muted-foreground hover:text-foreground">
          Explore
        </Link>
        <div className="ml-auto">
          <UserMenu />
        </div>
      </header>

      <section className="mx-auto max-w-4xl px-4 pt-20 pb-16 text-center">
        <h1 className="text-5xl font-bold tracking-tight md:text-6xl">
          Code, run, and share
          <br />
          <span className="text-primary">from your browser.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
          Replot is an online IDE with a real computer behind it. Pick a language, hit Run, and you're
          live. No setup, no installs.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Button size="lg" asChild>
            <Link to={user ? "/dashboard" : "/register"}>
              {user ? "Go to your repls" : "Start coding"} <ArrowRight />
            </Link>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <Link to="/explore">Explore repls</Link>
          </Button>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-16 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-lg border bg-card p-5">
            <f.icon className="mb-3 size-5 text-primary" />
            <h3 className="font-semibold">{f.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{f.text}</p>
          </div>
        ))}
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-24">
        <h2 className="mb-6 text-center text-2xl font-semibold">Pick a language. Any language.</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {(templates ?? []).map((t) => (
            <Link
              key={t.slug}
              to={user ? `/dashboard?template=${encodeURIComponent(t.slug)}` : "/register"}
              className="flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:border-primary/60"
            >
              <LangIcon language={t.language} icon={t.icon} />
              <span className="truncate text-sm font-medium">{t.name}</span>
            </Link>
          ))}
          {!templates &&
            Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg border bg-card" />
            ))}
        </div>
      </section>
      <footer className="border-t py-6 text-center text-xs text-muted-foreground">
        Replot · a self-hosted, 2020-flavored Replit clone
      </footer>
    </div>
  );
}
