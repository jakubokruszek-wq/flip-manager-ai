import type { CanonicalDeal } from "../types";
import { ContentList } from "./investment-ui";

export function RisksPanel({ deal }: { deal: CanonicalDeal }) {
  const ceo = deal.ceo.result;
  const gates = ceo?.criticalGates ?? [];
  return <div className="space-y-4">
    <section><h4 className="text-sm font-semibold">Bramki decyzyjne</h4>{gates.length ? <div className="mt-2 grid gap-2 sm:grid-cols-2">{gates.map((gate, index) => <article className={`rounded-lg border p-3 ${gate.passed ? "border-emerald-500/25 bg-emerald-500/[0.04]" : "border-amber-500/30 bg-amber-500/[0.06]"}`} key={`${gate.fact}-${index}`}><div className="flex items-center justify-between gap-3"><p className="text-sm font-medium">{gate.fact}</p><span className="text-xs font-bold">{gate.passed ? "PASS" : "BLOCKED"}</span></div><p className="mt-1 text-xs leading-5 text-muted-foreground">{gate.reason}</p></article>)}</div> : <p className="mt-2 text-sm text-muted-foreground">Brak bramek w bieżącym wyniku CEO.</p>}</section>
    <div className="grid gap-3 lg:grid-cols-2"><ContentList title="Red team" values={ceo?.redTeam.map((item) => `${item.severity} · ${item.finding}`) ?? []} /><ContentList title="Dissent" values={ceo?.dissent ?? []} /><ContentList title="Brakujące informacje" values={ceo?.missingBeforePurchase ?? []} /><ContentList title="Co zmieniłoby ocenę" values={ceo?.nextBestQuestions.map((question) => `${question.priority} · ${question.question} (VOI ${question.valueOfInformation})`) ?? []} /></div>
  </div>;
}
