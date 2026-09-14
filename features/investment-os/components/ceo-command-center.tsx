import type { CanonicalDeal } from "../types";
import { formatInvestmentRisk, formatPercentDisplay, pln, StatusPill } from "./investment-ui";

export function CeoCommandCenter({ deal, onOpenPlaybook }: { deal: CanonicalDeal; onOpenPlaybook: () => void }) {
  const ceo = deal.ceo.result;
  const underwriting = deal.underwriting.result;
  const action = ceo?.action ?? "WSTRZYMAJ DECYZJĘ · UZUPEŁNIJ DANE";
  const blocked = ceo?.criticalGates.filter((gate) => !gate.passed) ?? [];
  const primaryRisk = ceo?.risks[0] ?? (blocked[0] ? blocked[0].reason : null);
  const missingBeforePurchase = ceo?.missingBeforePurchase ?? [];
  const missingSummary = missingBeforePurchase.length
    ? `${missingBeforePurchase.slice(0, 2).map(labelMissingField).join(" · ")}${missingBeforePurchase.length > 2 ? ` · +${missingBeforePurchase.length - 2}` : ""}`
    : "Brak pozycji zgłoszonych przez CEO w aktualnej analizie.";
  const nextAction = ceo?.action === "NEGOCJUJ" && ceo.openingOffer != null
    ? `Oferta otwierająca: ${pln(ceo.openingOffer)}.`
    : ceo?.nextBestAction || "Uzupełnij dane krytyczne i ponownie oceń warunki zakupu.";
  const formattedPrimaryRisk = primaryRisk ? formatInvestmentRisk(primaryRisk) : null;

  return (
    <section aria-labelledby="command-center-title" className="min-w-0 max-w-full overflow-hidden rounded-[1.375rem] border border-gold/20 bg-[linear-gradient(135deg,#1b2026_0%,#111418_72%)] text-foreground shadow-[0_24px_70px_-34px_rgba(0,0,0,1)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-6 sm:py-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gold/80">Flip Investment OS · Centrum decyzji</p>
          <h2 className="type-section-title mt-1 text-2xl tracking-tight sm:text-3xl" id="command-center-title">{action}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-5 text-muted-foreground">{ceo?.headline ?? "Decyzja jest ograniczona przez brak wymaganych danych."}</p>
        </div>
        <StatusPill label={deal.ceo.status === "COMPLETE" ? "ANALIZA GOTOWA" : undefined} status={deal.ceo.status} />
      </div>

      <div className="grid gap-2 px-3 py-2 sm:grid-cols-2 sm:p-4 lg:grid-cols-4">
        <CommandMetric label="Maks. cena zakupu" value={pln(ceo?.maxPurchasePrice)} emphasis detail="Górny limit ceny zakupu" />
        <CommandMetric label="Oczekiwany zysk" value={pln(ceo?.expectedProfitBase ?? underwriting?.profitBase)} detail="Scenariusz bazowy" />
        <div className="hidden sm:block"><CommandMetric label="Zwrot z inwestycji" value={formatPercentDisplay(underwriting?.roiBase)} detail="Wskaźnik ROI względem kosztu projektu" /></div>
        <div className="hidden sm:block"><CommandMetric label="Ocena inwestycji" value={ceo ? `${ceo.flipScore}/100` : "—"} detail={`Pewność ${ceo ? `${ceo.confidence}/100` : "—"}`} /></div>
      </div>

      <RiskAndMissingInfo missingSummary={missingSummary} primaryRisk={formattedPrimaryRisk} className="mx-3 mb-3 hidden sm:mx-4 sm:block" />

      <div className="mx-3 mb-3 flex items-center gap-2 rounded-2xl border border-gold/15 bg-gold/[0.045] p-2.5 sm:mx-4 sm:mb-4 sm:justify-between sm:gap-4 sm:px-4 sm:py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gold/80">Następny krok</p>
          <p className="mt-1 text-sm font-medium leading-5">{nextAction}</p>
        </div>
        <button className="min-h-9 max-w-[44%] shrink-0 rounded-xl border border-gold/25 bg-gold px-2 text-center text-[11px] font-semibold leading-4 text-primary-foreground outline-none transition hover:bg-gold/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card sm:min-h-10 sm:max-w-none sm:px-4 sm:text-sm" onClick={onOpenPlaybook} type="button">
          Otwórz plan działania
        </button>
      </div>
      <div className="mx-3 mb-3 grid grid-cols-2 gap-2 sm:hidden">
        <CommandMetric label="Zwrot z inwestycji" value={formatPercentDisplay(underwriting?.roiBase)} detail="Wskaźnik ROI względem kosztu projektu" />
        <CommandMetric label="Ocena inwestycji" value={ceo ? `${ceo.flipScore}/100` : "—"} detail={`Pewność ${ceo ? `${ceo.confidence}/100` : "—"}`} />
      </div>
      <RiskAndMissingInfo missingSummary={missingSummary} primaryRisk={formattedPrimaryRisk} className="mx-3 mb-3 sm:hidden" />
      <div className="hidden gap-2 px-4 pb-4 sm:grid sm:grid-cols-2 lg:grid-cols-4">
        <CommandMetric label="Cena ofertowa" value={pln(deal.facts.askingPrice.effectiveValue)} />
        <CommandMetric label="Oferta otwierająca" value={pln(ceo?.openingOffer)} />
        <CommandMetric label="Cel negocjacyjny" value={pln(ceo?.targetPurchasePrice)} />
        <CommandMetric label="Zysk ostrożny" value={pln(ceo?.expectedProfitConservative)} />
      </div>
      <details className="mx-3 mb-3 rounded-xl border border-border sm:hidden">
        <summary className="min-h-10 cursor-pointer px-3 py-2.5 text-xs font-semibold text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary">Cena ofertowa, oferta otwarcia i cel</summary>
        <div className="grid grid-cols-2 gap-2 border-t border-background/10 p-2">
          <CommandMetric label="Cena ofertowa" value={pln(deal.facts.askingPrice.effectiveValue)} />
          <CommandMetric label="Oferta otwierająca" value={pln(ceo?.openingOffer)} />
          <CommandMetric label="Cel negocjacyjny" value={pln(ceo?.targetPurchasePrice)} />
          <CommandMetric label="Zysk ostrożny" value={pln(ceo?.expectedProfitConservative)} />
        </div>
      </details>
    </section>
  );
}

function RiskAndMissingInfo({ primaryRisk, missingSummary, className }: { primaryRisk: string | null; missingSummary: string; className: string }) {
  return <div className={`grid gap-3 rounded-2xl border border-warning/25 bg-warning/10 px-3 py-3 text-xs text-foreground sm:grid-cols-2 ${className}`}>
    {primaryRisk ? <div className="space-y-1" data-command-primary-risk>
      <p className="font-semibold uppercase tracking-wide text-warning">NAJWIĘKSZE RYZYKO</p>
      <p className="leading-5">{primaryRisk}</p>
    </div> : null}
    <div className="space-y-1" data-command-missing-info>
      <p className="font-semibold uppercase tracking-wide text-muted-foreground">BRAKUJĄCE INFORMACJE</p>
      <p className="leading-5">{missingSummary}</p>
    </div>
  </div>;
}

function labelMissingField(field: string): string {
  const labels: Record<string, string> = {
    askingPrice: "cena zakupu",
    areaM2: "powierzchnia",
    rooms: "liczba pokoi",
    city: "miasto",
    district: "dzielnica",
    street: "dokładny adres",
    buildingType: "typ budynku",
    ownership: "forma własności",
    legalStatus: "stan prawny",
    marketEvidence: "wiarygodne dane rynkowe",
    renovationScope: "zakres remontu",
    economics: "zweryfikowana ekonomika",
    riskReview: "przegląd ryzyk",
    identity: "dokładna tożsamość ogłoszenia",
  };
  return labels[field] ?? field;
}

function CommandMetric({ label, value, detail, emphasis = false }: { label: string; value: string; detail?: string; emphasis?: boolean }) {
  return <div className={`min-h-[68px] min-w-0 rounded-2xl border border-border px-3 py-2 ${emphasis ? "bg-gold/10 ring-1 ring-gold/20" : "bg-background/35"}`}>
    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
    <p className={`type-financial-standard mt-1 ${emphasis ? "text-gold" : "text-foreground"}`}>{value}</p>
    {detail ? <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{detail}</p> : null}
  </div>;
}
