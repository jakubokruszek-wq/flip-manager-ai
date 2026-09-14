"use client";

import Link from "next/link";
import { ArrowLeft, ChevronRight, ExternalLink, Landmark, ShieldAlert, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { CanonicalDeal, DealFactOverrides, DirectorOutput, InformationRequest } from "../types";
import type { ValueProvenance } from "../../flip-finder/underwriting";
import { DIRECTOR_DEPENDENCIES } from "../engine";
import { formatInvestmentText, formatKnownMoneyText, formatPercentDisplay, formatPLNDisplay, pln } from "./investment-ui";
import { OverridePanel } from "./override-panel";

type RoomTab = "SUMMARY" | "MARKET" | "FINANCE" | "RENOVATION" | "RISKS" | "NEGOTIATION" | "AUDIT" | "NOTES";

const TABS: Array<{ id: RoomTab; label: string }> = [
  { id: "SUMMARY", label: "Podsumowanie" },
  { id: "MARKET", label: "Rynek" },
  { id: "FINANCE", label: "Finanse" },
  { id: "RENOVATION", label: "Remont" },
  { id: "RISKS", label: "Ryzyka" },
  { id: "NEGOTIATION", label: "Negocjacje" },
  { id: "AUDIT", label: "Źródła i audyt" },
  { id: "NOTES", label: "Notatki" },
];

const DIRECTORS = ["SCOUT", "VERIFY", "MARKET", "RENOVATION", "UNDERWRITER", "RISK / LEGAL", "CFO", "ACQUISITION", "SALE", "CEO"] as const;

export function DealRoomView({ deal, saving, onRefresh, onSave }: { deal: CanonicalDeal; saving: boolean; onRefresh: () => void; onSave: (overrides: DealFactOverrides) => Promise<void> }) {
  const [activeTab, setActiveTab] = useState<RoomTab>("SUMMARY");
  const [expandedDirector, setExpandedDirector] = useState<string | null>(null);
  const title = deal.facts.street.effectiveValue || deal.facts.district.effectiveValue || "Analizowana oferta";
  const location = [deal.facts.city.effectiveValue, deal.facts.district.effectiveValue].filter(Boolean).join(" · ");
  const sourceUrl = safeHttpUrl(deal.facts.sourceUrl.effectiveValue);
  const directorCards = useMemo(() => buildDirectorCards(deal), [deal]);
  const timeline = useMemo(() => buildTimeline(deal), [deal]);

  return <main className="mx-auto w-full max-w-[1720px] space-y-4 px-3 pb-10 pt-3 sm:px-6 lg:px-8" data-deal-room>
    <header className="border-b border-white/10 pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link className="inline-flex min-h-9 items-center gap-2 rounded-lg px-1 text-xs font-semibold text-muted-foreground outline-none transition hover:text-foreground focus-visible:ring-2 focus-visible:ring-gold" href="/flip-finder"><ArrowLeft className="size-3.5" />Flip Finder <span className="text-white/25">/</span> Oferta <span className="text-white/25">/</span> <span className="text-gold">Pokój transakcji</span></Link>
        <div className="flex flex-wrap gap-2"><StageBadge stage={deal.stage} /><Button className="min-h-9" onClick={onRefresh} size="sm" type="button" variant="outline">Odśwież analizę</Button></div>
      </div>
      <div className="mt-4 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <div aria-hidden className="grid size-[68px] shrink-0 place-items-center rounded-xl border border-gold/25 bg-[radial-gradient(circle_at_30%_20%,rgba(214,179,90,.16),transparent_54%),#13181e] text-gold shadow-[0_14px_32px_-26px_rgba(214,179,90,.95)] sm:size-[86px]"><Landmark className="size-6 sm:size-7" /></div>
          <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gold">{sourceLabel(deal.facts.source.effectiveValue)}</p><h1 className="type-page-title mt-1 break-words">{title}</h1><p className="mt-1 text-xs text-muted-foreground sm:text-sm">{location || "Lokalizacja nieustalona"} <span className="px-1.5 text-white/30">|</span> {factsSummary(deal)}</p></div>
        </div>
        <div className="flex flex-wrap gap-2 xl:justify-end">
          {sourceUrl ? <a className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-gold/35 bg-gold/[0.06] px-3 text-sm font-semibold text-gold outline-none transition hover:bg-gold/[0.12] focus-visible:ring-2 focus-visible:ring-gold" href={sourceUrl} rel="noreferrer" target="_blank">Zobacz ogłoszenie <ExternalLink className="size-4" /></a> : null}
        </div>
      </div>
    </header>

    <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section className="order-2 min-w-0 space-y-5 xl:order-1">
        <ExecutiveHero deal={deal} />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <BuyGate deal={deal} />
          <Completeness deal={deal} />
          <BiggestRisk deal={deal} />
          <NextAction deal={deal} />
        </div>
        <div className="xl:hidden"><Questions deal={deal} /></div>
        <DirectorCouncil directors={directorCards} expanded={expandedDirector} onToggle={setExpandedDirector} />
        <ScenarioAndTriggers deal={deal} />
        <DealTabs activeTab={activeTab} deal={deal} onChange={setActiveTab} />
        <OverridePanel deal={deal} disabled={saving} onSave={onSave} />
      </section>
      <aside className="order-1 min-w-0 space-y-4 xl:order-2 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto xl:pr-1">
        <CeoRail deal={deal} />
        <div className="hidden space-y-4 xl:block"><Timeline events={timeline} /><Questions deal={deal} /></div>
      </aside>
    </div>
  </main>;
}

function ExecutiveHero({ deal }: { deal: CanonicalDeal }) {
  const ceo = deal.ceo.result;
  const underwriting = deal.underwriting.result;
  const expectedProfit = ceo?.expectedProfitBase ?? underwriting?.profitBase ?? null;
  return <section aria-label="Kluczowe metryki finansowe" className="grid grid-cols-2 gap-2 sm:grid-cols-2 xl:grid-cols-5">
    <HeroMetric className="order-4 sm:order-none" label="Cena ofertowa" value={pln(deal.facts.askingPrice.effectiveValue)} />
    <HeroMetric className="order-1 col-span-2 sm:order-none sm:col-span-1" emphasis label="Maks. cena zakupu" value={pln(ceo?.maxPurchasePrice ?? underwriting?.maxPurchasePrice)} />
    <HeroMetric className="order-5 sm:order-none" label="Cel negocjacyjny" value={pln(ceo?.targetPurchasePrice ?? underwriting?.targetPurchasePrice)} />
    <HeroMetric className="order-2 sm:order-none" label="Oczekiwany zysk" negative={expectedProfit != null && expectedProfit < 0} positive={expectedProfit != null && expectedProfit >= 0} value={pln(expectedProfit)} />
    <HeroMetric className="order-3 sm:order-none" label="Zwrot z inwestycji (ROI)" value={percent(underwriting?.roiBase)} />
  </section>;
}

function BuyGate({ deal }: { deal: CanonicalDeal }) {
  const gates = deal.ceo.result?.criticalGates ?? [];
  const blocked = gates.filter((gate) => !gate.passed);
  const state = !gates.length ? "NIEPEWNY" : blocked.length ? "ZABLOKOWANY" : "OTWARTY";
  return <CompactCard icon={<ShieldCheck className="size-5" />} label="Bramka zakupu" tone={state === "OTWARTY" ? "green" : state === "ZABLOKOWANY" ? "red" : "amber"} value={state} detail={gates.length ? `${gates.length - blocked.length}/${gates.length} kryteriów potwierdzonych` : "Brak kompletnego wyniku bramki"} />;
}

function Completeness({ deal }: { deal: CanonicalDeal }) {
  const known = [deal.facts.askingPrice, deal.facts.areaM2, deal.facts.rooms, deal.facts.city, deal.facts.sourceUrl].filter((fact) => fact.effectiveValue != null).length;
  const missing = [deal.facts.askingPrice, deal.facts.areaM2, deal.facts.rooms, deal.facts.city, deal.facts.sourceUrl].filter((fact) => fact.effectiveValue == null).length;
  return <CompactCard icon={<Landmark className="size-5" />} label="Kompletność danych oferty" tone={missing ? "amber" : "green"} value={`${known}/5 danych kluczowych`} detail={missing ? `${missing} wymagają uzupełnienia` : "Kluczowe dane oferty są dostępne"} />;
}

function BiggestRisk({ deal }: { deal: CanonicalDeal }) {
  const ceo = deal.ceo.result;
  const blocked = ceo?.criticalGates.find((gate) => !gate.passed);
  const risk = ceo?.risks[0] || blocked?.reason || null;
  return <CompactCard icon={<ShieldAlert className="size-5" />} label="Największe ryzyko" tone={risk ? "red" : "amber"} value={risk ? polishRiskText(risk) : "Nie ustalono"} detail={risk ? "Na podstawie aktualnej analizy" : "Brak osobnego wyniku ryzyka"} />;
}

function NextAction({ deal }: { deal: CanonicalDeal }) {
  const ceo = deal.ceo.result;
  const action = ceo?.nextBestAction ? polishGeneratedText(ceo.nextBestAction) : null;
  return <CompactCard icon={<ChevronRight className="size-5" />} label="Następny krok" tone="gold" value={action || "Oczekuje na wynik analizy"} detail={action ? "Działanie wskazane przez bieżącą analizę" : "Nie wyznaczono jeszcze wiarygodnego następnego kroku"} />;
}

function CompactCard({ icon, label, value, detail, tone }: { icon: ReactNode; label: string; value: string; detail: string; tone: "green" | "amber" | "red" | "gold" }) {
  const toneClass = { green: "border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-300", amber: "border-amber-400/20 bg-amber-400/[0.05] text-amber-200", red: "border-red-400/20 bg-red-400/[0.05] text-red-200", gold: "border-gold/20 bg-gold/[0.05] text-gold" }[tone];
  return <section className={`min-w-0 rounded-[1.25rem] border p-4 shadow-[0_16px_38px_-30px_rgba(0,0,0,.9)] ${toneClass}`}><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.15em]"><span>{icon}</span>{label}</div><p className="mt-3 line-clamp-3 text-sm font-semibold leading-5 text-foreground">{value}</p><p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p></section>;
}

function DirectorCouncil({ directors, expanded, onToggle }: { directors: RoomDirector[]; expanded: string | null; onToggle: (value: string | null) => void }) {
  const selected = directors.find((director) => director.id === expanded) ?? null;
  return <section aria-labelledby="director-council-title" className="rounded-[1.5rem] border border-white/10 bg-[#13181e] p-4 shadow-[0_20px_50px_-38px_rgba(0,0,0,.95)] sm:p-5"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gold">Rzeczywiste wyniki analizy</p><h2 className="type-section-title mt-1" id="director-council-title">Zespół analityczny</h2></div><p className="text-xs text-muted-foreground">Kliknij kartę, aby zobaczyć dane i ograniczenia.</p></div><div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{directors.map((director) => <DirectorCard director={director} expanded={expanded === director.id} key={director.id} onToggle={() => onToggle(expanded === director.id ? null : director.id)} />)}</div>{selected ? <DirectorDetails director={selected} /> : null}</section>;
}

function DirectorCard({ director, expanded, onToggle }: { director: RoomDirector; expanded: boolean; onToggle: () => void }) {
  const status = directorStatus(director.status);
  const detailsId = `director-details-${director.id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return <article className="overflow-hidden rounded-2xl border border-white/10 bg-black/15"><button aria-controls={detailsId} aria-expanded={expanded} className="block min-h-40 w-full p-4 text-left outline-none transition hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold" id={`director-button-${detailsId}`} onClick={onToggle} type="button"><div className="flex items-start justify-between gap-2"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-foreground">{director.label}</p><p className={`mt-2 inline-flex rounded-full px-2 py-1 text-[10px] font-bold ${status.className}`}>{status.label}</p></div><ChevronRight className={`mt-1 size-4 text-gold transition-transform ${expanded ? "rotate-90" : ""}`} /></div>{director.finding ? <p className="mt-4 line-clamp-3 min-h-[3.75rem] text-xs leading-5 text-muted-foreground" data-director-collapsed-finding>{director.finding}</p> : director.status === "WAITING" ? <p className="mt-4 line-clamp-3 min-h-[3.75rem] text-xs leading-5 text-muted-foreground" data-director-collapsed-finding>Oczekuje na zapisane wyniki.</p> : null}{director.confidence != null ? <p className="mt-3 text-[10px] font-semibold text-foreground">Pewność {director.confidence}/100</p> : <p className="mt-3 text-[10px] font-semibold text-muted-foreground">Pewność nieustalona</p>}</button></article>;
}

function DirectorDetails({ director }: { director: RoomDirector }) {
  const status = directorStatus(director.status);
  return <section aria-labelledby="selected-director-title" className="mt-3 rounded-2xl border border-gold/20 bg-black/20 p-4 sm:p-5" id={`director-details-${director.id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-gold">Szczegóły wyniku</p><h3 className="mt-1 text-sm font-semibold text-foreground" id="selected-director-title">{director.label}</h3></div><div className="flex items-center gap-2"><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${status.className}`}>{status.label}</span><span className="text-xs text-muted-foreground">Pewność {director.confidence == null ? "nieustalona" : `${director.confidence}/100`}</span></div></div><div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3"><OptionalDetail title="Główny wniosek" value={director.finding} /><OptionalDetail title="Rekomendacja" value={director.recommendation} /><OptionalList title="Brakujące dane" values={director.missing} /><OptionalList title="Źródła i dowody" values={director.evidence} /><OptionalList title="Co zmieniłoby ocenę" values={director.triggers} />{director.dependencies.length ? <p className="text-xs leading-5 text-muted-foreground"><strong className="text-foreground">Zależności:</strong> {director.dependencies.join(", ")}</p> : null}</div></section>;
}

function OptionalDetail({ title, value }: { title: string; value: string | null }) { return value ? <p className="text-xs leading-5 text-muted-foreground"><strong className="text-foreground">{title}:</strong> {value}</p> : null; }
function OptionalList({ title, values }: { title: string; values: string[] }) { return values.length ? <div><p className="text-xs font-semibold text-foreground">{title}</p><ul className="mt-1 space-y-1 text-xs leading-5 text-muted-foreground">{values.map((value, index) => <li key={`${title}-${index}`}>• {value}</li>)}</ul></div> : null; }

function ScenarioAndTriggers({ deal }: { deal: CanonicalDeal }) {
  const scenarios = deal.underwriting.result?.scenarios;
  const ceo = deal.ceo.result;
  return <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,.9fr)]"><section className="rounded-[1.5rem] border border-white/10 bg-[#13181e] p-4 sm:p-5"><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gold">Deterministyczna ekonomika</p><h2 className="type-section-title mt-1">Kluczowe liczby — scenariusze</h2>{scenarios ? <div className="mt-4 grid gap-3 sm:grid-cols-3"><Scenario title="Ostrożny" scenario={scenarios.conservative} /><Scenario featured title="Bazowy" scenario={scenarios.base} /><Scenario title="Optymistyczny" scenario={scenarios.optimistic} /></div> : <EmptyState text="Scenariusze pojawią się, gdy analiza finansowa ma wystarczające dane wejściowe." />}</section><section className="rounded-[1.5rem] border border-gold/20 bg-[#181812] p-4 sm:p-5"><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gold">Decyzja warunkowa</p><h2 className="type-section-title mt-1">Co zmieni rekomendację systemu?</h2>{ceo?.conditionsToProceed.length || ceo?.walkAwayConditions.length ? <div className="mt-4 grid gap-3 sm:grid-cols-2"><TriggerList good title="Na kontynuację, jeśli" values={ceo?.conditionsToProceed ?? []} /><TriggerList title="Na odrzucenie, jeśli" values={ceo?.walkAwayConditions ?? []} /></div> : <EmptyState text="Aktualny wynik nie zawiera deterministycznych warunków zmiany rekomendacji." />}</section></div>;
}

function DealTabs({ activeTab, deal, onChange }: { activeTab: RoomTab; deal: CanonicalDeal; onChange: (tab: RoomTab) => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const currentIndex = TABS.findIndex((tab) => `deal-tab-${tab.id}` === target.id);
    if (currentIndex < 0) return;
    let nextIndex = currentIndex;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex + TABS.length - 1) % TABS.length;
    else if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;
    else return;
    event.preventDefault();
    const next = TABS[nextIndex];
    onChange(next.id);
    document.getElementById(`deal-tab-${next.id}`)?.focus();
  };
  return <section aria-label="Szczegóły analizy" className="rounded-[1.5rem] border border-white/10 bg-[#13181e] p-3 sm:p-5"><div aria-label="Sekcje Deal Room" className="flex gap-1 overflow-x-auto rounded-2xl border border-white/10 bg-black/15 p-1" onKeyDown={onKeyDown} role="tablist">{TABS.map((tab) => <button aria-controls="deal-panel" aria-selected={tab.id === activeTab} className={`min-h-11 shrink-0 rounded-xl px-3 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-gold ${tab.id === activeTab ? "bg-gold/15 text-gold shadow-sm" : "text-muted-foreground hover:text-foreground"}`} id={`deal-tab-${tab.id}`} key={tab.id} onClick={() => onChange(tab.id)} role="tab" tabIndex={tab.id === activeTab ? 0 : -1} type="button">{tab.label}</button>)}</div><div aria-labelledby={`deal-tab-${activeTab}`} className="mt-5 min-h-44 outline-none focus-visible:ring-2 focus-visible:ring-gold" id="deal-panel" role="tabpanel" tabIndex={0}><TabContent tab={activeTab} deal={deal} /></div></section>;
}

function TabContent({ tab, deal }: { tab: RoomTab; deal: CanonicalDeal }) {
  const market = deal.market.result ? { ...deal.market.result, confidence: deal.market.confidence } : null;
  const underwriting = deal.underwriting.result;
  const ceo = deal.ceo.result;
  if (tab === "SUMMARY") return <div className="grid gap-4 lg:grid-cols-2"><Panel title="Teza inwestycyjna"><p>{ceo?.investmentThesis ? polishGeneratedText(ceo.investmentThesis) ?? "Teza wymaga sprawdzenia w zapisanym wyniku analizy." : "Brak pełnej tezy w aktualnym wyniku CEO."}</p></Panel><Panel title="Stan decyzji"><ListDetail title="Warunki kontynuacji" values={(ceo?.conditionsToProceed ?? []).map(localizeDecisionCondition)} /><ListDetail title="Zdania odrębne" values={(ceo?.dissent ?? []).map(localizeDissent)} /></Panel></div>;
  if (tab === "MARKET") return market ? <div className="grid gap-4 lg:grid-cols-2"><MetricGrid items={[ ["Cena po remoncie · ostrożna", pln(market.resaleValueLow)], ["Cena po remoncie · bazowa", pln(market.resaleValueBase)], ["Cena po remoncie · optymistyczna", pln(market.resaleValueHigh)], ["Porównania", String(market.compCount)] ]} /><Panel title="Źródło wyceny"><p>Dopasowanie: {marketMatchLabel(market.assumptionMatchedBy)}</p><p className="mt-2">Rodzaj dowodów: {evidenceLabel(market.priceEvidenceType)} · dane zastępcze: {fallbackLevelLabel(market.fallbackLevel)}</p><p className="mt-2">Pewność rynku: {formatPercentDisplay(market.confidence, 0)}</p></Panel><Panel className="lg:col-span-2" title="Porównania rynkowe">{market.comparables.length ? <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{market.comparables.slice(0, 9).map((item) => <article className="rounded-2xl border border-white/10 bg-black/15 p-3 text-xs" key={item.id}><p className="font-semibold text-foreground">{marketSourceLabel(item.source)}</p><p className="mt-1">{pln(item.pricePerM2)}/m² · podobieństwo {formatPercentDisplay(item.similarityScore, 0)}</p><p className="mt-1 text-muted-foreground">Jakość danych {formatPercentDisplay(item.dataQuality, 0)}{item.freshnessDays != null ? ` · ${item.freshnessDays} dni` : ""}</p></article>)}</div> : <EmptyState text="Nie ma zapisanych porównań w aktualnym wyniku rynku." />}</Panel></div> : <EmptyState text="Rynek oczekuje na dane lub na wynik dyrektora rynku." />;
  if (tab === "FINANCE") return underwriting ? <div className="space-y-4"><MetricGrid items={[ ["Zakup", pln(underwriting.purchasePrice)], ["Remont", pln(underwriting.renovationTotal)], ["Utrzymanie", pln(underwriting.holdingCosts)], ["Koszty sprzedaży", pln(underwriting.salesCosts)], ["Rezerwa", pln(underwriting.contingency)], ["Łączny koszt", pln(underwriting.totalProjectCost)], ["Zysk bazowy", pln(underwriting.profitBase)], ["ROI bazowe", percent(underwriting.roiBase)] ]} /><Panel title="Granice zakupu"><p>Maks. cena zakupu: <strong className="text-gold">{pln(underwriting.maxPurchasePrice)}</strong></p><p className="mt-1">Cena docelowa: {pln(underwriting.targetPurchasePrice)} · potrzebny rabat: {pln(underwriting.discountNeeded)}</p></Panel></div> : <EmptyState text="Finanse oczekują na wystarczające dane wejściowe." />;
  if (tab === "RENOVATION") return <div className="grid gap-4 lg:grid-cols-2"><MetricGrid items={[["Tryb kalkulacji", renovationModeLabel(underwriting?.renovationMode)], ["Koszt remontu", pln(underwriting?.renovationTotal)], ["Koszt / m²", pln(underwriting?.renovationPerM2)], ["Stan lokalu", conditionLabel(deal.facts.condition.effectiveValue)]]} /><Panel title="Ograniczenie danych"><p>Nie ma osobnego wyniku wykonawcy remontu. Pokazana kwota pochodzi wyłącznie z istniejącej, deterministycznej analizy finansowej.</p></Panel></div>;
  if (tab === "RISKS") return <div className="grid gap-4 lg:grid-cols-2"><Panel title="Ryzyka CEO"><ListDetail title="Najważniejsze ryzyka" values={(ceo?.risks ?? []).map(polishRiskText)} /><ListDetail title="Braki przed zakupem" values={(ceo?.missingBeforePurchase ?? []).map(factLabel)} /></Panel><Panel title="Bramki krytyczne">{ceo?.criticalGates.length ? <div className="space-y-2">{ceo.criticalGates.map((gate) => <div className={`rounded-xl border p-3 text-sm ${gate.passed ? "border-emerald-400/20 bg-emerald-400/[0.05]" : "border-red-400/20 bg-red-400/[0.05]"}`} key={gate.fact}><strong>{gate.passed ? "Potwierdzone" : "Do potwierdzenia"}: </strong>{localizeGateReason(gate.reason, gate.fact, gate.passed)}</div>)}</div> : <EmptyState text="Brak zdefiniowanych bramek krytycznych." />}</Panel></div>;
  if (tab === "NEGOTIATION") return <div className="space-y-4"><MetricGrid items={[["Cena ofertowa", pln(deal.facts.askingPrice.effectiveValue)], ["Oferta otwierająca", pln(ceo?.openingOffer)], ["Cel negocjacyjny", pln(ceo?.targetPurchasePrice)], ["Granica odejścia", pln(ceo?.maxPurchasePrice)]]} /><Panel title="Plan negocjacji"><ListDetail title="Plan" values={deal.playbook.negotiationPlan.map((value) => polishGeneratedText(value) ?? "Plan oczekuje na potwierdzenie danych.")} /><ListDetail title="Pytania do sprzedającego" values={deal.playbook.sellerQuestions.map((value) => polishGeneratedText(value) ?? "Do potwierdzenia ze sprzedającym.")} /></Panel></div>;
  if (tab === "AUDIT") return <Audit deal={deal} />;
  return <EmptyState text="Notatki nie mają jeszcze trwałego, wspólnego modelu danych. Nie tworzymy pozorowanej historii." />;
}

function CeoRail({ deal }: { deal: CanonicalDeal }) { const ceo = deal.ceo.result; const recommendation = ceo ? polishGeneratedText(ceo.recommendation) : null; const systemCopy = recommendation && recommendation !== ceo?.action ? recommendation : "Wynik deterministycznej analizy; zakup nadal wymaga potwierdzenia danych i decyzji człowieka."; const nextAction = ceo?.nextBestAction ? polishGeneratedText(ceo.nextBestAction) : null; return <section className="rounded-[1.5rem] border border-gold/30 bg-[#1b1710] p-5 shadow-[0_22px_58px_-40px_rgba(0,0,0,.95)]"><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gold">{ceo ? "Rekomendacja systemu" : "Decyzja inwestycyjna"}</p><h2 className="type-section-title mt-2 text-2xl">{ceo ? ceoAction(ceo.action) : "Oczekuje na wynik"}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{ceo ? systemCopy : "Decyzja pojawi się po zapisaniu wyniku analizy."}</p><div className="mt-5 border-t border-gold/15 pt-4"><p className="text-[10px] font-bold uppercase tracking-wide text-gold">Następny krok</p><p className="mt-1 text-sm font-semibold">{nextAction || "Nie wyznaczono wiarygodnego kroku."}</p></div></section>; }

function Timeline({ events }: { events: TimelineView }) { return <section data-executive-timeline aria-label="Oś czasu analizy" className="rounded-[1.5rem] border border-white/10 bg-[#13181e] p-5"><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gold">Zapisany przebieg analizy</p><h2 className="type-section-title mt-1">Oś czasu analizy</h2>{events.executive.length ? <ol className="mt-5 space-y-0">{events.executive.map((event, index) => <TimelineItem event={event} index={index} total={events.executive.length} key={event.id} />)}</ol> : <EmptyState text="Brak zapisanych zdarzeń możliwych do pokazania." />}{events.audit.length ? <details className="mt-4 border-t border-white/10 pt-3"><summary className="cursor-pointer text-xs font-semibold text-gold outline-none focus-visible:ring-2 focus-visible:ring-gold">Pokaż pełną historię ({events.audit.length})</summary><ol className="mt-4 space-y-0">{events.audit.map((event, index) => <TimelineItem event={event} index={index} total={events.audit.length} key={event.id} />)}</ol></details> : null}</section>; }

function TimelineItem({ event, index, total }: { event: TimelineEvent; index: number; total: number }) { return <li className="relative grid grid-cols-[14px_minmax(0,1fr)] gap-3 pb-4 last:pb-0"><span className="relative mt-1.5 size-2.5 rounded-full border border-gold bg-gold/20"><span className={`absolute left-1/2 top-2.5 h-[calc(100%+12px)] w-px -translate-x-1/2 bg-white/15 ${index === total - 1 ? "hidden" : ""}`} /></span><div><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{dateTime(event.at)} · {event.actor}</p><p className="mt-1 text-xs font-semibold">{event.title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{event.detail}</p></div></li>; }

function Questions({ deal }: { deal: CanonicalDeal }) { const questions = deal.informationRequests.filter((request) => request.status === "OPEN"); return <section data-user-questions aria-label="Pytania do Ciebie" className="rounded-[1.5rem] border border-amber-400/20 bg-[#1b1812] p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gold">Dane od Ciebie</p><h2 className="type-section-title mt-1">Pytania do Ciebie</h2></div>{questions.length ? <span className="rounded-full bg-red-400/10 px-2.5 py-1 text-[10px] font-bold text-red-200">{questions.length} otwarte</span> : null}</div>{questions.length ? <div className="mt-4 space-y-3">{questions.slice(0, 5).map((question) => <article className="rounded-xl border border-white/10 bg-black/15 p-3" key={question.id}><div className="flex items-center justify-between gap-2"><p className="text-[10px] font-bold uppercase tracking-wide text-gold">{priorityLabel(question.priority)}</p><span className="text-[10px] text-muted-foreground">{directorLabel(question.requestedBy)}</span></div><p className="mt-2 text-sm font-semibold leading-5">{polishGeneratedText(question.question) || "Wymagane jest potwierdzenie dodatkowych danych."}</p><p className="mt-2 text-xs leading-5 text-muted-foreground">Potwierdź: {polishGeneratedText(question.evidenceNeeded) || "wiarygodny dokument lub bezpośrednie źródło"}</p><p className="mt-2 text-[11px] leading-5 text-muted-foreground">Możliwy wpływ na decyzję: {question.decisionImpact.map(decisionImpactLabel).join(", ") || "do sprawdzenia"}</p></article>)}</div> : <p className="mt-4 text-sm leading-6 text-muted-foreground">Brak otwartych pytań w aktualnej analizie.</p>}{questions.length ? <p className="mt-4 border-t border-white/10 pt-3 text-[10px] leading-4 text-muted-foreground">Odpowiedzi wymagające trwałego dowodu zapisuje się w istniejącym panelu korekt ręcznych poniżej.</p> : null}</section>; }

function HeroMetric({ label, value, emphasis = false, positive = false, negative = false, className = "" }: { label: string; value: string; emphasis?: boolean; positive?: boolean; negative?: boolean; className?: string }) { return <article className={`min-w-0 rounded-xl border p-3 sm:p-4 ${emphasis ? "border-gold/45 bg-gold/[0.08]" : "border-white/10 bg-[#13181e]"} ${className}`}><p className="min-h-7 text-[10px] font-semibold leading-4 tracking-[0.04em] text-muted-foreground">{label}</p><p className={`type-financial-hero mt-1 ${emphasis ? "text-gold" : positive ? "text-emerald-300" : negative ? "text-red-300" : "text-foreground"}`}>{value}</p></article>; }
function Scenario({ title, scenario, featured = false }: { title: string; scenario: NonNullable<CanonicalDeal["underwriting"]["result"]>["scenarios"]["base"]; featured?: boolean }) { return <article className={`rounded-2xl border p-4 ${featured ? "border-gold/45 bg-gold/[0.09]" : "border-white/10 bg-black/15"}`}><p className="text-xs font-bold uppercase tracking-wide">{title}{featured ? " · rekomendowany" : ""}</p><p className="mt-4 text-[10px] uppercase text-muted-foreground">Zysk</p><p className="type-financial-standard mt-1 text-foreground">{pln(scenario.profit)}</p><p className="mt-3 text-[10px] uppercase text-muted-foreground">Sprzedaż / łączny koszt</p><p className="mt-1 text-xs leading-5 tabular-nums text-muted-foreground">{pln(scenario.resaleValue)} / {pln(scenario.totalProjectCost)}</p></article>; }
function TriggerList({ title, values, good = false }: { title: string; values: string[]; good?: boolean }) { return <div className={`rounded-xl border p-3 ${good ? "border-emerald-400/20 bg-emerald-400/[0.04]" : "border-red-400/20 bg-red-400/[0.04]"}`}><p className={`text-xs font-bold ${good ? "text-emerald-300" : "text-red-200"}`}>{title}</p>{values.length ? <ul className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">{values.map((value, index) => <li className="flex gap-2" key={`${index}-${value}`}><span className={good ? "text-emerald-300" : "text-red-200"}>✓</span>{localizeDecisionCondition(value)}</li>)}</ul> : <p className="mt-3 text-xs text-muted-foreground">Brak danych.</p>}</div>; }
function Panel({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) { return <section className={`rounded-2xl border border-white/10 bg-black/15 p-4 ${className}`}><h3 className="type-card-title">{title}</h3><div className="mt-3 text-sm leading-6 text-muted-foreground">{children}</div></section>; }
function MetricGrid({ items }: { items: Array<[string, string]> }) { return <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{items.map(([label, value]) => <article className="rounded-2xl border border-white/10 bg-black/15 p-4" key={label}><p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{label}</p><p className="type-financial-standard mt-2 text-foreground">{value}</p></article>)}</section>; }
function Audit({ deal }: { deal: CanonicalDeal }) { const facts = Object.entries(deal.facts); const conflicts = deal.evidenceFabric.filter((item) => item.verificationStatus === "CONFLICT"); return <div className="space-y-4"><Panel title="Konflikty danych">{conflicts.length ? <ListDetail title="Pozycje konfliktowe" values={conflicts.map((item) => `${item.field ? factLabel(item.field) : "Dowód"}: ${sourceLabel(item.sourceName)}`)} /> : <p>Brak konfliktów oznaczonych przez aktualny CanonicalDeal.</p>}</Panel><Panel title="Pochodzenie faktów"><div className="grid gap-2 sm:grid-cols-2">{facts.map(([field, fact]) => <div className="rounded-xl border border-white/10 bg-black/10 p-3 text-xs" key={field}><p className="font-semibold text-foreground">{factLabel(field)}</p><p className="mt-1">Wartość użyta: <strong>{displayFactValue(field, fact.effectiveValue)}</strong></p><p className="mt-1 text-muted-foreground">{sourceLabel(fact.source)} · {provenanceLabel(fact.provenance)} · {dateTime(fact.observedAt)}</p></div>)}</div></Panel><Panel title="Dowody">{deal.evidenceFabric.length ? <div className="grid gap-2 sm:grid-cols-2">{deal.evidenceFabric.slice(0, 24).map((item) => <div className="rounded-xl border border-white/10 bg-black/10 p-3 text-xs" key={item.id}><p className="font-semibold text-foreground">{sourceLabel(item.sourceName)}</p><p className="mt-1">{item.field ? factLabel(item.field) : evidenceTypeLabel(item.evidenceType)}</p><p className="mt-1 text-muted-foreground">{verificationLabel(item.verificationStatus)} · {dateTime(item.observedAt)}</p></div>)}</div> : <EmptyState text="Brak zapisanych dowodów." />}</Panel></div>; }
function ListDetail({ title, values }: { title: string; values: string[] }) { return <div>{title ? <p className="font-semibold text-foreground">{title}</p> : null}{values.length ? <ul className="mt-2 space-y-1.5">{values.map((value, index) => <li className="flex gap-2" key={`${index}-${value}`}><span className="text-gold">•</span><span>{value}</span></li>)}</ul> : <p className="mt-2 text-muted-foreground">Brak danych.</p>}</div>; }
function EmptyState({ text }: { text: string }) { return <p className="mt-4 rounded-xl border border-dashed border-white/10 bg-black/10 p-4 text-sm leading-6 text-muted-foreground">{text}</p>; }

type RoomDirector = { id: string; label: string; status: string; confidence: number | null; finding: string | null; recommendation: string | null; evidence: string[]; missing: string[]; triggers: string[]; dependencies: string[] };
type TimelineEvent = { id: string; at: string; actor: string; title: string; detail: string };
function buildDirectorCards(deal: CanonicalDeal): RoomDirector[] { const available = new Map<string, DirectorOutput<unknown>>([["SCOUT", deal.scout as DirectorOutput<unknown>], ["VERIFY", deal.verify as DirectorOutput<unknown>], ["MARKET", deal.market as DirectorOutput<unknown>], ["UNDERWRITER", deal.underwriting as DirectorOutput<unknown>], ["CEO", deal.ceo as DirectorOutput<unknown>]]); return DIRECTORS.map((name) => { const output = available.get(name); const dependencies = (DIRECTOR_DEPENDENCIES[name as keyof typeof DIRECTOR_DEPENDENCIES] ?? []).map(directorLabel); return output ? { id: name, label: directorLabel(name), status: output.status, confidence: output.confidence, finding: polishGeneratedText(useful(output.finding)), recommendation: polishGeneratedText(useful(output.recommendation)), evidence: output.evidence.map(localizeEvidenceLine).filter((value) => useful(value) !== null), missing: (output.missingData.length ? output.missingData : output.missingFields).map(factLabel), triggers: (output.whatWouldChangeMyMind.length ? output.whatWouldChangeMyMind : output.decisionTriggers).map((value) => polishGeneratedText(useful(value))).filter((value): value is string => Boolean(value)), dependencies } : { id: name, label: directorLabel(name), status: "WAITING", confidence: null, finding: dependencies.length ? `Oczekuje na zapisane wyniki: ${dependencies.join(", ")}.` : "Oczekuje na osobny, zapisany wynik.", recommendation: null, evidence: [], missing: [], triggers: [], dependencies }; }); }
type TimelineView = { executive: TimelineEvent[]; audit: TimelineEvent[] };
function buildTimeline(deal: CanonicalDeal): TimelineView { const created = { id: "created", at: deal.createdAt, actor: "Zespół analityczny", title: "Utworzono analizę", detail: "Zapisano analizę inwestycyjną dla tej oferty." }; const executive: TimelineEvent[] = [created]; const directors = [deal.scout, deal.verify, deal.market, deal.underwriting, deal.ceo]; for (const output of directors) if (output.computedAt) executive.push({ id: `director-${output.director}-${output.computedAt}`, at: output.computedAt, actor: directorLabel(output.director), title: `Wynik: ${directorLabel(output.director)}`, detail: `${directorStatus(output.status).label}${output.confidence == null ? "" : ` · pewność ${formatPercentDisplay(output.confidence, 0)}`}.` }); const evidence: TimelineEvent[] = deal.evidenceFabric.flatMap((item) => item.observedAt ? [{ id: `evidence-${item.id}`, at: item.observedAt, actor: sourceNameLabel(item.sourceName), title: item.field ? `Dowód: ${factLabel(item.field)}` : `Dowód: ${evidenceTypeLabel(item.evidenceType)}`, detail: `${verificationLabel(item.verificationStatus)} · ${evidenceTypeLabel(item.evidenceType)}.` }] : []); const sortRecent = (events: TimelineEvent[]) => events.filter((event) => !Number.isNaN(Date.parse(event.at))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); return { executive: sortRecent(executive).slice(0, 7), audit: sortRecent([...executive, ...evidence]).slice(0, 80) }; }
function directorStatus(status: string): { label: string; className: string } { if (status === "COMPLETE" || status === "READY") return { label: "GOTOWE", className: "bg-emerald-400/10 text-emerald-300" }; if (status === "RUNNING") return { label: "W TOKU", className: "bg-gold/10 text-gold" }; if (status === "BLOCKED" || status === "FAILED") return { label: "ZABLOKOWANE", className: "bg-red-400/10 text-red-200" }; if (status === "STALE") return { label: "NIEAKTUALNE", className: "bg-amber-400/10 text-amber-200" }; return { label: "OCZEKUJE", className: "bg-white/[0.06] text-muted-foreground" }; }
function StageBadge({ stage }: { stage: CanonicalDeal["stage"] }) { const label = ({ DISCOVERED: "Nowa", VERIFYING: "Weryfikacja", VERIFIED: "Weryfikacja", MARKET_READY: "Analiza", UNDERWRITTEN: "Analiza", DECISION_READY: "Negocjacja", ACQUISITION: "Zakup", RENOVATION: "Remont", SALE: "Sprzedaż", CLOSED: "Zamknięta" } as Record<string, string>)[stage] ?? "Etap do sprawdzenia"; return <span className="rounded-full border border-gold/35 bg-gold/[0.08] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-gold">{label}</span>; }
function ceoAction(value: string | undefined): string { return ({ KUP: "KUP", NEGOCJUJ: "NEGOCJUJ", "JEDŹ OBEJRZEĆ": "SPRAWDŹ", "HOLD / ZBIERZ DANE": "WSTRZYMAJ", ODRZUĆ: "ODRZUĆ" } as Record<string, string>)[value ?? ""] ?? "DO SPRAWDZENIA"; }
function directorLabel(value: string): string { return ({ SCOUT: "Rozpoznanie", VERIFY: "Weryfikacja", MARKET: "Rynek", RENOVATION: "Remont", UNDERWRITER: "Analiza finansowa", "RISK / LEGAL": "Ryzyko i prawo", RISK: "Ryzyko", LEGAL: "Prawo", CFO: "Finanse", ACQUISITION: "Zakup", SALE: "Sprzedaż", CEO: "CEO" } as Record<string, string>)[value] ?? "Zespół analityczny"; }
function priorityLabel(value: InformationRequest["priority"]): string { return ({ CRITICAL: "Krytyczne", HIGH: "Ważne", MEDIUM: "Do sprawdzenia", LOW: "Dodatkowe" } as Record<string, string>)[value] ?? "Do sprawdzenia"; }
function sourceLabel(value: string | null): string { return value === "facebook" ? "Facebook" : value === "olx" ? "OLX" : value === "otodom" ? "Otodom" : value === "manual" ? "Ręcznie" : value ? sourceNameLabel(value) : "Źródło nieustalone"; }
function sourceNameLabel(value: string | null | undefined): string { return ({ LISTING: "Ogłoszenie", DETERMINISTIC_UNDERWRITER: "Wyliczenie finansowe", RESALE_COMPS: "Porównania odsprzedaży", DEAL_OVERRIDE: "Korekta ręczna", facebook: "Facebook", FACEBOOK: "Facebook", olx: "OLX", OLX: "OLX", otodom: "Otodom", OTODOM: "Otodom", manual: "Wpis ręczny", MANUAL: "Wpis ręczny" } as Record<string, string>)[value ?? ""] ?? "Inne źródło"; }
function marketSourceLabel(value: string): string { return ({ otodom: "Otodom", OTODOM: "Otodom", olx: "OLX", OLX: "OLX", facebook: "Facebook", FACEBOOK: "Facebook", TRANSACTION: "Dane transakcyjne", USER_ASSUMPTION: "Założenie użytkownika", RESALE_COMPS: "Baza porównań odsprzedaży", "Oferta porównawcza": "Oferta porównawcza" } as Record<string, string>)[value] ?? "Inne źródło"; }
function renovationModeLabel(value: string | null | undefined): string { return ({ LIGHT: "Lekki zakres", STANDARD: "Standardowy zakres", FULL: "Pełny zakres" } as Record<string, string>)[value ?? ""] ?? "Nie ustalono"; }
function conditionLabel(value: unknown): string { if (typeof value !== "string" || !value.trim()) return "Nie ustalono"; return ({ RENOVATION: "Do remontu", NEEDS_RENOVATION: "Do remontu", READY: "Do zamieszkania", MOVE_IN_READY: "Do zamieszkania", GOOD: "Dobry stan", UNKNOWN: "Nie ustalono" } as Record<string, string>)[value] ?? (looksLikeEnglish(value) || /^[A-Z][A-Z0-9_]{2,}$/.test(value) ? "Do sprawdzenia" : value); }
function displayFactValue(field: string, value: unknown): string {
  if (value == null || value === "") return "—";
  if (field === "buildingType") return buildingTypeLabel(String(value));
  if (field === "condition") return conditionLabel(value);
  if (field === "source") return sourceLabel(typeof value === "string" ? value : null);
  if (field === "sourceUrl") return safeHttpUrl(typeof value === "string" ? value : null) ?? "Nieprawidłowy link";
  if (typeof value === "string" && /^[A-Z][A-Z0-9_]{2,}$/.test(value)) return factValueEnumLabel(value);
  if (["askingPrice", "askingPricePerM2", "monthlyFee", "price", "pricePerSqm", "rent", "maxPurchasePrice", "targetPurchasePrice"].includes(field)) {
    const amount = typeof value === "number" ? value : typeof value === "string" ? parseMoneyAmount(value) : null;
    if (amount !== null) return `${formatPLNDisplay(amount)}${field.toLowerCase().includes("perm2") || field.toLowerCase().includes("persqm") ? "/m²" : ""}`;
  }
  if (["areaM2", "area"].includes(field) && typeof value === "number") return `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 }).format(value)} m²`;
  if (typeof value === "number") return new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 }).format(value);
  if (typeof value === "string" && ["city", "district", "street"].includes(field)) return value;
  if (typeof value === "string") return polishGeneratedText(value) ?? "Do sprawdzenia";
  return stringValue(value);
}
function parseMoneyAmount(value: string): number | null { const normalized = value.trim().replace(/[\s\u00a0\u202f]/g, "").replace(/PLN|zł/gi, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", "."); const parsed = Number(normalized); return Number.isFinite(parsed) ? parsed : null; }
function factValueEnumLabel(value: string): string { return ({ FREEHOLD: "Pełna własność", FULL_OWNERSHIP: "Pełna własność", COOPERATIVE: "Własność spółdzielcza", COOPERATIVE_OWNERSHIP: "Własność spółdzielcza", LEASEHOLD: "Użytkowanie wieczyste", LIGHT: "Lekki zakres", STANDARD: "Standardowy zakres", FULL: "Pełny zakres", UNKNOWN: "Nie ustalono" } as Record<string, string>)[value] ?? "Do sprawdzenia"; }
function marketMatchLabel(value: string | null | undefined): string { return ({ RESALE_COMPS: "porównania odsprzedaży", DEAL_OVERRIDE: "korekta ręczna" } as Record<string, string>)[value ?? ""] ?? (value ? "inne źródło wyceny" : "brak danych"); }
function fallbackLevelLabel(value: number): string { return value === 0 ? "bez danych zastępczych" : `poziom ${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(value)}`; }
function evidenceLabel(value: "ASKING" | "TRANSACTION" | "MIXED" | "USER_ASSUMPTION"): string { return ({ ASKING: "ceny ofertowe", TRANSACTION: "dane transakcyjne", MIXED: "dane mieszane", USER_ASSUMPTION: "założenie ręczne" } as const)[value]; }
function provenanceLabel(value: ValueProvenance): string { return ({ EXTRACTED: "dane z ogłoszenia", DERIVED: "wartość wyliczona", USER_ASSUMPTION: "założenie użytkownika", MARKET_ASSUMPTION: "założenie rynkowe", MANUAL_OVERRIDE: "korekta ręczna", UNKNOWN: "nie ustalono" } as const)[value] ?? "nie ustalono"; }
function verificationLabel(value: string): string { return ({ VERIFIED: "potwierdzone", UNVERIFIED: "niezweryfikowane", CONFLICT: "konflikt danych", STALE: "nieaktualne" } as Record<string, string>)[value] ?? "stan do sprawdzenia"; }
function evidenceTypeLabel(value: string | undefined): string { return ({ LISTING_OBSERVATION: "Obserwacja ogłoszenia", PRICE_OBSERVATION: "Obserwacja ceny", DOCUMENT_OBSERVATION: "Dokument", USER_INSPECTION: "Oględziny", MANUAL_INPUT: "Dane ręczne", AI_EXTRACTION: "Odczyt automatyczny", VISION_OBSERVATION: "Analiza obrazu", MARKET_COMPARABLE: "Porównywalna oferta", MARKET_TRANSACTION: "Dane transakcyjne", RENOVATION_QUOTE: "Kosztorys remontu", ACTUAL_OUTCOME: "Wynik rzeczywisty" } as Record<string, string>)[value ?? ""] ?? "Inny rodzaj dowodu"; }
function localizeEvidenceLine(value: string): string { const [field, evidenceClass] = value.split(":"); if (!field || !evidenceClass) return polishGeneratedText(value) ?? "Zapisany dowód"; return `${factLabel(field)} · ${evidenceClassLabel(evidenceClass)}`; }
function evidenceClassLabel(value: string): string { return ({ FACT: "fakt", ASSUMPTION: "założenie", ESTIMATE: "szacunek", PREDICTION: "prognoza", USER_OVERRIDE: "korekta użytkownika", UNKNOWN: "nie ustalono", EXTRACTED: "dane z ogłoszenia", DERIVED: "wartość wyliczona", USER_ASSUMPTION: "założenie użytkownika", MARKET_ASSUMPTION: "założenie rynkowe", MANUAL_OVERRIDE: "korekta ręczna" } as Record<string, string>)[value] ?? "zapisany dowód"; }
function decisionImpactLabel(value: string): string { return ({ REJECT: "odrzucenie", HOLD: "wstrzymanie decyzji", NEGOTIATE: "negocjacje", BUY: "zakup" } as Record<string, string>)[value] ?? "dalszą ocenę"; }
function localizeDecisionCondition(value: string): string { const price = value.match(/^Cena zakupu <= (.+) PLN$/); if (price) return `Cena zakupu nie wyższa niż ${formatAmountText(price[1])}`; const over = value.match(/^Cena > (.+) PLN$/); if (over) return `Cena powyżej ${formatAmountText(over[1])}`; const knownMoney = formatKnownMoneyText(value); if (knownMoney) return knownMoney; const gate = value.match(/^([A-Za-z_]+): (confirmed|requires evidence)$/i); if (gate) return localizeGateReason(value, gate[1], gate[2].toLowerCase() === "confirmed"); const localized = polishGeneratedText(value); if (localized !== null) return localized; return "Warunek wymaga sprawdzenia w szczegółach analizy."; }
function formatAmountText(value: string): string { const amount = parseMoneyAmount(value); return amount == null ? "kwota do sprawdzenia" : formatPLNDisplay(amount); }
function localizeGateReason(reason: string, fact: string, passed: boolean): string { const gate = reason.match(/^[A-Za-z_]+: (confirmed|requires evidence)$/i); if (gate) return `${factLabel(fact)}: ${passed ? "potwierdzone" : "wymaga dowodu"}`; return polishGeneratedText(reason) ?? `${factLabel(fact)}: ${passed ? "potwierdzone" : "wymaga dowodu"}`; }
function localizeDissent(value: string): string { const dissent: Record<string, string> = { "High score rests on low-confidence evidence.": "Wysoka ocena opiera się na danych o niskiej pewności.", "Bear case loses money.": "Wariant ostrożny oznacza stratę.", "Critical purchase gates remain unverified.": "Kluczowe warunki zakupu nie są jeszcze potwierdzone." }; return dissent[value] ?? polishGeneratedText(value) ?? "Zastrzeżenie wymaga sprawdzenia w szczegółach analizy."; }
function polishRiskText(value: string): string { const risks: Record<string, string> = { "Bear case is loss-making.": "Wariant ostrożny jest stratny.", "Bear-case profit must survive.": "Należy potwierdzić, czy wariant ostrożny nadal jest rentowny.", "Scope and overrun require site evidence.": "Zakres prac i ryzyko przekroczenia budżetu wymagają potwierdzenia na miejscu.", "Delay increases holding and finance cost.": "Opóźnienie zwiększa koszty utrzymania i finansowania.", "Exit liquidity is an estimate.": "Możliwość szybkiej sprzedaży jest szacunkiem.", "Title and encumbrances require documents.": "Stan prawny i obciążenia wymagają potwierdzenia dokumentami.", "Resale, renovation, time and purchase price can change the decision.": "Cena odsprzedaży, remontu, czas realizacji i cena zakupu mogą zmienić decyzję.", "No verifier omissions.": "Weryfikacja nie wykazała brakujących danych." }; return risks[value] ?? polishGeneratedText(value) ?? "Ryzyko wymaga sprawdzenia w szczegółach analizy."; }
function polishGeneratedText(value: string | null): string | null {
  if (!value) return null;
  const investmentText = formatInvestmentText(value);
  if (investmentText) return investmentText;
  const exact: Record<string, string> = {
    "Pass only validated output downstream.": "Przekazuj dalej wyłącznie zweryfikowane wyniki.",
    "Execute only the conditional human-approved action.": "Wykonuj wyłącznie działanie zatwierdzone przez człowieka i zgodne z warunkami.",
    "Revalidate after material change": "Ponownie zweryfikuj po istotnej zmianie danych.",
    "Material fact, assumption or freshness change": "Istotna zmiana faktu, założenia lub aktualności danych.",
    "Conditional offer only": "Wyłącznie oferta warunkowa.",
    "Target after validation": "Ustal cel po weryfikacji.",
    "No maximum without validation": "Nie ustalono limitu przed weryfikacją.",
    "Open canonical listing and price history": "Otwórz kanoniczne ogłoszenie i historię ceny.",
    "What is the legal title and are there encumbrances?": "Jaki jest stan prawny nieruchomości i czy są na niej obciążenia?",
    "Why is it being sold?": "Dlaczego nieruchomość jest sprzedawana?",
    "Is price negotiable?": "Czy cena podlega negocjacji?",
    "What is the monthly fee?": "Jaka jest wysokość miesięcznego czynszu?",
    "Primary legal document or qualified legal review": "Podstawowy dokument prawny lub ocena uprawnionego specjalisty.",
    "Title document / land and mortgage register": "Dokument potwierdzający tytuł prawny lub księga wieczysta.",
    "Current seller asking price": "Aktualna cena podana przez sprzedającego.",
    "At least three current high-quality comparables or stronger evidence": "Co najmniej trzy aktualne, dobrej jakości porównania lub mocniejszy dowód.",
    "Primary document or exact verified listing fact": "Dokument źródłowy lub dokładny, zweryfikowany fakt z ogłoszenia.",
    "Inspection scope and/or contractor estimate": "Zakres z oględzin i/lub wycena wykonawcy.",
    "Exact canonical listing location": "Dokładna lokalizacja kanonicznego ogłoszenia.",
    "Exact canonical source binding": "Jednoznaczne powiązanie z kanonicznym źródłem.",
    "Independently validated deterministic calculation": "Niezależnie zweryfikowane, deterministyczne wyliczenie.",
    "Resolved material conflicts and risk review": "Rozstrzygnięte istotne konflikty i ocena ryzyka.",
    "Reliable identified source": "Wiarygodne, możliwe do wskazania źródło.",
    "Title document": "Dokument potwierdzający tytuł prawny",
    "No-arrears certificate": "Zaświadczenie o braku zaległości",
    "Unit plan": "Rzut lokalu",
    "Community/cooperative documents": "Dokumenty wspólnoty lub spółdzielni",
    "Confirmed legal defect": "Potwierdzona wada prawna",
    "Unresolved material fact conflict": "Nierozstrzygnięty konflikt istotnych danych",
    "Human approval is mandatory": "Zakup wymaga zatwierdzenia przez człowieka.",
    "Confirm area and layout": "Potwierdź powierzchnię i układ lokalu.",
    "Inspect installations and moisture": "Sprawdź instalacje i ślady wilgoci.",
    "Record renovation scope": "Zapisz zakres remontu.",
    "Twarde wykluczenie zamyka ofertÄ™": "Twarde wykluczenie zamyka ofertę.",
    "Mocny deal po peĹ‚nej walidacji": "Mocna oferta po pełnej weryfikacji.",
    "Ekonomia wymaga niĹĽszej ceny": "Ekonomika wymaga niższej ceny.",
    "Decyzja wymaga potwierdzenia danych": "Decyzja wymaga potwierdzenia danych.",
  };
  if (exact[value]) return exact[value];
  const ask = value.match(/^(Ask about|Verify|Confirm) (.+)$/);
  if (ask) return `${ask[1] === "Ask about" ? "Zapytaj o" : ask[1] === "Verify" ? "Zweryfikuj" : "Potwierdź"}: ${factLabel(ask[2])}.`;
  const identifiedEvidence = value.match(/^Identified evidence for (.+)$/);
  if (identifiedEvidence) return `Wymagany dowód: ${factLabel(identifiedEvidence[1])}.`;
  const verify = value.match(/^Verify (.+)$/);
  if (verify) return `Zweryfikuj: ${factLabel(verify[1])}.`;
  const confirm = value.match(/^Confirm (.+)$/);
  if (confirm) return `Potwierdź: ${factLabel(confirm[1])}.`;
  const gate = value.match(/^([A-Za-z_]+): (confirmed|requires evidence)$/i);
  if (gate) return `${factLabel(gate[1])}: ${gate[2].toLowerCase() === "confirmed" ? "potwierdzone" : "wymaga dowodu"}`;
  const missingFields = value.match(/^VERIFY missing: (.+)$/i);
  if (missingFields) return `Do weryfikacji: ${missingFields[1].split(",").map((field) => factLabel(field.trim())).join(", ")}.`;
  if (looksLikeEnglish(value) || !looksLikePolish(value)) return null;
  return value;
}

function looksLikeEnglish(value: string): boolean {
  return /\b(?:the|and|with|requires|require|evidence|validated|validation|confidence|blocked|completed|missing|confirmed|current|source|price|profit|loss|case|score|offer|listing|unknown|unverified|purchase|seller|resale|renovation|holding|liquidity|maximum|target|opening|downstream|action|document|title|encumbrance|estimate|delay|scope|overrun|this|that|please|should|could|would|before|after|review|expected|because|available|based|value|safe|not|proceed|deal)\b/i.test(value);
}
function looksLikePolish(value: string): boolean { return /[ąćęłńóśźż]/i.test(value) || /\b(?:brak|dane|cena|ceny|oferta|ogłoszenie|ogloszenie|wymaga|wymagają|potwierdź|potwierdz|sprawdź|sprawdz|zakup|sprzedaż|sprzedaz|remont|ryzyko|czynsz|lokal|miasto|adres|własność|wlasnosc|warunek|warunki|warto|może|moze|powierzchnia|pokoje|do|dla|na|z|ze|oraz|przed|po|jest|są|sa|oraz)\b/i.test(value); }
function factLabel(value: string): string { return ({ askingPrice: "Cena ofertowa", askingPricePerM2: "Cena za m²", areaM2: "Powierzchnia", rooms: "Pokoje", city: "Miasto", district: "Dzielnica", street: "Adres", buildingType: "Typ budynku", ownership: "Forma własności", monthlyFee: "Czynsz", sourceUrl: "Link źródłowy", condition: "Stan lokalu", legalStatus: "Stan prawny", marketEvidence: "Dane porównawcze", renovationScope: "Zakres remontu", identity: "Tożsamość ogłoszenia", economics: "Ekonomika", riskReview: "Ocena ryzyka", floorsTotal: "Liczba pięter", yearBuilt: "Rok budowy", postId: "Identyfikator ogłoszenia", floor: "Piętro" } as Record<string, string>)[value] ?? "Dodatkowe dane"; }
function factsSummary(deal: CanonicalDeal): string { return [deal.facts.areaM2.effectiveValue != null ? `${deal.facts.areaM2.effectiveValue} m²` : null, deal.facts.rooms.effectiveValue != null ? `${deal.facts.rooms.effectiveValue} pokoje` : null, deal.facts.floor.effectiveValue ? `${deal.facts.floor.effectiveValue} piętro` : null, deal.facts.buildingType.effectiveValue ? buildingTypeLabel(deal.facts.buildingType.effectiveValue) : null].filter(Boolean).join(" · ") || "Parametry oferty wymagają weryfikacji"; }
function buildingTypeLabel(value: string): string { return ({ BLOCK: "blok", block: "blok", APARTMENT_BLOCK: "blok", TENEMENT: "kamienica", kamienica: "kamienica", HOUSE: "dom", house: "dom", DETACHED_HOUSE: "dom wolnostojący", APARTMENT: "mieszkanie", mieszkanie: "mieszkanie", UNKNOWN: "nie ustalono", unknown: "nie ustalono" } as Record<string, string>)[value] ?? "typ budynku do weryfikacji"; }
function safeHttpUrl(value: string | null): string | null { try { const parsed = value ? new URL(value) : null; return parsed?.protocol === "https:" || parsed?.protocol === "http:" ? parsed.toString() : null; } catch { return null; } }
function useful(value: string | null): string | null { if (!value || /completed with confidence|blocked by evidence or validation/i.test(value)) return null; const normalized = value.trim().replace(/[.!?]+$/, "").toLocaleLowerCase("pl-PL"); if (["wniosek nie został zapisany", "brak dodatkowej notatki", "brak zapisanej rekomendacji ceo", "zapisano zdarzenie"].includes(normalized)) return null; return value; }
function dateTime(value: string | null): string { if (!value || Number.isNaN(Date.parse(value))) return "—"; return new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
function percent(value: number | null | undefined): string { return formatPercentDisplay(value); }
function stringValue(value: unknown): string { return value == null || value === "" ? "—" : String(value); }
