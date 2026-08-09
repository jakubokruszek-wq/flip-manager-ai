import Link from "next/link";
import {
  Activity, ArrowDownRight, BarChart3, Building2, CircleDollarSign,
  Radar, Sparkles, TrendingUp,
} from "lucide-react";

import { MetricCard } from "@/components/ui/metric-card";
import { PageHeader } from "@/components/ui/page-header";
import { AttentionItems, OpportunityCards } from "@/features/dashboard/components/dashboard-property-sections";
import type {
  DashboardPriceDrop, DashboardSummary,
} from "@/features/dashboard/types";
import { cn } from "@/lib/utils";

const currency = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 });

export function DashboardView({ summary }: { summary: DashboardSummary }) {
  const { kpis } = summary;
  return (
    <div className="space-y-7">
      <PageHeader
        title="Panel inwestora"
        description="Najważniejsze okazje, rentowność portfela i aktywność Flip Findera w jednym miejscu."
        actions={<span className="ui-badge"><span className="size-1.5 rounded-full bg-success" />Dane na żywo</span>}
      />

      <section aria-label="Kluczowe wskaźniki" className="grid gap-3 min-[360px]:grid-cols-2 xl:grid-cols-6">
        <Kpi icon={Building2} label="Aktywne w CRM" value={String(kpis.activeProperties)} detail="bez sprzedanych" />
        <Kpi icon={Sparkles} label="Nowe okazje · 24h" value={String(kpis.newOpportunities24h)} detail="unikalne oferty" tone="gold" />
        <Kpi icon={Radar} label="Śr. Flip Score" value={formatMetric(kpis.averageFlipScore)} detail="analizowane CRM" />
        <Kpi icon={TrendingUp} label="Średni ROI" value={formatPercent(kpis.averageRoi)} detail="analizowane CRM" tone="success" />
        <Kpi icon={CircleDollarSign} label="Potencjalny zysk" value={currency.format(kpis.potentialProfit)} detail="łącznie w CRM" tone="gold" />
        <Kpi icon={ArrowDownRight} label="Obniżki ceny" value={String(kpis.priceDrops)} detail="wykryte w historii" tone="danger" />
      </section>

      <section>
        <SectionHeading title="Najlepsze okazje" description="TOP 5 według rekomendacji zakupu, Flip Score, ROI i potencjalnego zysku." />
        {summary.topOpportunities.length ? (
          <OpportunityCards opportunities={summary.topOpportunities} />
        ) : <EmptyCopy text="Brak zapisanych analiz inwestycyjnych do rankingu." />}
      </section>

      <div className="grid gap-5 xl:grid-cols-[1.35fr_0.65fr]">
        <ChartPanel title="Nowe okazje — ostatnie 14 dni" subtitle="Unikalne oferty po dacie pierwszego dopasowania">
          <OpportunitiesChart data={summary.opportunitiesByDay} />
        </ChartPanel>
        <ChartPanel title="Potencjalny zysk w CRM" subtitle="Rozkład zysku z zapisanych analiz">
          <ProfitChart data={summary.profitByProperty} />
        </ChartPanel>
      </div>

      <section className="ui-section">
        <SectionHeading title="Aktywność Flip Findera" description="Ostatnie skany i rzeczywisty wynik pracy źródeł." compact />
        {summary.recentScans.length ? <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[700px] text-sm"><thead><tr className="border-b border-border/70 text-left text-[11px] uppercase tracking-wider text-muted-foreground"><th className="pb-3 font-semibold">Źródło / czas</th><th className="pb-3 font-semibold">Status</th><th className="pb-3 text-right font-semibold">Pobrane</th><th className="pb-3 text-right font-semibold">Nowe dopasowania</th><th className="pb-3 text-right font-semibold">Obniżki</th><th className="pb-3 text-right font-semibold">Błędy</th></tr></thead><tbody>{summary.recentScans.map((scan) => <tr className="border-b border-border/45 last:border-0" key={scan.id}><td className="py-3.5"><p className="font-medium capitalize">{scan.source}</p><p className="mt-0.5 text-xs text-muted-foreground">{formatDateTime(scan.startedAt)}</p></td><td className="py-3.5"><StatusBadge status={scan.status} /></td><td className="py-3.5 text-right font-mono">{scan.fetched}</td><td className="py-3.5 text-right font-mono text-gold">{scan.newMatches}</td><td className="py-3.5 text-right font-mono">{scan.priceDrops}</td><td className={cn("py-3.5 text-right font-mono", scan.sourceErrors ? "text-danger" : "text-muted-foreground")}>{scan.sourceErrors}</td></tr>)}</tbody></table></div> : <EmptyCopy text="Flip Finder nie zarejestrował jeszcze żadnego skanu." />}
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <section className="ui-section">
          <SectionHeading title="Ostatnie obniżki ceny" description="Zmiany wykryte w historii ofert." compact />
          <div className="mt-4 divide-y divide-border/60">{summary.recentPriceDrops.length ? summary.recentPriceDrops.map((drop) => <PriceDropRow key={`${drop.listingId}-${drop.droppedAt}`} drop={drop} />) : <EmptyCopy text="Brak zarejestrowanych obniżek ceny." />}</div>
        </section>
        <section className="ui-section">
          <SectionHeading title="Oferty wymagające uwagi" description="Braki i ryzyka, które warto obsłużyć w pierwszej kolejności." compact />
          {summary.attentionItems.length ? <AttentionItems items={summary.attentionItems} /> : <EmptyCopy text="Wszystkie aktywne oferty mają kompletne, aktualne dane." />}
        </section>
      </div>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, detail, tone }: { icon: typeof Activity; label: string; value: string; detail: string; tone?: "gold" | "success" | "danger" }) {
  return <MetricCard className="relative overflow-hidden" label={label} value={<span className="flex items-center justify-between gap-2"><span className={cn("break-words text-lg xl:text-xl", tone === "gold" && "text-gold", tone === "success" && "text-success", tone === "danger" && "text-danger")}>{value}</span><Icon className="size-4 shrink-0 text-muted-foreground/60" /></span>} detail={detail} />;
}

function OpportunitiesChart({ data }: { data: DashboardSummary["opportunitiesByDay"] }) {
  const max = Math.max(1, ...data.map((point) => point.count));
  const points = data.map((point, index) => `${(index / Math.max(1, data.length - 1)) * 100},${92 - (point.count / max) * 76}`).join(" ");
  return <div className="mt-5"><div className="h-56 w-full"><svg aria-label="Wykres nowych okazji z ostatnich 14 dni" className="h-full w-full overflow-visible" preserveAspectRatio="none" role="img" viewBox="0 0 100 100"><defs><linearGradient id="opportunity-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--gold)" stopOpacity=".28"/><stop offset="100%" stopColor="var(--gold)" stopOpacity="0"/></linearGradient></defs>{[16,35,54,73,92].map((y) => <line key={y} stroke="var(--border)" strokeDasharray="2 2" strokeWidth=".45" x1="0" x2="100" y1={y} y2={y} />)}<polygon fill="url(#opportunity-fill)" points={`0,92 ${points} 100,92`} /><polyline fill="none" points={points} stroke="var(--gold)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />{data.map((point, index) => <circle aria-label={`${point.date}: ${point.count}`} cx={(index / Math.max(1, data.length - 1)) * 100} cy={92 - (point.count / max) * 76} fill="var(--card)" key={point.date} r="1.25" stroke="var(--gold)" strokeWidth=".7" />)}</svg></div><div className="mt-2 flex justify-between text-[10px] text-muted-foreground"><span>{formatChartDate(data[0]?.date)}</span><span>{formatChartDate(data[6]?.date)}</span><span>{formatChartDate(data.at(-1)?.date)}</span></div></div>;
}

function ProfitChart({ data }: { data: DashboardSummary["profitByProperty"] }) {
  const shown = data.slice(0, 6); const max = Math.max(1, ...shown.map((item) => Math.abs(item.profit)));
  return <div className="mt-5 space-y-4">{shown.length ? shown.map((item) => <div key={item.propertyId}><div className="mb-1.5 flex items-center justify-between gap-3 text-xs"><span className="truncate text-muted-foreground">{item.label}</span><strong className={item.profit >= 0 ? "text-success" : "text-danger"}>{currency.format(item.profit)}</strong></div><div className="h-2 overflow-hidden rounded-full bg-surface-muted"><div className={cn("h-full rounded-full", item.profit >= 0 ? "bg-gradient-to-r from-gold-muted to-gold" : "bg-danger")} style={{ width: `${Math.max(2, Math.abs(item.profit) / max * 100)}%` }} /></div></div>) : <EmptyCopy text="Brak zapisanych prognoz zysku." />}</div>;
}

function PriceDropRow({ drop }: { drop: DashboardPriceDrop }) {
  const content = <span className="flex w-full items-center gap-3 py-3.5 text-left"><span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger"><ArrowDownRight className="size-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{drop.title}</span><span className="mt-0.5 block text-xs text-muted-foreground">{drop.district ?? "Bez dzielnicy"} · {formatDateTime(drop.droppedAt)}</span></span><span className="text-right"><span className="block font-mono text-sm text-danger">−{currency.format(drop.dropAmount)}</span><span className="block text-[11px] text-muted-foreground line-through">{currency.format(drop.previousPrice)}</span></span></span>;
  return drop.propertyId ? <Link href="/properties">{content}</Link> : content;
}

function ChartPanel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) { return <section className="ui-chart"><SectionHeading compact description={subtitle} title={title} />{children}</section>; }
function SectionHeading({ title, description, compact = false }: { title: string; description: string; compact?: boolean }) { return <div className={compact ? undefined : "mb-4"}><h2 className="flex items-center gap-2 text-base font-semibold tracking-tight"><BarChart3 className="size-4 text-gold" />{title}</h2><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>; }
function EmptyCopy({ text }: { text: string }) { return <p className="py-8 text-center text-sm text-muted-foreground">{text}</p>; }
function StatusBadge({ status }: { status: DashboardSummary["recentScans"][number]["status"] }) { const label = status === "completed" ? "Zakończony" : status === "running" ? "W toku" : status === "partial" ? "Częściowy" : "Błąd"; return <span className={cn("ui-badge", status === "completed" ? "border-success/20 bg-success/10 text-success" : status === "running" ? "border-gold/20 bg-gold/10 text-gold" : "border-danger/20 bg-danger/10 text-danger")}>{label}</span>; }
function formatMetric(value: number | null): string { return value === null ? "—" : number.format(value); }
function formatPercent(value: number | null): string { return value === null ? "—" : `${number.format(value)}%`; }
function formatDateTime(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" }).format(date) : "—"; }
function formatChartDate(value?: string): string { if (!value) return ""; const date = new Date(`${value}T12:00:00Z`); return new Intl.DateTimeFormat("pl-PL", { day: "2-digit", month: "short", timeZone: "Europe/Warsaw" }).format(date); }
