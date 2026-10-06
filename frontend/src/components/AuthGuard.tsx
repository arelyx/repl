import { Navigate, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuthStore } from "@/stores/auth";

export function FullPageSpinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex h-full min-h-screen items-center justify-center gap-2 text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, isLoaded } = useAuthStore();
  const location = useLocation();

  if (!isLoaded) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}
