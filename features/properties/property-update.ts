import type { Property, PropertySource, PropertyStatus } from "@/features/properties/types";

export type PropertyUpdateValues = {
  title: string | null;
  address: string;
  city: string | null;
  district: string | null;
  price: number | null;
  area: number | null;
  rooms: number | null;
  floor: number | null;
  totalFloors: number | null;
  status: PropertyStatus;
  source: PropertySource | null;
  description: string | null;
  originalUrl: string | null;
  images: string[];
  renovationCost: number | null;
  expectedSalePrice: number | null;
  profit: number | null;
  roi: number | null;
};

export type PropertyUpdateColumns = {
  title: string | null;
  address: string;
  city: string | null;
  district: string | null;
  price: number | null;
  area: number | null;
  rooms: number | null;
  floor: number | null;
  total_floors: number | null;
  status: PropertyStatus;
  source: PropertySource | null;
  notes: string | null;
  original_url: string | null;
  images: string[];
  renovation_cost: number | null;
  expected_sale_price: number | null;
  profit: number | null;
  roi: number | null;
};

const SOURCES = ["otodom", "olx", "facebook", "gratka", "morizon"] as const satisfies readonly PropertySource[];
const STATUSES = ["draft", "analysis", "acquired", "renovation", "listed", "sold"] as const satisfies readonly PropertyStatus[];

export function propertyToEditValues(property: Property): Record<string, string | string[]> {
  return {
    title: property.title ?? "",
    address: property.address,
    city: property.city ?? "",
    district: property.district ?? "",
    price: textNumber(property.price),
    area: textNumber(property.area),
    rooms: textNumber(property.rooms),
    floor: property.floor ?? "",
    totalFloors: property.totalFloors ?? "",
    status: property.status,
    source: property.source ?? "",
    description: property.description ?? "",
    originalUrl: property.originalUrl ?? "",
    images: property.images,
    renovationCost: textNumber(property.renovationCost),
    expectedSalePrice: textNumber(property.expectedSalePrice),
    profit: textNumber(property.profit),
    roi: textNumber(property.roi),
  };
}

export function parsePropertyUpdate(value: unknown): PropertyUpdateValues {
  if (!isRecord(value)) throw new Error("Nieprawidłowe dane nieruchomości.");
  const address = requiredText(value.address, "Adres");
  const status = enumValue(value.status, STATUSES, "Status");
  const source = optionalEnumValue(value.source, SOURCES, "Źródło");

  return {
    title: optionalText(value.title),
    address,
    city: optionalText(value.city),
    district: optionalText(value.district),
    price: nullableNumber(value.price, "Cena", { min: 0 }),
    area: nullableNumber(value.area, "Powierzchnia", { min: 0 }),
    rooms: nullableNumber(value.rooms, "Pokoje", { min: 0, integer: true }),
    floor: nullableFloor(value.floor, "Piętro"),
    totalFloors: nullableFloor(value.totalFloors, "Liczba pięter"),
    status,
    source,
    description: optionalText(value.description),
    originalUrl: nullableUrl(value.originalUrl, "Link do ogłoszenia"),
    images: imageUrls(value.images),
    renovationCost: nullableNumber(value.renovationCost, "Koszt remontu", { min: 0 }),
    expectedSalePrice: nullableNumber(value.expectedSalePrice, "Planowana cena sprzedaży", { min: 0 }),
    profit: nullableNumber(value.profit, "Zysk"),
    roi: nullableNumber(value.roi, "ROI"),
  };
}

export function propertyUpdateColumns(values: PropertyUpdateValues): PropertyUpdateColumns {
  return {
    title: values.title,
    address: values.address,
    city: values.city,
    district: values.district,
    price: values.price,
    area: values.area,
    rooms: values.rooms,
    floor: values.floor,
    total_floors: values.totalFloors,
    status: values.status,
    source: values.source,
    notes: values.description,
    original_url: values.originalUrl,
    images: values.images,
    renovation_cost: values.renovationCost,
    expected_sale_price: values.expectedSalePrice,
    profit: values.profit,
    roi: values.roi,
  };
}

function nullableFloor(value: unknown, label: string): number | null {
  const text = optionalText(value);
  if (text === null) return null;
  if (/\b(?:parter|ground)\b/i.test(text)) return 0;
  if (/\b(?:suterena|piwnica)\b/i.test(text)) return -1;
  if (!/^(?:floor_)?-?\d+$/i.test(text)) throw new Error(`${label} musi być liczbą, „parterem” albo wartością floor_N.`);
  return Number(text.replace(/^floor_/i, ""));
}

function nullableNumber(value: unknown, label: string, options: { min?: number; integer?: boolean } = {}): number | null {
  const text = optionalText(value);
  if (text === null) return null;
  const number = Number(text.replace(",", "."));
  if (!Number.isFinite(number) || options.integer && !Number.isInteger(number) || options.min !== undefined && number < options.min) {
    throw new Error(`${label} ma nieprawidłową wartość.`);
  }
  return number;
}

function nullableUrl(value: unknown, label: string): string | null {
  const text = optionalText(value);
  if (text === null) return null;
  return validUrl(text, label);
}

function imageUrls(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Galeria zdjęć musi być tablicą adresów URL.");
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`Zdjęcie nr ${index + 1} ma nieprawidłowy adres.`);
    return validUrl(item.trim(), `Zdjęcie nr ${index + 1}`);
  });
}

function validUrl(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${label} musi być poprawnym adresem HTTP lub HTTPS.`);
  }
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  throw new Error(`${label} ma nieprawidłową wartość.`);
}

function optionalEnumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T | null {
  const text = optionalText(value);
  return text === null ? null : enumValue(text, allowed, label);
}

function requiredText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (text === null) throw new Error(`${label} jest wymagany.`);
  return text;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function textNumber(value: number | null): string {
  return value === null ? "" : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
