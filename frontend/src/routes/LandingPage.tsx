import { Link } from "react-router-dom";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { langColor } from "@/components/LangIcon";
import { ThemeToggle } from "@/components/ThemeToggle";
import { UserMenu } from "@/components/UserMenu";
import { useTemplates } from "@/hooks/useTemplates";
import { useAuthStore } from "@/stores/auth";

const FEATURES = [
  {
    title: "A real Linux computer",
    text: "Each repl runs in its own container. Use the console for your program and a full bash shell for everything else.",
  },
  {
    title: "Web preview",
    text: "Start a web server on any port and it opens in the Webview, with a link you can send to someone.",
  },
  {
    title: "Desktop apps in the browser",
    text: "Tkinter, Swing and pygame windows show up in the Display tab, streamed over VNC.",
  },
  {
    title: "Code together",
    text: "Invite people to edit with you and see their cursors live. Commit and roll back with built-in Git.",
  },
];

const today = new Date().toLocaleDateString("en-US", { weekday: "long" });

/** A still picture of a repl: the editor on the left, its console output on the right. */
function ReplScene() {
  const kw = "text-primary";
  const str = "text-live";
  const fn = "text-[var(--syn-fn)]";
  return (
    <div className="grid overflow-hidden rounded-[18px] bg-card md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="flex h-11 items-center gap-3 px-5 text-sm">
          <span className="font-medium">main.py</span>
          <span className="text-muted-foreground">utils.py</span>
          <span className="ml-auto flex h-7 items-center gap-1.5 rounded-md bg-live px-3 text-[13px] font-semibold text-live-foreground">
            <Play className="size-3 fill-current" aria-hidden /> Run
          </span>
        </div>
        <pre className="overflow-hidden px-5 pt-2 pb-6 font-mono text-[13px] leading-[1.7] sm:text-sm">
          <code>
            <span className="text-[var(--syn-comment)] italic"># Say good morning in the local language</span>
            {"\n"}
            <span className={kw}>from</span> datetime <span className={kw}>import</span> date
            {"\n\n"}
            <span className={kw}>def</span> <span className={fn}>greet</span>(name):
            {"\n"}
            {"    "}
            <span className={kw}>return</span> <span className={str}>f"God morgen, {"{"}name{"}"}! It's {"{"}date.today():%A{"}"}."</span>
            {"\n\n"}
            <span className={fn}>print</span>(greet(<span className={str}>"Ada"</span>))
          </code>
        </pre>
      </div>
      <div className="min-w-0 bg-[color-mix(in_oklab,var(--card),var(--frost)_45%)]">
        <div className="flex h-11 items-center gap-4 px-5 text-sm">
          <span className="font-medium">Console</span>
          <span className="text-muted-foreground">Shell</span>
          <span className="text-muted-foreground">Webview</span>
        </div>
        <pre className="overflow-hidden px-5 pt-2 pb-6 font-mono text-[13px] leading-[1.7] sm:text-sm">
          <span className="text-muted-foreground">~/brave-otter $ python main.py</span>
          {"\n"}
          God morgen, Ada! It's {today}.{"\n"}
          <span className="text-muted-foreground">exited with code 0</span>
        </pre>
      </div>
    </div>
  );
}

export function LandingPage() {
  const user = useAuthStore((s) => s.user);
  const { templates } = useTemplates();

  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:gap-8 sm:px-6">
        <Logo />
        <Link to="/explore" className="rounded-md text-sm text-muted-foreground hover:text-foreground">
          Explore
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <UserMenu />
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 pt-12 pb-10 sm:px-6 sm:pt-16 sm:pb-14">
        <h1 className="max-w-[18ch] text-[40px] leading-[1.06] font-medium tracking-[-0.025em] text-balance sm:text-[64px]">
          A quiet place to write and run code.
        </h1>
        <p className="mt-6 max-w-[56ch] text-[17px] leading-relaxed text-muted-foreground">
          Pick a language and Replot starts a real Linux container with an editor, console, shell and web preview. It
          works the same on a laptop, a school Chromebook or a phone.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button size="lg" asChild>
            <Link to={user ? "/dashboard" : "/register"}>{user ? "Open your repls" : "Start coding"}</Link>
          </Button>
          <Button size="lg" variant="ghost" asChild>
            <Link to="/explore">Browse public repls</Link>
          </Button>
        </div>
      </section>

      {/* The waterline: sky above, water below. Everything after the hero sits on the water. */}
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <ReplScene />
      </div>
      <div className="bg-[var(--water)]">
        <div className="waterline-water mx-auto h-[120px] max-w-6xl overflow-hidden px-4 pt-1.5 sm:h-[180px] sm:px-6" aria-hidden>
          <div className="waterline-reflection">
            <ReplScene />
          </div>
        </div>

        <section className="mx-auto grid max-w-6xl gap-x-16 gap-y-10 px-4 pt-6 pb-20 sm:px-6 md:grid-cols-[14rem_1fr]">
          <h2 className="text-xl font-semibold tracking-[-0.01em]">What's in every repl</h2>
          <dl className="grid gap-x-12 gap-y-8 sm:grid-cols-2">
            {FEATURES.map((f) => (
              <div key={f.title} className="max-w-[44ch]">
                <dt className="font-medium">{f.title}</dt>
                <dd className="mt-1.5 text-[15px] leading-relaxed text-muted-foreground">{f.text}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="mx-auto grid max-w-6xl gap-x-16 gap-y-6 px-4 pb-24 sm:px-6 md:grid-cols-[14rem_1fr]">
          <div>
            <h2 className="text-xl font-semibold tracking-[-0.01em]">Start in a language</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {templates ? `${templates.length} templates, each ready to run.` : "Loading templates…"}
            </p>
          </div>
          <ul className="flex flex-wrap gap-x-2 gap-y-2">
            {(templates ?? []).map((t) => (
              <li key={t.slug}>
                <Link
                  to={user ? `/dashboard?template=${encodeURIComponent(t.slug)}` : "/register"}
                  className="flex h-9 items-center gap-2 rounded-full bg-card px-3.5 text-sm transition-colors hover:bg-[color-mix(in_oklab,var(--card),var(--fjord)_8%)]"
                >
                  <span className="size-2 rounded-full" style={{ backgroundColor: langColor(t.language) }} aria-hidden />
                  {t.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 pb-10 text-sm text-muted-foreground sm:px-6">
          <span>Replot runs on your own server. Your code stays there.</span>
        </footer>
      </div>
    </div>
  );
}
