"use client";
import { useState } from "react";
import Link from "next/link";
export function TestFinder({ cases }: { cases: { id: string; title: string; price: number }[] }) {
  const [ready,setReady] = useState(false), [busy,setBusy] = useState(false), [error,setError] = useState(false);
  async function prepare() {
    setBusy(true); setError(false);
    try { const response = await fetch("/api/deal-room/test",{method:"POST"}); if (!response.ok) throw Error(); setReady(true); }
    catch { setError(true); } finally { setBusy(false); }
  }
  return <section aria-label="Deal Room TEST" className="mx-auto my-4 max-w-7xl space-y-3 rounded-xl border border-amber-500 p-4">
    <h2 className="text-lg font-semibold">Deal Room 2.0 · TEST</h2>
    <p>Trzy syntetyczne mieszkania w Łodzi. Osobna baza testowa, bez prawdziwych ofert. Wyniki i podatki są warunkowe.</p>
    <button className="min-h-11 rounded border px-3" disabled={busy} onClick={prepare} type="button">{busy ? "Przygotowuję…" : "Przygotuj / wznów testy"}</button>
    {error ? <p role="alert">Test niedostępny. Nie używaj bazy produkcyjnej; sprawdź konfigurację środowiska.</p> : null}
    {ready ? <ul className="grid gap-3 sm:grid-cols-3">{cases.map(c=><li className="min-w-0 rounded border p-3" key={c.id}><h3>{c.title}</h3><p>{c.price.toLocaleString("pl-PL")} zł · 45 m²</p><Link className="inline-flex min-h-11 items-center underline" href={`/deals/${c.id}`}>Otwórz Deal Room TEST</Link></li>)}</ul> : null}
  </section>;
}
