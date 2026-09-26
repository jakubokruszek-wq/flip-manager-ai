/**
 * Towns near Łódź that share street/highway names or sound similar in casual
 * text, but are administratively distinct cities and must never be treated as
 * Łódź itself (e.g. "Aleksandrów Łódzki" is its own town, not a district of
 * Łódź). Matched narrowly: "aleksandr\w*\s+lodzk\w*" requires the "łódzki"
 * adjective (in any declined form — łódzki/łódzkim/łódzkiego/…) to
 * immediately follow "Aleksandrów" in any of its own declined forms
 * (Aleksandrów/Aleksandrowie/Aleksandrowa/…, since Polish real-estate titles
 * routinely use the locative "w Aleksandrowie Łódzkim" rather than the
 * nominative). An ordinary Łódź street name like "ul. Aleksandrowska" is a
 * single word with no following "łódzk…" word, so it never matches.
 *
 * Callers must normalize their own text first (strip diacritics, lowercase,
 * fold "ł"→"l") before testing against these patterns — each caller in this
 * codebase already has its own normalize step with slightly different rules,
 * so normalization intentionally stays their responsibility rather than
 * being duplicated here.
 */
export const OUTSIDE_LODZ_TOWN = /\b(belchat\w*|pabianic\w*|zgierz\w*|sokolnik\w*|prusinowic\w*|szadk\w*|jezew\w*|dlutow\w*|aleksandr\w*\s+lodzk\w*|konstantynow\w*\s+lodzk\w*)\b/u;

/** Positive evidence a text is genuinely about Łódź itself or one of its districts. */
export const LODZ_CONTEXT = /\b(lodz|balut\w*|teofil\w*|widzew\w*|retkini\w*|polesi\w*|gorn\w*|srodmies\w*|radogoszcz\w*|zubardz\w*|chojn\w*|doly|dabrow\w*|rokici\w*|janow\w*)\b/u;
