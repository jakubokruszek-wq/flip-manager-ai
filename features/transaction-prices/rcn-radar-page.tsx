"use client";

import { useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/api-fetch";
import { StreetResalesPanel } from "./resales-panel";
import { DistrictRadarPanel } from "./district-radar-panel";
import { NearbyRadarPanel } from "./nearby-radar-panel";
import type { RcnResaleResult } from "./resales";

type Search = { street: string; attempt: number };
type Result = { key: string; data: RcnResaleResult | null; error: string | null };

export function RcnRadarPage({ defaultStreet = "Tatrzańska" }: { defaultStreet?: string }) {
  const [tab, setTab] = useState<"districts" | "street" | "nearby">("districts");
  const [street, setStreet] = useState(defaultStreet);
  const [search, setSearch] = useState<Search>({ street: defaultStreet.trim(), attempt: 0 });
  const [result, setResult] = useState<Result | null>(null);
  const key = JSON.stringify(search);
  useEffect(() => {
    if (tab !== "street" || search.street.length < 2 || search.street.length > 100) return;
    const controller = new AbortController();
    let active = true;
    void apiFetch(`/api/price-radar/rcn?${new URLSearchParams({ street: search.street, dataset: "city" })}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "Nie udało się pobrać transakcji RCN.");
        if (active) setResult({ key, data: data as RcnResaleResult, error: null });
      })
      .catch((error: unknown) => {
        if (active && !controller.signal.aborted) setResult({ key, data: null, error: error instanceof Error ? error.message : "Nie udało się pobrać transakcji RCN." });
      });
    return () => { active = false; controller.abort(); };
  }, [tab, search.street, key]);
  const current = result?.key === key ? result : null;
  const valid = street.trim().length >= 2 && street.trim().length <= 100;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (valid) setSearch((previous) => ({ street: street.trim(), attempt: previous.attempt + 1 }));
  }
  return <main className="mx-auto w-full min-w-0 max-w-6xl space-y-5 p-4 sm:p-6">
    <header>
      <h1 className="text-2xl font-bold tracking-tight">Radar transakcji · RCN</h1>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">Sprawdź możliwe flipy w Łodzi — według dzielnic, na wybranej ulicy lub w pobliżu wskazanego punktu: wzrost ceny o co najmniej 30%, zakup i odsprzedaż w ciągu maksymalnie 365 dni, końcowa sprzedaż w ostatnich 24 miesiącach.</p>
    </header>
    <div role="group" aria-label="Tryb Radaru" className="flex flex-wrap gap-2">
      <button type="button" aria-pressed={tab === "districts"} onClick={() => setTab("districts")} className="min-h-11 rounded-lg border px-4 text-sm font-medium aria-pressed:bg-primary aria-pressed:text-primary-foreground">Dzielnice</button>
      <button type="button" aria-pressed={tab === "street"} onClick={() => setTab("street")} className="min-h-11 rounded-lg border px-4 text-sm font-medium aria-pressed:bg-primary aria-pressed:text-primary-foreground">Ulica</button>
      <button type="button" aria-pressed={tab === "nearby"} onClick={() => setTab("nearby")} className="min-h-11 rounded-lg border px-4 text-sm font-medium aria-pressed:bg-primary aria-pressed:text-primary-foreground">W pobliżu</button>
    </div>
    {tab === "districts" ? <DistrictRadarPanel /> : tab === "nearby" ? <NearbyRadarPanel /> : <>
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1">
        <label htmlFor="rcn-radar-street" className="text-sm font-medium">Ulica w Łodzi</label>
        <input id="rcn-radar-street" name="street" value={street} onChange={(event) => setStreet(event.target.value)} minLength={2} maxLength={100} required placeholder="np. Tatrzańska" className="mt-2 block min-h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm" aria-describedby="rcn-radar-street-help" />
        <p id="rcn-radar-street-help" className="mt-2 text-xs text-muted-foreground">Podaj nazwę ulicy bez numeru mieszkania. Analiza obejmuje wszystkie metraże.</p>
      </div>
      <button type="submit" disabled={!valid} className="min-h-11 shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">Analizuj ulicę</button>
    </form>
    <div aria-live="polite" aria-busy={!current && search.street.length >= 2}>
      {search.street.length < 2 || search.street.length > 100 ? <p className="text-sm text-muted-foreground">Wpisz nazwę ulicy zawierającą od 2 do 100 znaków.</p>
        : !current ? <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">Pobieranie transakcji dla ulicy {search.street}…</p>
          : current.error ? <div className="rounded-xl border border-border p-4"><p role="alert" className="text-sm">{current.error}</p><button type="button" className="mt-3 min-h-11 rounded-lg border px-3 text-sm font-medium" onClick={() => setSearch((previous) => ({ ...previous, attempt: previous.attempt + 1 }))}>Spróbuj ponownie</button></div>
            : current.data ? <StreetResalesPanel data={current.data} /> : null}
    </div>
    </>}
    <aside className="space-y-2 rounded-xl bg-muted/40 p-4 text-xs leading-relaxed text-muted-foreground" aria-label="Zakres danych Radaru">
      <p>Wyniki dotyczą sprawdzonej próbki publicznego rejestru. Nie są pełnym spisem flipów na wybranym obszarze. Brak dopasowanej pary nie oznacza braku sprzedaży; różnica cen nie potwierdza remontu ani zysku netto.</p>
      <p>Dane dzielnic i wyszukiwania w pobliżu pochodzą z opublikowanych plików RCN; rejestr nie obejmuje jeszcze wszystkich najnowszych transakcji.</p>
    </aside>
  </main>;
}
