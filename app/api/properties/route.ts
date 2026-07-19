import { createClient } from "@/lib/supabase/server";
import {
  SUPPORTED_PROPERTY_SOURCES,
  type ImportedPropertyFormField,
  type ImportedPropertyFormValues,
  type PropertiesInsert,
  type PropertySaveRequest,
  type SavePropertyResponse,
  type SupportedPropertySource,
} from "@/features/properties/types/imported-property-form";

const FORM_FIELDS: ImportedPropertyFormField[] = [
  "title",
  "price",
  "area",
  "rooms",
  "floor",
  "buildingType",
  "ownership",
  "rent",
  "address",
  "district",
  "city",
  "description",
  "originalUrl",
  "source",
];

export async function POST(request: Request) {
  try {
    const values = await readSaveRequest(request);
    const payload = createPropertiesInsert(values);
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("properties")
      .insert(payload)
      .select("id")
      .single();

    if (error) {
      console.error("PROPERTY SAVE ERROR:", error);
      return Response.json(
        { message: error.message },
        { status: error.code === "42501" ? 403 : 500 }
      );
    }

    const response: SavePropertyResponse = {
      id: data.id,
      savedColumns: Object.keys(payload),
    };

    return Response.json(response, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Nie udało się zapisać nieruchomości.";
    return Response.json({ message }, { status: 400 });
  }
}

async function readSaveRequest(request: Request): Promise<PropertySaveRequest> {
  const body: unknown = await request.json();

  if (!isRecord(body)) {
    throw new Error("Nieprawidłowe dane nieruchomości.");
  }

  const values = {} as ImportedPropertyFormValues;

  for (const field of FORM_FIELDS) {
    const value = body[field];

    if (typeof value !== "string") {
      throw new Error(`Pole ${field} ma nieprawidłowy format.`);
    }

    values[field] = value.trim();
  }

  if (!values.address) {
    throw new Error("Adres jest wymagany do zapisania nieruchomości.");
  }

  if (!Array.isArray(body.images)) {
    throw new Error("Pole images musi być tablicą adresów URL.");
  }

  const images = body.images.map((image, index) => {
    if (typeof image !== "string") {
      throw new Error(`Zdjęcie nr ${index + 1} ma nieprawidłowy format.`);
    }

    return parseHttpsUrl(image, `Zdjęcie nr ${index + 1}`);
  });

  return { ...values, images };
}

function createPropertiesInsert(values: PropertySaveRequest): PropertiesInsert {
  return {
    title: emptyToNull(values.title),
    price: parseNullableNumber(values.price, "price"),
    area: parseNullableNumber(values.area, "area"),
    rooms: parseNullableNumber(values.rooms, "rooms"),
    floor: emptyToNull(values.floor),
    building_type: emptyToNull(values.buildingType),
    ownership: emptyToNull(values.ownership),
    rent: parseNullableNumber(values.rent, "rent"),
    address: values.address,
    district: emptyToNull(values.district),
    city: emptyToNull(values.city),
    notes: emptyToNull(values.description),
    original_url: values.originalUrl
      ? parseHttpsUrl(values.originalUrl, "Pole originalUrl")
      : null,
    source: parseSource(values.source),
    images: values.images,
    status: "draft",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emptyToNull(value: string): string | null {
  return value || null;
}

function parseNullableNumber(value: string, field: string): number | null {
  if (!value) {
    return null;
  }

  const number = Number(value.replace(",", "."));

  if (!Number.isFinite(number)) {
    throw new Error(`Pole ${field} musi być liczbą.`);
  }

  return number;
}

function parseHttpsUrl(value: string, field: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} musi być poprawnym adresem URL HTTPS.`);
  }

  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new Error(`${field} musi być poprawnym adresem URL HTTPS.`);
  }

  return url.toString();
}

function parseSource(value: string): SupportedPropertySource {
  if (!value) {
    throw new Error("Pole source jest wymagane.");
  }

  const source = SUPPORTED_PROPERTY_SOURCES.find((candidate) => candidate === value);

  if (!source) {
    throw new Error(`Pole source obsługuje obecnie tylko: ${SUPPORTED_PROPERTY_SOURCES.join(", ")}.`);
  }

  return source;
}
