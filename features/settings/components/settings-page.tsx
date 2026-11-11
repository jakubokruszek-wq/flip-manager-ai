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
  return <div className="space-y-6"><ModulePageShell title={FEATURE_TITLE} /><VersionUpdatesSettings /><section className="ui-card space-y-3 p-5"><h2 className="text-lg font-semibold">Android — Flip Watcher</h2><p className="text-sm text-muted-foreground">Pobierz sprawdzoną aplikację do zbierania ofert z Facebooka.</p><a href="/android" className="inline-block min-h-11 text-primary underline">Pobierz aplikację Android</a></section><WatcherScanIntervalSettings /><InvestmentOsSettings /><PushSettings /><AlertSettings /></div>;
}
