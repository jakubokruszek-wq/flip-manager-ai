import "server-only";

import { propertyImporterAdapters } from "../adapters/registry";
import { PropertyImportError } from "../errors";
import type { ImportedProperty } from "../types";

/**
 * Publiczny punkt wejścia importu. Nie zna domen ani szczegółów parserów;
 * deleguje wybór do adapterów z rejestru.
 */
export async function importProperty(url: string): Promise<ImportedProperty> {
  const normalizedUrl = normalizeImportUrl(url);
  const adapter = propertyImporterAdapters.find((candidate) =>
    candidate.supports(normalizedUrl)
  );

  if (!adapter) {
    throw new PropertyImportError(
      "UNSUPPORTED_SOURCE",
      "Ten portal lub adres ogłoszenia nie jest jeszcze obsługiwany."
    );
  }

  console.log("IMPORT SELECTED ADAPTER:", adapter.constructor.name);

  return adapter.import(normalizedUrl);
}

function normalizeImportUrl(value: string): string {
  const input = value.trim();

  if (!input) {
    throw new PropertyImportError("INVALID_URL", "Adres ogłoszenia jest wymagany.");
  }

  try {
    const url = new URL(input);

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      throw new Error("Invalid import URL");
    }

    return url.href;
  } catch {
    throw new PropertyImportError(
      "INVALID_URL",
      "Podaj poprawny adres HTTPS ogłoszenia."
    );
  }
}
