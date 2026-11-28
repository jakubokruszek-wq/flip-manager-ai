import { load } from "cheerio";
import type { RcnComparable, RcnComparison, RcnMarket, RcnRawRow, RcnSubject, RcnWfsPage } from "./types.ts";

const localName = (name: string) => name.split(":").at(-1) ?? "";
export const normalizeRcnStreet = (value: string) => value.normalize("NFC").replace(/^\s*(?:ulica\b|ul\.)\s*/iu, "").replace(/\s+/g, " ").trim();
export const normalizeRcnLocation = (value: string) => normalizeRcnStreet(value).toLocaleLowerCase("pl").replace(/ł/g, "l").normalize("NFD").replace(/\p{M}/gu, "").replace(/^\s*(?:ulica|ul\.)\s+/u, "").replace(/\s+/g, " ").trim();
const positive = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^\d+(?:[.,]\d+)?$/.test(value.trim())) return null;
  const number = Number(value.trim().replace(",", "."));
  return Number.isFinite(number) && number > 0 ? number : null;
};
const source = { title: "Rejestr Cen Nieruchomości — Łódź", url: "https://nowa.mapa.lodz.pl/dla-profesjonalistow/" };

/** Fail closed before handing XML to Cheerio's deliberately forgiving parser. */
function validateXml(xml: string) {
  if (xml.length > 8_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("RCN_INVALID_XML");
  const cleaned = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, "");
  const tokens = /<(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
  const stack: string[] = [];
  let roots = 0;
  for (const match of cleaned.matchAll(tokens)) {
    const token = match[0];
    const name = /^<\/?([\w:.-]+)/.exec(token)?.[1];
    if (!name) throw new Error("RCN_INVALID_XML");
    if (token.startsWith("</")) { if (stack.pop() !== name) throw new Error("RCN_INVALID_XML"); }
    else { if (!stack.length) roots++; if (!token.endsWith("/>")) stack.push(name); }
  }
  if (stack.length || roots !== 1 || cleaned.replace(tokens, "").includes("<")) throw new Error("RCN_INVALID_XML");
}
export function parseRcnWfs(xml: string): RcnWfsPage {
  validateXml(xml);
  const $ = load(xml, { xmlMode: true });
  const root = $.root().children();
  const prefix = root[0]?.name.split(":")[0];
  const namespace = root.attr(root[0]?.name.includes(":") ? `xmlns:${prefix}` : "xmlns");
  if (root.length !== 1 || namespace !== "http://www.opengis.net/wfs/2.0" || localName(root[0].name) !== "FeatureCollection" || /<(?:\w+:)?ExceptionReport\b/i.test(xml)) throw new Error("RCN_INVALID_COLLECTION");
  const attr = root.attr("numberReturned");
  if (!attr || !/^\d+$/.test(attr)) throw new Error("RCN_INVALID_METADATA");
  const returned = Number(attr);
  const matched = root.attr("numberMatched");
  if (returned > 10000 || !matched || (matched !== "unknown" && (!/^\d+$/.test(matched) || Number(matched) < returned || !Number.isSafeInteger(Number(matched))))) throw new Error("RCN_INVALID_METADATA");
  const sourceTimestamp = root.attr("timeStamp") ?? null;
  if (sourceTimestamp !== null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(sourceTimestamp) || !Number.isFinite(Date.parse(sourceTimestamp)) || !transactionDate(sourceTimestamp.slice(0, 10)))) throw new Error("RCN_INVALID_METADATA");
  const rows: RcnRawRow[] = [];
  root.children().each((_, member) => {
    if (localName(member.name) === "boundedBy") return;
    if (localName(member.name) !== "member") throw new Error("RCN_INVALID_MEMBER");
    const features = $(member).children();
    if (features.length !== 1 || localName(features[0].name) !== "lokale") throw new Error("RCN_INVALID_MEMBER");
    const row: RcnRawRow = {};
    features.children().each((_, field) => {
      const key = localName(field.name);
      if (key === "boundedBy" || key === "msGeometry") return;
      if ($(field).children().length || key in row) throw new Error("RCN_INVALID_FIELD");
      row[key] = $(field).text().trim();
    });
    rows.push(row);
  });
  if (rows.length !== returned) throw new Error("RCN_INVALID_METADATA");
  return { rows, returned, hasMore: !!root.attr("next") || (matched !== "unknown" && Number(matched) > returned), sourceTimestamp };
}
function address(row: RcnRawRow) {
  const parts = Object.fromEntries((row.LOK_ADRES ?? "").split(";").map(part => { const at = part.indexOf(":"); return at < 0 ? ["", ""] : [part.slice(0, at).trim(), part.slice(at + 1).trim()]; }));
  return { city: row.LOK_ADRESMSC ?? parts.MSC ?? "", street: row.LOK_ADRESUL ?? parts.UL ?? "", building: (row.LOK_ADRESNR_PORZ ?? parts.NR_PORZ ?? "").split(/\s*(?:m\.|lok\.|lokal\b|mieszkanie\b)/i)[0].trim() };
}
function transactionDate(raw: string | undefined): string | null {
  const date = /^(\d{4}-\d{2}-\d{2})(?:[ T]00:00:00(?:Z)?)?$/.exec(raw ?? "")?.[1];
  if (!date) return null;
  const parsed = new Date(date + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}
function quantile(sorted: number[], p: number) { const index = (sorted.length - 1) * p; const lo = Math.floor(index); return sorted[lo] + (sorted[Math.ceil(index)] - sorted[lo]) * (index - lo); }
const round = (n: number) => Math.round(n * 100) / 100;

export function buildTransactionComparison(subject: RcnSubject, rows: RcnRawRow[], options: { market: RcnMarket; now: Date; fetchedAt: string; truncated: boolean }): RcnComparison {
  const result: RcnComparison = { status: "insufficient_data", source: { ...source }, street: subject.street?.trim() || null, market: options.market, sampleCount: 0, rows: [], medianPricePerM2: null, q1PricePerM2: null, q3PricePerM2: null, estimatedRange: null, differencePct: null, fetchedAt: options.fetchedAt, truncated: options.truncated };
  if (!subject.city?.trim() || !subject.street?.trim()) return { ...result, status: "missing_location" };
  if (normalizeRcnLocation(subject.city) !== "lodz") return { ...result, status: "unsupported_location" };
  if (!subject.area || !Number.isFinite(subject.area) || subject.area <= 0) return { ...result, status: "missing_area" };
  if (!Number.isFinite(options.now.getTime())) return result;
  const today = options.now.toISOString().slice(0, 10);
  const oldest = new Date(options.now); const day = oldest.getUTCDate(); oldest.setUTCDate(1); oldest.setUTCMonth(oldest.getUTCMonth() - 24); oldest.setUTCDate(Math.min(day, new Date(Date.UTC(oldest.getUTCFullYear(), oldest.getUTCMonth() + 1, 0)).getUTCDate()));
  const cutoff = oldest.toISOString().slice(0, 10);
  // Group before filtering: a second unit in one transaction cannot disappear merely
  // because its area/address falls outside the requested comparable range.
  const transactions = new Map<string, RcnRawRow[]>();
  for (const row of rows) {
    const id = row.TRAN_LOKALNY_ID_IIP?.trim();
    if (!id || !row.LOK_ID_LOKALU?.trim()) continue;
    transactions.set(id, [...(transactions.get(id) ?? []), row]);
  }
  const candidates: Omit<RcnComparable, "id">[] = [];
  const seenSales = new Set<string>();
  for (const versions of transactions.values()) {
    if (new Set(versions.map(r => r.LOK_ID_LOKALU.trim())).size !== 1) continue;
    if (versions.some(r => !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(r.TRAN_WERSJA_ID ?? "") || !Number.isFinite(Date.parse(r.TRAN_WERSJA_ID.replace(" ", "T") + "Z")))) continue;
    const newest = versions.map(r => r.TRAN_WERSJA_ID.replace("T", " ")).sort().at(-1)!;
    const current = versions.filter(r => r.TRAN_WERSJA_ID.replace("T", " ") === newest);
    const economic = (r: RcnRawRow) => JSON.stringify([r.LOK_CENA_BRUTTO, r.LOK_POW_UZYT, r.NIER_UDZIAL, r.LOK_FUNKCJA, r.TRAN_RODZAJ_TRANS, r.TRAN_RODZAJ_RYNKU, r.DOK_DATA, address(r), r.NIER_OPIS ?? "", r.LOK_INFO ?? ""]);
    if (new Set(current.map(economic)).size !== 1) continue;
    const row = current[0]; const addr = address(row); const date = transactionDate(row.DOK_DATA);
    const price = positive(row.LOK_CENA_BRUTTO); const area = positive(row.LOK_POW_UZYT);
    if (!price || !area || !date || date < cutoff || date > today || row.NIER_UDZIAL?.trim() !== "1/1" || row.LOK_FUNKCJA !== "mieszkalna" || row.TRAN_RODZAJ_TRANS !== "wolnyRynek" || row.TRAN_RODZAJ_RYNKU !== (options.market === "secondary" ? "rynekWtorny" : "rynekPierwotny")) continue;
    if (normalizeRcnLocation(addr.city) !== "lodz" || normalizeRcnLocation(addr.street) !== normalizeRcnLocation(subject.street) || Math.abs(area - subject.area) > Math.max(10, subject.area * .2)) continue;
    if (/garaz|garaż|postoj|parking|udzia[lł]|[lł][aą]czn|pakiet|wraz z|dwa lokale|kilka lokali/i.test(`${row.NIER_OPIS ?? ""} ${row.LOK_INFO ?? ""}`)) continue;
    const saleKey = JSON.stringify([row.LOK_ID_LOKALU, date, price, area]);
    if (seenSales.has(saleKey)) continue;
    seenSales.add(saleKey);
    // Deliberately use the local-unit price, never transaction/property totals.
    candidates.push({ date, street: addr.street.trim(), building: /^\d+[A-Za-z]?(?:[/-]\d+[A-Za-z]?)?$/.test(addr.building) ? addr.building : null, area, price, pricePerM2: price / area, market: options.market });
  }
  candidates.sort((a, b) => b.date.localeCompare(a.date) || a.pricePerM2 - b.pricePerM2);
  // Robust quartiles describe the qualifying sample; do not silently remove high/low sales.
  const values = candidates.map(row => row.pricePerM2).sort((a, b) => a - b);
  result.sampleCount = candidates.length;
  result.rows = candidates.slice(0, 10).map((row, i) => ({ ...row, pricePerM2: round(row.pricePerM2), id: `rcn-${i + 1}` }));
  if (!values.length) return result;
  result.medianPricePerM2 = round(quantile(values, .5)); result.q1PricePerM2 = round(quantile(values, .25)); result.q3PricePerM2 = round(quantile(values, .75));
  if (values.length < 5) return result;
  result.status = "ready";
  result.estimatedRange = { low: Math.round(result.q1PricePerM2 * subject.area), high: Math.round(result.q3PricePerM2 * subject.area) };
  if (subject.price !== null && Number.isFinite(subject.price) && subject.price > 0) result.differencePct = round(((subject.price / subject.area) / result.medianPricePerM2 - 1) * 100);
  return result;
}
