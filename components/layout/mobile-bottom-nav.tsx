"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, LayoutDashboard, LineChart, Menu, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";

const items = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Flip Finder", href: "/flip-finder", icon: Sparkles },
  { label: "CRM", href: "/properties", icon: Building2 },
  { label: "Rynek", href: "/market", icon: LineChart },
  { label: "Więcej", href: "/settings", icon: Menu },
] as const;

export function MobileBottomNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Nawigacja mobilna" className="mobile-bottom-nav fixed inset-x-0 bottom-0 z-50 border-t bg-surface-elevated/95 px-1 pt-1.5 backdrop-blur-xl lg:hidden">
      <div className="mx-auto grid h-16 max-w-lg grid-cols-5 items-center">
        {items.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return <Link aria-current={active ? "page" : undefined} key={item.href} href={item.href} className={cn("flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary", active ? "bg-primary/10 text-primary" : "text-muted-foreground active:bg-muted")}><Icon className="size-5" aria-hidden="true" /><span className="max-w-full truncate">{item.label}</span></Link>;
        })}
      </div>
    </nav>
  );
}
