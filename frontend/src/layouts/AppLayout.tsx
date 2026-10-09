import { NavLink, Outlet } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { Kbd } from "@/components/Kbd";
import { PaletteTrigger } from "@/components/PaletteTrigger";
import { UserMenu } from "@/components/UserMenu";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";

export function AppLayout() {
  const user = useAuthStore((s) => s.user);
  const link = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex h-7 items-center rounded-md px-2.5 text-sm transition-colors touch-target",
      isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-30 border-b bg-card">
        <div className="flex h-[38px] items-center gap-3 px-3">
          <Logo to={user ? "/dashboard" : "/"} />
          <nav className="flex items-center gap-0.5" aria-label="Main">
            {user && (
              <NavLink to="/dashboard" className={link}>
                My repls
              </NavLink>
            )}
            <NavLink to="/explore" className={link}>
              Explore
            </NavLink>
          </nav>
          <PaletteTrigger label="Search repls, templates and commands" className="ml-auto w-full max-w-sm sm:mx-auto" />
          <div className="flex shrink-0 items-center">
            <UserMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        <Outlet />
      </main>
      <footer className="flex h-6 shrink-0 items-center gap-4 border-t bg-card px-3 text-xs text-muted-foreground">
        <span className="truncate">{user ? `Signed in as @${user.username}` : "Not signed in"}</span>
        <span className="ml-auto hidden items-center gap-1.5 sm:flex">
          <Kbd keys={["mod", "K"]} /> commands
        </span>
      </footer>
    </div>
  );
}
