import type { CanonicalDeal } from "../types";
import { ConfidenceMeter, MetricTile, SectionHeading } from "./investment-ui";

export function DealHealth({ deal }: { deal: CanonicalDeal }) {
  const ceo = deal.ceo.result;
  const market = deal.market.result;
  const underwriting = deal.underwriting.result;
  const blocked = ceo?.criticalGates.filter((gate) => !gate.passed) ?? [];

  return <section aria-labelledby="deal-health-title" className="min-w-0 max-w-full space-y-3">
    <SectionHeading eyebrow="02 · economics & confidence" id="deal-health-title" title="Deal health" aside={blocked.length ? <span className="rounded-full border border-amber-500/35 bg-amber-500/10 px-3 py-1 text-xs font-semibold">BUY GATE BLOCKED · {blocked.length}</span> : null} />
    {blocked.length ? <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-4 py-3 text-sm">
      <p className="font-semibold">Zakup wymaga potwierdzenia krytycznych informacji</p>
      <p className="mt-1 text-muted-foreground">{blocked.slice(0, 2).map((gate) => gate.reason).join(" · ")}{blocked.length > 2 ? ` · oraz ${blocked.length - 2} kolejnych` : ""}</p>
    </div> : null}
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      <MetricTile label="Zysk bazowy" value={money(underwriting?.profitBase ?? ceo?.expectedProfitBase)} />
      <MetricTile label="ROI bazowe" value={pct(underwriting?.roiBase)} />
      <MetricTile label="Marża bazowa" value={pct(underwriting?.marginBase)} />
      <MetricTile label="Odsprzedaż · base" value={money(market?.resaleValueBase)} detail={market ? `${money(market.resalePricePerM2Base)} / m²` : undefined} />
      <MetricTile label="Remont" value={money(underwriting?.renovationTotal)} detail={underwriting ? `${money(underwriting.renovationPerM2)} / m² · ${underwriting.renovationMode}` : undefined} />
      <MetricTile label="Całkowity koszt projektu" value={money(underwriting?.totalProjectCost)} />
    </div>
    <div className="grid gap-3 rounded-xl border border-border/70 bg-muted/20 p-4 sm:grid-cols-3">
      <ConfidenceMeter label="Pewność danych" value={deal.verify.confidenceAxes.data} />
      <ConfidenceMeter label="Pewność rynku" value={deal.market.confidenceAxes.market ?? deal.market.confidence} />
      <ConfidenceMeter label="Pewność decyzji" value={ceo?.confidence ?? null} />
    </div>
  </section>;
}

function money(value: number | null | undefined) { return value == null ? "—" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value); }
function pct(value: number | null | undefined) { return value == null ? "—" : `${value.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%`; }
