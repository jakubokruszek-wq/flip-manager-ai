"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CanonicalDeal, DealFactOverrides } from "../types";
import { SectionHeading } from "./investment-ui";

type OverrideField = "askingPrice" | "resalePerM2" | "renovationPerM2" | "holdingMonths";
type OverrideDraft = Partial<Record<OverrideField, string>>;

export function OverridePanel({ deal, disabled, onSave }: { deal: CanonicalDeal; disabled: boolean; onSave: (value: DealFactOverrides) => Promise<void> }) {
  const [values, setValues] = useState<OverrideDraft>({});
  const asking = deal.facts.askingPrice;
  const marketIsDealOverride = deal.market.result?.assumptionMatchedBy === "DEAL_OVERRIDE";
  const resale = deal.market.result?.resalePricePerM2Base ?? null;
  const renovation = deal.underwriting.result?.renovationPerM2 ?? null;
  const holding = null;

  const payload = (): DealFactOverrides => Object.fromEntries(Object.entries(values).filter(([, value]) => value?.trim() !== "").map(([key, value]) => [key, Number(value)])) as DealFactOverrides;
  const update = (name: OverrideField, value: string) => setValues((current) => ({ ...current, [name]: value }));
  const save = () => void onSave(payload());
  const reset = () => { setValues({}); void onSave({}); };

  return <section aria-labelledby="overrides-title" className="min-w-0 max-w-full space-y-3 rounded-2xl border border-border/80 bg-muted/20 p-4 sm:p-5">
    <SectionHeading eyebrow="05 · human-controlled inputs" id="overrides-title" title="Assumptions & overrides" aside={<span className="rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">Manualne założenia · wymagają decyzji człowieka</span>} />
    <p className="max-w-3xl text-xs leading-5 text-muted-foreground">System value pozostaje widoczne. Zapis zmienia tylko effective value w zakresie istniejącego kontraktu override i przelicza zależne dyrekcje.</p>

    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <OverrideCard label="Cena zakupu" unit="PLN" system={asking.sourceValue} manual={asking.overrideValue} effective={asking.effectiveValue} draft={values.askingPrice} onChange={(value) => update("askingPrice", value)} placeholder={asking.effectiveValue} disabled={disabled} />
      <OverrideCard label="Odsprzedaż / m²" unit="PLN/m²" system={marketIsDealOverride ? null : resale} manual={marketIsDealOverride ? resale : null} effective={resale} draft={values.resalePerM2} onChange={(value) => update("resalePerM2", value)} placeholder={resale} disabled={disabled} manualUnavailable={false} />
      <OverrideCard label="Remont / m²" unit="PLN/m²" system={null} manual={null} effective={renovation} draft={values.renovationPerM2} onChange={(value) => update("renovationPerM2", value)} placeholder={renovation} disabled={disabled} manualUnavailable />
      <OverrideCard label="Utrzymanie" unit="miesiące" system={null} manual={null} effective={holding} draft={values.holdingMonths} onChange={(value) => update("holdingMonths", value)} placeholder={holding} disabled={disabled} manualUnavailable />
    </div>

    <div className="flex flex-col gap-2 border-t border-border/70 pt-3 sm:flex-row">
      <Button className="min-h-10" disabled={disabled} onClick={save} type="button">Zapisz i przelicz</Button>
      <Button className="min-h-10" disabled={disabled} onClick={reset} type="button" variant="outline">Reset do źródła</Button>
      <p className="self-center text-xs text-muted-foreground">Draft nie zmienia wyniku, dopóki go nie zapiszesz.</p>
    </div>
  </section>;
}

function OverrideCard({ label, unit, system, manual, effective, draft, onChange, placeholder, disabled, manualUnavailable = false }: { label: string; unit: string; system: number | string | null; manual: number | string | null; effective: number | string | null; draft?: string; onChange: (value: string) => void; placeholder: number | null; disabled: boolean; manualUnavailable?: boolean }) {
  const displayValue = (value: number | string | null) => value == null || value === "" ? "—" : typeof value === "number" ? new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 }).format(value) : value;
  const draftNumber = draft?.trim() ? Number(draft) : null;
  const manualValue = draft?.trim() ? `${draftNumber != null && Number.isFinite(draftNumber) ? displayValue(draftNumber) : "niepoprawna wartość"} · draft` : manualUnavailable ? "nieudostępnione" : displayValue(manual);
  return <article className="min-w-0 rounded-xl border border-border/70 bg-background/65 p-3">
    <div className="flex items-start justify-between gap-2"><h4 className="text-sm font-semibold">{label}</h4><span className="text-[10px] text-muted-foreground">{unit}</span></div>
    <dl className="mt-3 space-y-1.5 text-xs"><ValueRow label="SYSTEM" value={displayValue(system)} /><ValueRow label="MANUAL" value={manualValue} /><ValueRow label="EFFECTIVE" value={displayValue(effective)} strong /></dl>
    {manualUnavailable ? <p className="mt-2 text-[10px] leading-4 text-muted-foreground">Rozbicie system/manual nie jest udostępnione w bieżącym CanonicalDeal.</p> : null}
    <label className="mt-3 block"><span className="mb-1 block text-[11px] font-medium text-muted-foreground">Nowa wartość ręczna</span><Input autoComplete="off" disabled={disabled} inputMode="decimal" min="0" onChange={(event) => onChange(event.target.value)} placeholder={placeholder == null ? "brak danych" : String(Math.round(placeholder))} type="number" value={draft ?? ""} /></label>
  </article>;
}

function ValueRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) { return <div className="flex justify-between gap-2"><dt className="text-muted-foreground">{label}</dt><dd className={`text-right tabular-nums ${strong ? "font-semibold text-foreground" : "font-medium"}`}>{value}</dd></div>; }
