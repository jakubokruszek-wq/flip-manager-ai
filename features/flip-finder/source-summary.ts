import type { ListingSource } from "./index.ts";
import type { SearchFilterScan } from "./search-filter-contract.ts";

export function sourceLabel(source: ListingSource): string {
  return ({
    otodom: "Otodom", olx: "OLX", morizon: "Morizon", facebook: "Facebook",
    gratka: "Gratka", nieruchomosci_online: "Nieruchomosci-online.pl", domiporta: "Domiporta",
    sprzedajemy: "Sprzedajemy.pl", adresowo: "Adresowo.pl", oferty_net: "Oferty.net",
    szybko: "Szybko.pl", bezposrednio: "Bezposrednio.net.pl", domy: "Domy.pl", allegro_lokalnie: "Allegro Lokalnie",
  } satisfies Record<ListingSource, string>)[source];
}

export function activeSourcesSummary(sources: ListingSource[]): string {
  return `Aktywne źródła: ${sources.map(sourceLabel).join(", ") || "brak"}`;
}

export function latestActiveScansText(scans: SearchFilterScan[], sources: ListingSource[]): string {
  const active = new Set(sources);
  const latest = new Map<ListingSource, SearchFilterScan>();

  for (const scan of scans) {
    if (!active.has(scan.source)) continue;
    const current = latest.get(scan.source);
    if (!current || scan.startedAt > current.startedAt) latest.set(scan.source, scan);
  }

  return sources.map((source) => latest.get(source)).filter((scan): scan is SearchFilterScan => Boolean(scan)).map((scan) => {
    const label = sourceLabel(scan.source);
    if (scan.status === "pending" && scan.source === "facebook") return "Facebook: oczekuje na production Collector";
    if (scan.status === "pending" && scan.source === "olx") return "OLX: oczekuje na lokalny worker";
    if (scan.status === "failed") return `${label}: błąd${scan.errorMessage ? ` — ${scan.errorMessage}` : ""}`;
    return `${label}: sprawdzono ${scan.scannedCount}, dopasowano ${scan.matchedCount}`;
  }).join(" · ");
}
