import type { SearchFilterScan } from "@/features/flip-finder/search-filter-contract";

export const NO_SCANS_MESSAGE = "Nie uruchomiono jeszcze żadnego skanu ofert.";

export function dashboardCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function latestScanCounters(
  scan: Pick<SearchFilterScan, "listingsUpdated" | "priceDropCount">,
): { updatedCount: number; priceDropCount: number } {
  return {
    updatedCount: dashboardCount(scan.listingsUpdated),
    priceDropCount: dashboardCount(scan.priceDropCount),
  };
}

export function canRunManualScan(isActive: boolean, scanning: boolean): boolean {
  return isActive && !scanning;
}

export function filterResultsHref(filterId: string): string {
  return `/flip-finder/filters/${filterId}/results`;
}

export function hasLatestScan(scan: SearchFilterScan | null): scan is SearchFilterScan {
  return scan !== null;
}

export function scanStatusLabel(status: SearchFilterScan["status"]): string {
  switch (status) {
    case "pending":
      return "Oczekuje";
    case "running":
      return "Skanowanie";
    case "completed":
      return "Zakończony";
    case "partial":
      return "Częściowo zakończony";
    case "failed":
      return "Błąd";
  }
}
