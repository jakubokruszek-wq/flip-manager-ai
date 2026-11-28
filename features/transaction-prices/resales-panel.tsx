"use client";

import type { RcnResaleResult } from "./resales";

/** Public transaction pairs are candidates; the register cannot establish a renovation or profit. */
export function StreetResalesPanel({ data, scope = "street" }: { data: RcnResaleResult; scope?: "street" | "nearby" }) {
  return <section aria-label={scope === "nearby" ? "Możliwe flipy w pobliżu" : "Możliwe flipy na ulicy"} className="min-w-0 space-y-4 rounded-xl border border-border p-4">
    <div>
      <h4 className="text-sm font-semibold">{scope === "nearby" ? "Możliwe flipy w pobliżu" : "Możliwe flipy na ulicy"}</h4>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Powtórne sprzedaże w ciągu maksymalnie 365 dni od zakupu. Ostatnia sprzedaż z ostatnich 24 miesięcy; wszystkie metraże {scope === "nearby" ? "w wybranym promieniu" : "na tej ulicy"}, niezależnie od metrażu oglądanej oferty.</p>
    </div>
    {data.status === "unsupported_location" ? <p className="text-sm text-muted-foreground">Wyszukiwanie powtórnych sprzedaży jest obecnie dostępne dla Łodzi.</p>
      : data.status === "missing_location" ? <p className="text-sm text-muted-foreground">Uzupełnij miasto i ulicę oferty, aby wyszukać powtórne sprzedaże.</p>
        : <>
          <div className="rounded-lg bg-muted/40 p-3">
            <p className="text-xs text-muted-foreground">{scope === "nearby" ? "W wybranym promieniu" : data.street} · Wzrost ≥30% w ciągu roku</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{data.strongCandidateCount}</p>
            <p className="mt-2 text-xs">Silniejszy sygnał możliwego flipa w sprawdzonej próbce RCN. Wszystkie szybkie odsprzedaże ze wzrostem ceny: <strong>{data.candidateCount}</strong>.</p>
          </div>
          {data.truncated ? <p className="rounded-lg bg-amber-500/10 p-3 text-xs leading-relaxed">Dane źródłowe są ograniczone. Licznik dotyczy wyłącznie sprawdzonej próbki, a nie wszystkich flipów ani sprzedaży na wybranym obszarze.</p> : null}
          {data.rows.length ? <div className="space-y-3">
            {data.rows.map((row) => <article key={row.id} className="min-w-0 rounded-xl bg-muted/40 p-3 text-sm">
              {row.strongSignal ? <p className="mb-2 inline-block rounded-md bg-amber-500/15 px-2 py-1 text-xs font-semibold">Wzrost ≥30% · silniejszy sygnał</p> : null}
              {"distanceMeters" in row && typeof row.distanceMeters === "number" && Number.isFinite(row.distanceMeters) ? <p className="mb-2 text-xs text-muted-foreground">Odległość od środka wyszukiwania: około {Math.round(row.distanceMeters)} m</p> : null}
              <p className="break-words font-semibold">{row.street}{row.building ? ` ${row.building}` : ""} · {number(row.area)} m²</p>
              <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Zakup · {market(row.buyMarket)}</p>
                  <p className="mt-1">{date(row.buyDate)}</p>
                  <p className="mt-1 break-words font-semibold">{money(row.buyPrice)}</p>
                  <p className="text-xs text-muted-foreground">{money(row.buyPricePerM2)}/m²</p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Sprzedaż · {market(row.sellMarket)}</p>
                  <p className="mt-1">{date(row.sellDate)}</p>
                  <p className="mt-1 break-words font-semibold">{money(row.sellPrice)}</p>
                  <p className="text-xs text-muted-foreground">{money(row.sellPricePerM2)}/m²</p>
                </div>
              </div>
              <p className="mt-3 text-xs">Czas między transakcjami: około {number(row.approxMonths)} mies. ({row.holdingDays} dni)</p>
              <p className="mt-1 break-words text-xs">Różnica cen brutto: <strong>{signedMoney(row.priceIncrease)} ({row.priceIncreasePct > 0 ? "+" : ""}{number(row.priceIncreasePct)}%)</strong></p>
            </article>)}
            {data.candidateCount > data.rows.length ? <p className="text-xs text-muted-foreground">Pokazano {data.rows.length} z {data.candidateCount} kandydatów w sprawdzonej próbce.</p> : null}
          </div> : <p className="text-sm text-muted-foreground">W sprawdzonej próbce nie znaleziono par transakcji spełniających warunki. Nie oznacza to braku flipów na wybranym obszarze.</p>}
        </>}
    <p className="text-xs leading-relaxed text-muted-foreground">To kandydaci na możliwe flipy, a nie potwierdzone remonty. Różnica cen brutto nie jest zyskiem netto: nie uwzględnia kosztów zakupu, remontu, finansowania, podatków ani sprzedaży. Rejestr nie potwierdza standardu mieszkania ani tego, kto przeprowadził remont.</p>
    <p className="break-words text-xs text-muted-foreground">Źródło: <a className="underline underline-offset-2" href={data.source.url} target="_blank" rel="noopener noreferrer">{data.source.title}</a> · pobrano {dateTime(data.fetchedAt)}</p>
  </section>;
}

function number(value: number): string { return new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 }).format(value); }
function money(value: number): string { return new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value); }
function signedMoney(value: number): string { return `${value > 0 ? "+" : ""}${money(value)}`; }
function date(value: string): string { return new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString("pl-PL"); }
function dateTime(value: string): string { return new Date(value).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" }); }
function market(value: "primary" | "secondary"): string { return value === "primary" ? "rynek pierwotny" : "rynek wtórny"; }
