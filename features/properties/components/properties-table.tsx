import { PROPERTY_TABLE_COLUMNS } from "@/features/properties/config";
import { PropertyImageCell } from "@/features/properties/components/property-image-cell";
import { PropertyStatusBadge } from "@/features/properties/components/property-status-badge";
import type { Property } from "@/features/properties/types";
import {
  formatCurrency,
  formatDate,
  formatFlipScore,
  formatPercent,
} from "@/features/properties/utils/format";

type PropertiesTableProps = {
  properties: Property[];
};

export function PropertiesTable({ properties }: PropertiesTableProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface-elevated">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1120px] border-collapse text-left text-sm">
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
                  {property.address}
                </td>
                <td className="px-4 py-3">
                  <PropertyStatusBadge status={property.status} />
                </td>
                <td className="px-4 py-3 font-mono text-foreground">
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
