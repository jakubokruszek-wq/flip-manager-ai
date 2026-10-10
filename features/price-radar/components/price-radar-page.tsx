"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { MetricCard } from "@/components/ui/metric-card";
import { DEFAULT_RADAR_DISTRICTS, MIN_RADAR_SAMPLE_SIZE, type RadarListing, type RadarMarketFilter, type RadarQualificationRejections, type RadarSource, type RadarStatGroup, type RadarRunStatus, type RadarQualityCategory } from "@/features/price-radar/types";

type ResultsResponse = {
  listings: RadarListing[];
  excludedListings: RadarListing[];
  stats: RadarStatGroup[];
  activeSources: RadarSource[];
  disabledSourceNote: string;
};
type RunStatus = { id: string; status: RadarRunStatus; startedAt: string; finishedAt: string | null; leaseUntil: string | null; scannedCount: number; qualifiedCount: number; sourceStatuses: Record<string, string>; sourceErrors: Record<string, string>; qualificationRejections?: RadarQualificationRejections; errorMessage: string | null; checkpoint?: { sourceQueue?: string[]; currentSourceIndex?: number } };
type SettingsResponse = { filters: { districts: string[]; market: RadarMarketFilter; areaMin: number | null; areaMax: number | null; rooms: number[]; sources: RadarSource[]; minPricePerSqm: number | null }; activeSources: RadarSource[]; disabledSourceNote: string };

const ROOM_OPTIONS = [1, 2, 3, 4, 5];
const SOURCE_OPTIONS: { value: RadarSource; label: string }[] = [
  { value: "otodom", label: "Otodom" },
  { value: "olx", label: "OLX" },
  { value: "morizon", label: "Morizon" },
  { value: "domiporta", label: "Domiporta" },
  { value: "sprzedajemy", label: "Sprzedajemy.pl" },
  { value: "adresowo", label: "Adresowo.pl" },
  { value: "gratka", label: "Gratka" },
  { value: "nieruchomosci_online", label: "Nieruchomosci-online.pl" },
  { value: "oferty_net", label: "Oferty.net" },
  { value: "szybko", label: "Szybko.pl" },
  { value: "domy", label: "Domy.pl" },
  { value: "allegro_lokalnie", label: "Allegro Lokalnie" },
  { value: "official_cooperative", label: "Spółdzielnie Łódź" },
  { value: "official_uml", label: "UMŁ/BIP Łódź" },
];

export function PriceRadarPage() {
  const [districts, setDistricts] = useState<string[]>([...DEFAULT_RADAR_DISTRICTS]);
  const [market, setMarket] = useState<RadarMarketFilter>("both");
  const [areaMin, setAreaMin] = useState("");
  const [areaMax, setAreaMax] = useState("");
  const [minPricePerSqm, setMinPricePerSqm] = useState("");
  const [rooms, setRooms] = useState<number[]>([]);
  const [sources, setSources] = useState<RadarSource[]>([]);
  const [data, setData] = useState<ResultsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingExclusion, setPendingExclusion] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [activeSourceIds, setActiveSourceIds] = useState<RadarSource[]>([]);
  const [disabledSourceNote, setDisabledSourceNote] = useState("");
  const [run, setRun] = useState<RunStatus | null>(null);
  const [runStarting, setRunStarting] = useState(false);
  const [autoResumeMessage, setAutoResumeMessage] = useState<string | null>(null);
  const autoResumeInFlight = useRef(false);
  const lastAutoResumeAttempt = useRef<{ key: string; at: number } | null>(null);
  const refreshRunNow = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiFetch("/api/price-radar/settings").then(async (response) => {
      const payload = await response.json() as SettingsResponse | { message?: string };
      if (!response.ok || !("filters" in payload)) throw new Error("message" in payload && payload.message ? payload.message : "Nie udało się odczytać zapisanych filtrów Radaru.");
      if (cancelled) return;
      setDistricts(payload.filters.districts);
      setMarket(payload.filters.market);
      setAreaMin(payload.filters.areaMin === null ? "" : String(payload.filters.areaMin));
      setAreaMax(payload.filters.areaMax === null ? "" : String(payload.filters.areaMax));
      setMinPricePerSqm(payload.filters.minPricePerSqm === null ? "" : String(payload.filters.minPricePerSqm));
      setRooms(payload.filters.rooms);
      setSources(payload.filters.sources);
      setActiveSourceIds(payload.activeSources);
      setDisabledSourceNote(payload.disabledSourceNote);
      setSettingsLoaded(true);
    }).catch((reason) => {
      if (!cancelled) { setError(reason instanceof Error ? reason.message : "Nie udało się odczytać filtrów Radaru."); setSettingsLoaded(true); }
    });
    return () => { cancelled = true; };
  }, []);

  const saveSettings = useCallback(async () => {
    setSettingsSaving(true);
    try {
      const response = await apiFetch("/api/price-radar/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: { districts, market, areaMin: areaMin ? Number(areaMin) : null, areaMax: areaMax ? Number(areaMax) : null, rooms, sources, minPricePerSqm: minPricePerSqm ? Number(minPricePerSqm) : null } }),
      });
      const payload = await response.json() as { filters?: SettingsResponse["filters"]; message?: string };
      if (!response.ok || !payload.filters) throw new Error(payload.message || "Nie udało się zapisać filtrów Radaru.");
      setSettingsDirty(false);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Nie udało się zapisać filtrów Radaru.");
    } finally { setSettingsSaving(false); }
  }, [districts, market, areaMin, areaMax, rooms, sources, minPricePerSqm]);

  useEffect(() => {
    if (!settingsLoaded || !settingsDirty) return;
    const timeoutId = window.setTimeout(() => { void saveSettings(); }, 400);
    return () => window.clearTimeout(timeoutId);
  }, [settingsLoaded, settingsDirty, saveSettings]);

  const load = useCallback(async () => {
    if (!settingsLoaded) return;
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      for (const district of districts) params.append("district", district);
      for (const source of sources) params.append("source", source);
      for (const room of rooms) params.append("rooms", String(room));
      params.set("market", market);
      if (areaMin) params.set("areaMin", areaMin);
      if (areaMax) params.set("areaMax", areaMax);
      if (minPricePerSqm) params.set("minPricePerSqm", minPricePerSqm);

      const response = await apiFetch(`/api/price-radar/results?${params.toString()}`);
      const payload = (await response.json()) as ResultsResponse | { message?: string };
      if (!response.ok || !("listings" in payload)) {
        throw new Error("message" in payload && payload.message ? payload.message : "Nie udało się pobrać wyników Radaru.");
      }
      setData(payload);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Nie udało się pobrać wyników Radaru.");
    } finally {
      setIsLoading(false);
    }
  }, [settingsLoaded, districts, market, areaMin, areaMax, rooms, sources, minPricePerSqm]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  useEffect(() => {
    if (!settingsLoaded) return;
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      let nextDelay = 60_000;
      let shouldPoll = false;
      try {
        const response = await apiFetch("/api/price-radar/run");
        const payload = await response.json() as { run?: RunStatus | null };
        if (!response.ok) throw new Error("Nie udało się odczytać stanu zbierania Radaru.");
        const latest = payload.run ?? null;
        if (!cancelled) setRun(latest);
        const nonterminal = latest?.status === "running" || latest?.status === "pending";
        nextDelay = nonterminal ? 5_000 : 60_000;
        shouldPoll = nonterminal;
        const leaseExpired = nonterminal && (!latest.leaseUntil || !Number.isFinite(Date.parse(latest.leaseUntil)) || Date.parse(latest.leaseUntil) <= Date.now());
        const currentSourceIndex = latest?.checkpoint?.currentSourceIndex ?? -1;
        const currentSource = latest?.checkpoint?.sourceQueue?.[currentSourceIndex];
        const olxWorkerOwnsSource = currentSource === "olx" && latest?.sourceStatuses.olx === "running";
        if (olxWorkerOwnsSource && !cancelled) setAutoResumeMessage("OLX: dalszy krok nale\u017cy do kolejki workera; sprawdz jej stan.");
        else if (!cancelled) setAutoResumeMessage(null);
        const attemptKey = latest ? `${latest.id}:${latest.leaseUntil ?? "none"}` : "";
        const priorAttempt = lastAutoResumeAttempt.current;
        const retryDelayElapsed = !priorAttempt || priorAttempt.key !== attemptKey || Date.now() - priorAttempt.at >= 30_000;
        if (!cancelled && leaseExpired && latest && !olxWorkerOwnsSource && !autoResumeInFlight.current && retryDelayElapsed) {
          autoResumeInFlight.current = true;
          lastAutoResumeAttempt.current = { key: attemptKey, at: Date.now() };
          if (!cancelled) { setRunStarting(true); setAutoResumeMessage(null); }
          try {
            const resumed = await apiFetch("/api/price-radar/run", {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRunId: latest.id }),
            });
            const resumePayload = await resumed.json().catch(() => null) as { code?: string; message?: string } | null;
            if (resumed.status === 409) {
        if (olxWorkerOwnsSource && !cancelled) setAutoResumeMessage("OLX: dalszy krok nale\u017cy do kolejki workera; sprawdz jej stan.");
            } else if (!resumed.ok) {
              throw new Error(resumePayload?.message || "Unable to automatically resume the Radar run.");
            } else if (!cancelled) {
              setAutoResumeMessage(null);
              await load();
            }
            const currentResponse = await apiFetch("/api/price-radar/run");
            const currentPayload = await currentResponse.json() as { run?: RunStatus | null };
            if (!currentResponse.ok) throw new Error("Unable to refresh the Radar run after continuation.");
            if (!cancelled) setRun(currentPayload.run ?? null);
            nextDelay = currentPayload.run?.status === "running" || currentPayload.run?.status === "pending" ? 5_000 : 60_000;
            shouldPoll = currentPayload.run?.status === "running" || currentPayload.run?.status === "pending";
          } finally {
            autoResumeInFlight.current = false;
            setRunStarting(false);
          }
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Nie udało się odczytać stanu zbierania Radaru.");
      } finally {
        if (!cancelled && shouldPoll) timer = window.setTimeout(() => { void refresh(); }, nextDelay);
      }
    };
    const refreshNow = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      void refresh();
    };
    refreshRunNow.current = refreshNow;
    void refresh();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (refreshRunNow.current === refreshNow) refreshRunNow.current = null;
    };
  }, [settingsLoaded, load]);

  const toggleDistrict = (district: string) => {
    setSettingsDirty(true);
    setDistricts((current) => (current.includes(district) ? current.filter((item) => item !== district) : [...current, district]));
  };
  const toggleRoom = (room: number) => {
    setSettingsDirty(true);
    setRooms((current) => (current.includes(room) ? current.filter((item) => item !== room) : [...current, room]));
  };
  const toggleSource = (source: RadarSource) => {
    setSettingsDirty(true);
    setSources((current) => (current.includes(source) ? current.filter((item) => item !== source) : [...current, source]));
  };

  const startCollection = async () => {
    autoResumeInFlight.current = true;
    setRunStarting(true);
    try {
      const response = await apiFetch("/api/price-radar/run", { method: "POST" });
      const payload = await response.json() as { runId?: string; status?: RadarRunStatus; message?: string };
      if (!response.ok) throw new Error(payload.message || "Nie udało się rozpocząć zbierania Radaru.");
      const status = await apiFetch("/api/price-radar/run");
      const statusPayload = await status.json() as { run?: RunStatus | null };
      setRun(statusPayload.run ?? null);
      await load();
      refreshRunNow.current?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Nie udało się rozpocząć zbierania Radaru.");
    } finally {
      autoResumeInFlight.current = false;
      setRunStarting(false);
    }
  };

  const setExclusion = async (listingId: string, excluded: boolean) => {
    setPendingExclusion(listingId);
    try {
      const response = await apiFetch("/api/price-radar/exclude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId, excluded }),
      });
      if (!response.ok) throw new Error("Nie udało się zaktualizować wykluczenia.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Nie udało się zaktualizować wykluczenia.");
    } finally {
      setPendingExclusion(null);
    }
  };

  const groupedStats = useMemo(() => data?.stats ?? [], [data]);
  const visibleSources = activeSourceIds.length ? SOURCE_OPTIONS.filter((option) => activeSourceIds.includes(option.value)) : [];

  return (
    <div className="space-y-6 sm:space-y-8">
      <PageHeader title="Radar cen po remoncie" description="Referencyjna cena ofertowa za m² dla mieszkań po pełnym remoncie (rynek wtórny) lub wykończonych pod klucz (rynek pierwotny), wyłącznie w blokach i apartamentowcach." />

      <section aria-label="Filtry Radaru" className="rounded-xl border bg-card p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dzielnice</p>
            <div className="flex flex-wrap gap-2">
              {DEFAULT_RADAR_DISTRICTS.map((district) => (
                <button
                  key={district}
                  type="button"
                  aria-pressed={districts.includes(district)}
                  onClick={() => toggleDistrict(district)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${districts.includes(district) ? "border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-input text-muted-foreground"}`}
                >
                  {district}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="price-radar-market" className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rynek</label>
            <select
              id="price-radar-market"
              className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
              value={market}
              onChange={(event) => { setSettingsDirty(true); setMarket(event.target.value as RadarMarketFilter); }}
            >
              <option value="both">Oba</option>
              <option value="secondary">Wtórny</option>
              <option value="primary">Pierwotny</option>
            </select>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Metraż (m²)</p>
            <div className="flex items-center gap-2">
              <input type="number" min={0} placeholder="od" value={areaMin} onChange={(event) => { setSettingsDirty(true); setAreaMin(event.target.value); }} className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm" />
              <span className="text-muted-foreground">–</span>
              <input type="number" min={0} placeholder="do" value={areaMax} onChange={(event) => { setSettingsDirty(true); setAreaMax(event.target.value); }} className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm" />
            </div>
          </div>

          <div>
            <label htmlFor="price-radar-min-price-per-sqm" className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Min. cena ofertowa za m²</label>
            <input id="price-radar-min-price-per-sqm" type="number" min={0} max={100000} step={100} placeholder="wyłączony" value={minPricePerSqm} onChange={(event) => { setSettingsDirty(true); setMinPricePerSqm(event.target.value); }} className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm" />
            <p className="mt-1 text-xs text-muted-foreground">Opcjonalny filtr porównań; standard oceniamy wyłącznie z danych oferty.</p>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pokoje</p>
            <div className="flex flex-wrap gap-2">
              {ROOM_OPTIONS.map((room) => (
                <button
                  key={room}
                  type="button"
                  aria-pressed={rooms.includes(room)}
                  onClick={() => toggleRoom(room)}
                  className={`size-9 rounded-full border text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${rooms.includes(room) ? "border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-input text-muted-foreground"}`}
                >
                  {room}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Portale</p>
          <div className="flex flex-wrap gap-2">
            {visibleSources.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={sources.includes(option.value) || sources.length === 0}
                onClick={() => toggleSource(option.value)}
                className={`rounded-full border px-3 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${sources.includes(option.value) || sources.length === 0 ? "border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-input text-muted-foreground"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{disabledSourceNote || "Dostępne są wyłącznie źródła włączone we wspólnej bramce."} Filtr pusty oznacza wszystkie aktywne portale.</p>
        </div>
      </section>

      <section aria-label="Zbieranie ofert Radaru" className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="min-w-0">
          <h2 className="font-semibold">Zbieranie Radaru</h2>
          <p className="mt-1 break-words text-sm text-muted-foreground">{run ? `${runStatusLabel(run.status)}${(run.status === "running" || run.status === "pending") && !isRunActuallyActive(run) ? " (przerwany, gotowy do wznowienia)" : ""} · ${run.scannedCount} sprawdzonych · ${run.qualifiedCount} zakwalifikowanych · start ${formatDate(run.startedAt)}` : "Brak uruchomionego przebiegu."}</p>
          {run?.sourceErrors && Object.keys(run.sourceErrors).length > 0 ? <ul className="mt-2 space-y-1 text-xs text-destructive">{Object.entries(run.sourceErrors).map(([source, message]) => <li className="break-words" key={source}>{source}: {message}</li>)}</ul> : null}
          {run?.qualificationRejections && Object.values(run.qualificationRejections).some((counts) => Object.keys(counts).length > 0) ? <details aria-label="Powody odrzucenia ofert" className="mt-2 text-xs"><summary className="cursor-pointer font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary">Powody odrzucenia w kwalifikacji</summary><ul className="mt-2 space-y-1 text-muted-foreground">{Object.entries(run.qualificationRejections).map(([source, counts]) => { const reasons = Object.entries(counts).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0); return reasons.length ? <li className="break-words" key={source}><span className="font-semibold">{radarSourceLabel(source)}:</span> {reasons.map(([reason, count]) => `${qualificationRejectionLabel(reason)} · ${count}`).join("; ")}</li> : null; })}</ul></details> : null}
          {autoResumeMessage ? <p className="mt-2 text-xs text-muted-foreground">{autoResumeMessage}</p> : null}
          {settingsSaving ? <p className="mt-1 text-xs text-muted-foreground">Zapisywanie ustawień…</p> : settingsDirty ? <p className="mt-1 text-xs text-destructive">Ustawienia nie zostały zapisane. Zmiana zostanie ponowiona po kolejnej edycji.</p> : null}
        </div>
        <Button disabled={runStarting || isRunActuallyActive(run) || !settingsLoaded} onClick={() => void startCollection()}>
          {runStarting ? "Uruchamianie…" : isRunActuallyActive(run) ? "Przebieg trwa" : "Uruchom / wznów zbieranie"}
        </Button>
        {run?.sourceStatuses ? <div className="flex w-full min-w-0 flex-wrap gap-2 text-xs">{Object.entries(run.sourceStatuses).map(([source, status]) => <span className="max-w-full break-words rounded-full border px-2 py-1" key={source}>{source}: {statusLabel(status)}</span>)}</div> : null}
      </section>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      ) : null}

      <section aria-label="Statystyki Radaru" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {groupedStats.length === 0 && !isLoading ? (
          <p className="text-sm text-muted-foreground">Brak danych dla wybranych filtrów.</p>
        ) : null}
        {groupedStats.map((group) => (
          <div key={`${group.district}-${group.marketType}-${group.qualityCategory}`} className="rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="font-semibold">{group.district} · {group.marketType === "primary" ? "Pierwotny" : "Wtórny"} · {qualityCategoryLabel(group.qualityCategory, group.marketType)}</p>
              {group.isSmallSample ? (
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">Niewystarczająca próba</span>
              ) : null}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <MetricCard label="Średnia zł/m²" value={group.averagePricePerSqm ? formatCurrency(group.averagePricePerSqm) : "—"} />
              <MetricCard label="Mediana zł/m²" value={group.medianPricePerSqm ? formatCurrency(group.medianPricePerSqm) : "—"} />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {group.sampleSize} {group.sampleSize === 1 ? "mieszkanie" : "mieszkań"} · {group.sampleSize < MIN_RADAR_SAMPLE_SIZE ? `brak ceny referencyjnej (minimum ${MIN_RADAR_SAMPLE_SIZE})` : "ceny ofertowe w próbie"}
              {group.updatedAt ? ` · aktualizacja ${formatDate(group.updatedAt)}` : ""}
            </p>
          </div>
        ))}
      </section>

      <section aria-label="Oferty w próbie" className="space-y-3">
        <h2 className="text-lg font-semibold">Oferty w próbie ({data?.listings.length ?? 0})</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {(data?.listings ?? []).map((listing) => (
            <ListingRow key={listing.id} listing={listing} onExclude={() => void setExclusion(listing.id, true)} pending={pendingExclusion === listing.id} />
          ))}
        </div>

        {data && data.excludedListings.length > 0 ? (
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-muted-foreground">Wykluczone z porównań ({data.excludedListings.length})</h3>
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              {data.excludedListings.map((listing) => (
                <ListingRow key={listing.id} listing={listing} excluded onExclude={() => void setExclusion(listing.id, false)} pending={pendingExclusion === listing.id} />
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ListingRow({ listing, excluded, onExclude, pending }: { listing: RadarListing; excluded?: boolean; onExclude: () => void; pending: boolean }) {
  return (
    <article className={`min-w-0 overflow-hidden rounded-xl border bg-card p-4 ${excluded ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 break-words font-semibold [overflow-wrap:anywhere]">{listing.title ?? "Oferta bez tytułu"}</h3>
        <span className="max-w-32 shrink-0 break-words rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{sourceLabel(listing.source)}</span>
      </div>
      <p className="mt-1 break-words text-sm text-muted-foreground">{listing.district}, {listing.city} · {listing.marketType === "primary" ? "Pierwotny" : "Wtórny"} · {listing.buildingType === "blok" ? "Blok" : "Apartamentowiec"} · {qualityCategoryLabel(listing.qualityCategory, listing.marketType)}</p>
      <p className="mt-3 text-sm font-medium">
        {formatCurrency(listing.price)} · {listing.area} m² · {formatCurrency(listing.pricePerSqm)}/m²{listing.rooms ? ` · ${listing.rooms} pok.` : ""}
      </p>
      <dl className="mt-3 grid gap-1 text-xs text-muted-foreground">
        <DateRow label="Opublikowano" value={listing.publishedAt} />
        <DateRow label="Zmiana ogłoszenia" value={listing.sourceUpdatedAt} />
        <DateRow label="Pobrano" value={listing.collectedAt} />
      </dl>
      {listing.crossSourceAlternates.length > 0 ? <div className="mt-2 space-y-2 text-xs"><p className="font-semibold">Znaleziono także na: {listing.crossSourceAlternates.map((item) => sourceLabel(item.source)).filter((source, index, all) => all.indexOf(source) === index).join(", ")}</p>{listing.crossSourceAlternates.map((item) => <a className="grid break-words rounded-lg border border-border/60 p-2 text-primary underline sm:grid-cols-[minmax(0,1fr)_auto]" href={item.originalUrl} key={`${item.source}:${item.id}`} rel="noreferrer" target="_blank"><span>{sourceLabel(item.source)} · {item.title ?? "Ogłoszenie"} · {formatCurrency(item.price)} · {item.area} m²{item.rooms ? ` · ${item.rooms} pok.` : ""}</span><span>Opublikowano: {item.publishedAt ? formatDate(item.publishedAt) : "nie podano"} · pobrano: {formatDate(item.collectedAt)}</span></a>)}</div> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button nativeButton={false} render={<a href={listing.originalUrl} target="_blank" rel="noopener noreferrer" />} size="sm" variant="outline">
          Otwórz ogłoszenie
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={onExclude}>
          {excluded ? "Przywróć do porównań" : "Wyklucz z porównań"}
        </Button>
      </div>
    </article>
  );
}

function DateRow({ label, value }: { label: string; value: string | null }) {
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2"><dt>{label}</dt><dd className="break-words text-right">{value ? formatDate(value) : "Nie podano"}</dd></div>;
}

function sourceLabel(source: RadarSource): string {
  return SOURCE_OPTIONS.find((option) => option.value === source)?.label ?? source;
}

function qualityCategoryLabel(category: RadarQualityCategory, market: "primary" | "secondary"): string {
  if (category === "ready_high_standard") return "B · Gotowe — wysoki standard";
  return market === "primary" ? "A · Wykończone pod klucz" : "A · Po świeżym remoncie";
}

function runStatusLabel(status: RadarRunStatus): string {
  return ({ pending: "Oczekuje", running: "Trwa", completed: "Zakończono", partial: "Zakończono częściowo", failed: "Niepowodzenie" })[status];
}

/**
 * status === "running" alone does not mean a claim is still held: the
 * owning portion's lease can expire (a crashed/disconnected local OLX
 * worker, a timed-out request) without anything ever flipping the run's own
 * status row. The server's own claim RPC already treats an expired lease as
 * reclaimable, so the UI must not block the operator from retrying past a
 * stale "running" label -- that would leave an orphaned run with no way to
 * resume it short of direct database access.
 */
function isRunActuallyActive(run: RunStatus | null): boolean {
  if (!run || (run.status !== "running" && run.status !== "pending")) return false;
  if (!run.leaseUntil) return false;
  return new Date(run.leaseUntil).getTime() > Date.now();
}

function statusLabel(status: string): string {
  return ({ pending: "oczekuje", running: "pobieranie", completed: "ukończono", failed: "błąd" } as Record<string, string>)[status] ?? "nieznany";
}

function radarSourceLabel(source: string): string {
  return SOURCE_OPTIONS.find((option) => option.value === source)?.label ?? source;
}

function qualificationRejectionLabel(reason: string): string {
  const labels: Record<string, string> = {
    detail_not_confirmed: "brak potwierdzonych danych szczegółowych",
    price_missing: "brak ceny całkowitej",
    area_missing: "brak metrażu",
    price_is_not_total_offer_price: "cena nie jest całkowitą ceną oferty",
    price_is_starting_price: "cena jest ceną od",
    price_per_sqm_invalid: "nieprawidłowa cena za m²",
    district_not_confirmed: "brak potwierdzonej dzielnicy Łodzi",
    city_not_lodz: "oferta poza Łodzią",
    rental: "najem lub wynajem",
    share: "udział we współwłasności",
    commercial: "lokal użytkowy",
    plot: "działka",
    tenement_excluded: "kamienica wyłączona z próby",
    house_excluded: "dom lub segment",
    bulk_investment_ad: "zbiorcza reklama inwestycji, nie pojedynczy lokal",
    apartment_not_confirmed: "brak potwierdzenia, że to mieszkanie",
    building_type_not_confirmed: "brak potwierdzonego typu budynku",
    market_type_not_confirmed: "brak potwierdzonego rynku",
    unfinished_or_needs_renovation: "stan deweloperski lub lokal do remontu",
    renovation_exclusion: "sprzeczne dane o remoncie",
    renovation_not_confirmed_fresh_full: "brak potwierdzenia świeżego, pełnego remontu",
    turnkey_not_confirmed: "brak potwierdzenia wykończenia pod klucz",
  };
  return labels[reason] ?? reason;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
