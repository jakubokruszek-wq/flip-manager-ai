import type { CanonicalDeal } from "../types";
import { pln, StatusPill } from "./investment-ui";

export function CeoCommandCenter({ deal, onOpenPlaybook }: { deal: CanonicalDeal; onOpenPlaybook: () => void }) {
  const ceo = deal.ceo.result;
  const underwriting = deal.underwriting.result;
  const action = ceo?.action ?? "HOLD / ZBIERZ DANE";
  const blocked = ceo?.criticalGates.filter((gate) => !gate.passed) ?? [];
  const primaryRisk = ceo?.risks[0] ?? (blocked[0] ? blocked[0].reason : null);
  const missingBeforePurchase = ceo?.missingBeforePurchase ?? [];
  const missingSummary = missingBeforePurchase.length
    ? `${missingBeforePurchase.slice(0, 2).map(labelMissingField).join(" · ")}${missingBeforePurchase.length > 2 ? ` · +${missingBeforePurchase.length - 2}` : ""}`
    : "Brak pozycji zgłoszonych przez CEO w aktualnej analizie.";
  const nextAction = ceo?.nextBestAction || "Uzupełnij dane krytyczne i ponownie oceń warunki zakupu.";

  return (
    <section aria-labelledby="command-center-title" className="min-w-0 max-w-full overflow-hidden rounded-2xl bg-foreground text-background shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-background/10 px-4 py-3 sm:px-6 sm:py-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-background/60">Flip Investment OS · Command Center</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl" id="command-center-title">{action}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-5 text-background/75">{ceo?.headline ?? "Decyzja jest ograniczona przez brak wymaganych danych."}</p>
        </div>
        <StatusPill status={deal.ceo.status} />
      </div>

      <div className="grid gap-2 px-3 py-2 sm:grid-cols-2 sm:p-4 lg:grid-cols-4">
        <CommandMetric label="MAX BUY" value={pln(ceo?.maxPurchasePrice)} emphasis detail="Górny limit ceny zakupu" />
        <CommandMetric label="EXPECTED PROFIT" value={pln(ceo?.expectedProfitBase ?? underwriting?.profitBase)} detail="Zysk bazowy" />
        <div className="hidden sm:block"><CommandMetric label="ROI" value={underwriting?.roiBase == null ? "—" : `${underwriting.roiBase.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%`} detail="Względem kosztu projektu" /></div>
        <div className="hidden sm:block"><CommandMetric label="Flip Score" value={ceo ? `${ceo.flipScore}/100` : "—"} detail={`Confidence ${ceo ? `${ceo.confidence}/100` : "—"}`} /></div>
      </div>

      <div className="mx-3 mb-3 hidden rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-xs text-background/90 sm:mx-4 sm:block">
        {primaryRisk ? <p><span className="font-semibold uppercase tracking-wide text-amber-200">Największe ryzyko</span><span className="ml-2">{primaryRisk}</span></p> : null}
        <p className={primaryRisk ? "mt-1" : ""} data-command-missing-info><span className="font-semibold uppercase tracking-wide text-background/65">Czego jeszcze nie wiemy</span><span className="ml-2">{missingSummary}</span></p>
      </div>

      <div className="mx-3 mb-3 flex items-center gap-2 rounded-xl border border-background/15 bg-background/5 p-2.5 sm:mx-4 sm:mb-4 sm:justify-between sm:gap-4 sm:px-4 sm:py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-background/60">Next best action</p>
          <p className="mt-1 text-sm font-medium leading-5">{nextAction}</p>
        </div>
        <button className="min-h-9 max-w-[44%] shrink-0 rounded-lg bg-background px-2 text-center text-[11px] font-semibold leading-4 text-foreground outline-none transition hover:bg-background/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-foreground sm:min-h-10 sm:max-w-none sm:px-4 sm:text-sm" onClick={onOpenPlaybook} type="button">
          Otwórz plan działania
        </button>
      </div>
      <div className="mx-3 mb-3 grid grid-cols-2 gap-2 sm:hidden">
        <CommandMetric label="ROI" value={underwriting?.roiBase == null ? "—" : `${underwriting.roiBase.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%`} detail="Względem kosztu projektu" />
        <CommandMetric label="Flip Score" value={ceo ? `${ceo.flipScore}/100` : "—"} detail={`Confidence ${ceo ? `${ceo.confidence}/100` : "—"}`} />
      </div>
      <div className="mx-3 mb-3 rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-xs text-background/90 sm:hidden">
        {primaryRisk ? <p><span className="font-semibold uppercase tracking-wide text-amber-200">Największe ryzyko</span><span className="ml-2">{primaryRisk}</span></p> : null}
        <p className={primaryRisk ? "mt-1" : ""} data-command-missing-info><span className="font-semibold uppercase tracking-wide text-background/65">Czego jeszcze nie wiemy</span><span className="ml-2">{missingSummary}</span></p>
      </div>
      <div className="hidden gap-2 px-4 pb-4 sm:grid sm:grid-cols-2 lg:grid-cols-4">
        <CommandMetric label="ASKING" value={pln(deal.facts.askingPrice.effectiveValue)} />
        <CommandMetric label="OPENING OFFER" value={pln(ceo?.openingOffer)} />
        <CommandMetric label="TARGET" value={pln(ceo?.targetPurchasePrice)} />
        <CommandMetric label="Zysk ostrożny" value={pln(ceo?.expectedProfitConservative)} />
      </div>
      <details className="mx-3 mb-3 rounded-lg border border-background/10 sm:hidden">
        <summary className="min-h-10 cursor-pointer px-3 py-2.5 text-xs font-semibold text-background/75 outline-none focus-visible:ring-2 focus-visible:ring-primary">Cena ofertowa, oferta otwarcia i target</summary>
        <div className="grid grid-cols-2 gap-2 border-t border-background/10 p-2">
          <CommandMetric label="ASKING" value={pln(deal.facts.askingPrice.effectiveValue)} />
          <CommandMetric label="OPENING OFFER" value={pln(ceo?.openingOffer)} />
          <CommandMetric label="TARGET" value={pln(ceo?.targetPurchasePrice)} />
          <CommandMetric label="Zysk ostrożny" value={pln(ceo?.expectedProfitConservative)} />
        </div>
      </details>
    </section>
  );
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
  return <div className={`min-h-[68px] min-w-0 rounded-lg border border-background/10 px-3 py-2 ${emphasis ? "bg-background/10" : "bg-background/[0.035]"}`}>
    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-background/60">{label}</p>
    <p className={`mt-1 break-words font-semibold tabular-nums tracking-tight ${emphasis ? "text-xl sm:text-2xl" : "text-base"}`}>{value}</p>
    {detail ? <p className="mt-0.5 text-[11px] leading-4 text-background/60">{detail}</p> : null}
  </div>;
}
