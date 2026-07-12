import { modules } from "@/config/modules";
import type { NavSection } from "@/types/navigation";

export const navigationSections: NavSection[] = [
  {
    items: modules.slice(0, 1).map((module) => ({
      title: module.title,
      href: module.href,
      icon: module.icon,
    })),
  },
  {
    label: "Praca",
    items: modules.slice(1, 7).map((module) => ({
      title: module.title,
      href: module.href,
      icon: module.icon,
    })),
  },
  {
    label: "System",
    items: modules.slice(7).map((module) => ({
      title: module.title,
      href: module.href,
      icon: module.icon,
    })),
  },
];
