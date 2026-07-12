import type { PropertyStatus } from "@/features/properties/types";

export const PROPERTY_STATUS_LABELS: Record<PropertyStatus, string> = {
  draft: "Szkic",
  analysis: "Analiza",
  acquired: "Zakupiona",
  renovation: "W remoncie",
  listed: "Na sprzedaży",
  sold: "Sprzedana",
};

export const PROPERTY_TABLE_COLUMNS = [
  { key: "image", label: "Zdjęcie" },
  { key: "address", label: "Adres" },
  { key: "status", label: "Status" },
  { key: "flipScore", label: "Flip Score" },
  { key: "purchasePrice", label: "Cena zakupu" },
  { key: "renovationCost", label: "Koszt remontu" },
  { key: "expectedSalePrice", label: "Przewidywana sprzedaż" },
  { key: "profit", label: "Zysk" },
  { key: "roi", label: "ROI" },
  { key: "updatedAt", label: "Data aktualizacji" },
] as const;
