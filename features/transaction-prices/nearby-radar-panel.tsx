"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/api-fetch";
import { StreetResalesPanel } from "./resales-panel";
import type { RcnNearbyResult } from "./nearby";

type Position = { latitude: number; longitude: number; accuracy?: number; label: string; precision?: "address" | "street" };
type Result = { key: string; data: RcnNearbyResult | null; error: string | null };

export function NearbyRadarPanel() {
  const [mode, setMode] = useState<"gps" | "address">("gps");
  const [address, setAddress] = useState("");
  const geocode = useRef<AbortController | null>(null);
  const [radius, setRadius] = useState(1000);
  const [position, setPosition] = useState<Position | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; geocode.current?.abort(); }, []);
  const key = JSON.stringify({ position, radius, attempt });
  useEffect(() => {
    if (!position) return;
    const controller = new AbortController();
    let active = true;
    const params = new URLSearchParams({ latitude: String(position.latitude), longitude: String(position.longitude), radius: String(radius) });
    void apiFetch(`/api/price-radar/rcn/nearby?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "Nie udało się pobrać transakcji w pobliżu.");
        if (active) setResult({ key, data: data as RcnNearbyResult, error: null });
      })
      .catch((error: unknown) => {
        if (active && !controller.signal.aborted) setResult({ key, data: null, error: error instanceof Error ? error.message : "Nie udało się pobrać transakcji w pobliżu." });
      });
    return () => { active = false; controller.abort(); };
  }, [position, radius, key]);
  function locate() {
    const request = ++generation.current;
    geocode.current?.abort();
    setPosition(null);
    setResult(null);
    setLocationError(null);
    if (!navigator.geolocation) { setLocationError("Ta przeglądarka nie obsługuje lokalizacji. Wybierz „Podaj adres”."); return; }
    setLocating(true);
    try { navigator.geolocation.getCurrentPosition(value => {
      if (generation.current !== request) return;
      const { latitude, longitude, accuracy } = value.coords;
      if (![latitude, longitude, accuracy].every(Number.isFinite)) {
        setLocationError("Nie udało się ustalić poprawnej lokalizacji. Spróbuj ponownie.");
      } else setPosition({ latitude, longitude, accuracy, label: "Moja lokalizacja" });
      setLocating(false);
    }, error => {
      if (generation.current !== request) return;
      setLocating(false);
      setLocationError(error.code === 1 ? "Brak zgody na lokalizację. Zezwól na nią w ustawieniach przeglądarki lub wybierz „Podaj adres”."
        : error.code === 3 ? "Ustalanie lokalizacji trwało zbyt długo. Spróbuj ponownie, najlepiej przy lepszym sygnale GPS."
          : "Lokalizacja jest obecnie niedostępna. Spróbuj ponownie lub wybierz „Podaj adres”.");
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }); } catch {
      if (generation.current === request) { setLocating(false); setLocationError("Nie udało się uruchomić lokalizacji. Sprawdź uprawnienia przeglądarki lub wybierz „Podaj adres”."); }
    }
  }
  function switchMode(next: "gps" | "address") {
    generation.current++;
    geocode.current?.abort();
    setMode(next); setPosition(null); setResult(null); setLocationError(null); setLocating(false);
  }
  async function setAddressCenter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (address.trim().length < 2 || address.trim().length > 200) return;
    const request = ++generation.current;
    geocode.current?.abort();
    const controller = new AbortController(); geocode.current = controller;
    setPosition(null); setResult(null); setLocationError(null); setLocating(true);
    try {
      const response = await apiFetch(`/api/price-radar/rcn/geocode?${new URLSearchParams({ address: address.trim() })}`, { signal: controller.signal, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "Nie udało się znaleźć wskazanego adresu w Łodzi.");
      if (!Number.isFinite(data.latitude) || !Number.isFinite(data.longitude) || typeof data.label !== "string" || !["address", "street"].includes(data.precision)) throw new Error("Nie udało się potwierdzić punktu adresowego. Podaj dokładniejszy adres.");
      if (generation.current === request) setPosition({ latitude: data.latitude, longitude: data.longitude, label: data.label, precision: data.precision });
    } catch (error: unknown) {
      if (generation.current === request && !controller.signal.aborted) setLocationError(error instanceof Error ? error.message : "Nie udało się znaleźć adresu. Spróbuj ponownie.");
    } finally { if (generation.current === request) setLocating(false); }
  }
  const current = result?.key === key ? result : null;
  return <section aria-label="Radar w pobliżu" className="min-w-0 space-y-4">
    <div role="group" aria-label="Środek wyszukiwania" className="flex flex-wrap gap-2">
      <button type="button" aria-pressed={mode === "gps"} onClick={() => switchMode("gps")} className="min-h-11 rounded-lg border px-3 text-sm aria-pressed:bg-primary aria-pressed:text-primary-foreground">Moja lokalizacja</button>
      <button type="button" aria-pressed={mode === "address"} onClick={() => switchMode("address")} className="min-h-11 rounded-lg border px-3 text-sm aria-pressed:bg-primary aria-pressed:text-primary-foreground">Podaj adres</button>
    </div>
    {mode === "address" ? <form onSubmit={setAddressCenter} className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1"><label htmlFor="rcn-nearby-address" className="text-sm font-medium">Ulica lub adres w Łodzi</label><input id="rcn-nearby-address" value={address} onChange={event => setAddress(event.target.value)} required minLength={2} maxLength={200} placeholder="np. Tatrzańska 66" className="mt-2 block min-h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm" /></div>
      <button type="submit" disabled={locating || address.trim().length < 2} className="min-h-11 rounded-lg border px-4 text-sm font-semibold disabled:opacity-50">{locating ? "Wyszukiwanie adresu…" : "Ustaw punkt"}</button>
    </form> : null}
    <div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1">
        <label htmlFor="rcn-nearby-radius" className="text-sm font-medium">Promień wyszukiwania</label>
        <select id="rcn-nearby-radius" value={radius} onChange={event => setRadius(Number(event.target.value))} className="mt-2 block min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm">
          {[250, 500, 1000, 1500, 2000, 3000, 5000, 10000].map(value => <option key={value} value={value}>{value} m</option>)}
        </select>
      </div>
      {mode === "gps" ? <button type="button" disabled={locating} onClick={locate} className="min-h-11 shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{locating ? "Ustalanie lokalizacji…" : "Lokalizuj mnie"}</button> : null}
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">{mode === "gps" ? "Lokalizacja zostanie pobrana dopiero po kliknięciu przycisku i zgodzie w przeglądarce." : "Wpisany adres zostanie wyszukany dopiero po kliknięciu „Ustaw punkt”."} Transakcje są wyszukiwane w promieniu do {radius} m od wskazanego punktu. Odległość jest orientacyjna i liczona w linii prostej.</p>
    {position ? <div className="space-y-2 text-xs text-muted-foreground"><p className="break-words">Środek wyszukiwania: {position.label} · promień wyszukiwania: {radius} m.</p>{position.accuracy !== undefined ? <p>Dokładność lokalizacji: ±{Math.ceil(position.accuracy)} m.</p> : null}{position.precision === "street" ? <p>Promień liczony od wskazanego punktu ulicy, nie od całego jej przebiegu; podaj numer dla dokładniejszego środka.</p> : null}</div> : null}
    <div aria-live="polite" aria-busy={locating || Boolean(position && !current)}>
      {locationError ? <p role="alert" className="rounded-xl border border-border p-4 text-sm">{locationError}</p>
        : locating ? <p className="text-sm text-muted-foreground">{mode === "gps" ? "Ustalanie lokalizacji…" : "Wyszukiwanie adresu…"}</p>
          : !position ? <p className="text-sm text-muted-foreground">{mode === "gps" ? "Kliknij „Lokalizuj mnie”, aby sprawdzić możliwe flipy w okolicy." : "Wpisz ulicę lub adres i kliknij „Ustaw punkt”, aby wybrać środek wyszukiwania."}</p>
            : !current ? <p className="text-sm text-muted-foreground">Pobieranie transakcji w promieniu {radius} m…</p>
              : current.error ? <div className="rounded-xl border border-border p-4"><p role="alert" className="text-sm">{current.error}</p><button type="button" className="mt-3 min-h-11 rounded-lg border px-3 text-sm font-medium" onClick={() => setAttempt(value => value + 1)}>Spróbuj ponownie</button></div>
                : current.data ? <StreetResalesPanel data={current.data} scope="nearby" /> : null}
    </div>
  </section>;
}
