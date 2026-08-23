import type { LucideIcon } from "lucide-react";

export type FeatureId =
  | "dashboard"
  | "properties"
  | "deals"
  | "facebookWatcher"
  | "ai"
  | "market"
  | "renovations"
  | "documents"
  | "crm"
  | "settings";

export type ModuleDefinition = {
  id: FeatureId;
  title: string;
  href: string;
  icon: LucideIcon;
};
