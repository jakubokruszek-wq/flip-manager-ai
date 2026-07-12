import type { Metadata } from "next";

import { PropertiesPanel } from "@/features/properties/components/properties-panel";
import { FEATURE_TITLE } from "@/features/properties/constants";
import { getProperties } from "@/services/properties.service";

export const propertiesMetadata: Metadata = {
  title: FEATURE_TITLE,
};

export async function PropertiesPage() {
  const properties = await getProperties();

  return <PropertiesPanel properties={properties} />;
}
