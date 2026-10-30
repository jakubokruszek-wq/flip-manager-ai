/* Generated from pinned existing property rules; scripts/desktop-fields.cjs --check */
(function(root){
"use strict";
                                                                                                                       

                                      
                                
                     
                                            
                                             
                                      
                                     
                    
  

                                      
               
                    
                       
                               
                   
                
                   
                      
                        
                              
                     
                              
                           
                         
                               

                                     
                           
                           
                                         
                                          
  

const BUY_PATTERNS                                                                                                       = [
  { name: "BUY_KUPIE", pattern: /\bkupie(?:\s+za\s+gotowke)?\b/u, requiresPropertyContext: true },
  { name: "BUY_CHCE_KUPIC", pattern: /\bchce\s+kupic\b/u, requiresPropertyContext: true },
  { name: "BUY_CHETNIE_KUPIE", pattern: /\bchetnie\s+kupie\b/u, requiresPropertyContext: true },
  { name: "BUY_INTERESUJE_MNIE_ZAKUP", pattern: /\binteresuje\s+mnie\s+zakup\b/u, requiresPropertyContext: true },
  { name: "BUY_POSZUKUJE", pattern: /\bposzukuje\s+(?:pilnie\s+)?(?:mieszkania|domu|nieruchomosci|kawalerki|apartamentu)\b/u, requiresPropertyContext: false },
  { name: "BUY_SZUKAM", pattern: /\bszukam\s+(?:pilnie\s+)?(?:mieszkania|domu|nieruchomosci|kawalerki|apartamentu)\b/u, requiresPropertyContext: false },
];

const SELL_PATTERNS                                                                     = [
  { name: "SELL_SPRZEDAM", pattern: /\bsprzedam\b/u },
  { name: "SELL_NA_SPRZEDAZ", pattern: /\bna\s+sprzedaz\b/u },
  { name: "SELL_DO_SPRZEDANIA", pattern: /\bdo\s+sprzedania\b/u },
  { name: "SELL_OFERUJE_NA_SPRZEDAZ", pattern: /\boferuje\s+na\s+sprzedaz\b/u },
  { name: "SELL_OFF_MARKET", pattern: /\boff\s*market\b/u },
  { name: "SELL_MAM_DO_ZAOFEROWANIA", pattern: /\bmam\s+do\s+zaoferowania\b/u },
  { name: "SELL_CENA_SPRZEDAZY", pattern: /\bcena\s+sprzedazy\b/u },
  { name: "SELL_SPRZEDAZ_MIESZKANIA", pattern: /\bsprzedaz\s+(?:mieszkania|domu|nieruchomosci|kawalerki|apartamentu)\b/u },
];

function resolveFacebookListingIntent(
  text                           ,
  visionIntent                                          ,
  visionConfidence                           ,
)                         {
  const normalized = normalizeIntentText(text ?? "");
  const signals = inspectNormalizedFacebookIntentSignals(normalized);
  const propertyContext = signals.propertyContext;
  const buySignal = signals.buySignals.length > 0;
  const sellSignal = signals.sellSignals.length > 0;
  const rentWantedSignal = /\b(szukam|poszukuje)\b[^.\n]{0,80}\b(wynajecia|najmu|wynajme)\b/u.test(normalized);
  // A leading "nie" ("nie do wynajęcia" = "not for rent") negates the phrase; without
  // this guard a sale post mentioning that it is *not* for rent would be misread as
  // a rental offer before the sell signal below ever gets a chance to be checked.
  // Every strong phrase here is rental-specific and unambiguous on its own — "czynsz
  // najmu" (rent itself, not the administrative "czynsz" fee a sale listing
  // routinely mentions) is deliberately NOT just "czynsz" alone, since that bare
  // word appears constantly in ordinary sale listings (administrative fees,
  // a mortgage estimate) and must never by itself flip a sale to a rental —
  // see "Na sprzedaż mieszkanie. Czynsz 615 zł." in facebook-intent.test.ts.
  const strongRentOfferSignal = /(?<!\bnie\s)\b(do wynajecia|wynajme|oferuje najem|na wynajem|czynsz najmu|odstepn[\p{L}]*|(?:wy)?najem)\b/u.test(normalized) && !rentWantedSignal;
  // "wolne od [data]" (available-from-date) is the standard Polish phrasing for
  // when a tenant may move in, and is overwhelmingly rental vocabulary — but,
  // unlike the phrases above, a sale listing occasionally uses it too ("wolne
  // od zaraz" = vacant possession available immediately). It must therefore
  // never override an EXPLICIT sale keyword (sprzedam, na sprzedaż, cena
  // sprzedaży, ...) — only the weak, keyword-free SELL_STRUCTURED_OFFER
  // heuristic, which is exactly the gap that let a real rental post with no
  // sale keyword at all ("Mieszkanie ... wolne od 1 ... 2000 zł 46 m2") be
  // read as a confident deterministic sale.
  const wolneOdSignal = /\bwolne\s+od\b/u.test(normalized) && !rentWantedSignal;
  // "zł/mies." is only a WEAK rental signal: it is a generic monthly-price-unit
  // marker, not rental-specific vocabulary — real sale listings routinely state
  // their administrative/HOA fee the same way ("czynsz administracyjny 500
  // zł/mies."). It may only tip a post toward RENT_OFFER when no EXPLICIT sale
  // keyword (sprzedam, na sprzedaż, cena sprzedaży, ...) is present. Deliberately
  // excludes SELL_STRUCTURED_OFFER (a bare area+price heuristic with no sale
  // keyword at all) from that override power: an ordinary rental ad routinely
  // states both an area and a monthly price too ("Kawalerka 30m2, 1500 zł/mies."),
  // so that weak, keyword-free heuristic must never itself suppress a rental read.
  const weakRentOfferSignal = /(?<!\bnie\s)\bzl\s*\/\s*mies\b/u.test(normalized) && !rentWantedSignal;
  const explicitSellSignal = signals.sellSignals.some((name) => name !== "SELL_STRUCTURED_OFFER");
  const rentOfferSignal = strongRentOfferSignal || (weakRentOfferSignal && !explicitSellSignal) || (wolneOdSignal && !explicitSellSignal);
  const serviceSignal = /\b(uslugi remontowe|wykonczenia wnetrz|posrednictwo|agent nieruchomosci|fotografia nieruchomosci)\b/u.test(normalized);
  // A post with an explicit sale keyword AND a strong, unambiguous rental
  // keyword together ("Sprzedam mieszkanie, ale możliwe też do wynajęcia.")
  // must never be silently classified RENT_OFFER (which would exclude it from
  // sale sourcing entirely — importFacebookWatcher only persists SELL_PROPERTY
  // as an actionable listing) nor silently treated as a clean, unconflicted
  // sale. It stays SELL_PROPERTY (so it is never excluded), but is flagged the
  // same way the existing BUY/SELL conflict already is — via `conflict: true`
  // and intentSource "CONFLICT" — carrying the same explainability the buy/
  // sell case already has, at a lower confidence than a clean deterministic
  // sale.
  const sellRentConflict = propertyContext && explicitSellSignal && (rentWantedSignal || strongRentOfferSignal);

  const normalizedVisionIntent = visionIntent ?? "UNKNOWN";
  if (sellRentConflict) return decision("SELL_PROPERTY", 0.6, "SELL_PROPERTY", normalizedVisionIntent, "CONFLICT", true);
  if (propertyContext && rentWantedSignal) return decision("RENT_WANTED", 0.96, "RENT_WANTED", normalizedVisionIntent, "UNKNOWN");
  if (propertyContext && rentOfferSignal) return decision("RENT_OFFER", 0.94, "RENT_OFFER", normalizedVisionIntent, "UNKNOWN");
  if (serviceSignal) return decision("SERVICE", 0.95, "SERVICE", normalizedVisionIntent, "UNKNOWN");
  if (buySignal && sellSignal) return decision("UNKNOWN", 0.35, "UNKNOWN", normalizedVisionIntent, "CONFLICT", true);
  if (propertyContext && buySignal) return decision("BUY_PROPERTY", 0.99, "BUY_PROPERTY", normalizedVisionIntent, "DETERMINISTIC_BUY");
  if (propertyContext && sellSignal) return decision("SELL_PROPERTY", 0.99, "SELL_PROPERTY", normalizedVisionIntent, "DETERMINISTIC_SELL");

  const boundedVisionConfidence = boundedConfidence(visionConfidence);
  if (visionIntent && visionIntent !== "UNKNOWN" && boundedVisionConfidence >= 0.75) {
    return decision(visionIntent, boundedVisionConfidence, "UNKNOWN", normalizedVisionIntent, "VISION");
  }
  if (visionIntent === "OTHER" && boundedVisionConfidence >= 0.75) return decision("OTHER", boundedVisionConfidence, "UNKNOWN", normalizedVisionIntent, "VISION");
  return decision("UNKNOWN", boundedVisionConfidence, "UNKNOWN", normalizedVisionIntent, "UNKNOWN");
}

function inspectFacebookIntentSignals(text                           )                        {
  return inspectNormalizedFacebookIntentSignals(normalizeIntentText(text ?? ""));
}

function facebookIntentSkipReason(intent                       )                                {
  if (intent === "SELL_PROPERTY") return null;
  if (intent === "BUY_PROPERTY") return "FACEBOOK_BUY_REQUEST";
  if (intent === "RENT_OFFER" || intent === "RENT_WANTED") return "FACEBOOK_RENT_REQUEST";
  if (intent === "SERVICE") return "FACEBOOK_SERVICE_POST";
  if (intent === "UNKNOWN") return "FACEBOOK_INTENT_UNKNOWN";
  return "FACEBOOK_NON_SALE_POST";
}

function decision(intent                       , confidence        , deterministicIntent                       , visionIntent                       , intentSource                      , conflict = false)                         {
  return { intent, confidence, reasonCode: facebookIntentSkipReason(intent), deterministicIntent, visionIntent, intentSource, conflict };
}

function normalizeIntentText(value        )         {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").replace(/\p{Cf}/gu, "").toLocaleLowerCase("pl-PL").replace(/ł/g, "l").replace(/\s+/g, " ").trim();
}

function inspectNormalizedFacebookIntentSignals(normalized        )                        {
  // "M3"/"M2" etc. is the standard Polish shorthand for apartment size and is
  // extremely common as the only property noun in short, terse posts/titles.
  const propertyContext = /\b(mieszkan[\p{L}\d]*|nieruchomo[\p{L}\d]*|kawalerk[\p{L}\d]*|apartament[\p{L}\d]*|pokoj[\p{L}\d]*|dom[\p{L}\d]*|lokal[\p{L}\d]*|dzial[\p{L}]*k[\p{L}]*|grunt[\p{L}]*|parcel[\p{L}]*|m[2-6])\b/u.test(normalized);
  const buySignals = BUY_PATTERNS
    .filter(({ pattern, requiresPropertyContext }) => (!requiresPropertyContext || propertyContext) && pattern.test(normalized))
    .map(({ name }) => name);
  const sellSignals = propertyContext
    ? SELL_PATTERNS.filter(({ pattern }) => pattern.test(normalized)).map(({ name }) => name)
    : [];
  if (
    propertyContext
    && buySignals.length === 0
    && /\b\d{1,3}(?:[.,]\d+)?\s*m(?:2)?\b/u.test(normalized)
    && /\b\d{2,7}(?:[\s.]\d{3})*(?:[.,]\d+)?\s*(?:tys(?:\.|iecy)?|zl|pln)\b/u.test(normalized)
  ) {
    sellSignals.push("SELL_STRUCTURED_OFFER");
  }
  return { normalizedLength: normalized.length, propertyContext, buySignals, sellSignals };
}

function boundedConfidence(value                           )         {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function explicitPolishCity(value                           )                {
  const normalized = normalizeCity(value);
  if (!normalized) return null;
  if (/\blodz(?:i)?\b/u.test(normalized)) return "Łódź";
  if (/\bwarszaw(?:a|ie|y)\b/u.test(normalized)) return "Warszawa";
  if (/\bzychlin\w*\b/u.test(normalized)) return "Żychlin";
  return null;
}

function explicitPolishGroupCity(value                           )                {
  if (!value) return null;
  const normalized = normalizeCity(value);
  return /(?:^|[^a-z])lodz(?:i)?(?:[^a-z]|$)/u.test(normalized) || /lodz(?:i)?/u.test(normalized)
    ? "Łódź"
    : null;
}

function normalizeCity(value                           )         {
  return value?.replace(/[łŁ]/g, "l").normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pl-PL").replace(/[^\p{L}\p{N}]+/gu, " ").trim() ?? "";
}


const PLACES = [
  ["radogoszcz zachód", "Radogoszcz Zachód", "Bałuty"], ["radogoszcz", "Radogoszcz", "Bałuty"],
  ["teofil", "Teofilów", "Bałuty"], ["retkini", "Retkinia", "Polesie"], ["dąbrow", "Dąbrowa", "Górna"],
]         ;
const DISTRICTS = ["Bałuty", "Widzew", "Polesie", "Śródmieście"];
// "Górna" is Łódź's only district name that is also an ordinary Polish
// adjective ("górny/górna" = "upper") -- unlike Bałuty/Widzew/Polesie/
// Śródmieście, a blind substring match (in ANY grammatical form, including
// the bare nominative "Górna" itself) would misread "Górna granica
// ceny"/"górna kondygnacja"/"w górnej części"/"z górnej szuflady" as the
// district, since "górna" the adjective and "Górna" the district are
// spelled identically in nominative form. It is therefore deliberately
// excluded from the generic DISTRICTS list above and handled only through
// mentionsGornaDistrict below: a mention is accepted only when it follows a
// location preposition ("na"/"w") or an explicit "dzielnica"/"osiedle"
// label, or ends the phrase at a comma/period (a real listing's "Górna,
// Łódź" / "na Górnej." pattern) -- and even then only when nothing that
// makes it the ordinary "upper X" adjective immediately follows.
const GORNA_UPPER_ADJACENT_NOUN = /^[^,.\n]{0,3}\b(kondygnacj|pietr|czesc|polow|warstw|granic|szafk|polk|szuflad|klatc|sufit|stron\w*)\w*/iu;
const GORNA_DISTRICT_MENTION = /\b(?:na|w|dzielnic\w*|osiedl\w*)\s+gorn(?:ej|a|ym|ych|emu|ego)\b|\bgorn(?:a|ej)\b\s*[,.]/giu;

/** Takes the already-diacritic-stripped, lowercased text (see extractFacebookProperty's `normalizedText`). */
function mentionsGornaDistrict(normalizedText        )          {
  return [...normalizedText.matchAll(GORNA_DISTRICT_MENTION)].some((mention) => {
    const start = (mention.index ?? 0) + mention[0].length;
    return !GORNA_UPPER_ADJACENT_NOUN.test(normalizedText.slice(start, start + 24));
  });
}
const FLAG_PHRASES = ["bezpośrednio", "bez pośredników", "do remontu", "generalny remont", "po babci", "pilnie", "okazja", "spadek", "do negocjacji", "prywatnie"];
const number = (value         ) => value ? Number(value.replace(",", ".").replace(/\s/g, "")) : null;
const boundedFloor = (value               ) => value !== null && value >= 0 && value <= 30 ? value : null;

const ROOM_MENTION = /\b(\d{1,2})\s*(?:[-–]\s*)?pok(?:oj(?:e|owy|owe|owych)?|oi|\.?)\b/giu;
const ROOM_POSSIBILITY = /(?:z\s+mozliwosc\w*|mozna\s+zrobic|wydziel\w*|przerob\w*|po\s+zmianie\s+uklad\w*|aran\w*)/giu;
const ROOM_CURRENT = /(?:obecnie|aktualnie|teraz|stan\s+obecn\w*)/iu;

/** Returns the explicitly stated current layout, never a potential rearrangement. */
function resolveActualRoomCount(text        )                {
  const normalized = text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("pl-PL");
  const mentions = [...normalized.matchAll(ROOM_MENTION)];
  let previousMentionEnd = 0;
  let firstNonPotential                = null;
  for (const mention of mentions) {
    const start = mention.index ?? 0;
    const between = normalized.slice(previousMentionEnd, start);
    const isPotential = ROOM_POSSIBILITY.test(between);
    ROOM_POSSIBILITY.lastIndex = 0;
    previousMentionEnd = start + mention[0].length;
    if (!isPotential && firstNonPotential === null) firstNonPotential = Number(mention[1]);
    if (!isPotential && ROOM_CURRENT.test(between)) return Number(mention[1]);
  }
  return firstNonPotential;
}

                                       
                       
                            
                                                                                      
  

const AUXILIARY_PRICE_CONTEXT = /(?:czynsz|opłat|kaucj|wyposażeni|mebl|remont|prowizj|telefon|tel\.?|\brat[ay]\b|zaliczk|przedpłat|\bmedi[ae]\b|administracj|wspólnot|fundusz\s*remontow\w*|abonament|ubezpieczeni|\bpodatek\b|\bpr[ąa]d\b|\bgaz\b|\bwod[ęya]\b|internet)[^\n]{0,24}$/i;
const MONTHLY_AMOUNT_SUFFIX = /^\s*(?:\/\s*mies(?:\.|iąc\w*)?|miesięczn\w*)/iu;
// "sprzeda*" ("sprzedam"/"sprzedaż"/"sprzedaje") re-anchors a number to the
// sale price exactly as authoritatively as "cena"/"kwota" -- without it,
// "Czynsz 700 zł, sprzedam za 260 000 zł" wrongly treated the 260 000 as part
// of the earlier czynsz's auxiliary context too, since nothing between them
// reset the anchor, and returned no price at all for a post that states one
// completely unambiguously.
const SALE_PRICE_RESET_KEYWORD = /cena|kwota|sprzeda/gi;

/**
 * A fee mentioned earlier in the same lookback window (e.g. "Niski czynsz
 * 615zł. Metraż 53m Cena 489tyś") must never suppress a later, clearly
 * distinct sale price — but a fee keyword immediately next to its OWN number
 * ("Czynsz 1500zł") must still exclude that number. The distinguishing
 * signal is an explicit "cena"/"kwota" mention sitting between the fee
 * keyword and the number under test: that re-anchors the number to the sale
 * price, closer than the fee keyword is.
 */
function isAuxiliaryPriceContext(window        )          {
  const auxiliaryMatch = window.match(AUXILIARY_PRICE_CONTEXT);
  if (!auxiliaryMatch) return false;
  const resetMatches = [...window.matchAll(SALE_PRICE_RESET_KEYWORD)];
  const lastReset = resetMatches[resetMatches.length - 1];
  return !lastReset || (lastReset.index ?? 0) < (auxiliaryMatch.index ?? 0);
}

function resolveFacebookPrice(text        , area               )                          {
  // Facebook renders "**bold**" (and "_italic_") markdown literally in the
  // post text it hands back -- "za **260 000** z\u0142" has the asterisks sitting
  // directly between the number and its currency marker, which every pattern
  // below expects to be separated only by whitespace. Stripping markdown
  // emphasis markers before matching fixes this for every pattern at once,
  // rather than patching each one's gap individually.
  const normalized = text.replace(/[\u00a0\u202f]/g, " ").replace(/[*_]+/g, "");
  const perM2 = uniqueNumbers(Array.from(normalized.matchAll(/(\d{1,3}(?:\s\d{3})+|\d{3,6})(?:[.,](\d{1,2}))?\s*(?:zł|pln)\s*\/\s*m(?:2|²)(?![\p{L}\d])/giu)), (match) => decimalNumber(match[1], match[2]));
  // Thousands groups are colloquially separated by a space OR a dot
  // ("489 000 zł" / "489.000 zł") — contextualTotals already accepted both;
  // this must too, for the same reason decimalNumber() already strips either
  // separator: a dot between two groups of exactly 3 digits is structurally
  // always a group separator here, never a decimal point.
  const explicitTotals = uniqueNumbers(Array.from(normalized.matchAll(/(\d{1,3}(?:[\s.]\d{3})+|\d{4,9})(?:[.,](\d{1,2}))?\s*(?:zł|pln)(?!\p{L})/giu))
    .filter((match) => !/^\s*\/\s*m(?:2|²)/iu.test(normalized.slice(match.index  + match[0].length)) && !MONTHLY_AMOUNT_SUFFIX.test(normalized.slice(match.index  + match[0].length)) && !isAuxiliaryPriceContext(normalized.slice(Math.max(0, match.index  - 32), match.index))), (match) => decimalNumber(match[1], match[2]));
  // "tyś" (colloquial misspelling with an accented ś) is at least as common in
  // real listing text as the correct "tys" — both must resolve identically.
  const thousandsTotals = uniqueNumbers(Array.from(normalized.matchAll(/(\d{2,4}(?:[.,]\d+)?)\s*(?:ty[sś]\.?|tysi(?:ąc(?:e|y)?)?)/giu))
    .filter((match) => !/^\s*(?:zł|pln)?\s*\/\s*m(?:2|²)/iu.test(normalized.slice(match.index  + match[0].length)) && !MONTHLY_AMOUNT_SUFFIX.test(normalized.slice(match.index  + match[0].length)) && !isAuxiliaryPriceContext(normalized.slice(Math.max(0, match.index  - 32), match.index))), (match) => Math.round((number(match[1]) ?? 0) * 1000));
  // Colloquial "399k" / "300 K" shorthand. `(?!\w)` keeps it from matching inside another
  // word (e.g. "300km"), so only a bare k/K right after the digits counts.
  const kNotationTotals = uniqueNumbers(Array.from(normalized.matchAll(/(\d{2,4}(?:[.,]\d+)?)\s*[kK](?!\w)/g))
    .filter((match) => !MONTHLY_AMOUNT_SUFFIX.test(normalized.slice(match.index  + match[0].length)) && !isAuxiliaryPriceContext(normalized.slice(Math.max(0, match.index  - 32), match.index))), (match) => Math.round((number(match[1]) ?? 0) * 1000));

  const contextualTotals = Array.from(normalized.matchAll(/(?:^|[^\p{L}])(?:cena(?:\s+(?:ofertowa|sprzeda[żz]y?))?|kwota(?:\s+do\s+negocjacji)?)\s*[:=-]?\s*(\d{1,3}(?:[\s.]\d{3})+|\d{4,9})(?:[.,](\d{1,2}))?(?![\d])/giu));
  const contextual = singleValue(uniqueNumbers(contextualTotals, (match) => decimalNumber(match[1], match[2])));
  if (contextual !== null) return { price: contextual, pricePerM2: singleValue(perM2), source: "EXPLICIT_TOTAL" };
  const explicit = singleValue(explicitTotals);
  if (explicit !== null) return { price: explicit, pricePerM2: singleValue(perM2), source: "EXPLICIT_TOTAL" };
  const thousands = singleValue([...thousandsTotals, ...kNotationTotals]);
  if (thousands !== null) return { price: thousands, pricePerM2: singleValue(perM2), source: "THOUSANDS_TOTAL" };
  const unitPrice = singleValue(perM2);
  if (unitPrice !== null && area !== null && area > 0) {
    return { price: Math.round(area * unitPrice), pricePerM2: unitPrice, source: "DERIVED_FROM_PRICE_PER_M2" };
  }
  return { price: null, pricePerM2: unitPrice, source: "NONE" };
}

function decimalNumber(integer        , decimals                    )         {
  // `integer` may be a thousands-grouped literal using either a space or a dot as the
  // group separator (see the `contextualTotals` pattern below, e.g. "665.500"). A dot
  // here is structurally always a group separator, never a decimal point — a real
  // fractional part only ever arrives separately, in `decimals`. Stripping it is what
  // turns "cena: 665.500 PLN" into 665500 instead of misreading it as 665.5.
  return Number(`${integer.replace(/[\s.]/g, "")}${decimals ? `.${decimals}` : ""}`);
}

function uniqueNumbers(matches                    , convert                                     )           {
  return [...new Set(matches.map(convert).filter((value) => Number.isFinite(value) && value > 0))];
}

function singleValue(values          )                {
  return values.length === 1 ? values[0] : null;
}

const STREET_UL_MATCH = /\b(?:ul\.?|ulica)\s+([\p{L}][\p{L}\s.-]{1,40}?)(?:\s+(\d+[\p{L}]?))?(?=,|\.|\n|$)/iu;
const STREET_PREFIXED_MATCH = /\b(al\.?|aleja|pl\.?|plac)\s+([\p{L}\d][\p{L}\d\s.-]{1,40}?)(?:\s+(\d+[\p{L}]?))?(?=,|\.|\n|$)/iu;

/**
 * Recognizes an explicit Polish street name behind `ul./ulica` (prefix stripped, matching
 * long-standing behavior) or `al./aleja/pl./plac` (prefix preserved, since a numbered street
 * name like "1 Maja" reads as an address only with its "al." qualifier attached). Never
 * guesses arbitrary text — city names, room counts, prices and phone numbers all lack these
 * prefixes and so are never mistaken for a street.
 */
function extractPolishStreet(text        )                {
  const stripped = text.match(STREET_UL_MATCH);
  if (stripped) return [stripped[1]?.trim(), stripped[2]].filter(Boolean).join(" ");
  const prefixed = text.match(STREET_PREFIXED_MATCH);
  return prefixed ? [prefixed[1], prefixed[2]?.trim(), prefixed[3]].filter(Boolean).join(" ") : null;
}

/**
 * Resolves the price-per-m² to persist for a Facebook listing: an explicit authoritative
 * unit price always wins (it survives even when total price/area are absent), falling back
 * to price/area only when both are known, and to null otherwise. Never a second, competing
 * unit-price calculation — this is the single source of truth callers must use.
 */
function resolveFacebookPricePerSqm(property                                                                          )                {
  if (property.pricePerM2 !== null && property.pricePerM2 > 0) return property.pricePerM2;
  return property.price && property.area ? property.price / property.area : null;
}

/** Deterministic condition classification from authoritative text; never the whole description. */
function classifyFacebookCondition(normalizedText        )                                {
  if (/po\s+remoncie|gotow\w*\s+do\s+(?:wprowadzenia|zamieszkania)|do\s+wejscia/u.test(normalizedText)) return "ready";
  if (/do\s+(?:generalnego\s+)?remontu|po\s+babci/u.test(normalizedText)) return "renovation";
  return null;
}

/** Same classification, taking raw (unnormalized) text — for callers outside the extraction pipeline. */
function classifyFacebookConditionFromText(text        )                                {
  return classifyFacebookCondition(text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("pl-PL").replace(/ł/g, "l"));
}


function normalizePreviewArea(text) {
 if(typeof text!=='string'||text.length>12000)return typeof text==='string'?text:'';
 // Delimit area tokens before pinned price/address rules: the ASCII unit's 2
 // must not become the first digit of the following total or a house number.
 const unit=/(?<![\p{L}\d.,])(\d{1,3}(?:[.,]\d+)?)\s*m(2|²)(?![\p{L}\d])/giu;
 text=text.replace(unit,'$1 m$2; ');
 // Bare metres only immediately after the Polish M2..M6 apartment shorthand,
 // with an explicit sale signal and no distance wording or competing area.
 if(!/\d\s*m(?:2|²)/iu.test(text)&&/\b(?:sprzedam|sprzeda[żz]|sprzedania)(?![\p{L}])/iu.test(text)){
  const bare=[...text.matchAll(/\bm[2-6]\s+(\d{1,3}(?:[.,]\d{1,2})?)\s*m(?![\p{L}\d²])/giu)];
  if(bare.length===1){const b=bare[0],n=Number(b[1].replace(',','.')),tail=text.slice(b.index+b[0].length,b.index+b[0].length+60).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
   if(n>=10&&n<=300&&!/^\s*(?:od|do|dystans|odleglos|przystan|autobus|tramwaj|drogi|chodnik)\b/u.test(tail))text=text.slice(0,b.index)+b[0].replace(/\d{1,3}(?:[.,]\d{1,2})?\s*m$/iu,'; '+b[1]+' m²; ')+text.slice(b.index+b[0].length);
  }
 }

 const normalized=text.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('pl-PL').replace(/ł/g,'l');
 if(!/\b(?:zl|pln)\s*\/\s*m2\b/u.test(normalized)||!/\b[1-9]\d?\s*(?:pokoje|pokoi|pokoj|pokojowe)\b/u.test(normalized))return text;
 // Never override an explicit square-metre value or resolve a conflict by order.
 if(/\d\s*m(?:2|²)(?![\p{L}\d])/iu.test(text))return text;
 const candidates=[...text.matchAll(/(?<![\p{L}\d.,])(\d{1,3}(?:[.,]\d{1,2})?)\s+metr(?:y|ów|ow)\b(?=\s*(?:[·•;|,\n]|$))/giu)];
 if(candidates.length!==1)return text;
 const m=candidates[0],value=Number(m[1].replace(',','.'));
 if(!Number.isFinite(value)||value<10||value>300)return text;
 const prefix=normalized.slice(Math.max(0,m.index-64),m.index);
 if(/odleglos|dystans|przystan|autobus|tramwaj|ogrodzeni|odcinek|drogi|chodnik/u.test(prefix))return text;
 return text.slice(0,m.index)+m[1]+' m2'+text.slice(m.index+m[0].length);
}
function previewStreet(text){return extractPolishStreet(text.replace(/(?<![\p{L}\d.,])\d{1,3}(?:[.,]\d+)?\s*m(?:2|²)(?![\p{L}\d])/giu,'\n'));}

function previewFields(input) {
  const text = normalizePreviewArea(input.postText ?? "");
  const lower = text.toLocaleLowerCase("pl-PL");
  const normalizedText = text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("pl-PL").replace(/ł/g, "l");
  const place = PLACES.find(([needle]) => lower.includes(needle));
  const districtFound = DISTRICTS.find((item) => lower.includes(item.toLocaleLowerCase("pl-PL"))) ?? (mentionsGornaDistrict(normalizedText) ? "Górna" : null);
  const area = number(text.match(/(\d{1,3}(?:[.,]\d+)?)\s*m(?:²|2)\b/i)?.[1]);
  const unicodeArea = number(text.match(/(\d{1,3}(?:[.,]\d+)?)\s*m\u00b2(?![\p{L}\d])/iu)?.[1]);
  // Colloquial "Metraż 53m" / "Powierzchnia 53m" drops the "2"/area-sign
  // suffix entirely — only recognized right after that explicit area
  // keyword (never a bare "Xm" anywhere in the text, which would just as
  // easily be a distance or an unrelated measurement), and never when a
  // proper m2 suffix is present (the negative lookahead), so it can never
  // double-count or override a well-formed match above.
  const bareMArea = number(text.match(/(?:metra[żz]\w*|powierzchni\w*)[^\n\d]{0,15}(\d{1,3}(?:[.,]\d+)?)\s*m\b(?!2|²|\w)/iu)?.[1]);
  const effectiveArea = unicodeArea ?? area ?? bareMArea;
  const price = resolveFacebookPrice(text, effectiveArea);
  const mRoomValues = [...normalizedText.matchAll(/\bm([2-6])\b/gu)]
    .filter((match) => !/[#\d]\s*$/u.test(normalizedText.slice(Math.max(0, (match.index ?? 0) - 4), match.index)))
    .map((match) => Number(match[1]));
  const mRooms = new Set(mRoomValues).size === 1 ? mRoomValues[0] : null;
  const explicitRoomCount = resolveActualRoomCount(text);
  // Polish phrasing states the floor both ways ("piętro 11" and "11 piętro" /
  // "11. piętro"); both must resolve to the same floor, never just one order.
  const floorBeforeWord = normalizedText.match(/\b(\d{1,2})\.?\s*(?:pietro|pietrze|p\.)\b/u)?.[1];
  const floorAfterWord = normalizedText.match(/\bpietr(?:o|ze)\s+(\d{1,2})\b/u)?.[1];
  const floor = boundedFloor(number(floorBeforeWord ?? floorAfterWord));
  const fraction = normalizedText.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\s*(?:pietro|p\.)\b/u)
    ?? normalizedText.match(/\bpietr(?:o|ze)\s+(\d{1,2})\s*\/\s*(\d{1,2})\b/u);

 const intent=resolveFacebookListingIntent(text,null,null).intent;
 const concrete=!['BUY_PROPERTY','RENT_WANTED','SERVICE','OTHER'].includes(intent);
 const sale=intent==='SELL_PROPERTY'||intent==='UNKNOWN';
 const street=previewStreet(text);
 const district=place?.[2]??districtFound;
 const neighborhood=place?.[1]??null;
 const rooms=explicitRoomCount??(mRooms?Math.max(1,mRooms-1):null);
   const realEstateLanguage = /mieszkan|nieruchomo|kawalerk|apartament|lokal mieszkal|\bm[2-6]\b|pok[oó]j|balkon/.test(text);
 const explicitCity=explicitPolishCity(text);
 const foreignCity=explicitCity!==null&&explicitCity!=='Łódź';
 const usable=!foreignCity&&(realEstateLanguage||[price.price,effectiveArea,rooms,neighborhood,district,street].filter(x=>x!==null).length>=3);
 const hasFields=[sale?price.price:null,concrete?effectiveArea:null,concrete?rooms:null].some(v=>v!==null);
 const qualification=!text.trim()?'NO_TEXT':!sale?'INTENT':foreignCity?'FOREIGN_CITY':!usable?'NOT_PROPERTY':!hasFields?'MISSING_FIELDS':'CANDIDATE';
 return {qualification,price:sale?price.price:null,priceSource:sale?price.source:'NONE',area:concrete?effectiveArea:null,rooms:concrete?rooms:null,district:foreignCity?null:district,neighborhood:foreignCity?null:neighborhood,street,intent,usable};
}

const api={previewFields};if(typeof module!=="undefined")module.exports=api;root.FlipDesktopFields=api;
})(globalThis);
