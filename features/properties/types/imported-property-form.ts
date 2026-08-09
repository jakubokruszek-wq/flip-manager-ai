import type { PropertiesInsert as SharedPropertiesInsert, PropertyFormValues, PropertySaveRequest as SharedPropertySaveRequest } from "./property";

export type ImportedPropertyFormValues = PropertyFormValues;

export type ImportedPropertyFormField = keyof ImportedPropertyFormValues;

export const SUPPORTED_PROPERTY_SOURCES = ["otodom", "facebook"] as const;

export type SupportedPropertySource = (typeof SUPPORTED_PROPERTY_SOURCES)[number];

export type PropertySaveRequest = SharedPropertySaveRequest;

export type PropertiesInsert = SharedPropertiesInsert;

export type SavePropertyResponse = {
  id: string;
  savedColumns: string[];
};
