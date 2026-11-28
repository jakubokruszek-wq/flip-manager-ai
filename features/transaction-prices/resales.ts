import { buildTransactionComparison, normalizeRcnLocation } from "./model.ts";
import type { RcnMarket, RcnRawRow, RcnSubject } from "./types.ts";

export type RcnResaleCandidate = {
  id: string; street: string; building: string | null; area: number;
  buyDate: string; sellDate: string; buyPrice: number; sellPrice: number;
  buyPricePerM2: number; sellPricePerM2: number; holdingDays: number; approxMonths: number;
  priceIncrease: number; priceIncreasePct: number; strongSignal: boolean; buyMarket: RcnMarket; sellMarket: RcnMarket;
};
export type RcnResaleResult = {
  status: "ready" | "no_candidates" | "missing_location" | "unsupported_location";
  source: { title: string; url: string }; street: string | null; candidateCount: number; strongCandidateCount: number;
  rows: RcnResaleCandidate[]; fetchedAt: string; truncated: boolean;
};
type Options = { now: Date; fetchedAt: string; truncated: boolean; limit?: number };
type Identity = { key: string; area: number };
type Event = { date: string; identity: Identity | null; price: number | null; market: RcnMarket | null; building: string | null };
const DAY = 86400000;
const rounded = (value: number) => Math.round(value * 100) / 100;
function dateOf(value: string | undefined): string | null {
  const date = /^(\d{4}-\d{2}-\d{2})(?:[ T]00:00:00Z?)?$/.exec(value ?? "")?.[1];
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}
function identityOf(row: RcnRawRow): Identity | null {
  const parts = Object.fromEntries((row.LOK_ADRES ?? "").split(";").map(part => { const index = part.indexOf(":"); return index < 0 ? ["", ""] : [part.slice(0, index).trim(), part.slice(index + 1).trim()]; }));
  const city = row.LOK_ADRESMSC ?? parts.MSC ?? "";
  const street = row.LOK_ADRESUL ?? parts.UL ?? "";
  const fullNumber = row.LOK_ADRESNR_PORZ ?? parts.NR_PORZ ?? "";
  if (!city.trim() || !street.trim() || !fullNumber.trim() || !/^\d+(?:[.,]\d+)?$/.test(row.LOK_POW_UZYT?.trim() ?? "")) return null;
  const area = Number(row.LOK_POW_UZYT.replace(",", "."));
  if (!Number.isFinite(area) || area <= 0) return null;
  const key = [city, street, fullNumber].map(value => normalizeRcnLocation(value).replace(/\s*([./-])\s*/g, "$1")).join("|");
  return { key, area };
}
function oldestSale(now: Date): string {
  const date = new Date(now); const day = date.getUTCDate(); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - 24);
  date.setUTCDate(Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()));
  return date.toISOString().slice(0, 10);
}

/** Observed quick-resale candidates, never asserted flips or renovation profit.
 * Invalid intermediate observations remain barriers; filtering first would invent pairs.
 */
export function buildResaleCandidates(subject: Pick<RcnSubject, "city" | "street">, rows: RcnRawRow[], options: Options): RcnResaleResult {
  const result: RcnResaleResult = { status: "no_candidates", source: { title: "Rejestr Cen Nieruchomości — Łódź", url: "https://nowa.mapa.lodz.pl/dla-profesjonalistow/" }, street: subject.street?.trim() || null, candidateCount: 0, strongCandidateCount: 0, rows: [], fetchedAt: options.fetchedAt, truncated: options.truncated };
  if (!subject.city?.trim() || !subject.street?.trim()) return { ...result, status: "missing_location" };
  if (normalizeRcnLocation(subject.city) !== "lodz") return { ...result, status: "unsupported_location" };
  if (!Number.isFinite(options.now.getTime())) return result;
  const today = options.now.toISOString().slice(0, 10); const cutoff = oldestSale(options.now);
  const transactions = new Map<string, RcnRawRow[]>();
  const poisoned = new Set<string>();
  for (const row of rows) {
    const transaction = row.TRAN_LOKALNY_ID_IIP?.trim(); const unit = row.LOK_ID_LOKALU?.trim();
    if (!transaction) { if (unit) poisoned.add(unit); continue; }
    transactions.set(transaction, [...(transactions.get(transaction) ?? []), row]);
  }
  const histories = new Map<string, Event[]>();
  for (const group of transactions.values()) {
    const units = new Set(group.map(row => row.LOK_ID_LOKALU?.trim()).filter((value): value is string => !!value));
    const allVersionsValid = group.every(row => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(row.TRAN_WERSJA_ID ?? "") && Number.isFinite(Date.parse(row.TRAN_WERSJA_ID.replace(" ", "T") + "Z")));
    const newest = group.map(row => (row.TRAN_WERSJA_ID ?? "").replace("T", " ")).sort().at(-1);
    const current = group.filter(row => (row.TRAN_WERSJA_ID ?? "").replace("T", " ") === newest);
    const dates = new Set(current.map(row => dateOf(row.DOK_DATA)));
    const date = dates.size === 1 ? [...dates][0] : null;
    if (!date || !allVersionsValid) { for (const unit of units) poisoned.add(unit); continue; }
    const identities = current.map(identityOf);
    const oneIdentity = identities.every(identity => identity !== null) && new Set(identities.map(identity => JSON.stringify(identity))).size === 1;
    const identity = oneIdentity ? identities[0] : null;
    const market: RcnMarket | null = current[0].TRAN_RODZAJ_RYNKU === "rynekWtorny" ? "secondary" : current[0].TRAN_RODZAJ_RYNKU === "rynekPierwotny" ? "primary" : null;
    const singleUnit = units.size === 1 && group.every(row => !!row.LOK_ID_LOKALU?.trim());
    // Reuse the existing all-rows transaction/version, full-share, local-price,
    // residential, free-market, exact-city/street and anti-bundle gates.
    const accepted = singleUnit && identity && market && date <= today
      ? buildTransactionComparison({ city: subject.city, street: subject.street, area: identity.area, price: null }, group,
          { market, now: new Date(`${date}T12:00:00Z`), fetchedAt: options.fetchedAt, truncated: false }).rows
      : [];
    const value = accepted.length === 1 ? accepted[0] : null;
    for (const unit of units) {
      const event: Event = { date, identity, price: value && Number.isFinite(value.pricePerM2) ? value.price : null, market: value ? market : null, building: value?.building ?? null };
      histories.set(unit, [...(histories.get(unit) ?? []), event]);
    }
  }
  const candidates: Omit<RcnResaleCandidate, "id">[] = [];
  for (const [unit, history] of histories) {
    if (poisoned.has(unit) || history.some(event => !event.identity)) continue;
    // A changed full address (including unit) or area breaks the identity claim.
    if (new Set(history.map(event => JSON.stringify(event.identity))).size !== 1) continue;
    history.sort((a, b) => a.date.localeCompare(b.date));
    const dates = new Map<string, number>(); for (const event of history) dates.set(event.date, (dates.get(event.date) ?? 0) + 1);
    for (let index = 1; index < history.length; index++) {
      const buy = history[index - 1]; const sell = history[index];
      if (!buy.price || !sell.price || !buy.market || !sell.market || dates.get(buy.date) !== 1 || dates.get(sell.date) !== 1 || sell.date < cutoff || sell.date > today) continue;
      const holdingDays = (Date.parse(sell.date) - Date.parse(buy.date)) / DAY;
      const increase = sell.price - buy.price;
      if (holdingDays < 1 || holdingDays > 365 || increase <= 0 || !Number.isFinite(increase)) continue;
      const area = sell.identity!.area;
      candidates.push({ street: subject.street.trim(), building: sell.building, area, buyDate: buy.date, sellDate: sell.date,
        buyPrice: buy.price, sellPrice: sell.price, buyPricePerM2: rounded(buy.price / area), sellPricePerM2: rounded(sell.price / area),
        holdingDays, approxMonths: Math.round(holdingDays / 30.4375 * 10) / 10, priceIncrease: rounded(increase),
        priceIncreasePct: rounded(increase / buy.price * 100), strongSignal: increase / buy.price >= .3, buyMarket: buy.market, sellMarket: sell.market });
    }
  }
  candidates.sort((a, b) => b.sellDate.localeCompare(a.sellDate) || b.priceIncrease - a.priceIncrease);
  result.candidateCount = candidates.length;
  result.strongCandidateCount = candidates.filter(candidate => candidate.strongSignal).length;
  result.rows = candidates.slice(0, options.limit ?? 20).map((row, index) => ({ id: `resale-${index + 1}`, ...row }));
  if (candidates.length) result.status = "ready";
  return result;
}
