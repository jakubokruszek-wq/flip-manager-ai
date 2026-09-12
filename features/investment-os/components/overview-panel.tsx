import type { CanonicalDeal } from "../types";
import { ContentList, formatInvestmentRisk, PanelCard } from "./investment-ui";

export function OverviewPanel({ deal }: { deal: CanonicalDeal }) {
  const ceo = deal.ceo.result;
  return <div className="grid gap-3 lg:grid-cols-2">
    <ContentList title="Mocne strony" values={ceo?.strengths ?? []} />
    <ContentList title="Najważniejsze ryzyka" values={(ceo?.risks ?? []).map(formatInvestmentRisk)} />
    <ContentList title="Brakujące informacje przed zakupem" values={ceo?.missingBeforePurchase ?? []} />
    <PanelCard title="Investment thesis"><p>{ceo?.investmentThesis ?? "Brak zatwierdzonej tezy dla obecnego stanu danych."}</p></PanelCard>
    <PanelCard title="Scenariusze CEO">
      <dl className="grid gap-3 sm:grid-cols-3"><div><dt className="text-[11px] uppercase tracking-wide">Bear</dt><dd className="mt-1 text-foreground">{ceo?.bearCase ?? "—"}</dd></div><div><dt className="text-[11px] uppercase tracking-wide">Base</dt><dd className="mt-1 text-foreground">{ceo?.baseCase ?? "—"}</dd></div><div><dt className="text-[11px] uppercase tracking-wide">Bull</dt><dd className="mt-1 text-foreground">{ceo?.bullCase ?? "—"}</dd></div></dl>
    </PanelCard>
    <div className="grid gap-3 sm:grid-cols-2">
      <ContentList title="Warunki działania" values={ceo?.conditionsToProceed ?? []} />
      <ContentList title="Warunki odejścia" values={ceo?.walkAwayConditions ?? []} />
    </div>
  </div>;
}
