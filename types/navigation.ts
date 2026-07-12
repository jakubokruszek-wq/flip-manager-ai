import type { LucideIcon } from "lucide-react";

export type NavItem = {
  title: string;
  icon: LucideIcon;
  href?: string;
  disabled?: boolean;
};

export type NavSection = {
  label?: string;
  items: NavItem[];
};
