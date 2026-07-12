export type ImportSource =
  | "otodom"
  | "olx"
  | "facebook"
  | "gratka"
  | "morizon"
  | "unknown";

export interface PropertyImportResult {
  source: ImportSource;
  url: string;
}