import type { CanonicalDeal } from "../types";
import { MetricTile, PanelCard } from "./investment-ui";

export function EconomicsPanel({ deal }: { deal: CanonicalDeal }) {
  const result = deal.underwriting.result;
  if (!result) return <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.07] p-4"><p className="font-semibold">UNDERWRITER · BLOCKED</p><p className="mt-1 text-sm text-muted-foreground">{deal.underwriting.reasonCodes.join(" · ") || "Brak danych do obliczenia."}</p></div>;
  return <div className="space-y-4">
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"><MetricTile label="Remont" value={money(result.renovationTotal)} detail={`${money(result.renovationPerM2)} / m² · ${result.renovationMode}`} /><MetricTile label="Koszt projektu · base" value={money(result.totalProjectCost)} emphasis /><MetricTile label="Zysk · base" value={money(result.profitBase)} /><MetricTile label="Marża · base" value={pct(result.marginBase)} /><MetricTile label="ROI · base" value={pct(result.roiBase)} /><MetricTile label="MAX BUY" value={money(result.maxPurchasePrice)} detail={`Cel zakupu: ${money(result.targetPurchasePrice)}`} /></div>
    <section><h4 className="text-sm font-semibold">Scenariusze kosztów i zysku</h4><div className="mt-2 grid gap-2 sm:grid-cols-3">{(["conservative", "base", "optimistic"] as const).map((name) => { const scenario = result.scenarios[name]; return <article className="rounded-xl border border-border/70 p-4" key={name}><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{scenarioLabel(name)}</p><dl className="mt-3 space-y-2 text-sm"><Row label="Odsprzedaż" value={money(scenario.resaleValue)} /><Row label="Remont" value={money(scenario.renovationTotal)} /><Row label="Całkowity koszt" value={money(scenario.totalProjectCost)} /><Row label="Zysk" value={money(scenario.profit)} highlight /></dl></article>; })}</div></section>
    <PanelCard title="Składniki kosztu bazowego">
      <div className="grid gap-x-5 gap-y-1 sm:grid-cols-2">{[
        ["Cena zakupu", result.purchasePrice], ["Koszty transakcyjne", result.purchaseTransactionCosts], ["Utrzymanie", result.holdingCosts], ["Finansowanie", result.financingCosts], ["Koszty sprzedaży", result.salesCosts], ["Rezerwa", result.contingency],
      ].map(([label, value]) => <Row key={String(label)} label={String(label)} value={money(value as number | null)} />)}</div>
    </PanelCard>
    <div className="grid gap-3 lg:grid-cols-2"><PanelCard title="Cena względem limitu"><p>Aktualna cena: {money(deal.facts.askingPrice.effectiveValue)}</p><p>Max buy: {money(result.maxPurchasePrice)}</p><p>Potrzebny rabat: {money(result.discountNeeded)}{result.discountNeededPercent == null ? "" : ` · ${pct(result.discountNeededPercent)}`}</p></PanelCard><PanelCard title="Jakość obliczenia"><p>Decyzja underwriting: {result.decision} · confidence {result.confidenceScore}%</p><p>Confidence odsprzedaży: {result.resaleConfidence}% · wynik flip score {result.flipScore}/100</p><p>Braki: {result.missingFields.join(", ") || "brak"}</p></PanelCard></div>
  </div>;
}

function Row({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) { return <div className="flex justify-between gap-3 border-b border-border/50 py-1.5 text-sm last:border-0"><dt className="text-muted-foreground">{label}</dt><dd className={`text-right tabular-nums ${highlight ? "font-semibold text-foreground" : "font-medium text-foreground"}`}>{value}</dd></div>; }
function money(value: number | null | undefined) { return value == null ? "—" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value); }
function pct(value: number | null | undefined) { return value == null ? "—" : `${value.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%`; }
function scenarioLabel(value: "conservative" | "base" | "optimistic") { return value === "conservative" ? "Ostrożny" : value === "optimistic" ? "Optymistyczny" : "Bazowy"; }
