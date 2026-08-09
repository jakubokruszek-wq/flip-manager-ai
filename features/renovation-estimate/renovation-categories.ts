import type { RenovationCategoryKey } from "./types.ts";

export type RenovationCategoryDefinition = {
  name: string;
  description: string;
  items: string[];
  rateMin?: number;
  rateMax?: number;
  fixedMin?: number;
  fixedMax?: number;
};

export const RENOVATION_CATEGORIES: Record<RenovationCategoryKey, RenovationCategoryDefinition> = {
  demolition: { name: "Demontaż", description: "Usunięcie zużytych elementów i przygotowanie lokalu.", items: ["demontaż starej zabudowy", "wyniesienie i utylizacja odpadów"], rateMin: 45, rateMax: 90 },
  walls: { name: "Ściany i gładzie", description: "Naprawy podłoża, uzupełnienia oraz gładzie.", items: ["naprawa ścian", "gładzie i przygotowanie pod malowanie"], rateMin: 75, rateMax: 145 },
  painting: { name: "Malowanie", description: "Materiały, zabezpieczenie i dwukrotne malowanie.", items: ["gruntowanie", "malowanie ścian i sufitów"], rateMin: 45, rateMax: 75 },
  floors: { name: "Podłogi", description: "Nowa posadzka wraz z przygotowaniem podłoża.", items: ["demontaż starej podłogi", "podkład i montaż nowej podłogi"], rateMin: 140, rateMax: 310 },
  electrical: { name: "Elektryka", description: "Modernizacja widocznych punktów i osprzętu.", items: ["nowe punkty elektryczne", "gniazda i włączniki"], rateMin: 95, rateMax: 210 },
  plumbing: { name: "Hydraulika", description: "Podejścia wodne i kanalizacyjne w remontowanych strefach.", items: ["modernizacja podejść wodnych", "próby szczelności"], fixedMin: 3_500, fixedMax: 9_000 },
  kitchen: { name: "Kuchnia", description: "Zabudowa, blat i podstawowe wyposażenie kuchni.", items: ["zabudowa kuchenna", "blat, zlew i armatura"], fixedMin: 16_000, fixedMax: 42_000 },
  bathroom: { name: "Łazienka", description: "Kompleksowe wykończenie łazienki bez zmian konstrukcyjnych.", items: ["hydroizolacja i płytki", "ceramika i armatura"], fixedMin: 18_000, fixedMax: 38_000 },
  doors: { name: "Drzwi", description: "Skrzydła, ościeżnice i montaż.", items: ["wymiana drzwi wewnętrznych", "montaż klamek i ościeżnic"], fixedMin: 4_000, fixedMax: 11_000 },
  lighting: { name: "Oświetlenie", description: "Oprawy oraz montaż w istniejących punktach.", items: ["nowe oprawy oświetleniowe", "montaż i regulacja"], fixedMin: 2_000, fixedMax: 7_000 },
  furniture: { name: "Meble", description: "Podstawowe umeblowanie dopasowane do stylu.", items: ["meble wolnostojące", "tekstylia i wyposażenie"], fixedMin: 8_000, fixedMax: 28_000 },
  carpentry: { name: "Zabudowy stolarskie", description: "Zabudowy wykonywane na wymiar.", items: ["szafy na wymiar", "zabudowy funkcjonalne"], fixedMin: 9_000, fixedMax: 30_000 },
  reserve: { name: "Rezerwa", description: "Bufor na prace nieprzewidziane i zmiany cen.", items: ["rezerwa wykonawcza i materiałowa"] },
};
