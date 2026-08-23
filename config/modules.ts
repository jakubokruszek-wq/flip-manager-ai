import {
  Brain,
  Building2,
  FileText,
  Flame,
  Hammer,
  LayoutDashboard,
  LineChart,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";

import type { FeatureId, ModuleDefinition } from "@/types";

export const modules: ModuleDefinition[] = [
  {
    id: "dashboard",
    title: "Dashboard",
    href: "/dashboard",
    icon: LayoutDashboard,
  },
  {
    id: "properties",
    title: "Nieruchomości",
    href: "/properties",
    icon: Building2,
  },
  {
    id: "deals",
    title: "Flip Finder",
    href: "/flip-finder",
    icon: Sparkles,
  },
  {
    id: "facebookWatcher",
    title: "Facebook Watcher",
    href: "/facebook-watcher",
    icon: Flame,
  },
  {
    id: "ai",
    title: "Analiza AI",
    href: "/ai-analysis",
    icon: Brain,
  },
  {
    id: "market",
    title: "Rynek",
    href: "/market",
    icon: LineChart,
  },
  {
    id: "renovations",
    title: "Remonty",
    href: "/renovations",
    icon: Hammer,
  },
  {
    id: "documents",
    title: "Dokumenty",
    href: "/documents",
    icon: FileText,
  },
  {
    id: "crm",
    title: "CRM",
    href: "/crm",
    icon: Users,
  },
  {
    id: "settings",
    title: "Ustawienia",
    href: "/settings",
    icon: Settings,
  },
];

export function getModuleById(id: FeatureId): ModuleDefinition | undefined {
  return modules.find((module) => module.id === id);
}

export function getModuleByHref(pathname: string): ModuleDefinition | undefined {
  return modules
    .filter((module) => pathname === module.href || pathname.startsWith(`${module.href}/`))
    .sort((left, right) => right.href.length - left.href.length)[0];
}

export function getModuleTitle(href: string): string {
  return getModuleByHref(href)?.title ?? "Dashboard";
}
