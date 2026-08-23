"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { isNavigationItemActive, workingNavigationItems } from "@/config/navigation";
import { cn } from "@/lib/utils";

export function MobileBottomNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Nawigacja mobilna" className="mobile-bottom-nav fixed inset-x-0 bottom-0 z-50 border-t bg-surface-elevated/95 px-1 pt-1.5 backdrop-blur-xl lg:hidden">
      <div className="mx-auto grid h-16 max-w-lg grid-cols-5 items-center">
        {workingNavigationItems.map((item) => {
          const Icon = item.icon;
          const active = isNavigationItemActive(pathname, item.href);
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={cn("flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary", active ? "bg-primary/10 text-primary" : "text-muted-foreground active:bg-muted")}
              href={item.href!}
              key={item.href}
            >
              <Icon aria-hidden="true" className="size-5" />
              <span className="max-w-full truncate">{item.title}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
