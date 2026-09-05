"use client";

import { ExternalLink } from "lucide-react";
import { getPurchaseRecommendation } from "@/features/purchase-recommendation/recommendation";
import type { MarketIntelligence } from "./types";

type CalculatorCosts = {
  renovationCost: number;
  furnishingCost: number;
  reserveCost: number;
  notaryCost: number;
  purchaseCommission: number;
  saleCommission: number;
  taxCost: number;
};

type Props = {
  data: MarketIntelligence | null;
  loading: boolean;
  error: string | null;
  calculatorCosts: CalculatorCosts;
  targetProfit: number;
  targetRoi: number;
  onTargetProfitChange: (value: number) => void;
  onTargetRoiChange: (value: number) => void;
};

export function MarketIntelligencePanel({ data, loading, error, calculatorCosts, targetProfit, targetRoi, onTargetProfitChange, onTargetRoiChange }: Props) {
  if (loading) return <div className="px-5 py-8 text-sm text-muted-foreground sm:px-8">Analizowanie rynku…</div>;
  if (error) return <div className="px-5 py-8 text-sm text-destructive sm:px-8">{error}</div>;
  if (!data) return <div className="px-5 py-8 text-sm text-muted-foreground sm:px-8">Brak danych do analizy rynku.</div>;

  const purchaseRecommendation = getPurchaseRecommendation({
    estimatedAfterRenovationPrice: data.estimatedAfterRenovationPrice,
    currentListingPrice: data.currentPrice,
    targetProfit,
    targetRoi,
    ...calculatorCosts,
  });

  const topPercent =
    data.ranking !== null && data.comparableCount > 0
      ? (data.ranking / (data.comparableCount + 1)) * 100
      : null;

  return (
    <div className="market-intelligence-panel space-y-6 px-5 py-6 sm:px-8 sm:py-8">
      <style>{"@media (max-width: 767px){.market-intelligence-panel>section.overflow-hidden{display:none!important}}"}</style>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-lg font-bold tracking-tight">⭐ Rynek</p>
          <p className="mt-1 text-sm text-muted-foreground">Porównanie z aktywnymi ofertami obserwowanymi w ciągu ostatnich 90 dni.</p>
        </div>
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.08] px-3 py-2 text-right text-emerald-700 dark:text-emerald-300">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em]">Porównywalne</p>
          <p className="text-xl font-bold leading-none">{data.comparableCount}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Cena oferty" value={currency(data.currentPrice)} />
        <Metric label="Cena / m²" value={perSqm(data.currentPricePerSqm)} />
        <Metric label="Średnia ulicy" value={perSqm(data.streetAverage)} />
        <Metric label="Średnia dzielnicy" value={perSqm(data.districtAverage)} />
        <Metric label="Średnia porównań" value={perSqm(data.averagePricePerSqm)} />
        <Metric label="Mediana" value={perSqm(data.median)} />
        <Metric label="Po remoncie" value={currency(data.estimatedAfterRenovationPrice)} description={perSqm(data.estimatedAfterRenovationPricePerSqm)} />
        <Metric label="Potencjalny wzrost" value={signedCurrency(data.estimatedValueIncrease)} tone={tone(data.estimatedValueIncrease)} />
      </div>

      <ResaleCompsSection data={data} />

      <div className="grid gap-3 lg:grid-cols-3">
        <Metric label="Różnica do średniej" value={signedCurrency(data.priceDifference)} description={signedPercent(data.percentageDifference)} tone={tone(-1 * (data.priceDifference ?? 0))} />
        <Metric label="Ranking ceny / m²" value={data.ranking === null ? "—" : `${data.ranking}. z ${data.comparableCount + 1}`} />
        <Metric label="TOP" value={topPercent === null ? "—" : `${formatNumber(topPercent)}%`} description="niższa cena / m² = wyżej" />
      </div>

      <PurchaseRecommendationSection
        recommendation={purchaseRecommendation}
        currentListingPrice={data.currentPrice}
        targetProfit={targetProfit}
        targetRoi={targetRoi}
        onTargetProfitChange={onTargetProfitChange}
        onTargetRoiChange={onTargetRoiChange}
      />

      <ComparableCards comparables={data.comparables} />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="ui-chart p-4 sm:p-5">
          <h3 className="text-sm font-bold">Histogram cen / m²</h3>
          <p className="mt-1 text-xs text-muted-foreground">Rozkład cen wśród dobranych ofert.</p>
          <PriceHistogram values={data.comparables.map((listing) => listing.pricePerSqm)} />
        </section>
        <section className="ui-chart p-4 sm:p-5">
          <h3 className="text-sm font-bold">Box plot cen / m²</h3>
          <p className="mt-1 text-xs text-muted-foreground">Q1, mediana i Q3; znacznik pokazuje aktualną ofertę.</p>
          <PriceBoxPlot current={data.currentPricePerSqm} max={data.max} median={data.median} min={data.min} q1={data.q1} q3={data.q3} />
          <div className="mt-3 grid grid-cols-4 gap-2 text-xs text-muted-foreground"><Legend label="Min" value={perSqm(data.min)} /><Legend label="Q1" value={perSqm(data.q1)} /><Legend label="Mediana" value={perSqm(data.median)} /><Legend label="Q3" value={perSqm(data.q3)} /></div>
        </section>
      </div>

      <section className="overflow-hidden rounded-2xl border border-border/70">
        <div className="border-b border-border/70 bg-muted/20 px-4 py-4 sm:px-5"><h3 className="text-sm font-bold">10 najbardziej podobnych mieszkań</h3><p className="mt-1 text-xs text-muted-foreground">Kolejność uwzględnia ulicę, osiedle, dzielnicę, miasto, metraż i liczbę pokoi.</p></div>
        {data.comparables.length ? <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="border-b border-border/70 text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">Oferta</th><th className="px-4 py-3 font-medium">Lokalizacja</th><th className="px-4 py-3 font-medium">Cena</th><th className="px-4 py-3 font-medium">Cena / m²</th><th className="px-4 py-3 font-medium">Cechy</th><th className="px-4 py-3 text-right font-medium">Podobieństwo</th></tr></thead><tbody className="divide-y divide-border/60">{data.comparables.map((listing) => <tr key={listing.id}><td className="max-w-52 px-4 py-3 font-medium">{listing.originalUrl ? <a className="flex items-center gap-1 truncate text-foreground transition-colors hover:text-gold hover:underline" href={listing.originalUrl} rel="noopener noreferrer" target="_blank"><span className="truncate">{listing.title ?? "Oferta bez tytułu"}</span><ExternalLink className="size-3.5 shrink-0" /></a> : <p className="truncate">{listing.title ?? "Oferta bez tytułu"}</p>}<div className="mt-1 flex items-center gap-2"><span className="ui-badge px-2 py-0.5 text-[10px]">{sourceLabel(listing.source)}</span><p className="truncate text-xs text-muted-foreground">{listing.matchReasons.join(" · ")}</p></div></td><td className="px-4 py-3 text-muted-foreground">{[listing.address, listing.district, listing.city].filter(Boolean).join(", ") || "—"}</td><td className="px-4 py-3">{currency(listing.price)}</td><td className="px-4 py-3 font-medium">{perSqm(listing.pricePerSqm)}</td><td className="px-4 py-3 text-muted-foreground">{measure(listing.area, "m²")} · {measure(listing.rooms, "pok.")}</td><td className="px-4 py-3 text-right"><span className="rounded-full bg-foreground px-2.5 py-1 text-xs font-semibold text-background">{listing.similarityScore}%</span></td></tr>)}</tbody></table></div> : <div className="px-5 py-8 text-sm text-muted-foreground">Brak wystarczających ofert porównywalnych dla tej lokalizacji i parametrów.</div>}
      </section>
    </div>
  );
}

function ResaleCompsSection({ data }: { data: MarketIntelligence }) {
  const comps = data.resaleComps ?? [];
  const hasArv = data.resaleCompCount !== undefined;
  if (!hasArv) return null;
  return <section className="space-y-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-base font-bold">Porównania po remoncie</h3><p className="mt-1 text-sm text-muted-foreground">Oddzielna baza ofert wykończonych, używana wyłącznie do wyceny odsprzedaży.</p></div><span className="rounded-full border border-emerald-500/30 px-3 py-1 text-sm font-semibold text-emerald-700 dark:text-emerald-300">{data.resaleCompCount} porównań</span></div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><Metric label="Mediana / m²" value={perSqm(data.resaleCompMedianPricePerSqm ?? null)} /><Metric label="Średnia ważona / m²" value={perSqm(data.resaleCompWeightedPricePerSqm ?? null)} /><Metric label="Conservative" value={currency(data.resaleCompLowPrice ?? null)} /><Metric label="Expected" value={currency(data.resaleCompExpectedPrice ?? null)} /><Metric label="Optimistic" value={currency(data.resaleCompHighPrice ?? null)} /></div>
    <div className="grid gap-3 sm:grid-cols-2"><Metric label="Recommended listing price" value={currency(data.recommendedListingPrice ?? null)} /><Metric label="Estimated sale price" value={currency(data.estimatedSalePrice ?? null)} description="z uwzględnieniem negocjacji" /></div>
    {comps.length ? <div className="overflow-x-auto rounded-xl border border-border/70 bg-card"><table className="w-full min-w-[620px] text-left text-sm"><thead className="border-b border-border/70 text-xs text-muted-foreground"><tr><th className="px-3 py-2 font-medium">Oferta</th><th className="px-3 py-2 font-medium">Lokalizacja</th><th className="px-3 py-2 font-medium">zł/m²</th><th className="px-3 py-2 font-medium">Świeżość</th><th className="px-3 py-2 text-right font-medium">Podobieństwo</th></tr></thead><tbody className="divide-y divide-border/60">{comps.slice(0, 10).map((comp) => <tr key={comp.id}><td className="max-w-56 px-3 py-2 font-medium">{comp.originalUrl ? <a className="truncate text-gold hover:underline" href={comp.originalUrl} rel="noopener noreferrer" target="_blank">{comp.title ?? "Oferta"}</a> : comp.title ?? "Oferta"}<div className="mt-0.5 text-xs text-muted-foreground">Remont: {comp.renovationConfidence ?? "—"}</div></td><td className="px-3 py-2 text-muted-foreground">{[comp.address, comp.district, comp.city].filter(Boolean).join(", ") || "—"}</td><td className="px-3 py-2">{perSqm(comp.pricePerSqm)}</td><td className="px-3 py-2 text-muted-foreground">{comp.freshnessDays === null || comp.freshnessDays === undefined ? "—" : `${formatNumber(comp.freshnessDays)} dni`}</td><td className="px-3 py-2 text-right"><span className="rounded-full bg-foreground px-2 py-1 text-xs font-semibold text-background">{comp.similarityScore}%</span></td></tr>)}</tbody></table></div> : <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">Brak zweryfikowanych porównań po remoncie dla tej oferty.</p>}
  </section>;
}

function PurchaseRecommendationSection({ recommendation, currentListingPrice, targetProfit, targetRoi, onTargetProfitChange, onTargetRoiChange }: { recommendation: ReturnType<typeof getPurchaseRecommendation>; currentListingPrice: number | null; targetProfit: number; targetRoi: number; onTargetProfitChange: (value: number) => void; onTargetRoiChange: (value: number) => void }) {
  const decision = recommendation.decision;
  const decisionLabel = decision === "buy" ? "Kup" : decision === "negotiate" ? "Negocjuj" : "Odrzuć";
  const decisionClass = decision === "buy" ? "border-emerald-500/30 bg-emerald-500/[0.10] text-emerald-700 dark:text-emerald-300" : decision === "negotiate" ? "border-amber-500/30 bg-amber-500/[0.10] text-amber-700 dark:text-amber-300" : "border-rose-500/30 bg-rose-500/[0.10] text-rose-700 dark:text-rose-300";

  return <section className="rounded-2xl border border-border/70 bg-gradient-to-br from-foreground/[0.04] via-card to-card p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="text-base font-bold tracking-tight">Rekomendacja zakupu</h3><p className="mt-1 text-sm text-muted-foreground">Limit oparty o wycenę po remoncie i koszty z Kalkulatora.</p></div><span className={`rounded-full border px-3 py-1.5 text-sm font-bold ${decisionClass}`}>{decisionLabel}</span></div><div className="mt-5 grid gap-3 sm:grid-cols-2"><RecommendationInput label="Docelowy zysk" suffix="zł" value={targetProfit} onChange={onTargetProfitChange} /><RecommendationInput label="Docelowe ROI" suffix="%" value={targetRoi} onChange={onTargetRoiChange} /></div><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Cena ofertowa" value={currency(currentListingPrice)} /><Metric label="Rekomendowana maks. cena" value={currency(recommendation.recommendedMaxPrice)} /><Metric label="Cel negocjacyjny" value={currency(recommendation.negotiationTarget)} /><Metric label="Możliwy zysk" value={signedCurrency(recommendation.potentialProfit)} tone={tone(recommendation.potentialProfit)} /><Metric label="ROI przy cenie ofertowej" value={signedPercent(recommendation.potentialRoi)} tone={tone(recommendation.potentialRoi)} /><Metric label="Limit: cel zysku" value={currency(recommendation.maxPriceForTargetProfit)} /><Metric label="Limit: cel ROI" value={currency(recommendation.maxPriceForTargetRoi)} /><Metric label="Różnica do rekomendacji" value={signedCurrency(recommendation.currentPriceDifference)} description={signedPercent(recommendation.currentPriceDifferencePercent)} tone={tone(-1 * (recommendation.currentPriceDifference ?? 0))} /></div><div className="mt-5 grid gap-4 lg:grid-cols-2"><RecommendationList label="Uzasadnienie" values={recommendation.reasons} /><RecommendationList label="Ryzyka" values={recommendation.risks} empty="Nie wykryto dodatkowych ryzyk w założeniach." /></div></section>;
}

function RecommendationInput({ label, suffix, value, onChange }: { label: string; suffix: string; value: number; onChange: (value: number) => void }) { return <label className="block"><span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span><div className="relative"><input className="h-10 w-full rounded-lg border border-input bg-background px-3 pr-10 text-sm" min="0" onChange={(event) => onChange(nonNegativeNumber(event.target.value))} step="any" type="number" value={value} /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">{suffix}</span></div></label>; }
function ComparableCards({ comparables }: { comparables: MarketIntelligence["comparables"] }) { return <section className="space-y-3 md:hidden"><div><h3 className="text-sm font-bold">10 najbardziej podobnych mieszkań</h3><p className="mt-1 text-xs text-muted-foreground">Porównywalne oferty w układzie mobilnym.</p></div>{comparables.length ? comparables.map((listing) => <article className="rounded-2xl border border-border/70 bg-card p-4" key={listing.id}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="line-clamp-2 font-semibold">{listing.title ?? "Oferta bez tytułu"}</p><p className="mt-1 text-xs text-muted-foreground">{[listing.address, listing.district, listing.city].filter(Boolean).join(", ") || "—"}</p></div><span className="shrink-0 rounded-full bg-foreground px-2.5 py-1 text-xs font-semibold text-background">{listing.similarityScore}%</span></div><div className="mt-4 grid grid-cols-2 gap-2 text-sm"><Metric label="Cena" value={currency(listing.price)} /><Metric label="Cena / m²" value={perSqm(listing.pricePerSqm)} /></div><div className="mt-3 flex min-h-11 items-center justify-between gap-3"><span className="ui-badge px-2 py-1 text-[10px]">{sourceLabel(listing.source)}</span>{listing.originalUrl ? <a aria-label={`Otwórz ogłoszenie: ${listing.title ?? "oferta"}`} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-sm font-semibold text-gold outline-none focus-visible:ring-2 focus-visible:ring-primary" href={listing.originalUrl} rel="noopener noreferrer" target="_blank">Ogłoszenie<ExternalLink className="size-4" /></a> : null}</div></article>) : <div className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">Brak wystarczających ofert porównywalnych.</div>}</section>; }
function RecommendationList({ label, values, empty = "" }: { label: string; values: string[]; empty?: string }) { return <div className="rounded-xl bg-muted/30 p-4"><p className="text-sm font-semibold">{label}</p><ul className="mt-3 space-y-2 text-sm leading-5 text-muted-foreground">{values.length ? values.map((value) => <li className="flex gap-2" key={value}><span className="mt-2 size-1.5 shrink-0 rounded-full bg-current/70" />{value}</li>) : <li>{empty}</li>}</ul></div>; }

function PriceHistogram({ values }: { values: Array<number | null> }) {
  const prices = values.filter(isPositiveFinite);
  if (prices.length < 2) return <EmptyChart />;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (min === max) return <EmptyChart label="Wszystkie porównywalne oferty mają tę samą cenę / m²." />;
  const bins = Array.from({ length: Math.min(6, Math.max(3, prices.length)) }, () => 0);
  for (const price of prices) {
    const index = Math.min(bins.length - 1, Math.floor(((price - min) / (max - min)) * bins.length));
    bins[index] = (bins[index] ?? 0) + 1;
  }
  const maxCount = Math.max(...bins, 1);
  return <div className="mt-5"><svg aria-label="Histogram cen za metr kwadratowy" className="h-40 w-full" role="img" viewBox="0 0 360 160">{bins.map((count, index) => { const width = 360 / bins.length; const height = (count / maxCount) * 118; return <rect fill="currentColor" className="text-emerald-500" height={height} key={index} opacity="0.8" rx="4" width={Math.max(4, width - 7)} x={index * width + 4} y={130 - height} />; })}<line stroke="currentColor" className="text-border" x1="0" x2="360" y1="130" y2="130" /></svg><div className="flex justify-between text-xs text-muted-foreground"><span>{perSqm(min)}</span><span>{perSqm(max)}</span></div></div>;
}

function PriceBoxPlot({ min, q1, median, q3, max, current }: { min: number | null; q1: number | null; median: number | null; q3: number | null; max: number | null; current: number | null }) {
  if (!isPositiveFinite(min) || !isPositiveFinite(q1) || !isPositiveFinite(median) || !isPositiveFinite(q3) || !isPositiveFinite(max)) return <EmptyChart />;
  const range = max - min || 1;
  const position = (value: number) => 24 + ((value - min) / range) * 312;
  return <div className="mt-5"><svg aria-label="Wykres pudełkowy cen za metr kwadratowy" className="h-28 w-full" role="img" viewBox="0 0 360 112"><line className="text-muted-foreground" stroke="currentColor" strokeWidth="2" x1={position(min)} x2={position(max)} y1="55" y2="55" /><line className="text-muted-foreground" stroke="currentColor" x1={position(min)} x2={position(min)} y1="42" y2="68" /><line className="text-muted-foreground" stroke="currentColor" x1={position(max)} x2={position(max)} y1="42" y2="68" /><rect className="text-violet-500" fill="currentColor" fillOpacity="0.2" height="42" stroke="currentColor" strokeWidth="2" width={Math.max(2, position(q3) - position(q1))} x={position(q1)} y="34" /><line className="text-violet-600" stroke="currentColor" strokeWidth="3" x1={position(median)} x2={position(median)} y1="34" y2="76" />{isPositiveFinite(current) ? <><line className="text-emerald-500" stroke="currentColor" strokeDasharray="4 3" strokeWidth="2" x1={position(Math.min(max, Math.max(min, current)))} x2={position(Math.min(max, Math.max(min, current)))} y1="16" y2="94" /><text className="fill-emerald-600 text-[10px] dark:fill-emerald-300" textAnchor="middle" x={position(Math.min(max, Math.max(min, current)))} y="12">oferta</text></> : null}</svg></div>;
}

function EmptyChart({ label = "Za mało danych do narysowania wykresu." }: { label?: string }) { return <div className="mt-5 flex h-40 items-center justify-center rounded-xl border border-dashed border-border text-center text-sm text-muted-foreground">{label}</div>; }
function Metric({ label, value, description, tone: valueTone }: { label: string; value: string; description?: string; tone?: "positive" | "negative" | "neutral" }) { return <div className="ui-metric"><p className="text-xs text-muted-foreground">{label}</p><p className={`mt-1 text-lg font-bold tracking-tight ${valueTone === "positive" ? "text-emerald-600 dark:text-emerald-300" : valueTone === "negative" ? "text-rose-600 dark:text-rose-300" : ""}`}>{value}</p>{description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}</div>; }
function Legend({ label, value }: { label: string; value: string }) { return <div><p>{label}</p><p className="mt-0.5 font-medium text-foreground">{value}</p></div>; }
function currency(value: number | null): string { return isPositiveFinite(value) ? new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value) : "—"; }
function signedCurrency(value: number | null): string { return value === null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : ""}${new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value)}`; }
function perSqm(value: number | null): string { return isPositiveFinite(value) ? `${currency(value)}/m²` : "—"; }
function signedPercent(value: number | null): string { return value === null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : ""}${formatNumber(value)}%`; }
function measure(value: number | null, unit: string): string { return isPositiveFinite(value) ? `${formatNumber(value)} ${unit}` : "—"; }
function formatNumber(value: number): string { return new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 }).format(value); }
function sourceLabel(value: string): string { return value === "otodom" ? "Otodom" : value === "olx" ? "OLX" : value === "morizon" ? "Morizon" : value === "facebook" ? "Facebook" : value; }
function tone(value: number | null): "positive" | "negative" | "neutral" { return value === null || value === 0 ? "neutral" : value > 0 ? "positive" : "negative"; }
function isPositiveFinite(value: number | null): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function nonNegativeNumber(value: string): number { const parsed = Number(value.replace(",", ".")); return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0; }
