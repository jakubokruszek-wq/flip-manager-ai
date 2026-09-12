import type { ReactNode } from "react";
import type { DirectorStatus } from "../types";

export function pln(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value);
}

export function numeric(value: number | null | undefined, maximumFractionDigits = 1): string {
  return value == null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("pl-PL", { maximumFractionDigits }).format(value);
}

export function percent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : `${numeric(value)}%`;
}

export function display(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "number") return numeric(value);
  if (Array.isArray(value)) return value.length ? value.map(display).join(", ") : "—";
  return String(value);
}

export function StatusPill({ status, label }: { status: DirectorStatus | string; label?: string }) {
  const tone = status === "COMPLETE" || status === "READY" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
    : status === "BLOCKED" || status === "FAILED" || status === "STALE" ? "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300"
      : "border-border bg-muted/60 text-muted-foreground";
  const readable = label ?? status.replaceAll("_", " ");
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${tone}`}>{readable}</span>;
}

export function MetricTile({ label, value, detail, emphasis = false }: { label: string; value: string; detail?: string; emphasis?: boolean }) {
  return <div className={`min-w-0 rounded-xl border border-border/70 p-3 ${emphasis ? "bg-primary/5" : "bg-background/50"}`}>
    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
    <p className={`mt-1 break-words font-semibold tabular-nums tracking-tight ${emphasis ? "text-xl sm:text-2xl" : "text-base"}`}>{value}</p>
    {detail ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p> : null}
  </div>;
}

export function SectionHeading({ eyebrow, title, aside, id }: { eyebrow?: string; title: string; aside?: ReactNode; id?: string }) {
  return <div className="flex flex-wrap items-end justify-between gap-3">
    <div>{eyebrow ? <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{eyebrow}</p> : null}<h3 className="mt-0.5 text-base font-semibold tracking-tight" id={id}>{title}</h3></div>
    {aside}
  </div>;
}

export function ContentList({ title, values, empty = "Brak danych" }: { title: string; values: string[]; empty?: string }) {
  return <section className="rounded-xl border border-border/70 bg-background/40 p-4">
    <h4 className="text-sm font-semibold">{title}</h4>
    {values.length ? <ul className="mt-2 space-y-2 text-sm leading-5 text-muted-foreground">{values.map((value, index) => <li className="flex gap-2" key={`${index}-${value}`}><span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-primary/70" /><span>{value}</span></li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">{empty}</p>}
  </section>;
}

export function ConfidenceMeter({ label, value }: { label: string; value: number | null | undefined }) {
  const safe = value == null || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, value));
  return <div>
    <div className="mb-1 flex justify-between gap-2 text-xs"><span className="text-muted-foreground">{label}</span><span className="font-semibold tabular-nums">{safe == null ? "—" : `${numeric(safe, 0)}%`}</span></div>
    <div aria-label={`${label}: ${safe == null ? "brak danych" : `${numeric(safe, 0)} procent`}`} className="h-1.5 overflow-hidden rounded-full bg-muted" role="img">{safe == null ? null : <div className="h-full rounded-full bg-primary" style={{ width: `${safe}%` }} />}</div>
  </div>;
}

export function PanelCard({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-border/70 bg-background/50 p-4 ${className}`}><h4 className="text-sm font-semibold">{title}</h4><div className="mt-2 text-sm leading-6 text-muted-foreground">{children}</div></section>;
}
