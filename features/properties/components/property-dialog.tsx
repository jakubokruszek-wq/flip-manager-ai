"use client";

import Image from "next/image";
import Link from "next/link";
import type { ReactElement } from "react";
import {
  BrainCircuit,
  ArrowLeft,
  CalendarClock,
  CheckSquare,
  FileText,
  ExternalLink,
  MapPin,
  Sparkles,
  TrendingUp,
  WalletCards,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PropertyDeleteControl } from "@/features/properties/components/property-delete-control";
import { PropertyEditDialog } from "@/features/properties/components/property-edit-dialog";
import { analyzeProperty } from "@/features/ai-analysis/analyze-property";
import { calculateFlipScore } from "@/features/flip-score/calculate-flip-score";
import { formatListingDescription } from "@/lib/listing-description";
import type { Property, PropertyWithInvestmentAnalysis } from "@/features/properties/types";
import type { FlipScoreResult } from "@/features/properties/types/property";
import type { MarketIntelligence } from "@/features/market-intelligence/types";
import {
  formatCurrency,
  formatDate,
  formatFlipScore,
  formatPercent,
} from "@/features/properties/utils/format";

type PropertyDialogProps = {
  property: PropertyWithInvestmentAnalysis;
  trigger: ReactElement;
  onDeleted?: () => void;
  onUpdated?: () => void;
};

export function PropertyDialog({ property, trigger, onDeleted, onUpdated }: PropertyDialogProps) {
  const title = property.title ?? property.address;
  const location = [property.address, property.district, property.city]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(", ");
  const calculatedScore = calculateFlipScore({
    price: property.price,
    pricePerSqm: property.pricePerSqm,
    averagePricePerSqm: property.averagePricePerSqm,
    rooms: property.rooms,
    area: property.area,
    marketType: property.marketType,
    title: property.title,
    description: property.description,
  });
  const calculatedAnalysis = analyzeProperty({
    price: property.price,
    pricePerSqm: property.pricePerSqm,
    averagePricePerSqm: property.averagePricePerSqm,
    area: property.area,
    rooms: property.rooms,
    floor: property.floor,
    marketType: property.marketType,
    title: property.title,
    description: property.description,
    flipScore: property.flipScore ?? calculatedScore.score,
  });
  const score = property.investmentAnalysis?.flipScore ?? calculatedScore;
  const analysis = property.investmentAnalysis?.aiAnalysis ?? calculatedAnalysis;
  const investmentAnalysis = property.investmentAnalysis;

  return (
    <Dialog>
      <DialogTrigger render={trigger} />
      <DialogContent className="left-0 top-0 h-dvh max-h-none max-w-none translate-x-0 translate-y-0 gap-0 overflow-x-hidden overflow-y-auto rounded-none border-border/70 bg-card p-0 shadow-2xl shadow-black/20 sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[calc(100dvh-1.5rem)] sm:max-w-6xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl">
        <header className="relative overflow-hidden border-b border-border/70 bg-gradient-to-br from-primary/[0.13] via-card to-card px-5 pb-6 pt-7 sm:px-8 sm:pb-8 sm:pt-10">
          <div className="absolute -right-24 -top-28 size-72 rounded-full bg-primary/10 blur-3xl" />
          <div className="relative flex flex-col gap-5 pr-8 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary"><Sparkles className="size-3.5" />Dashboard inwestycji</p>
              <DialogTitle className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</DialogTitle>
              <DialogDescription className="mt-3 flex items-center gap-2 text-sm"><MapPin className="size-4 shrink-0" />{location || "Lokalizacja nie została uzupełniona"}</DialogDescription>
            </div>
            <div className="rounded-2xl border border-primary/20 bg-card/85 px-5 py-4 text-center shadow-lg shadow-primary/5 backdrop-blur"><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Flip Score</p><p className="mt-1 text-3xl font-bold tracking-tight text-primary">{formatFlipScore(property.flipScore ?? score.score)}</p><p className="mt-1 text-xs font-semibold text-muted-foreground">{score.label}</p></div>
          </div>
        </header>

        <div className="space-y-8 px-5 py-6 sm:px-8 sm:py-8">
          <PropertyHero property={property} score={score} title={title} location={location} onDeleted={onDeleted} onUpdated={onUpdated} />
          <DashboardSection icon={FileText} title="Galeria zdjęć">
            {property.images.length ? <div className="grid gap-3 sm:grid-cols-3">{property.images.slice(0, 6).map((image, index) => <div className={`relative aspect-[4/3] overflow-hidden rounded-2xl bg-muted ${index === 0 ? "sm:col-span-2 sm:row-span-2" : ""}`} key={image}><Image fill unoptimized alt={`${title} — zdjęcie ${index + 1}`} className="object-cover transition-transform duration-500 hover:scale-105" sizes="(max-width: 640px) 100vw, 50vw" src={image} /></div>)}</div> : <EmptyState text="Brak zdjęć nieruchomości. Zdjęcia pojawią się tutaj po imporcie lub dodaniu do rekordu." />}
          </DashboardSection>

          <div className="grid gap-8 xl:grid-cols-2">
            <DashboardSection icon={MapPin} title="Podstawowe informacje">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3"><InfoMetric label="Cena" value={formatCurrency(property.price)} /><InfoMetric label="Cena / m²" value={formatCurrency(property.pricePerSqm)} /><InfoMetric label="Powierzchnia" value={metric(property.area, "m²")} /><InfoMetric label="Pokoje" value={metric(property.rooms, "")} /><InfoMetric label="Piętro" value={property.floor ?? "—"} /><InfoMetric label="Typ budynku" value={property.buildingType ?? "—"} /><InfoMetric label="Własność" value={property.ownership ?? "—"} /><InfoMetric label="Czynsz" value={formatCurrency(property.rent)} /><InfoMetric label="Status" value={statusLabel(property.status)} /></div>
            </DashboardSection>
            <DashboardSection icon={Sparkles} title="Flip Score">
              <div className="grid gap-4 sm:grid-cols-[auto_1fr]"><div className="flex size-24 items-center justify-center rounded-2xl bg-primary text-3xl font-bold text-primary-foreground shadow-lg shadow-primary/20">{formatFlipScore(property.flipScore ?? score.score)}</div><div><p className="font-semibold">{score.label}</p><p className="mt-1 text-sm leading-6 text-muted-foreground">{score.reasons.length ? score.reasons.join(" ") : "Brak wystarczających danych do szczegółowej oceny."}</p>{score.risks.length ? <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">Do weryfikacji: {score.risks.join(", ")}</p> : null}</div></div>
            </DashboardSection>
          </div>

          <DashboardSection icon={BrainCircuit} title="AI Analysis" subtitle={`Pewność analizy: ${analysis.confidence}%`}>
            <div className="rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-500/[0.09] to-transparent p-5"><p className="leading-7 text-foreground/85">{analysis.summary}</p><div className="mt-5 grid gap-3 sm:grid-cols-2"><AnalysisList label="Mocne strony" values={analysis.strengths} /><AnalysisList label="Ryzyka i rekomendacje" values={[...analysis.risks, ...analysis.recommendations]} /></div></div>
          </DashboardSection>

          <div className="grid gap-3 sm:grid-cols-3">
            <AnalysisList label="Słabe strony" values={analysis.weaknesses} />
            <AnalysisList label="Ryzyka" values={analysis.risks} />
            <AnalysisList label="Rekomendacje" values={analysis.recommendations} />
          </div>

          <DashboardSection icon={TrendingUp} title="Analiza inwestycyjna" subtitle={investmentAnalysis ? `Wykonana: ${formatDate(investmentAnalysis.analyzedAt)}` : undefined}>
            {investmentAnalysis ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><InfoMetric label="Flip Score" value={formatFlipScore(investmentAnalysis.flipScore.score)} emphasis /><InfoMetric label="Decyzja zakupu" value={decisionLabel(investmentAnalysis.purchaseRecommendation.decision)} emphasis /><InfoMetric label="Maksymalna cena" value={formatCurrency(investmentAnalysis.purchaseRecommendation.recommendedMaxPrice)} /><InfoMetric label="Cel negocjacyjny" value={formatCurrency(investmentAnalysis.purchaseRecommendation.negotiationTarget)} /><InfoMetric label="Wycena po remoncie" value={formatCurrency(investmentAnalysis.marketIntelligence.estimatedAfterRenovationPrice)} /><InfoMetric label="Zysk" value={formatCurrency(investmentAnalysis.calculator.profit)} emphasis /><InfoMetric label="ROI" value={formatPercent(investmentAnalysis.calculator.roi)} emphasis /><InfoMetric label="Pewność" value={`${investmentAnalysis.aiAnalysis.confidence}%`} /></div> : <EmptyState text="Analiza inwestycyjna nie została jeszcze zapisana. Dodaj ofertę z Flip Finder po wykonaniu analizy." />}
          </DashboardSection>

          <DashboardSection icon={TrendingUp} title="Rynek">
            {investmentAnalysis ? <MarketMetrics market={investmentAnalysis.marketIntelligence} /> : <EmptyState text="Brak zapisanej analizy rynku. Wykonaj analizę inwestycyjną, aby zobaczyć porównanie z ulicą i dzielnicą." />}
          </DashboardSection>

          <DashboardSection icon={WalletCards} title="Kalkulator">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><InfoMetric label="Zakup" value={formatCurrency(property.purchasePrice)} /><InfoMetric label="Remont" value={formatCurrency(property.renovationCost)} /><InfoMetric label="Sprzedaż" value={formatCurrency(property.expectedSalePrice)} /><InfoMetric label="Zysk" value={formatCurrency(property.profit)} emphasis /><InfoMetric label="Koszt całkowity" value={formatCurrency(property.totalCost)} /><InfoMetric label="Przychód" value={formatCurrency(property.revenue)} /><InfoMetric label="ROI" value={formatPercent(property.roi)} emphasis /><InfoMetric label="Marża" value={formatPercent(property.margin)} /></div>
          </DashboardSection>

          <div className="grid gap-8 xl:grid-cols-2">
            <DashboardSection icon={CalendarClock} title="Historia ceny">
              <div className="rounded-2xl border border-dashed border-border/80 bg-muted/20 p-5"><p className="text-2xl font-bold tracking-tight">{formatCurrency(property.price)}</p><p className="mt-2 text-sm leading-6 text-muted-foreground">Brak zapisanej historii zmian ceny dla tej nieruchomości. Po dodaniu obserwacji pojawi się tutaj wykres i porównanie cen.</p><div className="mt-5 h-16 rounded-xl border border-dashed border-border/70 bg-gradient-to-r from-transparent via-primary/10 to-transparent" /></div>
            </DashboardSection>
            <DashboardSection icon={CalendarClock} title="Oś czasu zmian">
              <PropertyTimeline property={property} />
            </DashboardSection>
          </div>

          <div className="grid gap-8 xl:grid-cols-3">
            <DashboardSection icon={FileText} title="Notatki"><p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{formatListingDescription(property.description) || "Brak notatek dla tej nieruchomości."}</p></DashboardSection>
            <DashboardSection icon={FileText} title="Dokumenty"><EmptyState compact text="Nie dodano jeszcze dokumentów." /></DashboardSection>
            <DashboardSection icon={CheckSquare} title="Zadania"><EmptyState compact text="Brak zadań przypisanych do inwestycji." /></DashboardSection>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PropertyHero({ property, score, title, location, onDeleted, onUpdated }: { property: PropertyWithInvestmentAnalysis; score: FlipScoreResult; title: string; location: string; onDeleted?: () => void; onUpdated?: () => void }) {
  const heroImage = property.imageUrl ?? property.images[0] ?? null;
  return <section className="ui-card overflow-hidden"><div className="grid lg:grid-cols-[minmax(15rem,0.75fr)_1.25fr]"><div className="relative min-h-60 bg-surface-elevated">{heroImage ? <Image alt={`Zdjęcie główne: ${title}`} className="object-cover" fill sizes="(max-width: 1024px) 100vw, 42vw" src={heroImage} unoptimized /> : <div className="flex h-full min-h-60 items-center justify-center bg-gradient-to-br from-surface-hover to-surface text-sm text-muted-foreground">Brak zdjęcia głównego</div>}<div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/65 to-transparent" /></div><div className="flex flex-col p-5 sm:p-7"><div className="flex flex-wrap gap-2"><span className="ui-badge border-gold/25 bg-gold/10 text-gold">{sourceLabel(property.source)}</span><span className="ui-badge">{statusLabel(property.status)}</span></div><h1 className="mt-4 font-heading text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1><p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><MapPin className="size-4" />{location || "Lokalizacja nieuzupełniona"}</p><div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3"><InfoMetric label="Cena" value={formatCurrency(property.price)} emphasis /><InfoMetric label="Cena / m²" value={formatCurrency(property.pricePerSqm)} /><InfoMetric label="Flip Score" value={formatFlipScore(property.flipScore ?? score.score)} emphasis /></div><div className="mt-6 flex flex-wrap gap-2">{onUpdated ? <PropertyEditDialog property={property} onUpdated={onUpdated} /> : null}{property.originalUrl ? <Button nativeButton={false} render={<a href={property.originalUrl} rel="noreferrer" target="_blank" />} size="sm" variant="outline"><ExternalLink className="size-3.5" />Otwórz ogłoszenie</Button> : null}<Button nativeButton={false} render={<Link href="/properties" />} size="sm" variant="outline"><ArrowLeft className="size-3.5" />Powrót do listy</Button>{onDeleted ? <PropertyDeleteControl propertyId={property.id} onDeleted={onDeleted} /> : null}</div></div></div></section>;
}

function MarketMetrics({ market }: { market: MarketIntelligence }) { return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><InfoMetric label="Średnia ulicy" value={formatCurrency(market.streetAverage)} /><InfoMetric label="Średnia dzielnicy" value={formatCurrency(market.districtAverage)} /><InfoMetric label="Mediana" value={formatCurrency(market.median)} /><InfoMetric label="Percentyl" value={market.percentile === null ? "—" : `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(market.percentile)}%`} emphasis /><InfoMetric label="Liczba porównań" value={String(market.comparableCount)} /><InfoMetric label="Różnica względem rynku" value={signedCurrency(market.priceDifference)} /></div>; }

function DashboardSection({ title, icon: Icon, subtitle, children }: { title: string; icon: typeof Sparkles; subtitle?: string; children: React.ReactNode }) { return <section className="ui-section"><div className="mb-4 flex items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-base font-bold tracking-tight"><span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="size-4" /></span>{title}</h2>{subtitle ? <span className="text-xs font-medium text-muted-foreground">{subtitle}</span> : null}</div>{children}</section>; }
function InfoMetric({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) { return <div className={`ui-metric ${emphasis ? "border-primary/20 bg-primary/[0.06]" : ""}`}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 truncate font-semibold tracking-tight">{value}</p></div>; }
function EmptyState({ text, compact = false }: { text: string; compact?: boolean }) { return <div className={`flex items-center rounded-2xl border border-dashed border-border/80 bg-muted/20 text-sm leading-6 text-muted-foreground ${compact ? "min-h-24 p-4" : "min-h-36 justify-center p-6 text-center"}`}>{text}</div>; }
function AnalysisList({ label, values }: { label: string; values: string[] }) { return <div className="rounded-xl bg-card/70 p-4"><p className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">{label}</p><ul className="mt-3 space-y-2 text-sm leading-5 text-foreground/80">{values.length ? values.slice(0, 3).map((value) => <li className="flex gap-2" key={value}><span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />{value}</li>) : <li className="text-muted-foreground">Brak danych do wskazania elementów.</li>}</ul></div>; }
type TimelineEvent = { id: string; title: string; detail: string; occurredAt: string | null; tone: "primary" | "emerald" | "violet" | "amber" | "muted" };
function PropertyTimeline({ property }: { property: Property }) {
  const hasCalculatorData = [property.purchasePrice, property.renovationCost, property.expectedSalePrice, property.totalCost, property.profit].some((value) => value !== null);
  const events: TimelineEvent[] = [
    { id: "crm", title: "Dodano do CRM", detail: "Rekord nieruchomości został utworzony.", occurredAt: property.createdAt, tone: "primary" },
    { id: "finder", title: "Wykryto przez Flip Finder", detail: property.source ? `Źródło: ${property.source}.` : "Brak informacji o źródle wykrycia.", occurredAt: property.externalListingId ? property.firstSeenAt : null, tone: "emerald" },
    { id: "price", title: "Zarejestrowano cenę", detail: property.price !== null ? `Aktualna cena: ${formatCurrency(property.price)}.` : "Cena nie została uzupełniona.", occurredAt: property.price !== null ? property.updatedAt : null, tone: "emerald" },
    { id: "analysis", title: "Wykonano analizę", detail: "Brak zapisanego zdarzenia analizy. Wynik widoczny powyżej jest wyliczany z aktualnych danych.", occurredAt: null, tone: "violet" },
    { id: "calculator", title: "Zapisano kalkulator", detail: hasCalculatorData ? "Parametry inwestycji są dostępne w kalkulatorze." : "Brak zapisanego kalkulatora inwestycji.", occurredAt: hasCalculatorData ? property.updatedAt : null, tone: "amber" },
    { id: "note", title: "Dodano notatkę", detail: property.description ? "Notatka jest dostępna w sekcji Notatki." : "Brak zapisanych notatek.", occurredAt: property.description ? property.updatedAt : null, tone: "primary" },
    { id: "document", title: "Dodano dokument", detail: "Brak zapisanych dokumentów.", occurredAt: null, tone: "muted" },
    { id: "status", title: "Zmieniono status", detail: `Aktualny status: ${statusLabel(property.status)}.`, occurredAt: property.updatedAt, tone: "primary" },
  ];
  const datedEvents = events.filter((event): event is TimelineEvent & { occurredAt: string } => event.occurredAt !== null && !Number.isNaN(Date.parse(event.occurredAt))).sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
  const undatedEvents = events.filter((event) => !datedEvents.some((datedEvent) => datedEvent.id === event.id));

  return <div className="ui-chart p-4 sm:p-5"><ol className="space-y-5 border-l border-border pl-5">{datedEvents.map((event) => <TimelineItem event={event} key={event.id} />)}</ol>{undatedEvents.length ? <div className="mt-6 border-t border-border/70 pt-5"><p className="mb-4 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Bez daty zdarzenia</p><ol className="space-y-4 border-l border-dashed border-border pl-5">{undatedEvents.map((event) => <TimelineItem event={event} key={event.id} />)}</ol></div> : null}</div>;
}
function TimelineItem({ event }: { event: TimelineEvent }) { const toneClass = event.tone === "emerald" ? "bg-emerald-500" : event.tone === "violet" ? "bg-violet-500" : event.tone === "amber" ? "bg-amber-500" : event.tone === "muted" ? "bg-muted-foreground" : "bg-primary"; return <li className="relative"><span className={`absolute -left-[1.72rem] top-1.5 flex size-3 items-center justify-center rounded-full border-2 border-card ${toneClass}`} /><div className="rounded-xl border border-border/70 bg-card px-3.5 py-3 shadow-sm"><div className="flex items-start justify-between gap-3"><p className="font-semibold leading-5">{event.title}</p>{event.occurredAt ? <time className="shrink-0 text-xs text-muted-foreground">{formatDate(event.occurredAt)}</time> : <TrendingUp className="size-3.5 text-muted-foreground" aria-label="Brak daty" />}</div><p className="mt-1 text-sm leading-5 text-muted-foreground">{event.detail}</p></div></li>; }
function metric(value: number | null, suffix: string): string { return typeof value === "number" && Number.isFinite(value) ? `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 }).format(value)}${suffix ? ` ${suffix}` : ""}` : "—"; }
function signedCurrency(value: number | null): string { if (value === null || !Number.isFinite(value)) return "—"; const amount = formatCurrency(Math.abs(value)); return value > 0 ? `+${amount}` : value < 0 ? `−${amount}` : amount; }
function sourceLabel(value: Property["source"]): string { return value === "otodom" ? "Otodom" : value === "olx" ? "OLX" : value === "morizon" ? "Morizon" : value === "facebook" ? "Facebook" : value === "gratka" ? "Gratka" : "Źródło nieznane"; }
function statusLabel(value: Property["status"]): string { return value === "analysis" ? "Analiza" : value === "acquired" ? "Zakupiona" : value === "renovation" ? "W remoncie" : value === "listed" ? "Wystawiona" : value === "sold" ? "Sprzedana" : "Szkic"; }
function decisionLabel(value: "buy" | "negotiate" | "reject"): string { return value === "buy" ? "Kup" : value === "negotiate" ? "Negocjuj" : "Odrzuć"; }
