import type { Metadata } from "next";

import { ModulePageShell } from "@/components/shared/module-page-shell";
import { AlertSettings } from "@/features/alerts/components/alert-settings";
import { PushSettings } from "@/features/push/components/push-settings";

import { FEATURE_TITLE } from "../constants";

export const settingsMetadata: Metadata = {
  title: FEATURE_TITLE,
};

export function SettingsPage() {
  return <div className="space-y-6"><ModulePageShell title={FEATURE_TITLE} /><PushSettings /><AlertSettings /></div>;
}
