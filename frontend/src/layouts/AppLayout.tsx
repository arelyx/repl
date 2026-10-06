import { NavLink, Outlet } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { UserMenu } from "@/components/UserMenu";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";

export function AppLayout() {
  const user = useAuthStore((s) => s.user);
  const link = ({ isActive }: { isActive: boolean }) =>
    cn(
      "rounded-md px-3 py-1.5 text-sm transition-colors",
      isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
          <Logo to={user ? "/dashboard" : "/"} />
          <nav className="flex items-center gap-1">
            {user && (
              <NavLink to="/dashboard" className={link}>
                My repls
              </NavLink>
            )}
            <NavLink to="/explore" className={link}>
              Explore
            </NavLink>
          </nav>
          <div className="ml-auto">
            <UserMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
