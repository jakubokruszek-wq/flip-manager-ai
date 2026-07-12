import type { ImportAdapter } from "./import-adapter";
import type { PropertyImportResult } from "../types";

export class OtodomAdapter implements ImportAdapter {
  canHandle(url: string): boolean {
    return url.toLowerCase().includes("otodom");
  }

  async import(url: string): Promise<PropertyImportResult> {
    // Na razie atrapa.
    // W kolejnym kroku zaczniemy pobierać prawdziwe dane.

    return {
      source: "otodom",
      url,
    };
  }
}