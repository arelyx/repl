import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/** A prompt caret inside a tile: the box you type into. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-5", className)} aria-hidden>
      <rect x="1" y="1" width="30" height="30" rx="5" fill="#2c3240" stroke="#82aaff" strokeWidth="2" />
      <path d="M9 11l6 5-6 5" fill="none" stroke="#dce1ea" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="17" y="19" width="7" height="3" rx="1" fill="#f2b544" />
    </svg>
  );
}

export function Logo({ to = "/", className }: { to?: string; className?: string }) {
  return (
    <Link
      to={to}
      className={cn("flex items-center gap-2 rounded-md text-sm font-semibold tracking-tight text-foreground", className)}
    >
      <LogoMark />
      <span>Replot</span>
    </Link>
  );
}
