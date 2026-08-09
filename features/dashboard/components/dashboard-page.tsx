import type { Metadata } from "next";

import { DashboardView } from "@/features/dashboard/components/dashboard-view";
import { getDashboardSummary } from "@/features/dashboard/server/get-dashboard-summary";
import { FEATURE_TITLE } from "../constants";

export const dashboardMetadata: Metadata = { title: FEATURE_TITLE };

export async function DashboardPage() {
  const summary = await getDashboardSummary();
  return <DashboardView summary={summary} />;
}
