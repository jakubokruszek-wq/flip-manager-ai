/**
 * Decides whether a Facebook group's own (real, Facebook-rendered) name
 * reads as a real-estate group, so discovery never offers every group the
 * user has ever joined for import without any filtering at all.
 *
 * Diacritic/case/inflection-safe: normalized the same way
 * features/facebook-watcher/facebook-intent.ts already does (NFKD strip,
 * "ł"->"l", lowercase with the Polish locale) before matching, so
 * "Nieruchomości", "NIERUCHOMOŚCI" and "nieruchomosci" are all recognized
 * identically.
 *
 * Deliberately weak signals ("biznes", "inwestycje", a bare city name) never
 * classify a group as real estate by themselves -- only a real property noun
 * or an explicit buy/rent/sell verb does. This is a discovery-time filter
 * only: the operator can always manually reclassify and import any group
 * regardless of this result (see discovery.ts's manual override).
 */
export function normalizeGroupNameForClassification(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/\p{Cf}/gu, "")
    .toLocaleLowerCase("pl-PL")
    .replace(/ł/g, "l")
    .replace(/\s+/g, " ")
    .trim();
}

// Real-estate nouns: nieruchomości, mieszkania/mieszkanie, kawalerki, domy,
// lokale, działki, grunty, flipy/flipperzy, deweloper(zy/ski), apartamenty,
// inwestorzy (nieruchomości) -- unlike the generic "inwestycje" (investments)
// business term this module deliberately treats as too weak, "inwestor(zy)"
// names a role specific enough to this real-estate-flipper extension's own
// group list that it is kept independently sufficient, per an explicit,
// unqualified mission requirement.
const REAL_ESTATE_NOUN_PATTERN = /\b(nierucho\w*|mieszkan\w*|kawalerk\w*|apartament\w*|dom[a-z]*|lokal[a-z]*|dzial\w*k\w*|grunt\w*|flip[a-z]*|deweloper\w*|inwestor\w*)\b/u;

// "wynajem" is the mission's own separate, standalone-sufficient bullet: in
// real Polish Facebook group names it is overwhelmingly a property-rental
// term on its own (unlike a generic sale/purchase verb -- see below).
const RENTAL_PATTERN = /\bwynaj\w*\b/u;

// The mission's "kupno/sprzedaż" bullet names the paired "buy-sell"
// marketplace-group convention (e.g. "Kupno-Sprzedaż Nieruchomości"), not
// either verb alone: a bare "sprzeda*" or "kup*" matches an enormous range
// of non-property marketplaces ("Sprzedam telefon", "Kupię rower" -- proven
// by this module's own test suite), so only BOTH appearing together counts.
const BUY_PATTERN = /\bkup\w*\b/u;
const SELL_PATTERN = /\bsprzeda\w*\b/u;

export function isRealEstateGroupName(name: string | null | undefined): boolean {
  if (!name || !name.trim()) return false;
  const normalized = normalizeGroupNameForClassification(name);
  if (REAL_ESTATE_NOUN_PATTERN.test(normalized) || RENTAL_PATTERN.test(normalized)) return true;
  return BUY_PATTERN.test(normalized) && SELL_PATTERN.test(normalized);
}
