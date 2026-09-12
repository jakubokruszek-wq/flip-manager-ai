import type { CanonicalDeal, DirectorOutput } from "../types";
import { SectionHeading, StatusPill } from "./investment-ui";

export function DirectorBoard({ deal }: { deal: CanonicalDeal }) {
  const active = [deal.scout, deal.verify, deal.market, deal.underwriting, deal.ceo];
  const available = new Set(active.map((director) => director.director));
  const future = ["RISK", "RENOVATION", "CFO", "ACQUISITION"].filter((director) => !available.has(director as DirectorOutput<unknown>["director"]));

  return <section aria-labelledby="director-board-title" className="min-w-0 max-w-full space-y-3">
    <SectionHeading eyebrow="03 · operating board" id="director-board-title" title="Zespół inwestycyjny" aside={<span className="text-xs text-muted-foreground">Stan i rekomendacje pochodzą z bieżącego CanonicalDeal</span>} />
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {active.map((output) => <DirectorCard key={output.director} output={output} />)}
      {future.map((name) => <article aria-label={`${name}: niedostępny`} className="rounded-xl border border-dashed border-border/80 bg-muted/15 p-4" key={name}>
        <div className="flex items-center justify-between gap-2"><h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{name}</h4><StatusPill label="NOT AVAILABLE / FUTURE" status="NOT_RUN" /></div>
        <p className="mt-3 text-sm text-muted-foreground">Ten dyrektor nie jest obecnie częścią danych tej analizy.</p>
      </article>)}
    </div>
  </section>;
}

function DirectorCard({ output }: { output: DirectorOutput<unknown> }) {
  const signal = output.status === "STALE" ? "STALE" : output.status === "BLOCKED" || output.status === "FAILED" || output.validation.status === "FAIL" ? "BLOCKED" : output.missingFields.length ? "MISSING DATA" : output.status === "COMPLETE" && output.validation.status === "PASS" ? "PASS" : "CHECK";
  const signalStyle = signal === "PASS" ? "text-emerald-700 dark:text-emerald-300" : signal === "BLOCKED" || signal === "MISSING DATA" || signal === "STALE" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground";
  return <article className="rounded-xl border border-border/70 bg-background/50 p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h4 className="text-xs font-semibold uppercase tracking-[0.14em]">{output.director}</h4><p className={`mt-1 text-xs font-semibold ${signalStyle}`}>{signal}</p></div>
      <StatusPill status={output.status} />
    </div>
    <p className="mt-3 text-xs text-muted-foreground">Confidence <span className="font-semibold text-foreground">{output.confidence}%</span> · validator <span className="font-semibold text-foreground">{output.validation.status}</span></p>
    <p className="mt-3 line-clamp-3 text-sm leading-5">{output.finding || "Brak podsumowania."}</p>
    <p className="mt-2 line-clamp-2 text-sm font-medium leading-5 text-foreground">{output.recommendation || "Brak rekomendacji."}</p>
    {output.missingFields.length ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Brak danych: {output.missingFields.slice(0, 3).join(", ")}{output.missingFields.length > 3 ? ` +${output.missingFields.length - 3}` : ""}</p> : null}
    <details className="mt-3 border-t border-border/70 pt-2 text-xs">
      <summary className="min-h-8 cursor-pointer py-1 font-semibold text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">Evidence, ryzyka i warunki zmiany</summary>
      <div className="mt-2 space-y-2 text-muted-foreground">
        <FieldList title="Evidence" values={output.evidence} />
        <FieldList title="Ryzyka" values={output.risks} />
        <FieldList title="Missing data" values={output.missingData} />
        <FieldList title="Next best actions" values={output.nextBestActions} />
        <FieldList title="Decision triggers" values={output.decisionTriggers} />
        <FieldList title="Co zmieniłoby ocenę" values={output.whatWouldChangeMyMind} />
        <p><strong className="text-foreground">Walidacja:</strong> {output.validation.checks.map((check) => `${check.passed ? "PASS" : "FAIL"} · ${check.code}`).join("; ") || "brak"}</p>
        {output.reasonCodes.length ? <p><strong className="text-foreground">Kody:</strong> {output.reasonCodes.join(", ")}</p> : null}
      </div>
    </details>
  </article>;
}

function FieldList({ title, values }: { title: string; values: string[] }) {
  return <p><strong className="text-foreground">{title}:</strong> {values.length ? values.join("; ") : "brak"}</p>;
}
