import { areasCompatible } from "./identity-evidence.ts";

/**
 * Read-time cross-portal duplicate detection for Finder cards.
 *
 * The same flat is routinely published by one agency on OLX, Otodom, Gratka,
 * Nieruchomości-online, Domy.pl or Oferty.net. Portals almost never expose a
 * shared identifier, so explicit identity alone left those copies as separate
 * cards (Production 13.10: 238 000 zł / 37,07 m² on four portals and
 * 298 000 zł / 46,55 m² on three, split between Dopasowane and Do oceny).
 *
 * The rule is evidence-based and conservative:
 * - any hard contradiction (rooms, floor, street, building number, apartment
 *   number, city, top-level district, area outside tolerance, market, a large
 *   price gap) keeps the listings apart;
 * - an automatic link needs matching core facts (compatible area AND equal
 *   rooms) plus independent corroboration from location and content
 *   (description, photos, street, floor, title, offer number);
 * - matching price and area alone never link anything: such pairs become
 *   candidates for manual verification at most;
 * - two listings from the same portal are never linked automatically.
 */

export type CrossPortalListing = {
  id: string;
  source: string;
  price: number | null;
  area: number | null;
  rooms: number | null;
  floor?: string | null;
  address?: string | null;
  district?: string | null;
  city?: string | null;
  title?: string | null;
  description?: string | null;
  images?: readonly string[] | null;
};

export type CrossPortalEvidence =
  | "offer_reference"
  | "exact_area"
  | "compatible_area"
  | "rooms"
  | "price_equal"
  | "price_close"
  | "street"
  | "building_number"
  | "district"
  | "floor"
  | "title"
  | "description"
  | "photos";

export type CrossPortalConflict =
  | "same_source"
  | "area"
  | "rooms"
  | "floor"
  | "street"
  | "building_number"
  | "apartment_number"
  | "city"
  | "district"
  | "price_gap";

export type CrossPortalAssessment = {
  kind: "confirmed" | "candidate" | "separate";
  score: number;
  evidence: CrossPortalEvidence[];
  conflicts: CrossPortalConflict[];
  reason: string;
};

const WEIGHTS: Record<CrossPortalEvidence, number> = {
  offer_reference: 6,
  exact_area: 2,
  compatible_area: 1,
  rooms: 1,
  price_equal: 1,
  price_close: 0.5,
  street: 2,
  building_number: 1,
  district: 1,
  floor: 1.5,
  title: 1,
  description: 3,
  photos: 3,
};

/** Evidence that says something about the flat beyond its price/area/rooms. */
const CORROBORATING: ReadonlySet<CrossPortalEvidence> = new Set(["offer_reference", "street", "building_number", "district", "floor", "title", "description", "photos"]);
/** At least one of these must be present for an automatic link. */
const STRONG_CORROBORATION: ReadonlySet<CrossPortalEvidence> = new Set(["offer_reference", "description", "photos", "street"]);

export const CROSS_PORTAL_CONFIRM_SCORE = 7;
export const CROSS_PORTAL_CONFIRM_CORROBORATION = 3.5;
export const CROSS_PORTAL_CANDIDATE_SCORE = 4;

export function assessCrossPortalPair(left: CrossPortalListing, right: CrossPortalListing): CrossPortalAssessment {
  const evidence: CrossPortalEvidence[] = [];
  const conflicts: CrossPortalConflict[] = [];
  const sameSource = left.source === right.source;

  // Area: an exact match of a fractional area (37,07 m²) is a strong fact;
  // portals sometimes round, so a small tolerance is compatible but weaker.
  if (left.area === null || right.area === null) {
    return separate([], [], "missing_area");
  }
  if (!areasCompatible(left.area, right.area)) conflicts.push("area");
  else if (Math.abs(left.area - right.area) < 0.005 && hasFraction(left.area)) evidence.push("exact_area");
  else evidence.push("compatible_area");

  const leftText = `${left.title ?? ""}\n${left.description ?? ""}`;
  const rightText = `${right.title ?? ""}\n${right.description ?? ""}`;

  // A portal without a structured room count often states it in the text
  // ("dwupokojowe", "2 pok."); only an explicit statement is used.
  const leftRooms = left.rooms ?? roomsFromText(leftText);
  const rightRooms = right.rooms ?? roomsFromText(rightText);
  if (leftRooms !== null && rightRooms !== null) {
    if (leftRooms !== rightRooms) conflicts.push("rooms");
    else evidence.push("rooms");
  }

  if (left.price !== null && right.price !== null && left.price > 0 && right.price > 0) {
    const gap = Math.abs(left.price - right.price) / Math.max(left.price, right.price);
    if (gap === 0) evidence.push("price_equal");
    else if (gap <= 0.05) evidence.push("price_close");
    else if (gap > 0.25) conflicts.push("price_gap");
  }

  const leftFloor = parseFloorValue(left.floor) ?? floorFromText(leftText);
  const rightFloor = parseFloorValue(right.floor) ?? floorFromText(rightText);
  if (leftFloor !== null && rightFloor !== null) {
    if (leftFloor !== rightFloor) conflicts.push("floor");
    else evidence.push("floor");
  }

  const leftCity = normalizeKey(left.city);
  const rightCity = normalizeKey(right.city);
  if (leftCity && rightCity && !sameCity(leftCity, rightCity)) conflicts.push("city");

  const leftAddress = parseAddress(left.address) ?? parseAddress(streetFromText(leftText));
  const rightAddress = parseAddress(right.address) ?? parseAddress(streetFromText(rightText));
  if (leftAddress && rightAddress) {
    if (leftAddress.street !== rightAddress.street) conflicts.push("street");
    else {
      evidence.push("street");
      if (leftAddress.building && rightAddress.building) {
        if (leftAddress.building !== rightAddress.building) conflicts.push("building_number");
        else evidence.push("building_number");
      }
      if (leftAddress.apartment && rightAddress.apartment && leftAddress.apartment !== rightAddress.apartment) conflicts.push("apartment_number");
    }
  }

  const leftDistrict = resolveLodzDistrict(left.district, left.address, leftText);
  const rightDistrict = resolveLodzDistrict(right.district, right.address, rightText);
  if (leftDistrict.topLevel && rightDistrict.topLevel && leftDistrict.topLevel !== rightDistrict.topLevel) conflicts.push("district");
  else if ((leftDistrict.local && leftDistrict.local === rightDistrict.local) || (!leftDistrict.local && !rightDistrict.local && leftDistrict.topLevel && leftDistrict.topLevel === rightDistrict.topLevel)) evidence.push("district");

  const leftReference = offerReference(leftText);
  const rightReference = offerReference(rightText);
  if (leftReference && rightReference && leftReference === rightReference) evidence.push("offer_reference");

  if (tokenJaccard(titleTokens(left.title), titleTokens(right.title)) >= 0.5) evidence.push("title");
  if (descriptionsSimilar(left.description, right.description)) evidence.push("description");
  if (sharedPhoto(left.images, right.images)) evidence.push("photos");

  const score = evidence.reduce((sum, item) => sum + WEIGHTS[item], 0);
  const corroboration = evidence.filter((item) => CORROBORATING.has(item)).reduce((sum, item) => sum + WEIGHTS[item], 0);
  if (conflicts.length) return separate(evidence, conflicts, `conflict:${conflicts.join(",")}`, score);

  // Core facts: compatible area and equal rooms. When the room count is
  // unknown on one side only, an exact fractional area plus identical
  // content (description, photos or offer number) still identifies the flat.
  const roomsUnknown = leftRooms === null || rightRooms === null;
  const decisiveContent = evidence.some((item) => item === "description" || item === "photos" || item === "offer_reference");
  const coreMatch = (evidence.includes("rooms") && (evidence.includes("exact_area") || evidence.includes("compatible_area")))
    || (roomsUnknown && evidence.includes("exact_area") && decisiveContent);
  const strong = evidence.some((item) => STRONG_CORROBORATION.has(item));
  if (!sameSource && coreMatch && strong && score >= CROSS_PORTAL_CONFIRM_SCORE && corroboration >= CROSS_PORTAL_CONFIRM_CORROBORATION) {
    return { kind: "confirmed", score, evidence, conflicts, reason: "cross_portal_multi_evidence" };
  }
  // Identical fractional area and price on two portals without any
  // contradiction is never silently ignored: it goes to manual verification
  // even when the room count is unknown on one side.
  const samePriceAndExactArea = !sameSource && evidence.includes("exact_area") && (evidence.includes("price_equal") || evidence.includes("price_close"));
  if ((score >= CROSS_PORTAL_CANDIDATE_SCORE && (evidence.includes("exact_area") || corroboration > 0)) || samePriceAndExactArea) {
    return { kind: "candidate", score, evidence, conflicts, reason: sameSource ? "same_portal_similar_listing" : "cross_portal_partial_evidence" };
  }
  return separate(evidence, conflicts, "insufficient_evidence", score);
}

function separate(evidence: CrossPortalEvidence[], conflicts: CrossPortalConflict[], reason: string, score = 0): CrossPortalAssessment {
  return { kind: "separate", score, evidence, conflicts, reason };
}

/** Pre-filter key: two listings can only be duplicates when their areas round into a shared bucket. */
export function crossPortalAreaBuckets(area: number | null): string[] {
  if (area === null || !Number.isFinite(area) || area <= 0) return [];
  return [`area:${Math.floor(area)}`, `area:${Math.ceil(area)}`].filter((value, index, all) => all.indexOf(value) === index);
}

export function crossPortalEvidenceLabel(evidence: CrossPortalEvidence): string {
  return ({
    offer_reference: "ten sam numer oferty",
    exact_area: "identyczny metraż",
    compatible_area: "zgodny metraż",
    rooms: "ta sama liczba pokoi",
    price_equal: "ta sama cena",
    price_close: "zbliżona cena",
    street: "ta sama ulica",
    building_number: "ten sam numer budynku",
    district: "ta sama okolica",
    floor: "to samo piętro",
    title: "podobny tytuł",
    description: "podobny opis",
    photos: "wspólne zdjęcia",
  } satisfies Record<CrossPortalEvidence, string>)[evidence];
}

function hasFraction(value: number): boolean {
  return Math.abs(value - Math.round(value)) >= 0.005;
}

function normalizeKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.normalize("NFKD").replace(/[̀-ͯ]/gu, "").replace(/[łŁ]/gu, "l").toLocaleLowerCase("pl-PL").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return normalized || null;
}

function sameCity(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right} `) || right.startsWith(`${left} `);
}

const ENGLISH_FLOORS: Record<string, number> = { ground: 0, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const ROMAN_FLOORS: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 };
const ROMAN_PATTERN = "XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I";
/** Polish ordinal stems: "czwarte piętro", "na czwartym piętrze". */
const POLISH_ORDINAL_FLOORS: Array<[RegExp, number]> = [
  [/pierwsz/u, 1], [/drug/u, 2], [/trzeci/u, 3], [/czwart/u, 4], [/piat/u, 5], [/szost/u, 6], [/siodm/u, 7], [/osm/u, 8], [/dziewiat/u, 9], [/dziesiat/u, 10],
];

/**
 * Structured floor values as portals publish them: "4", "4/10", "parter",
 * Otodom "floor_4" / "FLOOR_4" / "ground_floor", English enums ("FOURTH",
 * "GROUND") and Roman numerals ("IV", "IV piętro"). Values that do not name
 * one floor ("floor_higher_10", "poddasze", "suterena") return null: an
 * unknown floor is never evidence and never a conflict.
 */
export function parseFloorValue(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= 60 ? value : null;
  const raw = value.trim();
  if (!raw) return null;
  const roman = new RegExp(`^(${ROMAN_PATTERN})(?:\\s*(?:p\\.|pi[eę]t(?:ro|rze)))?\\.?$`, "iu").exec(raw);
  if (roman && (roman[1] === roman[1].toUpperCase() || roman[1].length > 1 || raw.length > roman[1].length)) return ROMAN_FLOORS[roman[1].toUpperCase()] ?? null;
  const key = normalizeKey(raw.replace(/_/gu, " "));
  if (!key) return null;
  if (/^(?:parter|0|ground|ground floor|floor ground|floor 0|parterowe)$/u.test(key)) return 0;
  const english = /^(?:floor\s+)?(ground|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:\s+floor)?$/u.exec(key);
  if (english) return ENGLISH_FLOORS[english[1]];
  const numbered = /^(?:floor\s+|pietro\s+)?(\d{1,2})(?:\s.*)?$/u.exec(key);
  if (numbered) return Number(numbered[1]);
  return floorFromText(raw);
}

/** Only "N piętro", "na N piętrze", "piętro N", Roman/ordinal forms and "parter" describe the flat's floor; "4-piętrowy blok" does not. */
export function floorFromText(text: string): number | null {
  // Roman numerals are matched case-sensitively on the original text, so the
  // Polish conjunction "i" ("pokój i piętro wyżej") is never read as floor 1.
  const romanBefore = new RegExp(`(?:^|[^\\p{L}])(${ROMAN_PATTERN})\\s*(?:-?te|-?gie|-?cie|\\.)?\\s*pi[eę]t(?:ro|rze)(?![\\p{L}])`, "u").exec(text);
  if (romanBefore) return ROMAN_FLOORS[romanBefore[1]];
  const romanAfter = new RegExp(`pi[eę]tro\\s*(?:nr\\.?\\s*)?[:\\-]?\\s*(${ROMAN_PATTERN})(?![\\p{L}\\d])`, "iu").exec(text);
  if (romanAfter && romanAfter[1] === romanAfter[1].toUpperCase()) return ROMAN_FLOORS[romanAfter[1]];
  const key = normalizeKey(text) ?? "";
  const numbered = /\b(\d{1,2})\s*(?:te|gie|cie|me|ste)?\s*(?:pietro|pietrze)\b|\bpietro\s*(?:nr\s*)?(\d{1,2})\b/u.exec(key);
  if (numbered) return Number(numbered[1] ?? numbered[2]);
  const ordinal = /\b(\p{L}+)\s+(?:pietro|pietrze)\b/u.exec(key);
  if (ordinal) {
    const found = POLISH_ORDINAL_FLOORS.find(([pattern]) => pattern.test(ordinal[1]) && /(?:e|ym|im)$/u.test(ordinal[1]));
    if (found) return found[1];
  }
  return /\b(?:na parterze|parter mieszkania|mieszkanie na parterze)\b/u.test(key) ? 0 : null;
}

const ROOM_WORDS: Record<string, number> = { jedno: 1, dwu: 2, trzy: 3, cztero: 4, piecio: 5 };

function roomsFromText(text: string): number | null {
  const key = normalizeKey(text) ?? "";
  const found = new Set<number>();
  for (const match of key.matchAll(/\b(jedno|dwu|trzy|cztero|piecio)\s*pokojow\p{L}*/gu)) found.add(ROOM_WORDS[match[1]]);
  for (const match of key.matchAll(/\b(\d)\s*(?:pokoje|pokoi|pokojowe|pokojowy|pok)\b/gu)) found.add(Number(match[1]));
  if (/\bkawalerk\p{L}*/u.test(key)) found.add(1);
  // Contradicting statements in one text (e.g. "2 pokoje + kuchnia, 3 pokoje w ofercie obok") are not evidence.
  return found.size === 1 ? [...found][0] : null;
}

type ParsedAddress = { street: string; building: string | null; apartment: string | null };

const STREET_STOPWORDS = new Set(["lodz", "lodzkie", "mieszkanie", "sprzedam", "sprzedaz", "osiedle"]);

function parseAddress(value: string | null | undefined): ParsedAddress | null {
  if (!value) return null;
  const firstPart = value.split(",")[0] ?? value;
  const match = /^\s*(?:ul(?:ica|icy)?\.?|al(?:eja|ei)?\.?|pl(?:ac|acu)?\.?)?\s*([\p{L}][\p{L}.\- ]{2,40}?)\s*(?:(\d+[a-z]?)(?:\s*(?:\/|m\.?|lok\.?)\s*(\d+[a-z]?))?)?\s*$/iu.exec(firstPart);
  if (!match) return null;
  const street = normalizeKey(match[1]);
  if (!street || STREET_STOPWORDS.has(street) || resolveLodzDistrict(street, null, "").local || resolveLodzDistrict(street, null, "").topLevel) return null;
  return { street, building: match[2]?.toLowerCase() ?? null, apartment: match[3]?.toLowerCase() ?? null };
}

/** Only an explicit "ul./ulica/al./aleja" phrase in the listing text counts as a street. */
function streetFromText(text: string): string | null {
  const match = /\b(?:ul\.|ulica|ulicy|al\.|aleja|alei)\s+([\p{Lu}][\p{L}.\-]+(?:\s+[\p{Lu}][\p{L}.\-]+){0,2})(?:\s+(\d+[a-z]?))?/u.exec(text);
  return match ? `${match[1]}${match[2] ? ` ${match[2]}` : ""}` : null;
}

const LODZ_DISTRICTS: Record<string, string[]> = {
  baluty: ["baluty", "teofilow", "radogoszcz", "zubardz", "julianow", "marysin", "lagiewniki", "rogi", "arturowek", "kochanowka", "doly", "manii"],
  gorna: ["gorna", "chojny", "dabrowa", "rokicie", "ruda", "ruda pabianicka", "piastow", "kurak", "bronisin", "wiskitno", "nowe chojny", "chojny dabrowa", "niciarniana"],
  polesie: ["polesie", "retkinia", "karolew", "koziny", "zlotno", "zdrowie", "lublinek", "smulsko", "stare polesie", "nowe zlotno"],
  widzew: ["widzew", "stoki", "olechow", "janow", "zarzew", "widzew wschod", "dolina lodki", "mileszki", "andrzejow", "sikawa", "ksiezy mlyn"],
  srodmiescie: ["srodmiescie", "centrum", "stare miasto", "kosciuszki"],
};

function resolveLodzDistrict(district: string | null | undefined, address: string | null | undefined, text: string): { topLevel: string | null; local: string | null } {
  for (const value of [district, address]) {
    const key = normalizeKey(value);
    if (!key) continue;
    for (const [topLevel, names] of Object.entries(LODZ_DISTRICTS)) {
      for (const name of names) {
        const normalizedName = normalizeKey(name)!;
        if (new RegExp(`(?:^|\\s)${normalizedName}(?:$|\\s)`, "u").test(key)) {
          return { topLevel, local: normalizedName === topLevel ? null : normalizedName };
        }
      }
    }
  }
  // Text is used only for a neighbourhood that is named explicitly.
  const textKey = normalizeKey(text) ?? "";
  for (const [topLevel, names] of Object.entries(LODZ_DISTRICTS)) {
    for (const name of names) {
      const normalizedName = normalizeKey(name)!;
      if (normalizedName !== topLevel && new RegExp(`(?:^|\\s)${normalizedName}(?:$|\\s)`, "u").test(textKey)) return { topLevel, local: normalizedName };
    }
  }
  return { topLevel: null, local: null };
}

function offerReference(text: string): string | null {
  const match = /\b(?:nr|numer)\.?\s*(?:oferty|ogloszenia|ogłoszenia|ref(?:erencyjny)?\.?)\s*[:#]?\s*([A-Z0-9][A-Z0-9/\-_.]{2,30})/iu.exec(text);
  return match ? match[1].toUpperCase().replace(/[.\-_/]+$/u, "") : null;
}

const TITLE_STOPWORDS = new Set(["mieszkanie", "sprzedam", "sprzedaz", "na", "w", "z", "i", "do", "lodz", "lodzi", "m2", "m", "pokoje", "pokojowe", "pokoj", "pok", "zl", "ul", "oferta", "okazja", "bez", "posrednikow", "od", "zaraz"]);

function titleTokens(value: string | null | undefined): Set<string> {
  return new Set((normalizeKey(value) ?? "").split(" ").filter((token) => token.length >= 3 && !TITLE_STOPWORDS.has(token) && !/^\d+$/u.test(token)));
}

function tokenJaccard(left: Set<string>, right: Set<string>): number {
  if (left.size < 2 || right.size < 2) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function shingles(value: string | null | undefined): Set<string> {
  const words = (normalizeKey(value?.replace(/<[^>]+>/gu, " ")) ?? "").split(" ").filter(Boolean);
  const result = new Set<string>();
  for (let index = 0; index + 3 <= words.length; index += 1) result.add(words.slice(index, index + 3).join(" "));
  return result;
}

/**
 * Agencies paste the same description on every portal, but portals truncate
 * it or add their own boilerplate. Containment (shared three-word phrases
 * relative to the shorter text) tolerates that; very short texts are ignored.
 */
function descriptionsSimilar(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = shingles(left);
  const b = shingles(right);
  if (a.size < 12 || b.size < 12) return false;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared >= 10 && shared / Math.min(a.size, b.size) >= 0.5;
}

function sharedPhoto(left: readonly string[] | null | undefined, right: readonly string[] | null | undefined): boolean {
  if (!left?.length || !right?.length) return false;
  const keys = new Set(left.map(photoKey).filter(Boolean));
  return right.some((url) => {
    const key = photoKey(url);
    return Boolean(key && keys.has(key));
  });
}

/** Same image file across portals: identical path with transform parameters removed (portals re-host, so this is rare but decisive). */
function photoKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  } catch {
    return null;
  }
}
