import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/** A letter P resting on a waterline, with its reflection below. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-6 shrink-0", className)} aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--fjord)" />
      <path d="M11 5h6.5a5 5 0 0 1 0 10H14v2h-3z" fill="var(--snow)" />
      <rect x="6" y="18.25" width="20" height="1.5" rx=".75" fill="var(--lichen)" className="dark:fill-[var(--frost)]" />
      <path d="M11 27h6.5a5 5 0 0 0 0-6H14v-.5h-3z" fill="var(--snow)" opacity=".35" />
    </svg>
  );
}

export function Logo({ to = "/", className }: { to?: string; className?: string }) {
  return (
    <Link
      to={to}
      className={cn("flex items-center gap-2 rounded-md text-[17px] font-semibold tracking-[-0.01em]", className)}
    >
      <LogoMark />
      <span>Replot</span>
    </Link>
  );
}
