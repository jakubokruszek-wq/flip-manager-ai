import { getModuleById, modules } from "./modules.ts";
import type { FeatureId } from "@/types";
import type { NavItem, NavSection } from "@/types/navigation";

export const workingNavigationIds = [
  "dashboard",
  "properties",
  "deals",
  "facebookWatcher",
  "settings",
] as const satisfies readonly FeatureId[];

export const hiddenNavigationIds = modules
  .map((module) => module.id)
  .filter((id) => !workingNavigationIds.includes(id as (typeof workingNavigationIds)[number]));

export const workingNavigationItems: NavItem[] = workingNavigationIds.map(toNavigationItem);

export const navigationSections: NavSection[] = [
  { items: [toNavigationItem("dashboard")] },
  {
    label: "Praca",
    items: [
      toNavigationItem("properties"),
      toNavigationItem("deals"),
      toNavigationItem("facebookWatcher"),
    ],
  },
  { label: "System", items: [toNavigationItem("settings")] },
];

export function isNavigationItemActive(pathname: string, href: string | undefined): boolean {
  return Boolean(href && (pathname === href || pathname.startsWith(`${href}/`)));
}

function toNavigationItem(id: (typeof workingNavigationIds)[number]): NavItem {
  const definition = getModuleById(id);
  if (!definition) throw new Error(`Brak konfiguracji modułu nawigacji: ${id}`);
  return { title: definition.title, href: definition.href, icon: definition.icon };
}
