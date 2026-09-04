"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BedDouble, BrainCircuit, Clock3, ExternalLink, MapPin, Plus, SlidersHorizontal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatListingDescription } from "@/lib/listing-description";
import { analyzeProperty } from "@/features/ai-analysis/analyze-property";
import { calculateFlipScore } from "@/features/flip-score/calculate-flip-score";
import { MarketIntelligencePanel } from "@/features/market-intelligence/market-intelligence-panel";
import type { MarketIntelligence } from "@/features/market-intelligence/types";
import { RenovationVisualizer } from "@/features/renovation-visualizer/renovation-visualizer";
import { getPurchaseRecommendation } from "@/features/purchase-recommendation/recommendation";
import {
  filterResultsByText,
  parseResultSort,
  publicationLabel,
  resultLocation,
  sortResults,
  type FilterResult,
  type ResultSort,
} from "@/features/flip-finder/results";
import { activeSourcesSummary, latestActiveScansText, sourceLabel } from "@/features/flip-finder/source-summary";
import type { SearchFilter } from "@/features/flip-finder";
import type { SearchFilterScan } from "@/features/flip-finder/search-filter-contract";

type ResultsResponse = {
  filter: SearchFilter;
  results: FilterResult[];
  reviewResults?: FilterResult[];
  archivedResults?: FilterResult[];
  total: number;
  newMatches: number;
  lastScan: SearchFilterScan | null;
  sourceScans: SearchFilterScan[];
};

type PriceHistoryResponse = {
  listingId: string;
  currentPrice: number | null;
  history: Array<{ price: number | null; capturedAt: string }>;
};

export function InlineFilterResults({ filterId }: { filterId: string }) {
  const [data, setData] = useState<ResultsResponse | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ResultSort>("newest");
  const [source, setSource] = useState<FilterResult["source"] | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/flip-finder/search-filters/${filterId}/results${archiveOpen ? "?view=archive" : ""}`);
      const payload: unknown = await readJson(response);
      if (!response.ok || !isResultsResponse(payload)) {
        throw new Error(readMessage(payload, "Nie udało się pobrać ofert."));
      }
      setData(payload);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Nie udało się pobrać ofert.");
    }
  }, [archiveOpen, filterId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  const allResults = useMemo(() => data?.results ?? [], [data?.results]);
  const filteredResults = useMemo(() => {
    const textFiltered = filterResultsByText(allResults, query);
    return source ? textFiltered.filter((result) => result.source === source) : textFiltered;
  }, [allResults, query, source]);
  const renderedResults = useMemo(
    () => sortResults(filteredResults, sort),
    [filteredResults, sort],
  );
  const reviewResults = data?.reviewResults ?? [];
  const archivedResults = archiveOpen ? (data?.archivedResults ?? []) : [];
  const sourceCounts = useMemo(() => countSources(data?.results ?? []), [data]);
  const activeSources = data?.filter.sources ?? [];
  const historicalSources = (["otodom", "olx", "morizon", "facebook"] as const).filter((item) => sourceCounts[item] > 0 && !activeSources.includes(item));

  if (error) {
    return <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">{error}</p>;
  }

  return (
    <section aria-label="Oferty dopasowane do aktywnego filtra" className="space-y-4">
      {data ? <><div className="flex items-center justify-between gap-3"><div><p className="font-semibold">BAZA OFERT</p><p className="mt-1 text-sm text-muted-foreground">Aktywne zapisane oferty: <strong className="text-foreground">{data.total}</strong></p><p className="mt-1 text-xs font-medium text-foreground/80">{activeSourcesSummary(activeSources)}</p></div><button aria-expanded={filtersOpen} className="flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-primary sm:hidden" onClick={() => setFiltersOpen(true)} type="button"><SlidersHorizontal className="size-4" />Filtry{source ? <span className="size-2 rounded-full bg-primary" /> : null}</button><div className="hidden flex-wrap items-center gap-2 sm:flex"><SourceCount label="Razem" value={data.total} active={source === null} onClick={() => setSource(null)} />{activeSources.filter((item) => sourceCounts[item] > 0).map((item) => <SourceCount key={item} label={sourceLabel(item)} value={sourceCounts[item]} active={source === item} onClick={() => setSource(item)} />)}</div></div><p className="text-xs text-muted-foreground">{latestActiveScansText(data.sourceScans, activeSources)}</p>{historicalSources.length ? <p className="text-xs text-muted-foreground/80">Historyczne wyniki z wyłączonych źródeł: {historicalSources.map((item) => `${sourceLabel(item)} (${sourceCounts[item]})`).join(", ")}</p> : null}{filtersOpen ? <div className="fixed inset-0 z-[70] sm:hidden"><button aria-label="Zamknij filtry" className="absolute inset-0 bg-black/60" onClick={() => setFiltersOpen(false)} type="button" /><div className="absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-border bg-card p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl"><div className="flex items-center justify-between"><h2 className="text-lg font-bold">Filtry ofert</h2><button aria-label="Zamknij filtry" className="flex size-11 items-center justify-center rounded-xl border border-border" onClick={() => setFiltersOpen(false)} type="button"><X className="size-5" /></button></div><p className="mt-3 text-xs text-muted-foreground">{activeSourcesSummary(activeSources)}</p><div className="mt-5 grid grid-cols-2 gap-2"><SourceCount label="Wszystkie" value={data.total} active={source === null} onClick={() => { setSource(null); setFiltersOpen(false); }} />{activeSources.filter((item) => sourceCounts[item] > 0).map((item) => <SourceCount key={item} label={sourceLabel(item)} value={sourceCounts[item]} active={source === item} onClick={() => { setSource(item); setFiltersOpen(false); }} />)}</div></div></div> : null}</> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          aria-label="Szukaj ofert"
          className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm sm:max-w-lg"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Szukaj: tytuł, ulica, dzielnica, opis, źródło"
          type="search"
          value={query}
        />
        <label className="flex w-full items-center gap-2 text-sm sm:w-auto">
          <span className="text-muted-foreground">Sortowanie</span>
          <select
            className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 sm:flex-none"
            onChange={(event) => setSort(parseResultSort(event.target.value))}
            value={sort}
          >
            <option value="newest">Najnowsze ogłoszenia</option>
            <option value="price_asc">Najniższa cena</option>
            <option value="price_per_sqm_asc">Najniższa cena/m²</option>
            <option value="biggest_price_drop">Największa obniżka</option>
          </select>
        </label>
      </div>

      {data === null ? <p className="text-sm text-muted-foreground">Ładowanie ofert…</p> : null}
      {data !== null && renderedResults.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center">
          <p className="font-medium">Nie znaleziono jeszcze ofert pasujących do tego filtra.</p>
          {query ? <p className="mt-1 text-sm text-muted-foreground">Zmień tekst wyszukiwania, aby zobaczyć pozostałe oferty.</p> : null}
        </div>
      ) : null}
      {data && renderedResults.length > 0 ? <p className="text-lg font-semibold">AKTYWNE / MATCHED <span className="text-sm font-normal text-muted-foreground">({renderedResults.length})</span></p> : null}
      {data && reviewResults.length > 0 ? <section aria-label="Oferty do oceny" className="space-y-3"><div><h2 className="text-lg font-semibold">DO OCENY</h2><p className="text-sm text-muted-foreground">Potencjalne oferty bez kompletu danych: {reviewResults.length}</p></div><div className="grid gap-3 lg:grid-cols-2">{reviewResults.map((result) => <ReviewListingCard key={result.id} result={result} onChanged={() => void load()} />)}</div></section> : null}
      {data ? <div className="flex items-center justify-between border-t border-border/60 pt-4"><div><h2 className="font-semibold">ARCHIWUM</h2><p className="mt-1 text-sm text-muted-foreground">Stare i odrzucone rekordy są ukryte w głównym Finderze.</p></div><Button onClick={() => setArchiveOpen((current) => !current)} type="button" variant="outline">{archiveOpen ? "Ukryj archiwum" : "Pokaż archiwum"}</Button></div> : null}
      {data && archivedResults.length > 0 ? <section aria-label="Odrzucone i archiwalne oferty" className="space-y-3 rounded-xl border border-border/60 p-4"><h2 className="font-semibold">ARCHIWUM / ODRZUCONE</h2><p className="mt-1 text-sm text-muted-foreground">Ukryte z głównego widoku: {archivedResults.length} · stale: {archivedResults.filter((result) => result.lifecycleStatus === "STALE").length} · archiwalne: {archivedResults.filter((result) => result.lifecycleStatus === "ARCHIVED").length} · odrzucone: {archivedResults.filter((result) => result.lifecycleStatus === "REJECTED").length}</p><div className="grid gap-3 lg:grid-cols-2">{archivedResults.map((result) => <ExpandableListingCard averagePricePerSqm={data.filter.maxPricePerSqm ?? null} key={result.id} marketType={data.filter.marketType ?? null} result={result} />)}</div></section> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {renderedResults.map((result) => <ExpandableListingCard averagePricePerSqm={data?.filter.maxPricePerSqm ?? null} key={result.id} marketType={data?.filter.marketType ?? null} result={result} />)}
      </div>
    </section>
  );
}

function ReviewListingCard({ result, onChanged }: { result: FilterResult; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "ACCEPTED" | "REJECTED") => {
    setBusy(true);
    try {
      const response = await fetch(`/api/flip-finder/listings/${result.id}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) });
      if (!response.ok) throw new Error("Nie udało się zapisać decyzji.");
      onChanged();
    } finally { setBusy(false); }
  };
  return <article className="rounded-xl border border-amber-400/30 bg-amber-500/5 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{result.title ?? "Oferta do oceny"}</h3><p className="mt-1 text-sm text-muted-foreground">{result.locationText ?? "Lokalizacja nieznana"}</p></div><span className="rounded-full border border-amber-400/40 px-2 py-1 text-xs font-semibold">DO OCENY</span></div><div className="mt-3 grid grid-cols-2 gap-2 text-sm"><span>Cena: {result.price == null ? "brak" : `${result.price.toLocaleString("pl-PL")} zł`}</span><span>Metraż: {result.area == null ? "brak" : `${result.area} m²`}</span><span>Pokoje: {result.rooms ?? "brak"}</span><span>Typ: {result.buildingType ?? "brak"}</span></div><p className="mt-3 text-xs text-muted-foreground">{result.reviewReason ?? "Wymaga ręcznej oceny"}{result.missingFields?.length ? ` · Brak: ${result.missingFields.join(", ")}` : ""}</p><div className="mt-3 flex gap-2"><Button disabled={busy} onClick={() => void decide("ACCEPTED")} type="button">DODAJ</Button><Button disabled={busy} onClick={() => void decide("REJECTED")} type="button" variant="outline">ODRZUĆ</Button>{result.originalUrl ? <a className="flex items-center gap-1 rounded-md border px-3 text-sm" href={result.originalUrl} rel="noreferrer" target="_blank">Facebook <ExternalLink className="size-3" /></a> : null}</div></article>;
}

export function ExpandableListingCard({ result, averagePricePerSqm, marketType, onOpen, onCrmImported }: { result: FilterResult; averagePricePerSqm: number | null; marketType: SearchFilter["marketType"]; onOpen?: () => void; onCrmImported?: (propertyId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [crmImporting, setCrmImporting] = useState(false);
  const [crmToast, setCrmToast] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"details" | "calculator" | "analysis" | "price-history" | "market" | "renovation-visualizer">("details");
  const [priceHistory, setPriceHistory] = useState<PriceHistoryResponse | null>(null);
  const [priceHistoryError, setPriceHistoryError] = useState<string | null>(null);
  const [priceHistoryLoading, setPriceHistoryLoading] = useState(false);
  const [marketIntelligence, setMarketIntelligence] = useState<MarketIntelligence | null>(null);
  const [marketIntelligenceError, setMarketIntelligenceError] = useState<string | null>(null);
  const [marketIntelligenceLoading, setMarketIntelligenceLoading] = useState(false);
  const [calculator, setCalculator] = useState({ purchasePrice: result.price ?? 0, notary: 0, purchaseCommission: 0, renovation: 0, furnishing: 0, reserve: 0, salePrice: 0, saleCommission: 0, tax: 0 });
  const [targetProfit, setTargetProfit] = useState(50_000);
  const [targetRoi, setTargetRoi] = useState(15);
  const location = result.locationText ?? resultLocation(result.address, result.district, result.city) ?? "—";
  const title = result.title ?? "Oferta bez tytułu";
  const toggle = () => setExpanded((current) => { if (!current) onOpen?.(); return !current; });
  const purchaseTax = calculator.purchasePrice * 0.02;
  const purchaseCost = calculator.purchasePrice + purchaseTax + calculator.notary + calculator.purchaseCommission;
  const totalCost = purchaseCost + calculator.renovation + calculator.furnishing + calculator.reserve;
  const revenue = calculator.salePrice - calculator.saleCommission - calculator.tax;
  const profit = revenue - totalCost;
  const roi = totalCost > 0 ? (profit / totalCost) * 100 : 0;
  const margin = calculator.salePrice > 0 ? (profit / calculator.salePrice) * 100 : 0;
  const flipScore = calculateFlipScore({ price: result.price, pricePerSqm: result.pricePerSqm, averagePricePerSqm, rooms: result.rooms, area: result.area, marketType, title: result.title, description: result.description });
  const analysis = analyzeProperty({ price: result.price, pricePerSqm: result.pricePerSqm, averagePricePerSqm, area: result.area, rooms: result.rooms, floor: result.floor, marketType, title: result.title, description: result.description, flipScore: flipScore.score });
  const setCalculatorValue = (field: keyof typeof calculator, value: string) => {
    const amount = Number(value.replace(",", "."));
    setCalculator((current) => ({ ...current, [field]: Number.isFinite(amount) && amount >= 0 ? amount : 0 }));
  };
  const loadPriceHistory = useCallback(async () => {
    setPriceHistoryLoading(true);
    setPriceHistoryError(null);

    try {
      const response = await fetch(`/api/flip-finder/listings/${result.id}/price-history`);
      const payload: unknown = await readJson(response);

      if (!response.ok || !isPriceHistoryResponse(payload)) {
        throw new Error(readMessage(payload, "Nie udało się pobrać historii ceny."));
      }

      setPriceHistory(payload);
    } catch (reason) {
      setPriceHistoryError(
        reason instanceof Error ? reason.message : "Nie udało się pobrać historii ceny.",
      );
    } finally {
      setPriceHistoryLoading(false);
    }
  }, [result.id]);

  const loadMarketIntelligence = useCallback(async () => {
    setMarketIntelligenceLoading(true);
    setMarketIntelligenceError(null);

    try {
      const response = await fetch(`/api/market-intelligence/${result.id}`);
      const payload: unknown = await readJson(response);

      if (!response.ok || !isMarketIntelligence(payload)) {
        throw new Error(readMessage(payload, "Nie udało się przeanalizować rynku."));
      }

      setMarketIntelligence(payload);
      return payload;
    } catch (reason) {
      setMarketIntelligenceError(
        reason instanceof Error ? reason.message : "Nie udało się przeanalizować rynku.",
      );
      return null;
    } finally {
      setMarketIntelligenceLoading(false);
    }
  }, [result.id]);

  useEffect(() => {
    if (!expanded || activeTab !== "price-history") {
      return;
    }

    const timeoutId = window.setTimeout(() => void loadPriceHistory(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [activeTab, expanded, loadPriceHistory]);

  useEffect(() => {
    if (!expanded || activeTab !== "market") {
      return;
    }

    const timeoutId = window.setTimeout(() => void loadMarketIntelligence(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [activeTab, expanded, loadMarketIntelligence]);
  const importToCrm = async () => {
    if (crmImporting) return;

    setCrmImporting(true);
    setCrmToast(null);

    try {
      const market = marketIntelligence ?? await loadMarketIntelligence();
      if (!market) {
        throw new Error("Nie udało się przygotować analizy rynku do zapisu.");
      }
      const purchaseRecommendation = getPurchaseRecommendation({
        estimatedAfterRenovationPrice: market.estimatedAfterRenovationPrice,
        renovationCost: calculator.renovation,
        furnishingCost: calculator.furnishing,
        reserveCost: calculator.reserve,
        notaryCost: calculator.notary,
        purchaseCommission: calculator.purchaseCommission,
        saleCommission: calculator.saleCommission,
        taxCost: calculator.tax,
        targetProfit,
        targetRoi,
        currentListingPrice: result.price,
      });
      const investmentAnalysis = {
        flipScore,
        aiAnalysis: analysis,
        marketIntelligence: market,
        purchaseRecommendation,
        calculator: {
          purchasePrice: calculator.purchasePrice,
          purchaseTax,
          notaryCost: calculator.notary,
          purchaseCommission: calculator.purchaseCommission,
          renovationCost: calculator.renovation,
          furnishingCost: calculator.furnishing,
          reserveCost: calculator.reserve,
          salePrice: calculator.salePrice,
          saleCommission: calculator.saleCommission,
          taxCost: calculator.tax,
          purchaseCost,
          totalCost,
          revenue,
          profit,
          roi,
          margin,
        },
        analyzedAt: new Date().toISOString(),
      };
      const response = await fetch("/api/properties/import-from-finder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...result, investmentAnalysis }),
      });
      const payload: unknown = await readJson(response);

      if (!response.ok) {
        throw new Error(readMessage(payload, "Nie udało się dodać nieruchomości do CRM."));
      }
      if (!isPropertyImportResponse(payload)) {
        throw new Error("CRM zwrócił nieprawidłową odpowiedź po zapisie oferty.");
      }

      onCrmImported?.(payload.propertyId);

      setCrmToast(isUpdatedPropertyImport(payload) ? "Najnowsza analiza inwestycyjna została zaktualizowana w CRM." : "Nieruchomość została dodana do CRM z analizą inwestycyjną.");
    } catch (reason) {
      setCrmToast(reason instanceof Error ? reason.message : "Nie udało się dodać nieruchomości do CRM.");
    } finally {
      setCrmImporting(false);
    }
  };

  return (
    <Dialog onOpenChange={setExpanded} open={expanded}>
      <article
      aria-expanded={expanded}
      className="ui-card ui-card-hover group cursor-pointer overflow-hidden"
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="flex min-h-[270px] flex-col p-2 sm:flex-row sm:p-3">
        <div className="relative aspect-[16/11] w-full shrink-0 overflow-hidden rounded-xl bg-muted sm:w-[44%] sm:max-w-[300px]">
          {result.thumbnailUrl ? (
            <Image fill unoptimized alt={`Zdjęcie: ${title}`} className="object-cover transition-transform duration-500 group-hover:scale-[1.035]" sizes="(max-width: 640px) 100vw, 300px" src={result.thumbnailUrl} />
          ) : <Placeholder />}
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/55 via-black/15 to-transparent" />
          <div className="absolute inset-x-3 bottom-3 flex items-center justify-between gap-2">
            <StatusBadge status={result.listingStatus} />
            {result.isNew ? <Badge label="Nowa" /> : result.hasPriceDrop ? <Badge label="Obniżka" /> : null}
          </div>
        </div>
        <div className="relative flex min-w-0 flex-1 flex-col px-3 pb-3 pt-4 sm:px-5 sm:py-3">
          <div className="absolute right-3 top-4 flex items-center gap-2 sm:right-5 sm:top-3">
            <LifecycleBadge status={result.lifecycleStatus} />
            <SourceBadge source={result.source} />
          </div>
          <div className="min-w-0 pr-24"><h2 className="line-clamp-2 text-base font-semibold leading-snug tracking-tight sm:text-lg">{title}</h2></div>
          <div className="mt-3">
            <p className="text-2xl font-bold leading-none tracking-tight text-foreground sm:text-3xl">{currency(result.price)}</p>
            <p className="mt-1 text-sm font-medium text-muted-foreground">{currencyPerSqm(result.pricePerSqm)}</p>
            <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/[0.09] px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300"><span className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px] shadow-emerald-500/15" />Flip Score {flipScore.score} · {flipScore.label}</span>
          </div>
          <div className="mt-4 space-y-2.5 text-sm text-muted-foreground">
            <p className="flex items-center gap-2 truncate"><MapPin aria-hidden="true" className="size-4 shrink-0 text-foreground/65" /><span className="truncate">{location}</span></p>
            <p className="flex items-center gap-2"><BedDouble aria-hidden="true" className="size-4 shrink-0 text-foreground/65" /><span>{measure(result.rooms, "pok.")} <span className="mx-1.5 text-border">•</span> {measure(result.area, "m²")}</span></p>
            <p className="flex items-center gap-2"><Clock3 aria-hidden="true" className="size-4 shrink-0 text-foreground/65" /><span className="truncate">{publicationLabel(result.publishedAt)}</span></p>
            <p className="flex items-center gap-2"><Clock3 aria-hidden="true" className="size-4 shrink-0 text-foreground/65" /><span className="truncate">Ostatnie sprawdzenie: {dateTime(result.lastSeenAt)}</span></p>
          </div>
          <p className="mt-auto pt-4 text-xs font-medium text-muted-foreground/80">Kliknij kartę, aby zobaczyć szczegóły</p>
        </div>
      </div>
      </article>
      <DialogContent className="left-0 top-0 h-dvh max-h-none max-w-none translate-x-0 translate-y-0 gap-0 overflow-x-hidden overflow-y-auto rounded-none border-border/70 bg-card p-0 shadow-2xl shadow-black/15 sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-4xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl">
        <div className="border-b border-border/70 px-5 pb-5 pt-6 sm:px-8 sm:pb-6 sm:pt-8">
          <div className="flex flex-col items-start gap-4 pr-8 min-[390px]:flex-row">
            <div className="min-w-0 flex-1">
              <div className="mb-3 flex items-center gap-2"><SourceBadge source={result.source} /><StatusBadge status={result.listingStatus} /></div>
              <DialogTitle className="text-xl font-bold leading-tight tracking-tight sm:text-2xl">{title}</DialogTitle>
              <DialogDescription className="mt-2 flex items-center gap-2 text-sm"><MapPin aria-hidden="true" className="size-4 shrink-0" />{location}</DialogDescription>
            </div>
            <div className="shrink-0 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.09] px-4 py-3 text-center text-emerald-700 dark:text-emerald-300"><span className="block text-[11px] font-semibold uppercase tracking-[0.14em]">Flip Score</span><span className="mt-0.5 block text-3xl font-bold leading-none tracking-tight">{flipScore.score}</span><span className="mt-1 block text-[11px] font-semibold">{flipScore.label}</span></div>
          </div>
        </div>
        <div className="flex snap-x gap-1 overflow-x-auto border-b border-border/70 px-5 py-3 sm:px-8" role="tablist">
          <button aria-selected={activeTab === "details"} className={`min-h-11 shrink-0 snap-start rounded-lg px-3 py-2 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${activeTab === "details" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setActiveTab("details")} role="tab" type="button">Informacje</button>
          <button aria-selected={activeTab === "calculator"} className={`min-h-11 shrink-0 snap-start rounded-lg px-3 py-2 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${activeTab === "calculator" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setActiveTab("calculator")} role="tab" type="button">Kalkulator</button>
          <button aria-selected={activeTab === "analysis"} className={`min-h-11 shrink-0 snap-start rounded-lg px-3 py-2 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${activeTab === "analysis" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setActiveTab("analysis")} role="tab" type="button">Analiza AI</button>
          <button aria-selected={activeTab === "market"} className={`min-h-11 shrink-0 snap-start rounded-lg px-3 py-2 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${activeTab === "market" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setActiveTab("market")} role="tab" type="button">Rynek</button>
          <button aria-selected={activeTab === "price-history"} className={`min-h-11 shrink-0 snap-start rounded-lg px-3 py-2 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${activeTab === "price-history" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setActiveTab("price-history")} role="tab" type="button">Historia ceny</button>
          <button aria-selected={activeTab === "renovation-visualizer"} className={`min-h-11 shrink-0 snap-start rounded-lg px-3 py-2 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${activeTab === "renovation-visualizer" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setActiveTab("renovation-visualizer")} role="tab" type="button">AI Renovation Studio</button>
        </div>
        {activeTab === "details" ? <div className="space-y-7 px-5 py-6 sm:px-8 sm:py-8">
          <div className="grid gap-3 sm:grid-cols-2">
            {result.images.length > 0 ? result.images.map((image, index) => <div className={`relative aspect-[4/3] overflow-hidden rounded-xl bg-muted ${index === 0 ? "sm:col-span-2" : ""}`} key={image}><Image fill unoptimized alt={`${title} — zdjęcie ${index + 1}`} className="object-cover" sizes="(max-width: 640px) 100vw, 50vw" src={image} /></div>) : <div className="flex aspect-[16/9] items-center justify-center rounded-xl bg-muted text-sm text-muted-foreground sm:col-span-2">Brak zdjęć</div>}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="col-span-2 rounded-xl bg-foreground px-4 py-4 text-background"><p className="text-xs font-medium text-background/65">Cena</p><p className="mt-1 text-2xl font-bold leading-none tracking-tight">{currency(result.price)}</p><p className="mt-2 text-sm font-medium text-background/70">{currencyPerSqm(result.pricePerSqm)}</p></div>
            <div className="rounded-xl border border-border/70 bg-muted/30 p-4"><p className="text-xs text-muted-foreground">Powierzchnia</p><p className="mt-1 font-semibold tracking-tight">{measure(result.area, "m²")}</p></div>
            <div className="rounded-xl border border-border/70 bg-muted/30 p-4"><p className="text-xs text-muted-foreground">Pokoje</p><p className="mt-1 font-semibold tracking-tight">{measure(result.rooms, "pok.")}</p></div>
          </div>
          <div className="rounded-xl border border-border/70 bg-muted/20 p-4 sm:p-5"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Opis ogłoszenia</p><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground/80">{formatListingDescription(result.description) || "Brak opisu ogłoszenia."}</p></div>
          <div className="grid gap-3 rounded-xl bg-muted/40 p-4 text-sm sm:grid-cols-2"><Metric label="Piętro" value={result.floor ?? "—"} /><Metric label="Liczba pięter" value={result.totalFloors ?? "—"} /><Metric label="Typ budynku" value={result.buildingType ?? "—"} /><Metric label="Własność" value={result.ownership ?? "—"} /></div>
          <DetailList label="Powody dopasowania" values={result.matchReasons} empty="Brak dodatkowych danych." />
          <DetailList label="Do weryfikacji" values={result.unknownFields} empty="Brak." />
          <DetailList label="Atuty Flip Score" values={flipScore.reasons} empty="Brak punktów dodatnich." />
          <DetailList label="Ryzyka Flip Score" values={flipScore.risks} empty="Nie wykryto ryzyk." />
          <div className="grid gap-3 border-t border-border/70 pt-6 sm:grid-cols-3">
            <Button className="h-11 rounded-xl font-semibold" disabled={crmImporting} onClick={importToCrm} type="button" variant="outline"><Plus aria-hidden="true" className="size-4" />{crmImporting ? "Dodawanie..." : "Dodaj do CRM"}</Button>
            <Button className="h-11 rounded-xl font-semibold" onClick={() => setActiveTab("analysis")} type="button" variant="outline"><BrainCircuit aria-hidden="true" className="size-4" />Analiza AI</Button>
            <Button nativeButton={false} className="h-11 rounded-xl font-semibold shadow-sm" render={<a href={result.originalUrl} rel="noopener noreferrer" target="_blank" />} variant="default"><ExternalLink aria-hidden="true" className="size-4" />Otwórz ogłoszenie</Button>
          </div>
        </div> : activeTab === "calculator" ? <div className="space-y-6 px-5 py-6 sm:px-8 sm:py-8">
          <div><p className="text-lg font-bold tracking-tight">Kalkulator flipa</p><p className="mt-1 text-sm text-muted-foreground">Modeluj koszty i potencjalny zwrot z inwestycji.</p></div>
          <div className="grid gap-4 lg:grid-cols-3">
            <section className="rounded-2xl border border-border/70 bg-muted/20 p-4"><h3 className="text-sm font-bold">Zakup</h3><div className="mt-4 space-y-3"><CalculatorInput label="Cena zakupu" value={calculator.purchasePrice} onChange={(value) => setCalculatorValue("purchasePrice", value)} /><CalculatorComputed label="PCC 2%" value={calculatorCurrency(purchaseTax)} /><CalculatorInput label="Notariusz" value={calculator.notary} onChange={(value) => setCalculatorValue("notary", value)} /><CalculatorInput label="Prowizja zakupu" value={calculator.purchaseCommission} onChange={(value) => setCalculatorValue("purchaseCommission", value)} /></div></section>
            <section className="rounded-2xl border border-border/70 bg-muted/20 p-4"><h3 className="text-sm font-bold">Remont</h3><div className="mt-4 space-y-3"><CalculatorInput label="Koszt remontu" value={calculator.renovation} onChange={(value) => setCalculatorValue("renovation", value)} /><CalculatorInput label="Umeblowanie" value={calculator.furnishing} onChange={(value) => setCalculatorValue("furnishing", value)} /><CalculatorInput label="Rezerwa" value={calculator.reserve} onChange={(value) => setCalculatorValue("reserve", value)} /></div></section>
            <section className="rounded-2xl border border-border/70 bg-muted/20 p-4"><h3 className="text-sm font-bold">Sprzedaż</h3><div className="mt-4 space-y-3"><CalculatorInput label="Cena sprzedaży" value={calculator.salePrice} onChange={(value) => setCalculatorValue("salePrice", value)} /><CalculatorInput label="Prowizja sprzedaży" value={calculator.saleCommission} onChange={(value) => setCalculatorValue("saleCommission", value)} /><CalculatorInput label="Podatek" value={calculator.tax} onChange={(value) => setCalculatorValue("tax", value)} /></div></section>
          </div>
          <div className="grid gap-2 rounded-2xl bg-foreground p-3 text-background sm:grid-cols-3 lg:grid-cols-6 sm:p-5"><CalculatorResult label="Koszt zakupu" value={calculatorCurrency(purchaseCost)} /><CalculatorResult label="Koszt całkowity" value={calculatorCurrency(totalCost)} /><CalculatorResult label="Przychód" value={calculatorCurrency(revenue)} /><CalculatorResult label="Zysk netto" tone={profit >= 0 ? "positive" : "negative"} value={calculatorCurrency(profit)} /><CalculatorResult label="ROI" tone={roiTone(roi)} value={percentage(roi)} /><CalculatorResult label="Marża" tone={profit >= 0 ? "positive" : "negative"} value={percentage(margin)} /></div>
        </div> : activeTab === "price-history" ? <PriceHistoryPanel error={priceHistoryError} history={priceHistory} loading={priceHistoryLoading} /> : activeTab === "market" ? <MarketIntelligencePanel calculatorCosts={{ renovationCost: calculator.renovation, furnishingCost: calculator.furnishing, reserveCost: calculator.reserve, notaryCost: calculator.notary, purchaseCommission: calculator.purchaseCommission, saleCommission: calculator.saleCommission, taxCost: calculator.tax }} data={marketIntelligence} error={marketIntelligenceError} loading={marketIntelligenceLoading} onTargetProfitChange={setTargetProfit} onTargetRoiChange={setTargetRoi} targetProfit={targetProfit} targetRoi={targetRoi} /> : activeTab === "renovation-visualizer" ? <RenovationVisualizer images={result.images} onApplyRenovationCost={(value) => setCalculator((current) => ({ ...current, renovation: value }))} propertyContext={{ propertyId: result.id, title: result.title, area: result.area, rooms: result.rooms, address: result.address, buildingType: result.buildingType }} /> : <div className="space-y-6 px-5 py-6 sm:px-8 sm:py-8">
          <div className="rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-500/[0.10] via-card to-card p-5"><div className="flex items-start justify-between gap-4"><div><p className="text-lg font-bold tracking-tight">Analiza AI</p><p className="mt-1 text-sm leading-6 text-muted-foreground">Regułowa analiza potencjału inwestycyjnego — bez użycia modelu AI.</p></div><div className="rounded-xl bg-violet-500/15 px-3 py-2 text-right text-violet-700 dark:text-violet-300"><p className="text-[10px] font-semibold uppercase tracking-[0.12em]">Pewność</p><p className="text-xl font-bold leading-none">{analysis.confidence}%</p></div></div><p className="mt-5 text-sm leading-6 text-foreground/85">{analysis.summary}</p></div>
          <div className="grid gap-4 lg:grid-cols-2"><AnalysisList accent="emerald" label="Mocne strony" values={analysis.strengths} empty="Brak wyraźnych atutów na podstawie dostępnych danych." /><AnalysisList accent="amber" label="Słabe strony" values={analysis.weaknesses} empty="Nie wykryto słabych stron." /><AnalysisList accent="rose" label="Ryzyka" values={analysis.risks} empty="Nie wykryto istotnych ryzyk." /><AnalysisList accent="violet" label="Rekomendacje" values={analysis.recommendations} empty="Brak rekomendacji." /></div>
          <div className="grid gap-3 rounded-2xl bg-foreground p-4 text-background sm:grid-cols-2"><CalculatorResult label="Szacowany remont" value={`${calculatorCurrency(analysis.estimatedRenovation.min)} – ${calculatorCurrency(analysis.estimatedRenovation.max)}`} /><CalculatorResult label="Szacowany zysk" tone={analysis.estimatedProfit !== null && analysis.estimatedProfit >= 0 ? "positive" : analysis.estimatedProfit !== null ? "negative" : "neutral"} value={analysis.estimatedProfit === null ? "Brak danych" : calculatorCurrency(analysis.estimatedProfit)} /></div>
        </div>}
        {crmToast ? <div aria-live="polite" className="fixed bottom-5 left-1/2 z-[60] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-xl border border-emerald-500/20 bg-foreground px-4 py-3 text-sm font-medium text-background shadow-xl shadow-black/20"><span className="mr-2 inline-block size-2 rounded-full bg-emerald-400" />{crmToast}</div> : null}
      </DialogContent>
    </Dialog>
  );
}

function Placeholder() { return <div className="flex size-full items-center justify-center text-sm text-muted-foreground">Brak zdjęcia</div>; }
function PriceHistoryPanel({ history, loading, error }: { history: PriceHistoryResponse | null; loading: boolean; error: string | null }) {
  if (loading) return <div className="px-5 py-8 text-sm text-muted-foreground sm:px-8">Ładowanie historii ceny…</div>;
  if (error) return <div className="px-5 py-8 sm:px-8"><p className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">{error}</p></div>;
  if (!history) return null;

  const previousPrice = [...history.history].reverse().find((entry) => entry.price !== null && entry.price !== history.currentPrice)?.price ?? null;
  const difference = history.currentPrice !== null && previousPrice !== null ? history.currentPrice - previousPrice : null;
  const percentageDifference = difference !== null && previousPrice !== null && previousPrice > 0 ? difference / previousPrice * 100 : null;
  const observations = history.history.filter((entry): entry is { price: number; capturedAt: string } => entry.price !== null).map((entry) => ({ price: entry.price, label: dateTime(entry.capturedAt) }));
  if (history.currentPrice !== null && observations.at(-1)?.price !== history.currentPrice) observations.push({ price: history.currentPrice, label: "Teraz" });

  return <div className="space-y-6 px-5 py-6 sm:px-8 sm:py-8">
    <div><p className="text-lg font-bold tracking-tight">Historia ceny</p><p className="mt-1 text-sm text-muted-foreground">Zmiany zapisane podczas kolejnych odczytów oferty.</p></div>
    <div className="grid gap-3 sm:grid-cols-4">
      <PriceMetric label="Obecna cena" value={currency(history.currentPrice)} />
      <PriceMetric label="Poprzednia cena" value={currency(previousPrice)} />
      <PriceMetric label="Różnica" tone={difference === null ? "neutral" : difference < 0 ? "down" : difference > 0 ? "up" : "neutral"} value={difference === null ? "—" : signedCurrency(difference)} />
      <PriceMetric label="Zmiana" tone={percentageDifference === null ? "neutral" : percentageDifference < 0 ? "down" : percentageDifference > 0 ? "up" : "neutral"} value={percentageDifference === null ? "—" : signedPercentage(percentageDifference)} />
    </div>
    {observations.length === 0 ? <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">Brak cen do pokazania w historii tej oferty.</div> : <PriceHistoryChart points={observations} />}
    {history.history.length === 0 ? <p className="text-sm text-muted-foreground">Brak zapisanych snapshotów. Wykres pokazuje wyłącznie bieżącą cenę.</p> : <ol className="divide-y rounded-xl border border-border/70 text-sm">{[...history.history].reverse().map((entry) => <li className="flex items-center justify-between gap-4 px-4 py-3" key={entry.capturedAt}><span className="text-muted-foreground">{dateTime(entry.capturedAt)}</span><span className="font-semibold">{currency(entry.price)}</span></li>)}</ol>}
  </div>;
}
function PriceMetric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "down" | "up" }) { const toneClass = tone === "down" ? "border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300" : tone === "up" ? "border-rose-500/30 bg-rose-500/[0.07] text-rose-700 dark:text-rose-300" : "border-border/70 bg-muted/20"; return <div className={`rounded-xl border p-4 ${toneClass}`}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-lg font-bold tracking-tight">{value}</p></div>; }
function PriceHistoryChart({ points }: { points: Array<{ price: number; label: string }> }) { const width = 640; const height = 220; const padding = 28; const prices = points.map((point) => point.price); const min = Math.min(...prices); const max = Math.max(...prices); const range = max - min || 1; const coordinates = points.map((point, index) => ({ ...point, x: points.length === 1 ? width / 2 : padding + index * (width - padding * 2) / (points.length - 1), y: height - padding - (point.price - min) / range * (height - padding * 2) })); const line = coordinates.map((point) => `${point.x},${point.y}`).join(" "); return <section className="ui-chart p-4"><div className="mb-3 flex items-baseline justify-between gap-3"><p className="text-sm font-semibold">Zmiana ceny w czasie</p><p className="text-xs text-muted-foreground">{currency(min)} – {currency(max)}</p></div><svg aria-label="Wykres historii ceny" className="h-auto w-full" role="img" viewBox={`0 0 ${width} ${height}`}><line stroke="currentColor" className="text-border" strokeWidth="1" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} /><polyline fill="none" points={line} stroke="currentColor" className="text-primary" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />{coordinates.map((point) => <circle className="fill-primary stroke-card" cx={point.x} cy={point.y} key={`${point.label}-${point.x}`} r="5" strokeWidth="3"><title>{`${point.label}: ${currency(point.price)}`}</title></circle>)}</svg><div className="mt-2 flex justify-between gap-4 text-xs text-muted-foreground"><span>{points[0]?.label}</span><span>{points.at(-1)?.label}</span></div></section>; }
function CalculatorInput({ label, value, onChange }: { label: string; value: number; onChange: (value: string) => void }) { return <label className="block"><span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span><div className="relative"><Input className="h-10 rounded-lg bg-background pr-10 text-sm" min="0" onChange={(event) => onChange(event.target.value)} step="any" type="number" value={value || ""} /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">zł</span></div></label>; }
function CalculatorComputed({ label, value }: { label: string; value: string }) { return <div><span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span><div className="flex h-10 items-center rounded-lg border border-border/70 bg-muted/50 px-3 text-sm font-semibold">{value}</div></div>; }
function CalculatorResult({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "negative" | "warning" | "positive" }) { const toneClass = tone === "positive" ? "bg-emerald-400/15 text-emerald-200" : tone === "negative" ? "bg-rose-400/15 text-rose-200" : tone === "warning" ? "bg-amber-400/15 text-amber-100" : ""; return <div className={`rounded-xl p-3 ${toneClass}`}><p className="text-xs font-medium text-background/60">{label}</p><p className="mt-1 text-lg font-bold tracking-tight">{value}</p></div>; }
function AnalysisList({ label, values, empty, accent }: { label: string; values: string[]; empty: string; accent: "emerald" | "amber" | "rose" | "violet" }) { const accentClass = accent === "emerald" ? "border-emerald-500/20 bg-emerald-500/[0.05]" : accent === "amber" ? "border-amber-500/20 bg-amber-500/[0.05]" : accent === "rose" ? "border-rose-500/20 bg-rose-500/[0.05]" : "border-violet-500/20 bg-violet-500/[0.05]"; return <section className={`rounded-2xl border p-4 ${accentClass}`}><h3 className="text-sm font-bold">{label}</h3><ul className="mt-3 space-y-2 text-sm leading-5 text-foreground/80">{values.length ? values.map((value) => <li className="flex gap-2" key={value}><span className="mt-2 size-1.5 shrink-0 rounded-full bg-current/70" />{value}</li>) : <li className="text-muted-foreground">{empty}</li>}</ul></section>; }
function SourceCount({ label, value, active, onClick }: { label: string; value: number; active: boolean; onClick: () => void }) { return <button aria-pressed={active} className={`min-h-11 rounded-xl border px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary ${active ? "bg-primary text-primary-foreground" : "bg-card"}`} onClick={onClick} type="button">{label}: {value}</button>; }
function countSources(results: FilterResult[]): Record<FilterResult["source"], number> { return results.reduce((counts, result) => ({ ...counts, [result.source]: counts[result.source] + 1 }), { otodom: 0, olx: 0, morizon: 0, facebook: 0 }); }
function Metric({ label, value }: { label: string; value: string }) { return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-0.5 truncate font-medium">{value}</p></div>; }
function DetailList({ label, values, empty }: { label: string; values: string[]; empty: string }) { return <div className="mt-4 text-sm"><p className="font-medium">{label}</p><p className="mt-1 text-muted-foreground">{values.length ? values.join(", ") : empty}</p></div>; }
function SourceBadge({ source }: { source: FilterResult["source"] }) { return <span className="rounded-full border border-border/60 bg-background/90 px-2.5 py-1 text-xs font-semibold shadow-sm backdrop-blur">{source === "otodom" ? "Otodom" : source === "olx" ? "OLX" : source === "morizon" ? "Morizon" : "Facebook"}</span>; }
function StatusBadge({ status }: { status: FilterResult["listingStatus"] }) { return <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/90 px-2.5 py-1 text-xs font-semibold text-white shadow-sm backdrop-blur"><span className="size-1.5 rounded-full bg-white/90" />{status === "active" ? "Aktywna" : status === "removed" ? "Usunięta" : status === "sold" ? "Sprzedana" : "Obserwowana"}</span>; }
function Badge({ label }: { label: string }) { return <span className="rounded-full bg-background/90 px-2.5 py-1 text-xs font-semibold text-foreground shadow-sm backdrop-blur">{label}</span>; }
function LifecycleBadge({ status }: { status: FilterResult["lifecycleStatus"] }) { const label = status === "REVIEW" ? "DO OCENY" : status === "STALE" ? "NIEAKTUALNA" : status === "ARCHIVED" ? "ARCHIWALNA" : status === "REJECTED" ? "ODRZUCONA" : "AKTYWNA"; return <span className="rounded-full border border-border/60 bg-background/90 px-2.5 py-1 text-xs font-semibold shadow-sm backdrop-blur">{label}</span>; }
function calculatorCurrency(value: number): string { return new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value); }
function signedCurrency(value: number): string { return `${value > 0 ? "+" : ""}${calculatorCurrency(value)}`; }
function percentage(value: number): string { return `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 }).format(value)}%`; }
function signedPercentage(value: number): string { return `${value > 0 ? "+" : ""}${percentage(value)}`; }
function roiTone(value: number): "negative" | "warning" | "positive" { return value < 10 ? "negative" : value <= 20 ? "warning" : "positive"; }
function currency(value: number | null): string { return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value) : "—"; }
function currencyPerSqm(value: number | null): string { const formatted = currency(value); return formatted === "—" ? formatted : `${formatted}/m²`; }
function measure(value: number | null, unit: string): string { return typeof value === "number" && Number.isFinite(value) && value > 0 ? `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 }).format(value)} ${unit}` : "—"; }
function dateTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short" }).format(date); }
async function readJson(response: Response): Promise<unknown> { try { return await response.json(); } catch { return null; } }
function readMessage(value: unknown, fallback: string): string { return value !== null && typeof value === "object" && "message" in value && typeof value.message === "string" && value.message.trim() ? value.message : fallback; }
function isUpdatedPropertyImport(value: unknown): boolean { return value !== null && typeof value === "object" && "status" in value && value.status === "updated"; }
function isPropertyImportResponse(value: unknown): value is { status: "created" | "updated"; propertyId: string } { return value !== null && typeof value === "object" && "status" in value && (value.status === "created" || value.status === "updated") && "propertyId" in value && typeof value.propertyId === "string" && value.propertyId.trim().length > 0; }
function isPriceHistoryResponse(value: unknown): value is PriceHistoryResponse { return value !== null && typeof value === "object" && "listingId" in value && typeof value.listingId === "string" && "currentPrice" in value && (value.currentPrice === null || typeof value.currentPrice === "number") && "history" in value && Array.isArray(value.history) && value.history.every((entry) => entry !== null && typeof entry === "object" && "price" in entry && (entry.price === null || typeof entry.price === "number") && "capturedAt" in entry && typeof entry.capturedAt === "string"); }
function isMarketIntelligence(value: unknown): value is MarketIntelligence { return value !== null && typeof value === "object" && "listingId" in value && typeof value.listingId === "string" && "comparableCount" in value && typeof value.comparableCount === "number" && "comparables" in value && Array.isArray(value.comparables) && "currentPricePerSqm" in value && (value.currentPricePerSqm === null || typeof value.currentPricePerSqm === "number"); }
function isResultsResponse(value: unknown): value is ResultsResponse { return value !== null && typeof value === "object" && "filter" in value && "results" in value && Array.isArray(value.results) && "total" in value && typeof value.total === "number" && "newMatches" in value && typeof value.newMatches === "number" && "lastScan" in value && "sourceScans" in value && Array.isArray(value.sourceScans); }
