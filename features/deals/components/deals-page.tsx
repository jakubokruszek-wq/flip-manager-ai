import type { Metadata } from "next";

import { ModulePageShell } from "@/components/shared/module-page-shell";

import { FEATURE_TITLE } from "../constants";

export const dealsMetadata: Metadata = {
  title: FEATURE_TITLE,
};

export function DealsPage() {
  return <ModulePageShell title={FEATURE_TITLE} />;
}
