import { getModuleById } from "@/config/modules";
import type { FeatureId } from "@/types";

export function createFeatureConstants(id: FeatureId) {
  const featureModule = getModuleById(id)!;

  return {
    FEATURE_ID: id,
    FEATURE_TITLE: featureModule.title,
    FEATURE_HREF: featureModule.href,
  } as const;
}
