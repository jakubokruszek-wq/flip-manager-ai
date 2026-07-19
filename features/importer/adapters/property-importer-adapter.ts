import type { ImportedProperty } from "../types";

/**
 * Kontrakt portalu. Serwis importu wybiera adapter wyłącznie przez supports,
 * bez znajomosci domen, selektorow ani formatu danych danego portalu.
 */
export interface PropertyImporterAdapter {
  supports(url: string): boolean;
  import(url: string): Promise<ImportedProperty>;
}
