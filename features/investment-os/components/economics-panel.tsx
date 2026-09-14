import type { CanonicalDeal } from "../types";
import { formatPercentDisplay, formatPLNDisplay, MetricTile, PanelCard } from "./investment-ui";

export function EconomicsPanel({ deal }: { deal: CanonicalDeal }) {
  const result = deal.underwriting.result;
  if (!result) return <div className="rounded-2xl border border-warning/30 bg-warning/[0.07] p-4"><p className="type-card-title">Analiza finansowa · zablokowana</p><p className="mt-1 text-sm text-muted-foreground">Brak wystarczających danych do obliczenia. Sprawdź braki i konflikty w zakładce „Źródła i audyt”.</p></div>;
  return <div className="space-y-4">
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"><MetricTile label="Remont" value={money(result.renovationTotal)} detail={`${money(result.renovationPerM2)} / m² · ${renovationModeLabel(result.renovationMode)}`} /><MetricTile label="Koszt projektu · bazowy" value={money(result.totalProjectCost)} emphasis /><MetricTile label="Zysk · bazowy" value={money(result.profitBase)} /><MetricTile label="Marża · bazowa" value={pct(result.marginBase)} /><MetricTile label="Zwrot z inwestycji (ROI) · bazowy" value={pct(result.roiBase)} /><MetricTile label="Maks. cena zakupu" value={money(result.maxPurchasePrice)} detail={`Cel zakupu: ${money(result.targetPurchasePrice)}`} /></div>
    <section><h4 className="type-card-title">Scenariusze kosztów i zysku</h4><div className="mt-2 grid gap-2 sm:grid-cols-3">{(["conservative", "base", "optimistic"] as const).map((name) => { const scenario = result.scenarios[name]; return <article className="rounded-2xl border border-border/70 bg-background/35 p-4" key={name}><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{scenarioLabel(name)}</p><dl className="mt-3 space-y-2 text-sm"><Row label="Odsprzedaż" value={money(scenario.resaleValue)} /><Row label="Remont" value={money(scenario.renovationTotal)} /><Row label="Całkowity koszt" value={money(scenario.totalProjectCost)} /><Row label="Zysk" value={money(scenario.profit)} highlight /></dl></article>; })}</div></section>
    <PanelCard title="Składniki kosztu bazowego">
      <div className="grid gap-x-5 gap-y-1 sm:grid-cols-2">{[
        ["Cena zakupu", result.purchasePrice], ["Koszty transakcyjne", result.purchaseTransactionCosts], ["Utrzymanie", result.holdingCosts], ["Finansowanie", result.financingCosts], ["Koszty sprzedaży", result.salesCosts], ["Rezerwa", result.contingency],
      ].map(([label, value]) => <Row key={String(label)} label={String(label)} value={money(value as number | null)} />)}</div>
    </PanelCard>
    <div className="grid gap-3 lg:grid-cols-2"><PanelCard title="Cena względem limitu"><p>Aktualna cena: {money(deal.facts.askingPrice.effectiveValue)}</p><p>Maks. cena zakupu: {money(result.maxPurchasePrice)}</p><p>Potrzebny rabat: {money(result.discountNeeded)}{result.discountNeededPercent == null ? "" : ` · ${pct(result.discountNeededPercent)}`}</p></PanelCard><PanelCard title="Jakość obliczenia"><p>Decyzja analizy: {decisionLabel(result.decision)} · pewność {pct(result.confidenceScore)}</p><p>Pewność odsprzedaży: {pct(result.resaleConfidence)} · ocena inwestycji {result.flipScore}/100</p><p>Braki: {result.missingFields.map(fieldLabel).join(", ") || "brak"}</p></PanelCard></div>
  </div>;
}

function Row({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) { return <div className="flex justify-between gap-3 border-b border-border/50 py-1.5 text-sm last:border-0"><dt className="text-muted-foreground">{label}</dt><dd className={`text-right tabular-nums ${highlight ? "font-semibold text-foreground" : "font-medium text-foreground"}`}>{value}</dd></div>; }
function money(value: number | null | undefined) { return formatPLNDisplay(value); }
function pct(value: number | null | undefined) { return formatPercentDisplay(value); }
function scenarioLabel(value: "conservative" | "base" | "optimistic") { return value === "conservative" ? "Ostrożny" : value === "optimistic" ? "Optymistyczny" : "Bazowy"; }
function renovationModeLabel(value: string): string { return ({ LIGHT: "lekki zakres", STANDARD: "standardowy zakres", FULL: "pełny zakres" } as Record<string, string>)[value] ?? "zakres do sprawdzenia"; }
function decisionLabel(value: string): string { return ({ BUY: "KUP", NEGOTIATE: "NEGOCJUJ", HOLD: "WSTRZYMAJ", REJECT: "ODRZUĆ", REVIEW: "DO OCENY" } as Record<string, string>)[value] ?? "DO SPRAWDZENIA"; }
function fieldLabel(value: string): string { return ({ askingPrice: "cena ofertowa", askingPricePerM2: "cena za m²", areaM2: "powierzchnia", rooms: "liczba pokoi", city: "miasto", district: "dzielnica", street: "adres", buildingType: "typ budynku", ownership: "forma własności", legalStatus: "stan prawny", renovationScope: "zakres remontu", marketEvidence: "dane rynkowe", identity: "tożsamość ogłoszenia", economics: "ekonomika", riskReview: "ocena ryzyka" } as Record<string, string>)[value] ?? "dodatkowe dane"; }
