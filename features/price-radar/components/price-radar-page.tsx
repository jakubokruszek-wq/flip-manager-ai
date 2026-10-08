"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { MetricCard } from "@/components/ui/metric-card";
import { DEFAULT_RADAR_DISTRICTS, MIN_RADAR_SAMPLE_SIZE, type RadarListing, type RadarMarketFilter, type RadarSource, type RadarStatGroup } from "@/features/price-radar/types";

type ResultsResponse = {
  listings: RadarListing[];
  excludedListings: RadarListing[];
  stats: RadarStatGroup[];
};

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
  const [rooms, setRooms] = useState<number[]>([]);
  const [sources, setSources] = useState<RadarSource[]>([]);
  const [data, setData] = useState<ResultsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingExclusion, setPendingExclusion] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      for (const district of districts) params.append("district", district);
      for (const source of sources) params.append("source", source);
      for (const room of rooms) params.append("rooms", String(room));
      params.set("market", market);
      if (areaMin) params.set("areaMin", areaMin);
      if (areaMax) params.set("areaMax", areaMax);

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
  }, [districts, market, areaMin, areaMax, rooms, sources]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  const toggleDistrict = (district: string) => {
    setDistricts((current) => (current.includes(district) ? current.filter((item) => item !== district) : [...current, district]));
  };
  const toggleRoom = (room: number) => {
    setRooms((current) => (current.includes(room) ? current.filter((item) => item !== room) : [...current, room]));
  };
  const toggleSource = (source: RadarSource) => {
    setSources((current) => (current.includes(source) ? current.filter((item) => item !== source) : [...current, source]));
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
                  onClick={() => toggleDistrict(district)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${districts.includes(district) ? "border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-input text-muted-foreground"}`}
                >
                  {district}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rynek</p>
            <select
              className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
              value={market}
              onChange={(event) => setMarket(event.target.value as RadarMarketFilter)}
            >
              <option value="both">Oba</option>
              <option value="secondary">Wtórny</option>
              <option value="primary">Pierwotny</option>
            </select>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Metraż (m²)</p>
            <div className="flex items-center gap-2">
              <input type="number" min={0} placeholder="od" value={areaMin} onChange={(event) => setAreaMin(event.target.value)} className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm" />
              <span className="text-muted-foreground">–</span>
              <input type="number" min={0} placeholder="do" value={areaMax} onChange={(event) => setAreaMax(event.target.value)} className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm" />
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pokoje</p>
            <div className="flex flex-wrap gap-2">
              {ROOM_OPTIONS.map((room) => (
                <button
                  key={room}
                  type="button"
                  onClick={() => toggleRoom(room)}
                  className={`size-9 rounded-full border text-sm font-medium transition-colors ${rooms.includes(room) ? "border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-input text-muted-foreground"}`}
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
            {SOURCE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => toggleSource(option.value)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${sources.includes(option.value) || sources.length === 0 ? "border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-input text-muted-foreground"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      ) : null}

      <section aria-label="Statystyki Radaru" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {groupedStats.length === 0 && !isLoading ? (
          <p className="text-sm text-muted-foreground">Brak danych dla wybranych filtrów.</p>
        ) : null}
        {groupedStats.map((group) => (
          <div key={`${group.district}-${group.marketType}`} className="rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="font-semibold">{group.district} · {group.marketType === "primary" ? "Pierwotny" : "Wtórny"}</p>
              {group.isSmallSample ? (
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">Mała próba</span>
              ) : null}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <MetricCard label="Średnia zł/m²" value={group.averagePricePerSqm ? formatCurrency(group.averagePricePerSqm) : "—"} />
              <MetricCard label="Mediana zł/m²" value={group.medianPricePerSqm ? formatCurrency(group.medianPricePerSqm) : "—"} />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {group.sampleSize} {group.sampleSize === 1 ? "mieszkanie" : "mieszkań"} w próbie (min. {MIN_RADAR_SAMPLE_SIZE})
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
    <article className={`rounded-xl border bg-card p-4 ${excluded ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-2 min-w-0 font-semibold">{listing.title ?? "Oferta bez tytułu"}</h3>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{listing.source}</span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{listing.district}, {listing.city} · {listing.marketType === "primary" ? "Pierwotny" : "Wtórny"}</p>
      <p className="mt-3 text-sm font-medium">
        {formatCurrency(listing.price)} · {listing.area} m² · {formatCurrency(listing.pricePerSqm)}/m²{listing.rooms ? ` · ${listing.rooms} pok.` : ""}
      </p>
      <dl className="mt-3 grid gap-1 text-xs text-muted-foreground">
        <div className="flex justify-between"><dt>Pierwsze wykrycie</dt><dd>{formatDate(listing.firstSeenAt)}</dd></div>
        <div className="flex justify-between"><dt>Ostatnie potwierdzenie</dt><dd>{formatDate(listing.lastSeenAt)}</dd></div>
      </dl>
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

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
