/**
 * Real production bug: a Facebook listing with no structured `city` field
 * whose title/description named "Rzeszów" or "Piotrków Trybunalski" (neither
 * a Łódź satellite town) fell through to `unknown_city` (REVIEW) instead of
 * a genuine city_mismatch (REJECTED) under a Łódź filter, because the only
 * free-text city check that existed (OUTSIDE_LODZ_TOWN, lodz-satellite-
 * towns.ts) is a narrow list of towns immediately around Łódź, never meant
 * to cover the rest of the country.
 *
 * This is a second, separate list: real, well-known Polish cities from
 * elsewhere in the country (every voivodeship capital plus other large/
 * well-known cities). It is NOT exhaustive — no fixed list of Polish
 * localities can be — so a sufficiently obscure town's name will still fall
 * through to `unknown_city`, which is the documented, safe fallback for
 * "no location evidence found" rather than a false positive.
 *
 * Every entry here was checked against LODZ_CONTEXT (this feature's own
 * positive-evidence list of Łódź districts) and against common Polish words
 * for collision risk, exactly like lodz-satellite-towns.ts's own worked
 * example (`aleksandr\w*\s+lodzk\w*`, not bare `aleksandr\w*`, so an
 * ordinary "ul. Aleksandrowska" street reference never matches). Three
 * entries are deliberately OMITTED because their normalized stem collides
 * with an ordinary Polish word real-estate text routinely uses:
 *   - Tychy: "tych" is the genitive-plural determiner ("tych mieszkań").
 *   - Przemyśl: "przemysł/przemysłowy" ("industry/industrial") is common
 *     in property descriptions ("działka przemysłowa").
 *   - Piła: "piła" is the ordinary word for "saw" (the tool).
 * Two entries require a same-listing compound (city name + a specific
 * second word) rather than a bare stem, because the bare stem alone
 * collides with something else:
 *   - Piotrków Trybunalski: bare "piotrkow\w*" would also match
 *     "Piotrkowska", Łódź's own best-known street.
 *   - Dąbrowa Górnicza: bare "dabrow\w*" is already LODZ_CONTEXT's own
 *     pattern for Łódź's Dąbrowa district.
 *
 * Callers must normalize their own text first (strip diacritics, lowercase,
 * fold "ł"→"l"), exactly like lodz-satellite-towns.ts's own callers.
 */
export const OTHER_POLISH_CITY = /\b(warszaw\w*|krakow\w*|wroclaw\w*|poznan\w*|gdansk\w*|gdyni\w*|szczecin\w*|bydgoszcz\w*|lublin\w*|bialystok\w*|katowic\w*|gorzow\w*|zielon\w*\s+gor\w*|opol\w*|rzeszow\w*|kielc\w*|olsztyn\w*|czestochow\w*|radom\w*|sosnowic\w*|torun\w*|gliwic\w*|zabrz\w*|bytom\w*|bielsko\w*|rybnik\w*|plock\w*|elblag\w*|walbrzych\w*|wloclawek\w*|tarnow\w*|chorzow\w*|kalisz\w*|koszalin\w*|legnic\w*|grudziadz\w*|slupsk\w*|jaworzn\w*|nowy\w*\s+sacz\w*|jelen\w*\s+gor\w*|siedlc\w*|myslowic\w*|konin\w*|piotrkow\w*\s+trybunalsk\w*|inowroclaw\w*|lubin\w*|ostrowiec\w*|gniezn\w*|suwalk\w*|stargard\w*|glogow\w*|chelm\w*|zamosc\w*|tomaszow\w*|stalow\w*\s+wol\w*|tarnobrzeg\w*|kedzierzyn\w*|leszn\w*|swidnic\w*|ostrow\w*\s+wielkopolsk\w*|krosn\w*|sieradz\w*|skierniewic\w*|kutn\w*|dabrow\w*\s+gornicz\w*)\b/u;
