import type { CanonicalDeal, DirectorOutput } from "../types";
import { formatInvestmentRisk, formatPercentDisplay, SectionHeading, StatusPill } from "./investment-ui";

export function DirectorBoard({ deal }: { deal: CanonicalDeal }) {
  const active = [deal.scout, deal.verify, deal.market, deal.underwriting, deal.ceo];
  const available = new Set(active.map((director) => director.director));
  const future = ["RISK", "RENOVATION", "CFO", "ACQUISITION"].filter((director) => !available.has(director as DirectorOutput<unknown>["director"]));

  return <section aria-labelledby="director-board-title" className="min-w-0 max-w-full space-y-3">
    <SectionHeading eyebrow="03 · zespół analityczny" id="director-board-title" title="Zespół inwestycyjny" aside={<span className="text-xs text-muted-foreground">Stan i rekomendacje pochodzą z bieżącej analizy</span>} />
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {active.map((output) => <DirectorCard key={output.director} output={output} />)}
      {future.map((name) => <article aria-label={`${directorLabel(name)}: niedostępny`} className="rounded-2xl border border-dashed border-border bg-muted/15 p-4" key={name}>
        <div className="flex items-center justify-between gap-2"><h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{directorLabel(name)}</h4><StatusPill label="NIEDOSTĘPNY W TEJ ANALIZIE" status="NOT_RUN" /></div>
        <p className="mt-3 text-sm text-muted-foreground">Ten dyrektor nie jest obecnie częścią danych tej analizy.</p>
      </article>)}
    </div>
  </section>;
}

function DirectorCard({ output }: { output: DirectorOutput<unknown> }) {
  const signal = output.status === "STALE" ? "NIEAKTUALNE" : output.status === "BLOCKED" || output.status === "FAILED" || output.validation.status === "FAIL" ? "ZABLOKOWANE" : output.missingFields.length ? "BRAKUJĄ DANE" : output.status === "COMPLETE" && output.validation.status === "PASS" ? "GOTOWE" : "DO SPRAWDZENIA";
  const signalStyle = signal === "GOTOWE" ? "text-success" : signal === "ZABLOKOWANE" || signal === "BRAKUJĄ DANE" || signal === "NIEAKTUALNE" ? "text-warning" : "text-muted-foreground";
  const collapsedFinding = meaningfulFinding(output);
  return <article className="ui-card-hover rounded-2xl border border-border bg-background/50 p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h4 className="type-card-title uppercase tracking-[0.08em]">{directorLabel(output.director)}</h4><p className={`mt-1 text-xs font-semibold ${signalStyle}`}>{signal}</p></div>
      <StatusPill label={output.director === "CEO" && output.status === "COMPLETE" ? "ANALIZA GOTOWA" : undefined} status={output.status} />
    </div>
    <p className="mt-3 text-xs text-muted-foreground">Pewność <span className="font-semibold tabular-nums text-foreground">{formatPercentDisplay(output.confidence, 0)}</span> · walidacja <span className="font-semibold text-foreground">{validationLabel(output.validation.status)}</span></p>
    {collapsedFinding ? <p className="mt-3 line-clamp-3 text-sm leading-5" data-director-collapsed-finding>{collapsedFinding}</p> : null}
    {output.missingFields.length ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Brak danych: {output.missingFields.slice(0, 3).map(fieldLabel).join(", ")}{output.missingFields.length > 3 ? ` +${output.missingFields.length - 3}` : ""}</p> : null}
    <details className="mt-3 border-t border-border/70 pt-2 text-xs">
      <summary className="min-h-8 cursor-pointer py-1 font-semibold text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">Dowody, ryzyka i warunki zmiany</summary>
      <div className="mt-2 space-y-2 text-muted-foreground">
        <p><strong className="text-foreground">Ustalenie:</strong> {displayCopy(output.finding, "Brak podsumowania w zapisanym wyniku.")}</p>
        <p><strong className="text-foreground">Rekomendacja:</strong> {displayCopy(output.recommendation, "Brak rekomendacji w zapisanym wyniku.")}</p>
        <FieldList title="Dowody" values={output.evidence.map(displayToken)} />
        <FieldList title="Ryzyka" values={output.risks.map((risk) => displayCopy(formatInvestmentRisk(risk), "Ryzyko wymaga weryfikacji."))} />
        <FieldList title="Brakujące dane" values={output.missingData.map(displayToken)} />
        <FieldList title="Następne kroki" values={output.nextBestActions.map(displayToken)} />
        <FieldList title="Warunki decyzji" values={output.decisionTriggers.map(displayToken)} />
        <FieldList title="Co zmieniłoby ocenę" values={output.whatWouldChangeMyMind.map(displayToken)} />
        <p><strong className="text-foreground">Walidacja:</strong> {output.validation.checks.map((check) => check.passed ? "zgodne" : "wymaga sprawdzenia").join("; ") || "brak danych"}</p>
      </div>
    </details>
  </article>;
}

function meaningfulFinding(output: DirectorOutput<unknown>): string | null {
  const finding = output.finding?.trim();
  if (finding && !isGenericFinding(finding)) return displayCopy(finding, "Wynik zapisany; szczegóły wymagają sprawdzenia.");
  const warning = output.warnings.find((item) => item.trim() && !isGenericFinding(item.trim()));
  if (warning) return displayCopy(formatInvestmentRisk(warning), "Wynik wymaga weryfikacji.");
  if (output.missingFields.length) return `Wymaga uzupełnienia: ${output.missingFields.slice(0, 2).map(fieldLabel).join(", ")}${output.missingFields.length > 2 ? ` +${output.missingFields.length - 2}` : ""}.`;
  return null;
}

function isGenericFinding(value: string): boolean {
  return /^(?:[A-Z_ ]+ completed with confidence \d+\.?|[A-Z_ ]+ blocked by evidence or validation\.)$/.test(value)
    || value === "Pass only validated output downstream."
    || value === "Execute only the conditional human-approved action.";
}

function directorLabel(value: string): string { return ({ SCOUT: "Rozpoznanie", VERIFY: "Weryfikacja", MARKET: "Rynek", UNDERWRITER: "Analiza finansowa", CEO: "CEO", RISK: "Ryzyko", RENOVATION: "Remont", CFO: "Finanse", ACQUISITION: "Zakup" } as Record<string, string>)[value] ?? "Zespół analityczny"; }
function validationLabel(value: string): string { return value === "PASS" ? "zgodna" : value === "FAIL" ? "wymaga sprawdzenia" : "zablokowana"; }
function fieldLabel(value: string): string { return ({ askingPrice: "cena ofertowa", askingPricePerM2: "cena za m²", areaM2: "powierzchnia", rooms: "liczba pokoi", city: "miasto", district: "dzielnica", street: "adres", buildingType: "typ budynku", ownership: "forma własności", legalStatus: "stan prawny", renovationScope: "zakres remontu", marketEvidence: "dane rynkowe", identity: "tożsamość ogłoszenia", economics: "ekonomika", riskReview: "ocena ryzyka", monthlyFee: "czynsz" } as Record<string, string>)[value] ?? "dodatkowe dane"; }
function displayToken(value: string): string { const field = value.match(/^([A-Za-z][A-Za-z0-9_]*)(?::\s*(.*))?$/); if (field && fieldLabel(field[1]) !== "dodatkowe dane") return field[2] ? `${fieldLabel(field[1])} · ${displayToken(field[2])}` : fieldLabel(field[1]); return displayCopy(value, "Szczegół wymaga weryfikacji."); }
function displayCopy(value: string | null | undefined, fallback: string): string {
  if (!value?.trim()) return fallback;
  const text = value.trim();
  const completed = text.match(/^([A-Z_ ]+) completed with confidence (\d+)\.?$/i);
  if (completed) return `${directorLabel(completed[1].trim())} — zakończono z pewnością ${formatPercentDisplay(Number(completed[2]), 0)}.`;
  if (/^[A-Z_ ]+ blocked by evidence or validation\.?$/i.test(text)) return "Zablokowano z powodu niewystarczających dowodów lub wyniku walidacji.";
  if (text === "Pass only validated output downstream.") return "Dalej można przekazać wyłącznie zweryfikowany wynik.";
  if (text === "Execute only the conditional human-approved action.") return "Wykonaj wyłącznie działanie warunkowe zatwierdzone przez użytkownika.";
  return /^[A-Z][A-Z0-9_ -]{2,}$/.test(text) || /\b(?:the|and|with|requires|evidence|validated|validation|confidence|blocked|completed|missing|confirmed|current|source|price|profit|loss|case|score|offer|listing|unknown|unverified|purchase|seller|resale|renovation|holding|liquidity|maximum|target|opening|downstream|action|document|title|encumbrance|estimate|delay|scope|overrun|please|should|could|would|before|after|review|expected|because|available|based|value|safe|proceed|deal)\b/i.test(text) ? fallback : text;
}

function FieldList({ title, values }: { title: string; values: string[] }) {
  return <p><strong className="text-foreground">{title}:</strong> {values.length ? values.join("; ") : "brak"}</p>;
}
