import { NavLink, Outlet } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { UserMenu } from "@/components/UserMenu";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";

export function AppLayout() {
  const user = useAuthStore((s) => s.user);
  const link = ({ isActive }: { isActive: boolean }) =>
    cn(
      "rounded-md px-3 py-1.5 text-sm transition-colors",
      isActive ? "bg-snow font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-30 bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:gap-8 sm:px-6">
          <Logo to={user ? "/dashboard" : "/"} />
          <nav className="flex items-center gap-1">
            {user && (
              <NavLink to="/dashboard" className={link}>
                Your repls
              </NavLink>
            )}
            <NavLink to="/explore" className={link}>
              Explore
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-16 sm:px-6 sm:pt-10">
        <Outlet />
      </main>
    </div>
  );
}
