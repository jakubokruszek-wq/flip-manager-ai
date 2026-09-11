"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FilterResult } from "@/features/flip-finder/results";
import { calculateUnderwriting, DEFAULT_UNDERWRITING_SETTINGS, type UnderwritingResult, type UnderwritingSettings } from "@/features/flip-finder/underwriting";

const SETTINGS_KEY = "flipFinderUnderwritingSettingsV1";
const OVERRIDES_KEY = "flipFinderUnderwritingOverridesV1";

type Overrides = { purchasePrice: number | null; resalePerM2: number | null; renovationPerM2: number | null; holdingMonths: number | null; additionalCosts: number | null };
const EMPTY_OVERRIDES: Overrides = { purchasePrice: null, resalePerM2: null, renovationPerM2: null, holdingMonths: null, additionalCosts: null };

export function UnderwritingPanel({ result }: { result: FilterResult }) {
  const [settings, setSettings] = useState(DEFAULT_UNDERWRITING_SETTINGS);
  const [overrides, setOverrides] = useState<Overrides>(EMPTY_OVERRIDES);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSettings(loadUnderwritingSettings());
      setOverrides(readOverrides(result.id));
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [result.id]);
  const analysis = useMemo(() => calculateResultUnderwriting(result, settings, overrides), [overrides, result, settings]);
  const setOverride = (field: keyof Overrides, raw: string) => {
    const value = raw.trim() === "" ? null : Number(raw);
    const next = { ...overrides, [field]: value !== null && Number.isFinite(value) && value >= 0 ? value : null };
    setOverrides(next);
    writeOverrides(result.id, next);
  };
  return <div className="space-y-6 px-5 py-6 sm:px-8 sm:py-8">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-bold">Analiza inwestycji</h2><p className="mt-1 text-sm text-muted-foreground">Zysk projektu przed podatkiem dochodowym. Każda liczba pochodzi z ogłoszenia, comps albo jawnego założenia.</p></div><DecisionBadge decision={analysis.decision} /></div>
    <div className="grid gap-3 sm:grid-cols-3"><Hero label="Cena ofertowa" value={pln(result.price)} /><Hero label="Maksymalna cena zakupu" value={pln(analysis.maxPurchasePrice)} /><Hero label="Cel negocjacyjny" value={pln(analysis.targetPurchasePrice)} /></div>
    {analysis.discountNeeded !== null && analysis.discountNeeded > 0 ? <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm font-semibold">Wymagana negocjacja: {pln(analysis.discountNeeded)} ({percent(analysis.discountNeededPercent)})</p> : null}
    <section><h3 className="font-bold">Trzy scenariusze</h3><div className="mt-3 grid gap-3 md:grid-cols-3"><Scenario label="Ostrożny" value={analysis.scenarios.conservative} /><Scenario label="Bazowy" value={analysis.scenarios.base} /><Scenario label="Optymistyczny" value={analysis.scenarios.optimistic} /></div></section>
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Remont" value={`${pln(analysis.renovationTotal)} · ${pln(analysis.renovationPerM2)}/m²`} /><Metric label="Całkowity koszt" value={pln(analysis.totalProjectCost)} /><Metric label="Marża" value={percent(analysis.marginBase)} /><Metric label="ROI" value={percent(analysis.roiBase)} /></section>
    <section className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl border p-4"><p className="text-xs uppercase text-muted-foreground">Flip Score</p><p className="mt-1 text-3xl font-bold">{analysis.flipScore}/100</p><ul className="mt-3 space-y-1 text-xs text-muted-foreground">{analysis.scoreComponents.map((item) => <li key={item.label}>{item.points >= 0 ? "+" : ""}{item.points} {item.label}</li>)}</ul></div><div className="rounded-xl border p-4"><p className="text-xs uppercase text-muted-foreground">Pewność danych</p><p className="mt-1 text-3xl font-bold">{analysis.confidenceScore}%</p><p className="mt-2 text-xs text-muted-foreground">Pewność ARV: {analysis.resaleConfidence}%</p></div></section>
    <section className="grid gap-3 md:grid-cols-3"><List title="Mocne strony" values={analysis.strengths} /><List title="Ryzyka" values={analysis.redFlags} /><List title="Brakujące dane" values={analysis.missingFields} /></section>
    <section className="rounded-2xl border bg-muted/20 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="font-bold">Nadpisania tej oferty</h3><p className="text-xs text-muted-foreground">Wartość źródłowa pozostaje bez zmian; kalkulator używa wartości efektywnej.</p></div><Button onClick={() => { setOverrides(EMPTY_OVERRIDES); writeOverrides(result.id, EMPTY_OVERRIDES); }} type="button" variant="outline">Resetuj</Button></div><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><NumberField label="Cena zakupu" value={overrides.purchasePrice} placeholder={result.price} onChange={(v) => setOverride("purchasePrice", v)} /><NumberField label="Sprzedaż zł/m²" value={overrides.resalePerM2} placeholder={analysis.scenarios.base.resalePerM2} onChange={(v) => setOverride("resalePerM2", v)} /><NumberField label="Remont zł/m²" value={overrides.renovationPerM2} placeholder={analysis.renovationPerM2} onChange={(v) => setOverride("renovationPerM2", v)} /><NumberField label="Miesiące utrzymania" value={overrides.holdingMonths} placeholder={settings.holdingMonths} onChange={(v) => setOverride("holdingMonths", v)} /><NumberField label="Dodatkowe koszty" value={overrides.additionalCosts} placeholder={0} onChange={(v) => setOverride("additionalCosts", v)} /></div></section>
    <section className="rounded-xl border p-4"><h3 className="font-bold">Pochodzenie danych</h3><div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">{Object.entries(analysis.provenance).map(([field, source]) => <div className="flex justify-between gap-3 border-b py-1" key={field}><span>{field}</span><strong>{provenanceLabel(source)}</strong></div>)}</div></section>
  </div>;
}

export function UnderwritingSettingsPanel() {
  const [settings, setSettings] = useState(DEFAULT_UNDERWRITING_SETTINGS);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const timeout = window.setTimeout(() => setSettings(loadUnderwritingSettings()), 0);
    return () => window.clearTimeout(timeout);
  }, []);
  const update = (path: string, raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return;
    setSaved(false);
    setSettings((current) => setPath(current, path, value));
  };
  const save = () => { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); setSaved(true); window.dispatchEvent(new Event("flip-underwriting-settings")); };
  return <section className="rounded-xl border bg-card p-5"><h2 className="text-lg font-bold">Założenia Flip Underwriting</h2><p className="mt-1 text-sm text-muted-foreground">Centralne, edytowalne wartości dla kalkulacji. Dane są oznaczane jako założenia, nie jako fakty z ogłoszenia.</p><div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
    <Setting label="Remont lekki zł/m²" value={settings.renovationPerM2.LIGHT} onChange={(v) => update("renovationPerM2.LIGHT", v)} /><Setting label="Remont standard zł/m²" value={settings.renovationPerM2.STANDARD} onChange={(v) => update("renovationPerM2.STANDARD", v)} /><Setting label="Remont pełny zł/m²" value={settings.renovationPerM2.FULL} onChange={(v) => update("renovationPerM2.FULL", v)} /><Setting label="Rezerwa %" value={settings.contingencyPercent} onChange={(v) => update("contingencyPercent", v)} />
    <Setting label="Koszt zakupu %" value={settings.purchaseTaxPercent} onChange={(v) => update("purchaseTaxPercent", v)} /><Setting label="Koszty stałe zakupu" value={settings.fixedPurchaseCosts} onChange={(v) => update("fixedPurchaseCosts", v)} /><Setting label="Koszt sprzedaży %" value={settings.salesCostPercent} onChange={(v) => update("salesCostPercent", v)} /><Setting label="Miesiące utrzymania" value={settings.holdingMonths} onChange={(v) => update("holdingMonths", v)} />
    <Setting label="Prowizja zakupu %" value={settings.purchaseCommissionPercent} onChange={(v) => update("purchaseCommissionPercent", v)} /><Setting label="Utrzymanie / miesiąc" value={settings.monthlyHoldingCost} onChange={(v) => update("monthlyHoldingCost", v)} /><Setting label="Minimalny zysk" value={settings.minimumProfitPLN} onChange={(v) => update("minimumProfitPLN", v)} /><Setting label="Minimalna marża %" value={settings.minimumMarginPercent} onChange={(v) => update("minimumMarginPercent", v)} /><Setting label="Minimalne ROI %" value={settings.minimumROI} onChange={(v) => update("minimumROI", v)} />
    <Setting label="Oprocentowanie roczne %" value={settings.financingAnnualRatePercent} onChange={(v) => update("financingAnnualRatePercent", v)} /><Setting label="Finansowanie zakupu %" value={settings.financingLoanPercent} onChange={(v) => update("financingLoanPercent", v)} /><label className="flex items-center gap-2 rounded-lg border px-3"><input checked={settings.financingEnabled} onChange={(event) => { setSaved(false); setSettings((current) => ({ ...current, financingEnabled: event.target.checked })); }} type="checkbox" /><span className="text-sm">Uwzględnij finansowanie</span></label>
    <Setting label="Bufor negocjacyjny %" value={settings.targetNegotiationBufferPercent} onChange={(v) => update("targetNegotiationBufferPercent", v)} /><Setting label="ARV low zł/m²" value={settings.marketResalePerM2.low} onChange={(v) => update("marketResalePerM2.low", v)} /><Setting label="ARV base zł/m²" value={settings.marketResalePerM2.base} onChange={(v) => update("marketResalePerM2.base", v)} /><Setting label="ARV high zł/m²" value={settings.marketResalePerM2.high} onChange={(v) => update("marketResalePerM2.high", v)} />
  </div><div className="mt-4 flex gap-2"><Button onClick={save} type="button">Zapisz założenia</Button><Button onClick={() => { setSettings(DEFAULT_UNDERWRITING_SETTINGS); localStorage.removeItem(SETTINGS_KEY); setSaved(true); }} type="button" variant="outline">Przywróć domyślne</Button>{saved ? <span className="self-center text-sm text-emerald-600">Zapisano</span> : null}</div></section>;
}

export function calculateResultUnderwriting(result: FilterResult, settings: UnderwritingSettings, overrides: Overrides = EMPTY_OVERRIDES): UnderwritingResult {
  const baseline = result.underwriting;
  return calculateUnderwriting({ listingId: result.id, source: result.source, sourceUrl: result.originalUrl, lifecycleStatus: result.lifecycleStatus ?? null, decisionBucket: result.decisionBucket ?? "REVIEW", manualDecision: result.manualDecision ?? null, city: result.city, district: result.district, street: result.address, areaM2: result.area, rooms: result.rooms, floor: result.floor, floorsTotal: result.totalFloors, buildingType: result.buildingType, yearBuilt: null, ownership: result.ownership, condition: result.description, monthlyFee: null, askingPrice: result.price, askingPricePerM2: result.pricePerSqm, resalePerM2: baseline ? { low: baseline.scenarios.conservative.resalePerM2, base: baseline.scenarios.base.resalePerM2, high: baseline.scenarios.optimistic.resalePerM2, provenance: baseline.provenance.resalePricePerM2, confidence: baseline.resaleConfidence } : undefined, missingFields: result.missingFields, galleryAvailable: result.images.length > 0, priceOverride: overrides.purchasePrice, resalePerM2Override: overrides.resalePerM2, renovationPerM2Override: overrides.renovationPerM2, holdingMonthsOverride: overrides.holdingMonths, additionalCostsOverride: overrides.additionalCosts }, settings);
}
export function loadUnderwritingSettings(): UnderwritingSettings { try { const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null"); return value && typeof value === "object" ? { ...DEFAULT_UNDERWRITING_SETTINGS, ...value, renovationPerM2: { ...DEFAULT_UNDERWRITING_SETTINGS.renovationPerM2, ...value.renovationPerM2 }, marketResalePerM2: { ...DEFAULT_UNDERWRITING_SETTINGS.marketResalePerM2, ...value.marketResalePerM2 } } : DEFAULT_UNDERWRITING_SETTINGS; } catch { return DEFAULT_UNDERWRITING_SETTINGS; } }
function readOverrides(id: string): Overrides { try { const all = JSON.parse(localStorage.getItem(OVERRIDES_KEY) ?? "{}"); return { ...EMPTY_OVERRIDES, ...(all[id] ?? {}) }; } catch { return EMPTY_OVERRIDES; } }
function writeOverrides(id: string, value: Overrides): void { try { const all = JSON.parse(localStorage.getItem(OVERRIDES_KEY) ?? "{}"); localStorage.setItem(OVERRIDES_KEY, JSON.stringify({ ...all, [id]: value })); } catch { /* calculation remains available without persistence */ } }
function setPath(settings: UnderwritingSettings, path: string, value: number): UnderwritingSettings { const [parent, child] = path.split("."); if (parent === "renovationPerM2" && child) return { ...settings, renovationPerM2: { ...settings.renovationPerM2, [child]: value } }; if (parent === "marketResalePerM2" && child) return { ...settings, marketResalePerM2: { ...settings.marketResalePerM2, [child]: value } }; return { ...settings, [parent]: value }; }
function Scenario({ label, value }: { label: string; value: UnderwritingResult["scenarios"]["base"] }) { return <div className="rounded-xl border p-4"><h4 className="font-bold">{label}</h4><div className="mt-3 space-y-1 text-sm"><p>Sprzedaż: <strong>{pln(value.resaleValue)}</strong></p><p>Remont: <strong>{pln(value.renovationTotal)}</strong></p><p>Koszt: <strong>{pln(value.totalProjectCost)}</strong></p><p>Zysk: <strong>{pln(value.profit)}</strong></p></div></div>; }
function Hero({ label, value }: { label: string; value: string }) { return <div className="rounded-xl bg-foreground p-4 text-background"><p className="text-xs opacity-65">{label}</p><p className="mt-1 text-xl font-bold">{value}</p></div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-xl border p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-bold">{value}</p></div>; }
function List({ title, values }: { title: string; values: string[] }) { return <div className="rounded-xl border p-4"><h4 className="font-bold">{title}</h4><ul className="mt-2 space-y-1 text-sm text-muted-foreground">{values.length ? values.map((value) => <li key={value}>• {value}</li>) : <li>Brak</li>}</ul></div>; }
function NumberField({ label, value, placeholder, onChange }: { label: string; value: number | null; placeholder: number | null; onChange: (value: string) => void }) { return <label><span className="mb-1 block text-xs text-muted-foreground">{label}</span><Input min="0" onChange={(event) => onChange(event.target.value)} placeholder={placeholder == null ? "brak" : String(Math.round(placeholder))} type="number" value={value ?? ""} /></label>; }
function Setting({ label, value, onChange }: { label: string; value: number; onChange: (value: string) => void }) { return <NumberField label={label} onChange={onChange} placeholder={null} value={value} />; }
function DecisionBadge({ decision }: { decision: UnderwritingResult["decision"] }) { const labels = { HOT: "KUP / HOT", GOOD: "DOBRA", REVIEW: "DO ANALIZY", TOO_EXPENSIVE: "ZA DROGO", REJECT: "ODRZUĆ" }; return <span className="rounded-full border px-3 py-1 text-sm font-bold">{labels[decision]}</span>; }
function provenanceLabel(value: string): string { return value === "EXTRACTED" ? "Dane pewne" : value === "DERIVED" ? "Wyliczone" : value === "UNKNOWN" ? "Brak danych" : "Założenie"; }
function pln(value: number | null): string { return value == null || !Number.isFinite(value) ? "Brak danych" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value); }
function percent(value: number | null): string { return value == null || !Number.isFinite(value) ? "Brak danych" : `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 }).format(value)}%`; }
