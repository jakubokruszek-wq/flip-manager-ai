import {
  Brain,
  Building2,
  FileText,
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
    title: "Okazje",
    href: "/opportunities",
    icon: Sparkles,
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

export function getModuleByHref(href: string): ModuleDefinition | undefined {
  return modules.find((module) => module.href === href);
}

export function getModuleTitle(href: string): string {
  return getModuleByHref(href)?.title ?? "Dashboard";
}
