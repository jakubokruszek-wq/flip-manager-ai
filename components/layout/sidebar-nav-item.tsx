"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import type { NavItem } from "@/types/navigation";

type SidebarNavItemProps = {
  item: NavItem;
  onNavigate?: () => void;
};

export function SidebarNavItem({ item, onNavigate }: SidebarNavItemProps) {
  const pathname = usePathname();
  const Icon = item.icon;
  const isActive = item.href ? pathname === item.href || pathname.startsWith(`${item.href}/`) : false;

  const itemClassName = cn(
    "group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
    isActive
      ? "bg-gold/10 text-foreground ring-1 ring-gold/15"
      : "text-muted-foreground hover:bg-surface-hover/70 hover:text-foreground",
    item.disabled && "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground",
  );

  const content = (
    <>
      <Icon
        className={cn(
          "h-4 w-4 shrink-0",
          isActive ? "text-gold" : "text-muted-foreground group-hover:text-gold",
        )}
        aria-hidden="true"
      />
      <span className="truncate">{item.title}</span>
    </>
  );

  if (item.disabled || !item.href) {
    return (
      <span aria-disabled="true" className={itemClassName}>
        {content}
      </span>
    );
  }

  return (
    <Link href={item.href} onClick={onNavigate} className={itemClassName}>
      {content}
    </Link>
  );
}
