import Link from "next/link";

import { cn } from "@/lib/utils";

type LogoProps = {
  collapsed?: boolean;
  className?: string;
};

export function Logo({ collapsed = false, className }: LogoProps) {
  return (
    <Link
      href="/dashboard"
      className={cn(
        "group flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-muted",
        className,
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-gold/25 bg-gold/10 text-gold shadow-[0_8px_24px_-14px_rgba(0,0,0,1)]">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <path
            d="M7 16L12 6L17 16H7Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <path
            d="M9.5 13H14.5"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      </span>
      {!collapsed && (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-heading text-base font-semibold tracking-tight text-foreground">
            Flip Manager
          </span>
          <span className="truncate text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Investment OS
          </span>
        </span>
      )}
    </Link>
  );
}
