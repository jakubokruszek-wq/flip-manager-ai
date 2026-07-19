import type { PropertyImporterAdapter } from "./property-importer-adapter";
import { OtodomAdapter } from "./otodom.adapter";

/**
 * Jeden punkt rejestracji adapterow. Kolejne portale dolaczamy tutaj, bez
 * zmiany importProperty().
 */
export const propertyImporterAdapters: readonly PropertyImporterAdapter[] = [
  new OtodomAdapter(),
];
