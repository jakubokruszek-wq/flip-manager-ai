import type { CanonicalDeal, FactValue } from "../types";
import { display } from "./investment-ui";

export function AuditPanel({ deal }: { deal: CanonicalDeal }) {
  const facts = Object.entries(deal.facts) as Array<[string, FactValue<unknown>]>;
  return <div className="space-y-5">
    <section>
      <h4 className="text-sm font-semibold">Provenance faktów</h4>
      <div className="mt-2 hidden overflow-x-auto rounded-lg border border-border/70 md:block" data-audit-desktop-table>
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="bg-muted/50 text-muted-foreground"><tr><th className="px-3 py-2">Pole</th><th className="px-3 py-2">System</th><th className="px-3 py-2">Manual</th><th className="px-3 py-2">Effective</th><th className="px-3 py-2">Pochodzenie</th><th className="px-3 py-2">Evidence</th><th className="px-3 py-2">Kontrola</th></tr></thead>
          <tbody>{facts.map(([name, fact]) => {
            const overridden = fact.overrideValue != null && !Object.is(fact.sourceValue, fact.overrideValue);
            const conflict = fact.conflictStatus === "CRITICAL";
            const status = auditStatus(fact, overridden, conflict);
            return <tr className="border-t border-border/60 align-top" key={name}>
              <th className="px-3 py-2 font-medium">{fieldLabel(name)}</th><td className="px-3 py-2 tabular-nums">{display(fact.sourceValue)}</td><td className="px-3 py-2 tabular-nums">{display(fact.overrideValue)}</td><td className="px-3 py-2 font-semibold tabular-nums">{display(fact.effectiveValue)}</td><td className="px-3 py-2"><p>{fact.provenance}</p><p className="mt-1 text-muted-foreground">{fact.classification} · {fact.source}</p></td><td className="px-3 py-2">{fact.evidenceId ?? fact.assumptionId ?? "—"}<p className="mt-1 text-muted-foreground">{fact.observedAt ?? "data nieustalona"}</p></td><td className="px-3 py-2"><span className={status.className}>{status.label}</span></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <div className="mt-2 space-y-2 md:hidden" data-audit-mobile-cards>
        {facts.map(([name, fact]) => {
          const overridden = fact.overrideValue != null && !Object.is(fact.sourceValue, fact.overrideValue);
          const conflict = fact.conflictStatus === "CRITICAL";
          const status = auditStatus(fact, overridden, conflict);
          return <article aria-label={`Audyt: ${fieldLabel(name)}`} className="rounded-lg border border-border/70 bg-background/50 p-3" key={name}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">FIELD</p><h5 className="mt-0.5 break-words text-sm font-semibold">{fieldLabel(name)}</h5></div>
              <span className={`shrink-0 rounded-full border border-border/70 px-2 py-1 text-[10px] font-semibold ${status.className}`}>{status.label}</span>
            </div>
            <div className="mt-3 grid gap-2">
              <div><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">EFFECTIVE VALUE</p><p className="mt-0.5 break-words text-base font-semibold tabular-nums">{display(fact.effectiveValue)}</p></div>
              <div><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">SOURCE / PROVENANCE</p><p className="mt-0.5 break-words text-xs">{fact.provenance} · {fact.classification} · {fact.source}</p></div>
            </div>
            <details className="mt-3 border-t border-border/60 pt-2 text-xs">
              <summary className="min-h-8 cursor-pointer py-1 font-semibold text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">Szczegóły audytu</summary>
              <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-3 gap-y-2">
                <dt className="text-muted-foreground">SYSTEM VALUE</dt><dd className="break-words text-right tabular-nums">{display(fact.sourceValue)}</dd>
                <dt className="text-muted-foreground">MANUAL VALUE</dt><dd className="break-words text-right tabular-nums">{display(fact.overrideValue)}</dd>
                <dt className="text-muted-foreground">EVIDENCE ID</dt><dd className="break-all text-right">{fact.evidenceId ?? fact.assumptionId ?? "—"}</dd>
                <dt className="text-muted-foreground">DATE</dt><dd className="break-words text-right">{fact.observedAt ?? "data nieustalona"}</dd>
                <dt className="text-muted-foreground">RESOLUTION</dt><dd className="break-words text-right">{fact.resolutionReason}</dd>
              </dl>
            </details>
          </article>;
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Wartość systemowa i jej pochodzenie pozostają widoczne także przy override. Znacznik CONFLICT pochodzi wyłącznie z CanonicalDeal.</p>
    </section>
    <section>
      <h4 className="text-sm font-semibold">Evidence Fabric</h4>
      {deal.evidenceFabric.length ? <div className="mt-2 grid gap-2 md:grid-cols-2">{deal.evidenceFabric.map((item) => {
        const sourceUrl = item.sourceUrl ? safeHttpUrl(item.sourceUrl) : null;
        return <article className="rounded-lg border border-border/70 p-3 text-xs" key={item.id}>
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">{item.type.replaceAll("_", " ")} · {item.evidenceType?.replaceAll("_", " ") ?? "evidence"}</p><p className="font-medium">{item.verificationStatus}</p></div>
        <p className="mt-1 text-muted-foreground">{item.field ?? "pole nieokreślone"} · {item.sourceType.replaceAll("_", " ")} · {item.sourceName}</p>
        <p className="mt-2 text-foreground">Wartość: {evidenceValue(item.value)}</p>
        <p className="mt-1 text-muted-foreground">Confidence {item.confidence}% · reliability {item.reliability}% · observed {item.observedAt ?? "—"} · ważne od {item.validFrom ?? "—"} do {item.validUntil ?? "—"}</p>
        {sourceUrl ? <a className="mt-1 inline-flex min-h-8 items-center text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={sourceUrl} rel="noreferrer" target="_blank">Otwórz źródło</a> : null}
        {item.conflictsWith.length ? <p className="mt-1 text-amber-700 dark:text-amber-300">Konfliktuje z: {item.conflictsWith.join(", ")}</p> : null}
      </article>; })}</div> : <p className="mt-2 text-sm text-muted-foreground">Evidence Fabric nie zawiera jeszcze rekordów.</p>}
    </section>
  </div>;
}

function fieldLabel(name: string) { return name.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase()); }
function auditStatus(fact: FactValue<unknown>, overridden: boolean, conflict: boolean) {
  if (conflict) return { label: "CONFLICT", className: "font-semibold text-amber-700 dark:text-amber-300" };
  if (overridden) return { label: "MANUAL OVERRIDE", className: "font-semibold text-primary" };
  if (fact.freshness === "STALE") return { label: "STALE", className: "font-semibold text-amber-700 dark:text-amber-300" };
  return { label: fact.effectiveValue == null ? "MISSING" : "OK", className: "text-muted-foreground" };
}
function evidenceValue(value: unknown) {
  if (value == null || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return display(value);
  try { const serialized = JSON.stringify(value); return `${serialized.slice(0, 240)}${serialized.length > 240 ? "…" : ""}`; } catch { return "wartość niedostępna"; }
}
function safeHttpUrl(value: string) { try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null; } catch { return null; } }
