/**
 * Portal, z ktorego pochodzi ogloszenie. Dodanie kolejnego adaptera wymaga
 * dodania tutaj jego stabilnego identyfikatora.
 */
export type ImportSource =
  | "otodom"
  | "olx"
  | "facebook"
  | "gratka"
  | "morizon";

/**
 * Ujednolicony wynik importu niezalezny od struktury danych danego portalu.
 * Kwoty sa liczbami w PLN, a powierzchnia jest podana w m².
 */
export interface ImportedProperty {
  source: ImportSource;
  title: string;
  price: number | null;
  area: number | null;
  rooms: number | null;
  floor: string | null;
  buildingType: string | null;
  ownership: string | null;
  rent: number | null;
  address: string | null;
  district: string | null;
  city: string | null;
  description: string | null;
  images: string[];
  /** Kanoniczny adres ogloszenia zwrocony przez portal, gdy jest dostepny. */
  originalUrl: string;
}
