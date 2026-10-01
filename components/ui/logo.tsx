import Image from "next/image";
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
        "group flex min-w-0 items-center gap-3 overflow-hidden rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-muted",
        className,
      )}
      aria-label="Flip Manager by Jakub Okruszek"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-gold/25 bg-surface shadow-[0_8px_24px_-14px_rgba(0,0,0,1)]">
        <Image
          src="/icons/flip-manager-48.png"
          alt=""
          width={48}
          height={48}
          className="h-full w-full object-cover"
          priority
        />
      </span>
      {!collapsed && (
        // Each line has its own row (never a single truncating row) so the
        // full brand name and signature are always fully visible, however
        // narrow the sidebar column is -- a long name wraps to an extra line
        // instead of being clipped with an ellipsis.
        <span className="flex min-w-0 flex-col justify-center gap-0.5" data-testid="product-brand">
          <span className="font-heading text-base font-semibold leading-tight tracking-tight text-foreground">Flip Manager</span>
          <span className="text-[10px] font-medium leading-tight text-muted-foreground">by</span>
          <span className="brand-signature leading-tight" aria-label="Jakub Okruszek">Jakub Okruszek</span>
        </span>
      )}
    </Link>
  );
}
