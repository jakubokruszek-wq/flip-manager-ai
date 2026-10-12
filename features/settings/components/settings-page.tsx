import type { Metadata } from "next";

import { ModulePageShell } from "@/components/shared/module-page-shell";
import { AlertSettings } from "@/features/alerts/components/alert-settings";
import { PushSettings } from "@/features/push/components/push-settings";
import { InvestmentOsSettings } from "@/features/investment-os/components/investment-settings";
import { WatcherScanIntervalSettings } from "./watcher-scan-interval-settings";
import { VersionUpdatesSettings } from "./version-updates-settings";

import { FEATURE_TITLE } from "../constants";

export const settingsMetadata: Metadata = {
  title: FEATURE_TITLE,
};

export function SettingsPage() {
  return <div className="space-y-6"><ModulePageShell title={FEATURE_TITLE} /><VersionUpdatesSettings /><WatcherScanIntervalSettings /><InvestmentOsSettings /><PushSettings /><AlertSettings /></div>;
}
