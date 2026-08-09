import { PROPERTY_TABLE_COLUMNS } from "@/features/properties/config";
import { PropertyImageCell } from "@/features/properties/components/property-image-cell";
import { PropertyDialog } from "@/features/properties/components/property-dialog";
import { PropertyDeleteControl } from "@/features/properties/components/property-delete-control";
import { PropertyStatusBadge } from "@/features/properties/components/property-status-badge";
import type { PropertyWithInvestmentAnalysis } from "@/features/properties/types";
import {
  formatCurrency,
  formatDate,
  formatFlipScore,
  formatPercent,
} from "@/features/properties/utils/format";
import { cn } from "@/lib/utils";
import { DataTable, DataTableShell } from "@/components/ui/data-table";

type PropertiesTableProps = {
  properties: PropertyWithInvestmentAnalysis[];
  onDeleted?: () => void;
  onUpdated?: () => void;
};

export function PropertiesTable({ properties, onDeleted, onUpdated }: PropertiesTableProps) {
  return (
    <><div className="grid gap-4 md:hidden">{properties.map((property) => <article className="ui-card overflow-hidden" key={property.id}><PropertyImageCell address={property.address} className="aspect-[16/9] h-auto w-full rounded-none border-0" imageUrl={property.imageUrl} sizes="100vw" /><div className="p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><PropertyDialog property={property} onDeleted={onDeleted} onUpdated={onUpdated} trigger={<button aria-label={`Otwórz szczegóły: ${property.address}`} className="min-h-11 text-left text-base font-bold leading-5 outline-none hover:text-primary focus-visible:underline" type="button">{property.address}</button>} /><div className="mt-2"><PropertyStatusBadge status={property.status} /></div></div>{onDeleted ? <details className="relative shrink-0"><summary aria-label={`Akcje dla ${property.address}`} className="flex size-11 cursor-pointer list-none items-center justify-center rounded-xl border border-border text-xl text-muted-foreground">•••</summary><div className="absolute right-0 z-20 mt-2 w-44 rounded-xl border border-border/80 bg-popover p-2 shadow-xl"><PropertyDeleteControl propertyId={property.id} onDeleted={onDeleted} /></div></details> : null}</div><div className="mt-4 grid grid-cols-2 gap-2"><MobileMetric label="Cena" value={formatCurrency(property.purchasePrice ?? property.price)} /><MobileMetric label="Flip Score" value={formatFlipScore(property.flipScore)} /><MobileMetric label="ROI" value={formatPercent(property.roi)} /><MobileMetric label="Zysk" value={formatCurrency(property.profit)} /></div></div></article>)}</div><DataTableShell className="hidden md:block">
      <div className="overflow-x-auto">
        <DataTable className="min-w-[1120px]">
          <thead>
            <tr className="border-b border-border bg-surface-muted/60">
              {PROPERTY_TABLE_COLUMNS.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className="px-4 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
                >
                  {column.label}
                </th>
              ))}
              <th scope="col" className="px-4 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Akcje</th>
            </tr>
          </thead>
          <tbody>
            {properties.map((property) => (
              <tr
                key={property.id}
                className="border-b border-border last:border-b-0 transition-colors hover:bg-surface-muted/40"
              >
                <td className="px-4 py-3">
                  <PropertyImageCell
                    imageUrl={property.imageUrl}
                    address={property.address}
                  />
                </td>
                <td className="px-4 py-3 font-medium text-foreground">
                  <PropertyDialog property={property} onDeleted={onDeleted} onUpdated={onUpdated} trigger={<button className="text-left font-medium transition-colors hover:text-primary hover:underline" type="button">{property.address}</button>} />
                </td>
                <td className="px-4 py-3">
                  <PropertyStatusBadge status={property.status} />
                </td>
                <td
                  className={cn(
                    "px-4 py-3 font-mono",
                    typeof property.flipScore === "number" && Number.isFinite(property.flipScore)
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {formatFlipScore(property.flipScore)}
                </td>
                <td className="px-4 py-3 font-mono text-foreground">
                  {formatCurrency(property.purchasePrice)}
                </td>
                <td className="px-4 py-3 font-mono text-foreground">
                  {formatCurrency(property.renovationCost)}
                </td>
                <td className="px-4 py-3 font-mono text-foreground">
                  {formatCurrency(property.expectedSalePrice)}
                </td>
                <td className="px-4 py-3 font-mono text-foreground">
                  {formatCurrency(property.profit)}
                </td>
                <td className="px-4 py-3 font-mono text-foreground">
                  {formatPercent(property.roi)}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {formatDate(property.updatedAt)}
                </td>
                <td className="px-4 py-3">
                  {onDeleted ? <details className="relative"><summary className="cursor-pointer rounded-lg px-2 py-1 text-sm text-muted-foreground hover:bg-surface-hover hover:text-foreground">Więcej</summary><div className="absolute right-0 z-20 mt-2 w-40 rounded-xl border border-border/80 bg-popover p-2 shadow-xl"><PropertyDeleteControl propertyId={property.id} onDeleted={onDeleted} /></div></details> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </div>
    </DataTableShell></>
  );
}

function MobileMetric({ label, value }: { label: string; value: string }) { return <div className="rounded-xl bg-surface-muted/60 p-3"><p className="text-[11px] text-muted-foreground">{label}</p><p className="mt-1 truncate font-mono text-sm font-semibold">{value}</p></div>; }
