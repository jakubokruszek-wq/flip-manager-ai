"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  displayMetric,
  parseResultSort,
  publicationLabel,
  resultLocation,
  sortResults,
  type FilterResult,
  type ResultSort,
} from "@/features/flip-finder/results";
import type { SearchFilter } from "@/features/flip-finder";
import type { SearchFilterScan } from "@/features/flip-finder/search-filter-contract";

type ResultsResponse = {
  filter: SearchFilter;
  results: FilterResult[];
  total: number;
  newMatches: number;
  lastScan: SearchFilterScan | null;
};

export function FilterResultsPage({ id: filterId }: { id: string }) {
  const [data, setData] = useState<ResultsResponse | null>(null);
  const [sort, setSort] = useState<ResultSort>("newest");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/flip-finder/search-filters/${filterId}/results`);
      const payload: unknown = await readJson(response);

      if (!response.ok || !isResultsResponse(payload)) {
        throw new Error(readMessage(payload, "Nie udało się pobrać wyników filtra."));
      }

      setData(payload);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Nie udało się pobrać wyników filtra.");
    } finally {
      setIsLoading(false);
    }
  }, [filterId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void load();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [load]);

  const results = useMemo(() => (data ? sortResults(data.results, sort) : []), [data, sort]);

  if (isLoading) {
    return <ResultsLoadingState />;
  }

  if (error || !data) {
    return <ResultsErrorState message={error ?? "Nie udało się pobrać wyników filtra."} />;
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      <header className="rounded-xl border bg-card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-heading text-3xl font-semibold tracking-tight">{data.filter.name}</h1>
              <FilterStatusBadge isActive={data.filter.isActive} />
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              {filterCriteria(data.filter)}
            </p>
            {!data.filter.isActive ? (
              <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
                Ten filtr jest obecnie wstrzymany. Zapisane wyniki pozostają dostępne.
              </p>
            ) : null}
          </div>
          <Button nativeButton={false} render={<Link href="/flip-finder" />} variant="outline">
            Wróć do Flip Findera
          </Button>
        </div>

        <div className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
          <HeaderMetric label="Wszystkie wyniki" value={formatNumber(data.total)} />
          <HeaderMetric label="Nowe w ostatnim skanie" value={formatNumber(data.newMatches)} />
          {data.lastScan ? (
            <HeaderMetric label="Ostatni skan" value={formatDateTime(data.lastScan.startedAt)} />
          ) : null}
        </div>
      </header>

      {results.length > 0 ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Wyświetlasz {formatNumber(results.length)} {results.length === 1 ? "ofertę" : "ofert"}.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Sortowanie</span>
            <select
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
              onChange={(event) => setSort(parseResultSort(event.target.value))}
              value={sort}
            >
              <option value="newest">Najnowsze ogłoszenia</option>
              <option value="price_asc">Najniższa cena</option>
              <option value="price_per_sqm_asc">Najniższa cena za m²</option>
              <option value="biggest_price_drop">Największa obniżka</option>
            </select>
          </label>
        </div>
      ) : null}

      {results.length === 0 ? (
        <EmptyResultsState isActive={data.filter.isActive} />
      ) : (
        <section aria-label="Oferty dopasowane do filtra" className="grid gap-4 lg:grid-cols-2">
          {results.map((result) => (
            <ListingResultCard key={result.id} result={result} />
          ))}
        </section>
      )}
    </div>
  );
}

function ListingResultCard({ result }: { result: FilterResult }) {
  const price = formatCurrency(result.price);
  const pricePerSqm = formatCurrency(result.pricePerSqm);
  const location = result.locationText ?? resultLocation(result.address, result.district, result.city);
  const metrics = [
    price ? `Cena: ${price}` : null,
    displayMetric(result.area, "m²"),
    pricePerSqm ? `${pricePerSqm}/m²` : null,
    displayMetric(result.rooms, "pok."),
    result.floor ? `Piętro: ${result.floor}` : null,
  ].filter((metric): metric is string => metric !== null);

  return (
    <article className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-col sm:flex-row">
        <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden bg-muted sm:w-44">
          {result.thumbnailUrl ? (
            <Image
              fill
              unoptimized
              alt={`Zdjęcie oferty: ${result.title ?? "nieruchomość"}`}
              className="object-cover"
              sizes="(max-width: 640px) 100vw, 176px"
              src={result.thumbnailUrl}
            />
          ) : (
            <div className="flex size-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
              Brak zdjęcia
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="line-clamp-2 font-semibold">{result.title ?? "Oferta bez tytułu"}</h2>
              {location ? <p className="mt-1 text-sm text-muted-foreground">{location}</p> : null}
            </div>
            <SourceBadge source={result.source} />
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {result.isNew ? <ResultBadge label="Nowe" variant="new" /> : null}
            {result.hasPriceDrop ? <ResultBadge label="Obniżka ceny" variant="drop" /> : null}
            <ListingStatusBadge status={result.listingStatus} />
          </div>

          {metrics.length > 0 ? (
            <p className="mt-3 text-sm font-medium text-foreground">{metrics.join(" · ")}</p>
          ) : null}

          {result.hasPriceDrop && result.previousPrice !== null && result.priceDropAmount !== null ? (
            <p className="mt-3 text-sm text-emerald-800 dark:text-emerald-300">
              Poprzednia cena: {formatCurrency(result.previousPrice)} · obniżka: {formatCurrency(result.priceDropAmount)}
            </p>
          ) : null}

          <dl className="mt-4 grid gap-1 text-xs text-muted-foreground">
            <div className="flex flex-wrap justify-between gap-x-3">
              <dt>Data publikacji</dt>
              <dd>{publicationLabel(result.publishedAt).replace("Opublikowano: ", "")}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3">
              <dt>Pierwsze dopasowanie</dt>
              <dd>{formatDateTime(result.firstMatchedAt)}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3">
              <dt>Ostatnie sprawdzenie</dt>
              <dd>{formatDateTime(result.lastSeenAt)}</dd>
            </div>
          </dl>

          <div className="mt-4">
            <Button
              nativeButton={false}
              render={
                <a href={result.originalUrl} rel="noopener noreferrer" target="_blank" />
              }
              className="w-full sm:w-auto"
              size="sm"
              variant="outline"
            >
              Otwórz ogłoszenie
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}

function HeaderMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  );
}

function FilterStatusBadge({ isActive }: { isActive: boolean }) {
  return (
    <span
      className={
        isActive
          ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:text-emerald-300"
          : "rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
      }
    >
      {isActive ? "Aktywny" : "Wstrzymany"}
    </span>
  );
}

function SourceBadge({ source }: { source: FilterResult["source"] }) {
  const label = source === "otodom" ? "Otodom" : source === "olx" ? "OLX" : source === "morizon" ? "Morizon" : "Facebook";

  return <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{label}</span>;
}

function ListingStatusBadge({ status }: { status: FilterResult["listingStatus"] }) {
  const label =
    status === "active"
      ? "Aktywna"
      : status === "removed"
        ? "Usunięta"
        : status === "sold"
          ? "Sprzedana"
          : "Obserwowana";
  const className =
    status === "active"
      ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
      : "bg-muted text-muted-foreground";

  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{label}</span>;
}

function ResultBadge({ label, variant }: { label: string; variant: "new" | "drop" }) {
  const className =
    variant === "new"
      ? "bg-blue-500/10 text-blue-800 dark:text-blue-300"
      : "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300";

  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{label}</span>;
}

function EmptyResultsState({ isActive }: { isActive: boolean }) {
  return (
    <section className="rounded-xl border border-dashed bg-card p-6 text-center">
      <h2 className="font-semibold">Nie znaleziono jeszcze ofert pasujących do tego filtra.</h2>
      {isActive ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Uruchom pierwszy skan z dashboardu Flip Findera, aby pobrać oferty.
        </p>
      ) : null}
      <Button nativeButton={false} className="mt-4" render={<Link href="/flip-finder" />} variant="outline">
        Wróć do Flip Findera
      </Button>
    </section>
  );
}

function ResultsLoadingState() {
  return (
    <div className="space-y-6" role="status">
      <div className="h-48 animate-pulse rounded-xl bg-muted" />
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-64 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    </div>
  );
}

function ResultsErrorState({ message }: { message: string }) {
  return (
    <section className="rounded-xl border border-destructive/30 bg-destructive/10 p-6">
      <h1 className="font-semibold">Wyniki filtra</h1>
      <p className="mt-2 text-sm text-destructive">{message}</p>
      <Button nativeButton={false} className="mt-4" render={<Link href="/flip-finder" />} variant="outline">
        Wróć do Flip Findera
      </Button>
    </section>
  );
}

function filterCriteria(filter: SearchFilter): string {
  const location = [filter.city, filter.districts.filter(Boolean).join(", ")]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" · ");
  const details = [
    location || "Lokalizacja nie została ustawiona",
    filter.priceMax !== null ? `maks. ${formatCurrency(filter.priceMax)}` : null,
    filter.maxPricePerSqm !== null ? `maks. ${formatCurrency(filter.maxPricePerSqm)}/m²` : null,
  ].filter((value): value is string => value !== null);

  return details.join(" · ");
}

function formatCurrency(value: number | null): string | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Intl.NumberFormat("pl-PL", {
        style: "currency",
        currency: "PLN",
        maximumFractionDigits: 0,
      }).format(value)
    : null;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("pl-PL").format(
    typeof value === "number" && Number.isFinite(value) ? value : 0,
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? "Nie ustawiono"
    : new Intl.DateTimeFormat("pl-PL", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readMessage(value: unknown, fallback: string): string {
  if (
    value !== null &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message.trim()
  ) {
    return value.message;
  }

  return fallback;
}

function isResultsResponse(value: unknown): value is ResultsResponse {
  return (
    value !== null &&
    typeof value === "object" &&
    "filter" in value &&
    "results" in value &&
    Array.isArray(value.results) &&
    "total" in value &&
    typeof value.total === "number" &&
    "newMatches" in value &&
    typeof value.newMatches === "number" &&
    "lastScan" in value
  );
}
