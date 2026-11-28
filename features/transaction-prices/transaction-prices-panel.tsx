"use client";

import { useEffect, useState } from "react";
import type { RcnComparison, RcnMarket } from "./types";

type State = { key: string; data: RcnComparison | null; error: string | null };
export function TransactionPricesPanel({ listingId }: { listingId: string }) {
  const [market, setMarket] = useState<RcnMarket>("secondary");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State | null>(null);
  const key = `${listingId}:${market}:${attempt}`;
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void fetch(`/api/market-intelligence/${encodeURIComponent(listingId)}/transactions?market=${market}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(typeof body.message === "string" ? body.message : "Nie udało się pobrać cen transakcyjnych.");
        if (active) setState({ key, data: body as RcnComparison, error: null });
      })
      .catch((error: unknown) => {
        if (active && !controller.signal.aborted) setState({ key, data: null, error: error instanceof Error ? error.message : "Nie udało się pobrać cen transakcyjnych." });
      });
    return () => { active = false; controller.abort(); };
  }, [listingId, market, key]);
  const current = state?.key === key ? state : null;
  return <section aria-label="Porównanie z cenami transakcyjnymi" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="text-base font-bold">Ceny transakcyjne · RCN</h3><p className="mt-1 text-xs text-muted-foreground">Porównanie ze sprzedażami zapisanymi w rejestrze Łodzi.</p></div>
      <label className="text-xs font-medium">Rynek porównania<select aria-label="Rynek porównania RCN" className="mt-1 block min-h-11 rounded-lg border border-input bg-background px-3 text-sm" onChange={(event) => setMarket(event.target.value as RcnMarket)} value={market}><option value="secondary">Wtórny</option><option value="primary">Pierwotny</option></select></label>
    </div>
    <div aria-live="polite" className="mt-4">
      {!current ? <p className="text-sm text-muted-foreground">Pobieranie cen transakcyjnych…</p> : current.error ? <div><p className="text-sm text-muted-foreground">{current.error}</p><button className="mt-3 min-h-11 rounded-lg border px-3 text-sm font-medium" onClick={() => setAttempt((value) => value + 1)} type="button">Spróbuj ponownie</button></div> : current.data ? <TransactionComparison data={current.data} /> : null}
    </div>
  </section>;
}

export function TransactionComparison({ data }: { data: RcnComparison }) {
  if (data.status === "unsupported_location") return <p className="text-sm text-muted-foreground">Ceny transakcyjne są obecnie dostępne w programie dla Łodzi.</p>;
  if (data.status === "missing_area") return <p className="text-sm text-muted-foreground">Uzupełnij metraż oferty, aby porównać mieszkania o podobnej powierzchni.</p>;
  if (data.status === "missing_location") return <p className="text-sm text-muted-foreground">Uzupełnij miasto i ulicę oferty, aby dopasować transakcje.</p>;
  return <div className="space-y-4">
    <p className="text-xs text-muted-foreground">{data.street} · {data.market === "secondary" ? "rynek wtórny" : "rynek pierwotny"} · ostatnie 24 miesiące · podobny metraż</p>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <RcnMetric label="Transakcje w próbce" value={String(data.sampleCount)} />
      <RcnMetric label="Mediana / m²" value={data.sampleCount >= 5 ? perSqm(data.medianPricePerM2) : "Za mało danych"} />
      <RcnMetric label="Środkowe 50% cen / m²" value={data.sampleCount >= 5 ? `${perSqm(data.q1PricePerM2)} – ${perSqm(data.q3PricePerM2)}` : "—"} />
      <RcnMetric label="Oferta względem mediany" value={data.differencePct === null ? "—" : `${data.differencePct > 0 ? "+" : ""}${number(data.differencePct)}%`} />
    </div>
    {data.estimatedRange ? <p className="text-sm">Przedział dla metrażu oferty: <strong>{money(data.estimatedRange.low)} – {money(data.estimatedRange.high)}</strong></p> : <p className="text-sm text-muted-foreground">Do wyznaczenia przedziału potrzeba co najmniej 5 dopasowanych transakcji i metrażu oferty.</p>}
    {data.truncated ? <p className="rounded-lg bg-amber-500/10 p-3 text-xs">Próbka jest ograniczona do najnowszych wpisów z tej ulicy. Nie obejmuje wszystkich transakcji.</p> : null}
    {data.rows.length ? <div className="space-y-2"><h4 className="text-sm font-semibold">Przykładowe porównywalne transakcje</h4>{data.rows.map((row) => <article className="grid grid-cols-2 gap-2 rounded-xl bg-muted/40 p-3 text-sm sm:grid-cols-4" key={row.id}><div><p className="font-medium">{row.street}{row.building ? ` ${row.building}` : ""}</p><p className="mt-1 text-xs text-muted-foreground">{date(row.date)}</p></div><div><p>{number(row.area)} m²</p><p className="mt-1 text-xs text-muted-foreground">Powierzchnia użytkowa</p></div><div><p className="font-semibold">{money(row.price)}</p><p className="mt-1 text-xs text-muted-foreground">Cena lokalu</p></div><div><p className="font-semibold">{perSqm(row.pricePerM2)}</p></div></article>)}</div> : <p className="text-sm text-muted-foreground">Brak dopasowanych transakcji z jednoznaczną ceną lokalu. Brak danych nie oznacza braku sprzedaży.</p>}
    <p className="text-xs leading-relaxed text-muted-foreground">Rejestr nie potwierdza standardu wykończenia. To punkt odniesienia do ceny, a nie wycena mieszkania po remoncie. Pomijamy ceny całych transakcji, udziały oraz jawnie opisane pakiety; sam rejestr nie zawsze rozstrzyga skład ceny.</p>
    <p className="text-xs text-muted-foreground">Źródło: <a className="underline underline-offset-2" href={data.source.url} rel="noopener noreferrer" target="_blank">{data.source.title}</a> · pobrano {dateTime(data.fetchedAt)}</p>
  </div>;
}
function RcnMetric({ label, value }: { label: string; value: string }) { return <div className="rounded-xl bg-muted/40 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 break-words text-base font-semibold">{value}</p></div>; }
function number(value: number): string { return new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 }).format(value); }
function money(value: number): string { return new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value); }
function perSqm(value: number | null): string { return value === null ? "—" : `${money(value)}/m²`; }
function date(value: string): string { return new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString("pl-PL"); }
function dateTime(value: string): string { return new Date(value).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" }); }
