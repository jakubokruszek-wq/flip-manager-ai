import { ExternalLink } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import type { ImportedPropertyFormValues } from "@/features/properties/types/imported-property-form";

type PropertySummaryProps = {
  values: ImportedPropertyFormValues;
};

export function PropertySummary({ values }: PropertySummaryProps) {
  const price = toNumber(values.price);
  const area = toNumber(values.area);
  const pricePerSquareMeter = price !== null && area && area > 0 ? price / area : null;

  return (
    <header className="space-y-4">
      <span className="inline-flex rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
        {values.source || "Otodom"}
      </span>

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {values.title || "Oferta bez tytułu"}
        </h1>
        <p className="text-3xl font-bold tracking-tight">{formatCurrency(price)}</p>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <SummaryItem label="Powierzchnia" value={formatArea(area)} />
        <SummaryItem label="Cena za m²" value={formatPricePerSquareMeter(pricePerSquareMeter)} />
        <SummaryItem label="Pokoje" value={values.rooms || "—"} />
        <SummaryItem label="Piętro" value={values.floor || "—"} />
      </dl>

      {values.originalUrl && (
        <a
          className={buttonVariants({ variant: "outline", size: "sm" })}
          href={values.originalUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Otwórz ogłoszenie
          <ExternalLink aria-hidden="true" />
        </a>
      )}
    </header>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

function toNumber(value: string): number | null {
  const parsed = Number(value.replace(",", "."));
  return value.trim() && Number.isFinite(parsed) ? parsed : null;
}

function formatCurrency(value: number | null): string {
  return value === null
    ? "—"
    : `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(value)} zł`;
}

function formatArea(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("pl-PL")} m²`;
}

function formatPricePerSquareMeter(value: number | null): string {
  return value === null
    ? "—"
    : `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(value)} zł/m²`;
}
