import type { CanonicalDeal } from "../types";
import { ContentList, formatInvestmentRisk, formatInvestmentText, PanelCard } from "./investment-ui";

export function OverviewPanel({ deal }: { deal: CanonicalDeal }) {
  const ceo = deal.ceo.result;
  return <div className="grid gap-3 lg:grid-cols-2">
    <ContentList title="Mocne strony" values={ceo?.strengths ?? []} />
    <ContentList title="Najważniejsze ryzyka" values={(ceo?.risks ?? []).map(formatInvestmentRisk)} />
    <ContentList title="Brakujące informacje przed zakupem" values={ceo?.missingBeforePurchase ?? []} />
    <PanelCard title="Teza inwestycyjna"><p>{ceo?.investmentThesis ? formatInvestmentText(ceo.investmentThesis) ?? ceo.investmentThesis : "Brak zatwierdzonej tezy dla obecnego stanu danych."}</p></PanelCard>
    <PanelCard title="Scenariusze finansowe">
      <dl className="grid gap-3 sm:grid-cols-3"><div><dt className="text-[11px] uppercase tracking-wide">Ostrożny</dt><dd className="mt-1 text-foreground">{ceo?.bearCase ? formatInvestmentText(ceo.bearCase) ?? ceo.bearCase : "—"}</dd></div><div><dt className="text-[11px] uppercase tracking-wide">Bazowy</dt><dd className="mt-1 text-foreground">{ceo?.baseCase ? formatInvestmentText(ceo.baseCase) ?? ceo.baseCase : "—"}</dd></div><div><dt className="text-[11px] uppercase tracking-wide">Optymistyczny</dt><dd className="mt-1 text-foreground">{ceo?.bullCase ? formatInvestmentText(ceo.bullCase) ?? ceo.bullCase : "—"}</dd></div></dl>
    </PanelCard>
    <div className="grid gap-3 sm:grid-cols-2">
      <ContentList title="Warunki działania" values={(ceo?.conditionsToProceed ?? []).map((value) => formatInvestmentText(value) ?? value)} />
      <ContentList title="Warunki odejścia" values={(ceo?.walkAwayConditions ?? []).map((value) => formatInvestmentText(value) ?? value)} />
    </div>
  </div>;
}
