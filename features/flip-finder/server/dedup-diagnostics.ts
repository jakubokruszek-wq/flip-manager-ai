import type { FilterResultsPayload } from "./filter-results.ts";
import type { IdentityPairDiagnostic } from "../property-identity.ts";
import { crossPortalEvidenceLabel, parseFloorValue } from "../cross-portal-identity.ts";

/**
 * Report builder for scripts/finder-dedup-diagnostics.mts and the Production
 * replay test. Pure: it only formats what the real Finder read path returned.
 */

export type FocusCase = { price: number; area: number };

export type DedupFixture = {
  exportedAt: string;
  now: string;
  filterId: string;
  operatorId: string | null;
  cases: FocusCase[];
  /** Rows exactly as the Finder read them from Supabase (SELECT results), limited to the focus listings. */
  tables: Record<string, Record<string, unknown>[]>;
  /** Grouping confirmed by a person after reviewing the listings; null until then. */
  expected: { groups: string[][]; candidates?: Array<[string, string]> } | null;
};

/** Tables the Finder read path queries; a replay seeds the missing ones as empty. */
export const FINDER_READ_TABLES = [
  "search_filters", "listings", "listing_filter_matches", "listing_snapshots", "listing_source_metadata", "source_scans", "resale_comps",
  "finder_listing_identity_groups", "finder_listing_identity_decisions", "finder_building_type_confirmations",
] as const;

type Card = FilterResultsPayload["results"][number];
type Section = "Dopasowane" | "Do oceny" | "Do weryfikacji budynku";

function cardsWithSection(payload: FilterResultsPayload): Array<{ card: Card; section: Section }> {
  return [
    ...payload.results.map((card) => ({ card, section: "Dopasowane" as const })),
    ...payload.reviewResults.map((card) => ({ card, section: "Do oceny" as const })),
    ...payload.buildingVerificationResults.map((card) => ({ card, section: "Do weryfikacji budynku" as const })),
  ];
}

function members(card: Card): Array<{ id: string; source: string; originalUrl: string | null; price: number | null; area: number | null }> {
  return card.linkedListings?.length ? card.linkedListings : [{ id: card.id, source: card.source, originalUrl: card.originalUrl, price: card.price, area: card.area }];
}

function inCase(price: number | null, area: number | null, focus: FocusCase): boolean {
  if (price === null || area === null) return false;
  return Math.abs(area - focus.area) <= 0.6 && Math.abs(price - focus.price) / focus.price <= 0.05;
}

/** Listings of the focus cases plus every listing the grouping linked to them or assessed against them with any evidence. */
export function focusListingIds(after: FilterResultsPayload, pairs: readonly IdentityPairDiagnostic[], cases: readonly FocusCase[]): Set<string> {
  const ids = new Set<string>();
  for (const { card } of cardsWithSection(after)) {
    const cardMembers = members(card);
    if (cardMembers.some((member) => cases.some((focus) => inCase(member.price, member.area, focus)))) {
      cardMembers.forEach((member) => ids.add(member.id));
      (card.identityCandidates ?? []).forEach((candidate) => ids.add(candidate.id));
    }
  }
  for (const pair of pairs) {
    if (pair.kind === "separate" && pair.evidence.length === 0) continue;
    if (ids.has(pair.leftId) || ids.has(pair.rightId)) { ids.add(pair.leftId); ids.add(pair.rightId); }
  }
  return ids;
}

function sectionCounts(payload: FilterResultsPayload): string {
  return `Dopasowane ${payload.results.length} · Do oceny ${payload.reviewResults.length} · Do weryfikacji budynku ${payload.buildingVerificationResults.length} · razem ${payload.results.length + payload.reviewResults.length + payload.buildingVerificationResults.length}`;
}

function textLength(value: unknown): number {
  return typeof value === "string" ? value.trim().length : 0;
}

function fmtPair(pair: IdentityPairDiagnostic): string {
  const evidence = pair.evidence.map(crossPortalEvidenceLabel).join(", ") || "—";
  const conflicts = pair.conflicts.join(", ") || "—";
  const verdict = pair.kind === "confirmed" ? "POŁĄCZONE" : pair.kind === "candidate" ? "MOŻLIWY DUPLIKAT" : "OSOBNO";
  return `| ${pair.leftId} | ${pair.rightId} | ${verdict} | ${pair.score} | ${evidence} | ${conflicts} | ${pair.reason}${pair.blocked ? " (decyzja operatora: nie łącz)" : ""} |`;
}

const CONTENT_EVIDENCE = new Set(["description", "photos", "offer_reference"]);

export function buildDedupReport(input: {
  before: FilterResultsPayload;
  after: FilterResultsPayload;
  pairs: readonly IdentityPairDiagnostic[];
  cases: readonly FocusCase[];
  /** Raw listing rows (as read from Supabase) for per-listing facts. */
  listingRows?: ReadonlyMap<string, Record<string, unknown>>;
}): string {
  const { before, after, pairs, cases } = input;
  const lines: string[] = [];
  const afterCards = cardsWithSection(after);
  const sectionById = new Map<string, Section>();
  const cardById = new Map<string, Card>();
  for (const { card, section } of afterCards) for (const member of members(card)) { sectionById.set(member.id, section); cardById.set(member.id, card); }
  const beforeCardById = new Map<string, Card>();
  for (const { card } of cardsWithSection(before)) for (const member of members(card)) beforeCardById.set(member.id, card);

  lines.push("# Flip Finder — diagnostyka deduplikacji (READ-ONLY)", "");
  lines.push(`Filtr: ${after.filter.name} (${after.filter.id})`, "");
  lines.push("## Liczba kart", "");
  lines.push(`- Przed (tylko jawna tożsamość): ${sectionCounts(before)}`);
  lines.push(`- Po (deduplikacja międzyportalowa): ${sectionCounts(after)}`);
  const linkedListings = afterCards.reduce((sum, { card }) => sum + members(card).length, 0);
  lines.push(`- Widoczne oferty (kopie z portali): ${linkedListings}`, "");

  for (const focus of cases) {
    const caseCards = afterCards.filter(({ card }) => members(card).some((member) => inCase(member.price, member.area, focus)));
    const caseIds = new Set(caseCards.flatMap(({ card }) => members(card).map((member) => member.id)));
    lines.push(`## ${String(focus.price).replace(/\B(?=(\d{3})+(?!\d))/gu, " ")} zł / ${String(focus.area).replace(".", ",")} m²`, "");
    lines.push(`Karty przed: ${new Set([...caseIds].map((id) => beforeCardById.get(id)?.id ?? id)).size} · karty po: ${caseCards.length}`, "");
    lines.push("| Oferta | Portal | Sekcja po | Pokoje | Piętro (surowe → odczytane) | Dzielnica | Adres | Opis (znaki) | Zdjęcia | Link |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const id of [...caseIds].sort()) {
      const row = input.listingRows?.get(id);
      const card = beforeCardById.get(id);
      const floorRaw = (row?.floor ?? card?.floor ?? null) as string | null;
      const images = (row?.images ?? card?.images ?? []) as unknown[];
      lines.push(`| ${id} | ${String(row?.source ?? card?.source ?? "?")} | ${sectionById.get(id) ?? "—"} | ${String(row?.rooms ?? card?.rooms ?? "—")} | ${floorRaw ?? "—"} → ${parseFloorValue(floorRaw) ?? "?"} | ${String(row?.district ?? card?.district ?? "—")} | ${String(row?.address ?? card?.address ?? "—")} | ${textLength(row?.description ?? card?.description)} | ${Array.isArray(images) ? images.length : 0} | ${String(row?.original_url ?? card?.originalUrl ?? "—")} |`);
    }
    lines.push("");
    lines.push("Karty po deduplikacji:");
    for (const { card, section } of caseCards) {
      const cardMembers = members(card);
      const candidates = (card.identityCandidates ?? []).map((candidate) => `${candidate.id} (${candidate.source}; zgodne: ${candidate.evidence?.join(", ") || "—"})`);
      lines.push(`- **${section}** — ${cardMembers.length > 1 ? "POŁĄCZONE" : "osobno"}: ${cardMembers.map((member) => `${member.id} (${member.source})`).join(", ")}${candidates.length ? `; możliwy duplikat: ${candidates.join("; ")}` : ""}`);
    }
    lines.push("", "Oceny par (te same reguły co w Finderze):", "", "| Oferta A | Oferta B | Wynik | Punkty | Dowody | Konflikty | Powód |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const pair of pairs.filter((item) => caseIds.has(item.leftId) && caseIds.has(item.rightId))) lines.push(fmtPair(pair));
    lines.push("");
  }

  const confirmed = pairs.filter((pair) => pair.kind === "confirmed" && pair.reason === "cross_portal_multi_evidence");
  const withoutContent = confirmed.filter((pair) => !pair.evidence.some((item) => CONTENT_EVIDENCE.has(item)));
  lines.push("## Ryzyko błędnego połączenia", "");
  lines.push(`- Pary połączone automatycznie na podstawie dowodów międzyportalowych (cały filtr): ${confirmed.length}`);
  lines.push(`- W tym bez wspólnego opisu, zdjęć ani numeru oferty (oparte na ulicy/piętrze — do przejrzenia): ${withoutContent.length}`);
  for (const pair of withoutContent) lines.push(`  - ${pair.leftId} ↔ ${pair.rightId}: ${pair.evidence.map(crossPortalEvidenceLabel).join(", ")} (punkty ${pair.score})`);
  const merged = afterCards.filter(({ card }) => members(card).length > 1);
  lines.push(`- Wszystkie połączone karty w filtrze: ${merged.length}`);
  for (const { card, section } of merged) {
    const cardMembers = members(card);
    lines.push(`  - ${section}: ${cardMembers.map((member) => `${member.source} ${member.price ?? "?"} zł / ${member.area ?? "?"} m² (${member.id})`).join(" + ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Limits recorded SELECT results to the focus listings; the result replays through the same Finder read path. */
export function buildDedupFixture(input: {
  recorded: ReadonlyMap<string, ReadonlyMap<string, Record<string, unknown>>>;
  ids: ReadonlySet<string>;
  filterId: string;
  operatorId: string | null;
  now: number;
  cases: FocusCase[];
}): DedupFixture {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const [table, rows] of input.recorded) {
    tables[table] = [...rows.values()].filter((row) => {
      if (table === "search_filters") return row.id === input.filterId;
      if (table === "listings") return input.ids.has(String(row.id));
      if (table === "finder_listing_identity_decisions") return input.ids.has(String(row.listing_a)) || input.ids.has(String(row.listing_b));
      if ("listing_id" in row) return input.ids.has(String(row.listing_id));
      return false;
    });
  }
  return { exportedAt: new Date().toISOString(), now: new Date(input.now).toISOString(), filterId: input.filterId, operatorId: input.operatorId, cases: input.cases, tables, expected: null };
}

/** Collects SELECT results per table, merging partial column sets of one row. */
export function createSelectRecorder(): { recorded: Map<string, Map<string, Record<string, unknown>>>; record: (table: string, rows: readonly Record<string, unknown>[]) => void } {
  const recorded = new Map<string, Map<string, Record<string, unknown>>>();
  return {
    recorded,
    record(table, rows) {
      const byKey = recorded.get(table) ?? new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const key = typeof row.id === "string" || typeof row.id === "number" ? String(row.id) : JSON.stringify(row);
        byKey.set(key, { ...byKey.get(key), ...row });
      }
      recorded.set(table, byKey);
    },
  };
}
