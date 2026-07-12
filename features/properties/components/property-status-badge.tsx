import { PROPERTY_STATUS_LABELS } from "@/features/properties/config";
import type { PropertyStatus } from "@/features/properties/types";
import { cn } from "@/lib/utils";

const statusStyles: Record<PropertyStatus, string> = {
  draft: "bg-surface-muted text-muted-foreground",
  analysis: "bg-surface-muted text-foreground",
  acquired: "bg-surface-muted text-foreground",
  renovation: "bg-surface-muted text-foreground",
  listed: "bg-surface-muted text-foreground",
  sold: "bg-foreground/10 text-foreground",
};

type PropertyStatusBadgeProps = {
  status: PropertyStatus;
};

export function PropertyStatusBadge({ status }: PropertyStatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-1 text-xs font-medium",
        statusStyles[status],
      )}
    >
      {PROPERTY_STATUS_LABELS[status]}
    </span>
  );
}
