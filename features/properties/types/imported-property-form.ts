export type ImportedPropertyFormValues = {
  title: string;
  price: string;
  area: string;
  rooms: string;
  floor: string;
  buildingType: string;
  ownership: string;
  rent: string;
  address: string;
  district: string;
  city: string;
  description: string;
  originalUrl: string;
  source: string;
};

export type ImportedPropertyFormField = keyof ImportedPropertyFormValues;

export const SUPPORTED_PROPERTY_SOURCES = ["otodom"] as const;

export type SupportedPropertySource = (typeof SUPPORTED_PROPERTY_SOURCES)[number];

export type PropertySaveRequest = ImportedPropertyFormValues & {
  images: string[];
};

export type PropertiesInsert = {
  title: string | null;
  price: number | null;
  area: number | null;
  rooms: number | null;
  floor: string | null;
  building_type: string | null;
  ownership: string | null;
  rent: number | null;
  address: string;
  district: string | null;
  city: string | null;
  notes: string | null;
  original_url: string | null;
  source: SupportedPropertySource;
  images: string[];
  status: "draft";
};

export type SavePropertyResponse = {
  id: string;
  savedColumns: string[];
};
