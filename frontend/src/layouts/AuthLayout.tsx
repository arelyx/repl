import { Link, Outlet } from "react-router-dom";
import { Logo } from "@/components/Logo";

export function AuthLayout() {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex h-[38px] shrink-0 items-center gap-3 border-b bg-card px-3">
        <Logo />
        <Link to="/explore" className="ml-auto rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:text-foreground">
          Explore
        </Link>
      </header>
      <main className="flex flex-1 justify-center px-4 pt-[12vh] pb-12">
        <div className="w-full max-w-[22rem]">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
