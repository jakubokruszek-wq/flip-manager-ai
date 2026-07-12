import type { Metadata } from "next";

import { ModulePageShell } from "@/components/shared/module-page-shell";

import { FEATURE_TITLE } from "../constants";

export const marketMetadata: Metadata = {
  title: FEATURE_TITLE,
};

export function MarketPage() {
  return <ModulePageShell title={FEATURE_TITLE} />;
}
