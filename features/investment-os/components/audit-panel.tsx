import type { CanonicalDeal, FactValue } from "../types";
import { display } from "./investment-ui";

export function AuditPanel({ deal }: { deal: CanonicalDeal }) {
  const facts = Object.entries(deal.facts) as Array<[string, FactValue<unknown>]>;
  return <div className="space-y-5">
    <section>
      <h4 className="type-card-title">Pochodzenie faktów</h4>
      <div className="ui-table-shell mt-2 hidden md:block" data-audit-desktop-table>
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="bg-muted/50 text-muted-foreground"><tr><th className="px-3 py-2">Pole</th><th className="px-3 py-2">Źródło</th><th className="px-3 py-2">Ręczne</th><th className="px-3 py-2">Efektywne</th><th className="px-3 py-2">Pochodzenie</th><th className="px-3 py-2">Dowód</th><th className="px-3 py-2">Kontrola</th></tr></thead>
          <tbody>{facts.map(([name, fact]) => {
            const overridden = fact.overrideValue != null && !Object.is(fact.sourceValue, fact.overrideValue);
            const conflict = fact.conflictStatus === "CRITICAL";
            const status = auditStatus(fact, overridden, conflict);
            return <tr className="border-t border-border/60 align-top" key={name}>
              <th className="px-3 py-2 font-medium">{fieldLabel(name)}</th><td className="px-3 py-2 tabular-nums">{display(fact.sourceValue)}</td><td className="px-3 py-2 tabular-nums">{display(fact.overrideValue)}</td><td className="px-3 py-2 font-semibold tabular-nums">{display(fact.effectiveValue)}</td><td className="px-3 py-2"><p>{provenanceLabel(fact.provenance)}</p><p className="mt-1 text-muted-foreground">{classificationLabel(fact.classification)} · {sourceLabel(fact.source)}</p></td><td className="px-3 py-2"><span className="tabular-nums text-[10px]">{fact.evidenceId ?? fact.assumptionId ?? "—"}</span><p className="mt-1 text-muted-foreground">{formatAuditDate(fact.observedAt)}</p></td><td className="px-3 py-2"><span className={status.className}>{status.label}</span></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <div className="mt-2 space-y-2 md:hidden" data-audit-mobile-cards>
        {facts.map(([name, fact]) => {
          const overridden = fact.overrideValue != null && !Object.is(fact.sourceValue, fact.overrideValue);
          const conflict = fact.conflictStatus === "CRITICAL";
          const status = auditStatus(fact, overridden, conflict);
          return <article aria-label={`Audyt: ${fieldLabel(name)}`} className="rounded-2xl border border-border bg-background/50 p-3" key={name}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">POLE</p><h5 className="mt-0.5 break-words text-sm font-semibold">{fieldLabel(name)}</h5></div>
              <span className={`shrink-0 rounded-full border border-border/70 px-2 py-1 text-[10px] font-semibold ${status.className}`}>{status.label}</span>
            </div>
            <div className="mt-3 grid gap-2">
              <div><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">WARTOŚĆ EFEKTYWNA</p><p className="mt-0.5 break-words text-base font-semibold tabular-nums">{display(fact.effectiveValue)}</p></div>
              <div><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">ŹRÓDŁO / POCHODZENIE</p><p className="mt-0.5 break-words text-xs">{provenanceLabel(fact.provenance)} · {classificationLabel(fact.classification)} · {sourceLabel(fact.source)}</p></div>
            </div>
            <details className="mt-3 border-t border-border/60 pt-2 text-xs">
              <summary className="min-h-8 cursor-pointer py-1 font-semibold text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">Szczegóły audytu</summary>
              <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-3 gap-y-2">
                <dt className="text-muted-foreground">WARTOŚĆ ŹRÓDŁOWA</dt><dd className="break-words text-right tabular-nums">{display(fact.sourceValue)}</dd>
                <dt className="text-muted-foreground">WARTOŚĆ RĘCZNA</dt><dd className="break-words text-right tabular-nums">{display(fact.overrideValue)}</dd>
                <dt className="text-muted-foreground">ID DOWODU</dt><dd className="break-all text-right">{fact.evidenceId ?? fact.assumptionId ?? "—"}</dd>
                <dt className="text-muted-foreground">DATA</dt><dd className="break-words text-right">{formatAuditDate(fact.observedAt)}</dd>
                <dt className="text-muted-foreground">ROZSTRZYGNIĘCIE</dt><dd className="break-words text-right">{resolutionLabel(fact.resolutionReason)}</dd>
              </dl>
            </details>
          </article>;
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Wartość źródłowa i jej pochodzenie pozostają widoczne także przy korekcie ręcznej. Znacznik konfliktu pochodzi wyłącznie z bieżącej analizy.</p>
    </section>
    <section>
      <h4 className="type-card-title">Sieć dowodów</h4>
      {deal.evidenceFabric.length ? <div className="mt-2 grid gap-2 md:grid-cols-2">{deal.evidenceFabric.map((item) => {
        const sourceUrl = item.sourceUrl ? safeHttpUrl(item.sourceUrl) : null;
        return <article className="rounded-lg border border-border/70 p-3 text-xs" key={item.id}>
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">{evidenceTypeLabel(item.type)} · {evidenceTypeLabel(item.evidenceType)}</p><p className="font-medium">{verificationLabel(item.verificationStatus)}</p></div>
        <p className="mt-1 text-muted-foreground">{item.field ? fieldLabel(item.field) : "pole nieokreślone"} · {sourceLabel(item.sourceType)} · {item.sourceName}</p>
        <p className="mt-2 text-foreground">Wartość: {evidenceValue(item.value)}</p>
        <p className="mt-1 text-muted-foreground">Pewność {formatPercent(item.confidence)} · wiarygodność {formatPercent(item.reliability)} · obserwacja {formatAuditDate(item.observedAt)} · ważne od {formatAuditDate(item.validFrom)} do {formatAuditDate(item.validUntil)}</p>
        {sourceUrl ? <a className="mt-1 inline-flex min-h-8 items-center text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={sourceUrl} rel="noreferrer" target="_blank">Otwórz źródło</a> : null}
        {item.conflictsWith.length ? <p className="mt-1 text-amber-700 dark:text-amber-300">Konfliktuje z: {item.conflictsWith.map(fieldLabel).join(", ")}</p> : null}
      </article>; })}</div> : <p className="mt-2 text-sm text-muted-foreground">Sieć dowodów nie zawiera jeszcze rekordów.</p>}
    </section>
  </div>;
}

function fieldLabel(name: string) { return ({ source: "Źródło", sourceUrl: "Adres źródłowy", askingPrice: "Cena ofertowa", askingPricePerM2: "Cena za m²", price: "Cena", pricePerSqm: "Cena za m²", areaM2: "Powierzchnia", area: "Powierzchnia", rooms: "Liczba pokoi", city: "Miasto", district: "Dzielnica", street: "Ulica", buildingType: "Typ budynku", ownership: "Forma własności", legalStatus: "Stan prawny", condition: "Stan lokalu", renovationScope: "Zakres remontu", monthlyFee: "Czynsz", floor: "Piętro", floorsTotal: "Liczba pięter", resalePrice: "Cena po remoncie", resalePricePerM2: "Cena po remoncie za m²", maxPurchasePrice: "Maks. cena zakupu", targetPurchasePrice: "Cena docelowa", profitBase: "Zysk bazowy", totalProjectCost: "Całkowity koszt projektu" } as Record<string, string>)[name] ?? "Dodatkowe dane"; }
function provenanceLabel(value: string) { return ({ EXTRACTED: "Dane z ogłoszenia", DERIVED: "Wartość wyliczona", USER_ASSUMPTION: "Założenie użytkownika", MARKET_ASSUMPTION: "Założenie rynkowe", MANUAL_OVERRIDE: "Korekta ręczna", UNKNOWN: "Nie ustalono" } as Record<string, string>)[value] ?? "Zapisane dane"; }
function classificationLabel(value: string) { return ({ FACT: "Fakt", ASSUMPTION: "Założenie", ESTIMATE: "Szacunek", PREDICTION: "Prognoza", USER_OVERRIDE: "Korekta użytkownika", UNKNOWN: "Nie ustalono" } as Record<string, string>)[value] ?? "Zapisana klasyfikacja"; }
function sourceLabel(value: string) { return ({ LISTING: "Ogłoszenie", facebook: "Facebook", FACEBOOK: "Facebook", olx: "OLX", OLX: "OLX", otodom: "Otodom", OTODOM: "Otodom", MANUAL: "Wpis ręczny", MANUAL_INPUT: "Wpis ręczny", RESALE_COMPS: "Porównania rynkowe", DETERMINISTIC_UNDERWRITER: "Wyliczenie finansowe", DEAL_OVERRIDE: "Korekta ręczna", MARKET_INTELLIGENCE: "Analiza rynku" } as Record<string, string>)[value] ?? "Zapisane źródło"; }
function evidenceTypeLabel(value: string | undefined) { return ({ LISTING_OBSERVATION: "Obserwacja ogłoszenia", PRICE_OBSERVATION: "Obserwacja ceny", DOCUMENT_OBSERVATION: "Dokument", USER_INSPECTION: "Oględziny", MANUAL_INPUT: "Dane ręczne", AI_EXTRACTION: "Odczyt automatyczny", VISION_OBSERVATION: "Analiza obrazu", MARKET_COMPARABLE: "Oferta porównawcza", MARKET_TRANSACTION: "Dane transakcyjne", RENOVATION_QUOTE: "Kosztorys remontu", ACTUAL_OUTCOME: "Wynik rzeczywisty", LISTING_FACT: "Dane ogłoszenia", MANUAL_OVERRIDE: "Korekta ręczna", MARKET_ASSUMPTION: "Założenie rynkowe" } as Record<string, string>)[value ?? ""] ?? "Dowód"; }
function verificationLabel(value: string) { return ({ VERIFIED: "Potwierdzony", EXACT: "Potwierdzony", UNVERIFIED: "Do weryfikacji", CONFLICT: "Konflikt danych", STALE: "Nieaktualny", PARTIAL: "Częściowy", PENDING: "Oczekuje" } as Record<string, string>)[value] ?? "Do sprawdzenia"; }
function resolutionLabel(value: string | null | undefined) { if (!value) return "Nie wymaga dodatkowego rozstrzygnięcia"; return ({ SOURCE_VALUE: "Pozostawiono wartość źródłową", OVERRIDE: "Zastosowano korektę ręczną", CONFLICT: "Wykryto konflikt danych", UNKNOWN: "Nie ustalono" } as Record<string, string>)[value] ?? "Szczegóły zapisano w audycie"; }
function formatPercent(value: number) { return `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(value)}%`; }
function formatAuditDate(value: string | null | undefined) { if (!value || Number.isNaN(Date.parse(value))) return "data nieustalona"; return new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function auditStatus(fact: FactValue<unknown>, overridden: boolean, conflict: boolean) {
  if (conflict) return { label: "KONFLIKT", className: "font-semibold text-warning" };
  if (overridden) return { label: "KOREKTA RĘCZNA", className: "font-semibold text-primary" };
  if (fact.freshness === "STALE") return { label: "NIEAKTUALNE", className: "font-semibold text-warning" };
  return { label: fact.effectiveValue == null ? "BRAK DANYCH" : "ZGODNE", className: "text-muted-foreground" };
}
function evidenceValue(value: unknown) {
  if (value == null || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return display(value);
  try { const serialized = JSON.stringify(value); return `${serialized.slice(0, 240)}${serialized.length > 240 ? "…" : ""}`; } catch { return "wartość niedostępna"; }
}
function safeHttpUrl(value: string) { try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null; } catch { return null; } }
