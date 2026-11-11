/** Pre-purchase estimates use integer grosze. An unchecked condition never means zero cost. */
export const inspectionItems = { electrical: "Instalacja elektryczna", plumbing: "Piony i instalacja wodna", ventilation: "Wilgoć i wentylacja", windows: "Okna", heating: "Ogrzewanie", building: "Budynek i części wspólne", legal: "Stan prawny i opłaty", layout: "Układ pomieszczeń" } as const;
export const conditions = { unknown: "Niesprawdzone", ok: "OK", minor: "Lekkie korekty", replace: "Do wymiany / naprawy" } as const;
export type InspectionKey = keyof typeof inspectionItems;
export type Condition = keyof typeof conditions;
export type Repair = { condition: Condition; rate: number | null; quantity: number | null; override: number | null };
export type Assessment = { repairs: Record<InspectionKey, Repair>; finishingRate: number | null; finishingArea: number | null; reservePercent: number; furnishing: number | null; holding: number | null; finance: number | null; other: number | null; purchaseFixed: number | null; purchasePercent: number; saleFixed: number | null; salePercent: number; minimumProfit: number | null };
export function emptyAssessment(): Assessment { return { repairs: Object.fromEntries(Object.keys(inspectionItems).map(k => [k, { condition: "unknown", rate: null, quantity: null, override: null }])) as Assessment["repairs"], finishingRate: null, finishingArea: null, reservePercent: 10, furnishing: null, holding: null, finance: null, other: null, purchaseFixed: null, purchasePercent: 0, saleFixed: null, salePercent: 0, minimumProfit: null }; }
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("Nieprawidłowy kosztorys."); return v as Record<string, unknown>; }
function number(v: unknown, max: number, integer = false): number { if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max || (integer && !Number.isSafeInteger(v))) throw Error("Nieprawidłowa wartość w kosztorysie."); return v; }
export function parseAssessment(v: unknown): Assessment {
  if (v === undefined) return emptyAssessment();
  const a = object(v), rows = object(a.repairs); const money = (v: unknown) => v === null ? null : number(v, 100_000_000_000, true);
  const repairs = Object.fromEntries(Object.keys(inspectionItems).map(k => { const r = object(rows[k]); if (typeof r.condition !== "string" || !Object.hasOwn(conditions, r.condition)) throw Error("Nieprawidłowy stan techniczny."); return [k, { condition: r.condition, rate: money(r.rate), quantity: r.quantity === null ? null : number(r.quantity, 100000), override: money(r.override) }]; })) as Assessment["repairs"];
  for (const row of Object.values(repairs)) { if (row.rate !== null && row.quantity !== null && (!Number.isSafeInteger(Math.ceil(row.rate * row.quantity)) || row.rate * row.quantity > 100_000_000_000)) throw Error("Koszt pozycji jest za duży."); }
  if (a.finishingRate !== null && a.finishingArea !== null && Number(a.finishingRate) * Number(a.finishingArea) > 100_000_000_000) throw Error("Koszt wykończenia jest za duży.");
  return { repairs, finishingRate: money(a.finishingRate), finishingArea: a.finishingArea === null ? null : number(a.finishingArea, 100000), reservePercent: number(a.reservePercent, 100), furnishing: money(a.furnishing), holding: money(a.holding), finance: money(a.finance), other: money(a.other), purchaseFixed: money(a.purchaseFixed), purchasePercent: number(a.purchasePercent, 100), saleFixed: money(a.saleFixed), salePercent: number(a.salePercent, 100), minimumProfit: money(a.minimumProfit) };
}
export function repairCost(r: Repair): number | null { if (r.condition === "ok") return 0; if (r.override !== null) return r.override; if (r.condition === "unknown" || r.rate === null || r.quantity === null) return null; return Math.ceil(r.rate * r.quantity); }
const percentCost = (amount: number, percent: number) => Math.ceil(amount * percent / 100);
export function assess(a: Assessment, sale: number | null, purchase: number | null) {
  const missing: string[] = []; let repairs = 0;
  for (const [key, row] of Object.entries(a.repairs)) { const cost = repairCost(row); if (cost === null) missing.push(inspectionItems[key as InspectionKey]); else repairs += cost; }
  let finishing = 0;
  if (a.finishingRate === null || (a.finishingRate > 0 && a.finishingArea === null)) missing.push("Wykończenie: stawka i powierzchnia"); else finishing = Math.ceil(a.finishingRate * (a.finishingArea ?? 0));
  for (const [key, label] of Object.entries({ furnishing: "Wyposażenie", holding: "Utrzymanie", finance: "Finansowanie", other: "Inne koszty", purchaseFixed: "Formalności zakupu", saleFixed: "Koszty sprzedaży" })) if (a[key as keyof Assessment] === null) missing.push(label);
  if (sale === null) missing.push("Szacowana cena sprzedaży");
  if (a.minimumProfit === null) missing.push("Minimalny zysk");
  const renovation = repairs + finishing, reserve = percentCost(renovation, a.reservePercent);
  const saleCosts = sale === null ? null : (a.saleFixed ?? 0) + percentCost(sale, a.salePercent);
  const fixed = renovation + reserve + (a.furnishing ?? 0) + (a.holding ?? 0) + (a.finance ?? 0) + (a.other ?? 0) + (a.purchaseFixed ?? 0) + (saleCosts ?? 0);
  const complete = !missing.length;
  const profitAt = (p: number) => sale! - fixed - p - percentCost(p, a.purchasePercent);
  // Binary search handles percentage rounding exactly and never rounds the permitted bid up.
  let maxPurchase: number | null = null;
  if (complete && profitAt(0) >= a.minimumProfit!) { let lo = 0, hi = sale!; while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (profitAt(mid) >= a.minimumProfit!) lo = mid; else hi = mid - 1; } maxPurchase = lo; }
  return { complete, missing, renovation, reserve, saleCosts, fixed, maxPurchase, feasible: complete && maxPurchase !== null, profit: complete && purchase !== null ? profitAt(purchase) : null, purchaseCosts: purchase === null ? null : (a.purchaseFixed ?? 0) + percentCost(purchase, a.purchasePercent) };
}
/** Seed execution budgets only where no earlier plan exists; actual expenses remain untouched. */
export function acquisitionBudgets(a: Assessment, sale: number | null, purchase: number | null, previous: Record<string, number | null>) {
  const r = assess(a, sale, purchase);
  if (!r.complete || purchase === null) return previous;
  const planned = { transaction: r.purchaseCosts, renovation: r.renovation + r.reserve, furnishing: a.furnishing, holding: a.holding, finance: a.finance, sale: r.saleCosts, other: a.other };
  return Object.fromEntries(Object.entries(planned).map(([key, value]) => [key, previous[key] ?? value]));
}
