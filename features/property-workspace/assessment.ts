/** Pre-purchase estimates use integer grosze. An unchecked condition never means zero cost. */
export const inspectionItems = { electrical: "Instalacja elektryczna", plumbing: "Piony i instalacja wodna", ventilation: "Wilgoć i wentylacja", windows: "Okna", heating: "Ogrzewanie", building: "Budynek i części wspólne", legal: "Stan prawny i opłaty", layout: "Układ pomieszczeń" } as const;
export const conditions = { unknown: "Niesprawdzone", ok: "OK", minor: "Lekkie korekty", replace: "Do wymiany / naprawy" } as const;
export type InspectionKey = keyof typeof inspectionItems;
export type Condition = keyof typeof conditions;
export type Repair = { condition: Condition; rate: number | null; quantity: number | null; override: number | null };
export const taxModes = { resale: "Rynek wtórny — PCC 2%", vat: "Zakup opodatkowany VAT — PCC 0%", exempt: "Potwierdzone zwolnienie z PCC", bulk: "Szósty i kolejny lokal — PCC 6%", custom: "Własna dotychczasowa stawka" } as const;
export const monthlyItems = { rent: "Czynsz administracyjny / miesiąc", electricity: "Prąd / miesiąc", heating: "Ogrzewanie poza czynszem / miesiąc", other: "Pozostałe opłaty / miesiąc" } as const;
export type RunningCosts = { mode: "monthly" | "total"; months: number | null; monthly: Record<keyof typeof monthlyItems, number | null> };
export type Financing = { mode: "cash" | "loan" | "total"; principal: number | null; annualPercent: number | null; fee: number | null };
export function conditionOptions(key: InspectionKey): Record<Condition, string> {
  if (key === "legal") return { unknown: "Do sprawdzenia", ok: "Bez zastrzeżeń", minor: "Wymaga wyjaśnienia", replace: "Problem do rozwiązania" };
  if (key === "building") return { unknown: "Do sprawdzenia", ok: "Bez zastrzeżeń", minor: "Drobne prace wspólnoty", replace: "Duży remont budynku" };
  if (key === "layout") return { unknown: "Do oceny", ok: "Układ zostaje", minor: "Drobne zmiany", replace: "Przebudowa układu" };
  return conditions;
}
export function nonRenovationItem(key: string) { return key === "legal" || key === "building"; }
export type Assessment = { notaryMode: "estimate" | "manual"; notaryExtras: number | null; running: RunningCosts; financing: Financing; taxMode: keyof typeof taxModes; taxBase: number | null; purchaseAgencyPercent: number; repairs: Record<InspectionKey, Repair>; finishingRate: number | null; finishingArea: number | null; reservePercent: number; furnishing: number | null; holding: number | null; finance: number | null; other: number | null; purchaseFixed: number | null; purchasePercent: number; saleFixed: number | null; salePercent: number; minimumProfit: number | null };
export function emptyAssessment(): Assessment { return { notaryMode: "estimate", notaryExtras: 100000, running: { mode: "monthly", months: 6, monthly: { rent: null, electricity: null, heating: 0, other: 0 } }, financing: { mode: "cash", principal: null, annualPercent: null, fee: 0 }, taxMode: "resale", taxBase: null, purchaseAgencyPercent: 0, repairs: Object.fromEntries(Object.keys(inspectionItems).map(k => [k, { condition: "unknown", rate: null, quantity: null, override: null }])) as Assessment["repairs"], finishingRate: null, finishingArea: null, reservePercent: 10, furnishing: null, holding: null, finance: null, other: null, purchaseFixed: null, purchasePercent: 0, saleFixed: null, salePercent: 0, minimumProfit: null }; }
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("Nieprawidłowy kosztorys."); return v as Record<string, unknown>; }
function number(v: unknown, max: number, integer = false): number { if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max || (integer && !Number.isSafeInteger(v))) throw Error("Nieprawidłowa wartość w kosztorysie."); return v; }
export function parseAssessment(v: unknown): Assessment {
  if (v === undefined) return emptyAssessment();
  const a = object(v), rows = object(a.repairs); const money = (v: unknown) => v === null ? null : number(v, 100_000_000_000, true);
  const repairs = Object.fromEntries(Object.keys(inspectionItems).map(k => { const r = object(rows[k]); if (typeof r.condition !== "string" || !Object.hasOwn(conditions, r.condition)) throw Error("Nieprawidłowy stan techniczny."); return [k, { condition: r.condition, rate: money(r.rate), quantity: r.quantity === null ? null : number(r.quantity, 100000), override: money(r.override) }]; })) as Assessment["repairs"];
  for (const row of Object.values(repairs)) { if (row.rate !== null && row.quantity !== null && (!Number.isSafeInteger(Math.ceil(row.rate * row.quantity)) || row.rate * row.quantity > 100_000_000_000)) throw Error("Koszt pozycji jest za duży."); }
  if (a.finishingRate !== null && a.finishingArea !== null && Number(a.finishingRate) * Number(a.finishingArea) > 100_000_000_000) throw Error("Koszt wykończenia jest za duży.");
  const defaults = emptyAssessment();
  const running = a.running === undefined ? { ...defaults.running, mode: "total" as const } : object(a.running);
  if (running.mode !== "monthly" && running.mode !== "total") throw Error("Nieprawidłowy sposób liczenia utrzymania.");
  const monthly = object(running.monthly);
  const financing = a.financing === undefined ? { ...defaults.financing, mode: "total" as const } : object(a.financing);
  if (!["cash", "loan", "total"].includes(String(financing.mode))) throw Error("Nieprawidłowy sposób finansowania.");
  const taxMode = a.taxMode ?? (a.purchasePercent === 0 || a.purchasePercent === 2 ? "resale" : "custom");
  if (typeof taxMode !== "string" || !Object.hasOwn(taxModes, taxMode)) throw Error("Wybierz wariant PCC.");
  if (a.notaryMode !== undefined && a.notaryMode !== "estimate" && a.notaryMode !== "manual") throw Error("Wybierz sposób liczenia notariusza.");
  return { notaryMode: a.notaryMode === undefined ? "manual" : a.notaryMode as Assessment["notaryMode"], notaryExtras: a.notaryExtras === undefined ? 100000 : money(a.notaryExtras), running: { mode: running.mode, months: running.months === null ? null : number(running.months, 120, true), monthly: Object.fromEntries(Object.keys(monthlyItems).map(k => [k, money(monthly[k])])) as RunningCosts["monthly"] }, financing: { mode: financing.mode as Financing["mode"], principal: money(financing.principal), annualPercent: financing.annualPercent === null ? null : number(financing.annualPercent, 100), fee: money(financing.fee) }, taxMode: taxMode as Assessment["taxMode"], taxBase: a.taxBase === undefined ? null : money(a.taxBase), purchaseAgencyPercent: a.purchaseAgencyPercent === undefined ? 0 : number(a.purchaseAgencyPercent,100), repairs, finishingRate: money(a.finishingRate), finishingArea: a.finishingArea === null ? null : number(a.finishingArea, 100000), reservePercent: number(a.reservePercent, 100), furnishing: money(a.furnishing), holding: money(a.holding), finance: money(a.finance), other: money(a.other), purchaseFixed: money(a.purchaseFixed), purchasePercent: number(a.purchasePercent, 100), saleFixed: money(a.saleFixed), salePercent: number(a.salePercent, 100), minimumProfit: money(a.minimumProfit) };
}
export function repairCost(r: Repair): number | null { if (r.condition === "ok") return 0; if (r.override !== null) return r.override; if (r.condition === "unknown" || r.rate === null || r.quantity === null) return null; return Math.ceil(r.rate * r.quantity); }
const percentCost = (amount: number, percent: number) => Math.ceil(amount * percent / 100);
export function holdingCosts(a: Assessment): number | null {
  if (a.running.mode === "total") return a.holding;
  if (a.running.months === null || a.running.months < 1 || Object.values(a.running.monthly).some(v => v === null)) return null;
  return Object.values(a.running.monthly).reduce<number>((sum,v) => sum + (v ?? 0),0) * a.running.months;
}
export function financeCosts(a: Assessment): number | null {
  if (a.financing.mode === "cash") return 0;
  if (a.financing.mode === "total") return a.finance;
  const f = a.financing;
  if (f.principal === null || f.annualPercent === null || f.fee === null || a.running.months === null || a.running.months < 1) return null;
  return Math.ceil(f.principal * f.annualPercent * a.running.months / 1200) + f.fee;
}
export function purchaseTax(a: Assessment, purchase: number): number {
  if (a.taxMode === "vat" || a.taxMode === "exempt") return 0;
  if (a.taxMode === "custom") return percentCost(purchase, a.purchasePercent);
  // PCC is assessed on market value; the user can supply a different tax base.
  // Art.63 Ordynacja podatkowa: round the resulting tax to whole PLN.
  const rate = a.taxMode === "bulk" ? 6 : 2;
  const basePln = Math.floor(((a.taxBase ?? purchase) + 50) / 100);
  return Math.floor((basePln * rate + 50) / 100) * 100;
}
/** Apartment sale: half of §3 maximum, plus 23% VAT. Thresholds include the 5 Nov 2026 amendment.
 * This is a planning ceiling for the sale deed, not a quote for all notarial acts. */
export function estimatedApartmentNotaryGross(p: number): number {
  const net = p <= 300000 ? 10000 : p <= 1000000 ? 10000 + (p-300000)*0.03 : p <= 3000000 ? 31000 + (p-1000000)*0.02 : p <= 6000000 ? 71000 + (p-3000000)*0.01 : p <= 100000000 ? 101000 + (p-6000000)*0.004 : p <= 200000000 ? 477000 + (p-100000000)*0.002 : p <= 500000000 ? 677000 + (p-200000000)*0.0025 : Math.min(2500000,1427000+(p-500000000)*0.0015);
  return Math.ceil(net * 123 / 200);
}
export function notaryCosts(a: Assessment, p: number): number { return a.notaryMode === "estimate" ? estimatedApartmentNotaryGross(p) + (a.notaryExtras ?? 0) : a.purchaseFixed ?? 0; }
export function assess(a: Assessment, sale: number | null, purchase: number | null) {
  const missing: string[] = []; let repairs = 0, risks = 0;
  for (const [key, row] of Object.entries(a.repairs)) { const cost = repairCost(row); if (cost === null) missing.push(inspectionItems[key as InspectionKey]); else if (nonRenovationItem(key)) risks += cost; else repairs += cost; }
  let finishing = 0;
  if (a.finishingRate === null || (a.finishingRate > 0 && a.finishingArea === null)) missing.push("Wykończenie: stawka i powierzchnia"); else finishing = Math.ceil(a.finishingRate * (a.finishingArea ?? 0));
  for (const [key, label] of Object.entries({ furnishing: "Meble i wyposażenie", other: "Pozostałe wydatki jednorazowe", saleFixed: "Przygotowanie ogłoszenia i sprzedaży" })) if (a[key as keyof Assessment] === null) missing.push(label);
  if (a.notaryMode === "manual" && a.purchaseFixed === null) missing.push("Kwota notariusza i formalności");
  if (a.notaryMode === "estimate" && a.notaryExtras === null) missing.push("Dodatkowe opłaty notarialne i sądowe");
  const holding = holdingCosts(a), finance = financeCosts(a);
  if (holding === null) missing.push(a.running.mode === "monthly" ? "Miesięczne opłaty i czas flipa" : "Łączny koszt utrzymania");
  if (finance === null) missing.push("Koszt finansowania (kapitał, odsetki i czas)");
  if (sale === null) missing.push("Szacowana cena sprzedaży");
  if (a.minimumProfit === null) missing.push("Minimalny zysk");
  const renovation = repairs + finishing, reserve = percentCost(renovation, a.reservePercent);
  const saleCosts = sale === null ? null : (a.saleFixed ?? 0) + percentCost(sale, a.salePercent);
  const fixed = renovation + reserve + risks + (a.furnishing ?? 0) + (holding ?? 0) + (finance ?? 0) + (a.other ?? 0) + (saleCosts ?? 0);
  const complete = !missing.length;
  const buyingVariable = (p: number) => notaryCosts(a,p) + purchaseTax(a,p) + percentCost(p,a.purchaseAgencyPercent);
  const profitAt = (p: number) => sale! - fixed - p - buyingVariable(p);
  let maxPurchase: number | null = null;
  if (complete && profitAt(0) >= a.minimumProfit!) { let lo = 0, hi = sale!; while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (profitAt(mid) >= a.minimumProfit!) lo = mid; else hi = mid - 1; } maxPurchase = lo; }
  return { complete, missing, renovation, risks, reserve, holding, finance, saleCosts, fixed, maxPurchase, feasible: complete && maxPurchase !== null, profit: complete && purchase !== null ? profitAt(purchase) : null, notary: purchase === null ? null : notaryCosts(a,purchase), pcc: purchase === null ? null : purchaseTax(a,purchase), purchaseAgency: purchase === null ? null : percentCost(purchase,a.purchaseAgencyPercent), purchaseCosts: purchase === null ? null : buyingVariable(purchase) };
}
/** Seed execution budgets only where no earlier plan exists; actual expenses remain untouched. */
export function acquisitionBudgets(a: Assessment, sale: number | null, purchase: number | null, previous: Record<string, number | null>) {
  const r = assess(a, sale, purchase);
  if (!r.complete || purchase === null) return previous;
  const planned = { transaction: r.purchaseCosts, renovation: r.renovation + r.reserve, furnishing: a.furnishing, holding: r.holding, finance: r.finance, sale: r.saleCosts, other: (a.other ?? 0) + r.risks };
  return Object.fromEntries(Object.entries(planned).map(([key, value]) => [key, previous[key] ?? value]));
}
