/**
 * Catalogue and safety policy for Łódź municipal, cooperative and insolvency
 * notices. Their adapters remain schema-gated per-GROUP status in
 * source-availability.ts because pages publish mixed tenders (apartments,
 * commercial units, works and services); the parser must classify each
 * notice before a sale listing can be persisted.
 *
 * Fully re-investigated per-site (2026-10-03), one real, read-only GET per
 * source, following each site's own real navigation rather than guessing a
 * shared URL/selector (the same technique that activated
 * oferty.net/szybko/domy/allegro_lokalnie in external-source-adapters.ts).
 * The previous catalogue's `url` was WRONG (a homepage or category menu
 * rather than the real notice list) for several sources; those are
 * corrected below, each with the real sub-navigation path that was followed
 * to find it. Every site runs a genuinely different CMS/platform with its
 * own markup (Joomla, WordPress + Elementor, WordPress plain, TYPO3, a
 * bespoke "Strony" CMS, Nuxt 3) -- confirmed by direct inspection, not
 * assumed -- so official-lodz-adapters.ts gives each one its own parser
 * function and its own selector, never a shared one. Per-site findings:
 *
 * - sm-dabrowa (Joomla): url corrected to the real notice list
 *   (/informacje/oferty-przetargi). List teasers link to detail pages whose
 *   prose contains genuine sale data: "lokal mieszkalny nr 83 ... składa się
 *   z 2-ch pokoi ... o łącznej pow. użytkowej 36,74 m2" and "Cena wywoławcza
 *   wynosi 222 000,00 zł". Implemented as a 2-step list->detail parser.
 * - sm-teofilow (bespoke HTML, Windows-1250/mojibake source encoding): the
 *   registered URL was already correct. All notices are inline on one page
 *   (some wrapped in HTML comments -- stale, must be stripped). Found a real
 *   residential auction notice: "Kwota wywoławcza wynosi 231 000 zł",
 *   "Wadium wynosi 23 100 zł", "Wysokość postąpienia wynosi 2 000 zł".
 *   Implemented as a single-page prose parser.
 * - smtl: fails TLS certificate validation (schannel: SEC_E_WRONG_PRINCIPAL,
 *   hostname mismatch) on every connection attempt -- a properly-verifying
 *   HTTPS client (including this app's own fetch()) refuses the connection
 *   outright. Left wired but fails closed; never bypassed with insecure TLS.
 * - sm-chojny (WordPress + Elementor + Slider Revolution): /przetargi/ is
 *   reachable (200) but its content is generic lorem-ipsum-style placeholder
 *   text ("To help customers block out even more of the sun, consider
 *   offering window-tinting services...") under headings like "Opis
 *   przetargu nr. 1" -- the real site was apparently never populated with
 *   actual tender content. Left wired but fails closed with that evidence.
 * - sm-srodmiescie (WordPress): the registered URL is correct and real --
 *   a single tender announcement listing individual units in a repeating
 *   "<code> [zobacz] / powierzchnia: X m², <address>, za cenę nie niższą
 *   niż X zł, kwota wadium X zł" text pattern. The live tender (checked
 *   2026-10-03) lists only commercial units/storage rooms, zero residential
 *   ("lokal mieszkalny") entries -- the parser correctly classifies every
 *   current entry as excluded; it would pick up a residential unit the
 *   moment one appears, same pattern, same page.
 * - sm-karolew (bespoke HTML): /przetargi.html lists real current/historical
 *   tenders; today's current tender is "remont WLZ, wymianę przykanalików,
 *   remont fragmentu drogi" (maintenance works) -- correctly excluded.
 * - sm-retkinia-polnoc (bespoke "Strony,ID" CMS, smlodz.pl): the Przetargi
 *   page links to 2 real sub-pages ("przetarg dotyczący wyboru wykonawców",
 *   "Wyniki przetargu") -- a contractor-selection notice and historical
 *   results, both correctly excluded/non-open today. 2-step list->detail.
 * - sm-retkinia-poludnie (WordPress): url corrected from the "wyniki
 *   przetargow" (results/historical) page to the real open-tenders page
 *   (/przetargi/przetargi-lokali-mieszkalnych-i-uzytkowych/). It genuinely
 *   lists 2 current residential units ("ustalenie odrębnej własności lokalu
 *   nr 15 ...", "nr 8 ...") with address and area (e.g. "80 m² w budynku
 *   wolnostojącym") in a real Zdjęcie/Adres/Opis table -- but NO price
 *   anywhere in the HTML for either (price is presumably attachment-only).
 *   Implemented to extract address/area; listings without an extractable
 *   price are correctly dropped by the existing price>0 requirement rather
 *   than persisted with a fabricated price.
 * - sm-radogoszcz-wschod (WordPress): url corrected to the real tenders page
 *   (/aktualnosci/przetargi/). List teasers link to detail pages; found a
 *   real, fully-structured residential sale notice: "Lokal nr 14, przy ul.
 *   Sitowie 15A, blok 9, o powierzchni 42,36 m², 2 pokoje, IV piętro. Cena
 *   wywoławcza wynosi: 259 000,00 zł", plus real eligibility criteria and an
 *   auction date. Implemented as a 2-step list->detail parser.
 * - sm-doly-marysinska (WordPress): url corrected to the real tenders
 *   category (/category/przetargi/). Real, paginated list of notices; every
 *   current entry (checked page 1) is maintenance/works ("roboty
 *   ogólnobudowlane", "konserwacja instalacji sanitarnych") -- correctly
 *   excluded by title before any detail fetch is even made.
 * - uml-sale (TYPO3, "Edge Registers" extension): url corrected from a
 *   category MENU to the real structured listing
 *   (/dla-biznesu/nieruchomosci-na-sprzedaz/sprzedaz-nieruchomosci/mieszkania/),
 *   which the menu links to under "Mieszkania". This is the richest source
 *   found in the entire catalogue: 67 real current listings, each a clean
 *   accordion article with a genuine key/value table (Powierzchnia wyrażona
 *   w m2, Cena wywoławcza (PLN), Dzielnica, Struktura mieszkania incl. a
 *   literal room-count digit, Data przetargu), all server-rendered on one
 *   page, no pagination needed. Implemented as a single-page structured
 *   parser; the group's strongest, fully-verified real source.
 * - bip-uml-sale: the registered URL is real and correct (title "Sprzedaż
 *   nieruchomości: BIP ŁÓDŹ"), but it lists ANNOUNCEMENT-level entries, each
 *   covering several addresses/units at once ("Ustne przetargi ... na
 *   sprzedaż ... lokali ... przy ulicach: Kalinowej 42, Pabianickiej 37,
 *   Włókienniczej 18"), with no per-unit price in the list itself -- getting
 *   the same granular price/area data uml-sale already provides would need
 *   a further, unverified hop into each announcement. Since uml-sale already
 *   covers this municipal inventory at the per-unit level, left wired but
 *   not independently implemented this round (documented, not silently
 *   assumed empty or broken).
 * - krk-licytacje (licytacje.komornik.pl, Nuxt 3 SPA): confirmed via the
 *   page's own embedded __NUXT_DATA__ payload that search results are not
 *   server-rendered -- the SSR payload holds only category dropdown
 *   metadata ("antyki, sztuka", "łodzie, jachty", ...), never actual
 *   auction listings; those load through a client-side-only API call after
 *   hydration. No server-rendered, city-scoped listing reachable via a
 *   plain GET. Left wired but fails closed with that evidence.
 * - syndic-public-notices: the registered URL (gov.pl/web/sprawiedliwosc)
 *   is the generic Ministry of Justice homepage, not a notice list -- its
 *   few "zł"/related-looking matches were unrelated boilerplate (a
 *   "złóż wniosek" verb, a conference announcement). The real national
 *   registers for insolvency-estate sales (Krajowy Rejestr Zadłużonych,
 *   krz.ms.gov.pl; Monitor Sądowy i Gospodarczy, ems.ms.gov.pl) were
 *   checked directly and are themselves session/JS-gated applications, which
 *   this project's own rule against bypassing logins/CAPTCHAs excludes.
 *   Left wired but fails closed with that evidence.
 */
export type OfficialLodzSourceKind = "cooperative" | "municipal" | "krk" | "syndic" | "rental_program";
export type OfficialLodzSource = {
  id: string;
  label: string;
  kind: OfficialLodzSourceKind;
  url: string;
  /** Only set when the site's own <meta charset> declares something other than UTF-8. */
  charset?: string;
  status: "verified_public_page" | "access_blocked" | "excluded_rental_program";
  saleNoticeKeywords: string[];
  excludedNoticeKeywords: string[];
};

// Polish case endings vary by sentence structure ("lokal mieszkalny" nom.
// vs "lokalu mieszkalnego" gen., seen in real sm-dabrowa/sm-radogoszcz/
// sm-karolew-style notices) and a plain substring match does not bridge
// that -- every declined form actually observed across the real sources in
// this catalogue is listed explicitly rather than guessed at with a stem.
const SALE_KEYWORDS = ["lokal mieszkalny", "lokalu mieszkalnego", "lokalem mieszkalnym", "lokali mieszkalnych", "mieszkanie", "mieszkania", "sprzedaż lokalu", "odrębnej własności", "ustanowienie odrębnej własności", "ustalenie odrębnej własności", "sprzedaż nieruchomości", "licytacja nieruchomości"];
const EXCLUDED_KEYWORDS = ["lokal użytkowy", "lokalu użytkowego", "lokalem użytkowym", "lokali użytkowych", "pomieszczeń gospodarczych", "remont", "roboty budowlane", "usługi", "malowanie", "docieplenie", "najem", "wynajem", "czynsz", "konserwacj", "wykonawc", "przykanalik"];

export const OFFICIAL_LODZ_SOURCES: OfficialLodzSource[] = [
  // Real URL confirmed 2026-10-03: the site's own "Oferty, przetargi" nav
  // link, not the homepage.
  { id: "sm-dabrowa", label: "SM Dąbrowa — przetargi i oferty", kind: "cooperative", url: "https://smdabrowa.pl/informacje/oferty-przetargi", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  // Confirmed 2026-10-03: the page's own <meta charset> declares
  // iso-8859-2 (not UTF-8); response.text() would mojibake every diacritic.
  { id: "sm-teofilow", label: "SM Teofilów — przetargi", kind: "cooperative", url: "https://www.smteofilow.com.pl/strony/hprzetargi.html", charset: "iso-8859-2", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  // Confirmed 2026-10-03: TLS certificate hostname mismatch (schannel
  // SEC_E_WRONG_PRINCIPAL) on every connection attempt. A properly
  // certificate-verifying client refuses this outright; never bypassed.
  { id: "smtl", label: "SM Towarzystwo Lokator", kind: "cooperative", url: "https://smtl.pl/przetargi.html", status: "access_blocked", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  // Confirmed 2026-10-03: reachable (200), but /przetargi/ renders generic
  // lorem-ipsum placeholder text ("window-tinting services...") instead of
  // real tender content.
  { id: "sm-chojny", label: "SM Chojny", kind: "cooperative", url: "https://www.chojny.lodz.pl/przetargi/", status: "access_blocked", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "sm-srodmiescie", label: "SM Śródmieście", kind: "cooperative", url: "https://www.srodmiescie.lodz.pl/przetarg-na-sprzedaz-nieruchomosci/", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  // Real URL confirmed 2026-10-03: the site's own "przetargi.html" nav link.
  { id: "sm-karolew", label: "SM Karolew", kind: "cooperative", url: "https://karolew.eu/przetargi.html", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "sm-retkinia-polnoc", label: "SM Retkinia-Północ — przetargi", kind: "cooperative", url: "https://www.smlodz.pl/pl/index.php?id=38", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  // Real URL corrected 2026-10-03: the old "wyniki-przetargow" page is
  // historical/closed tenders; the real open-tenders page is
  // "przetargi-lokali-mieszkalnych-i-uzytkowych".
  { id: "sm-retkinia-poludnie", label: "SM Retkinia-Południe — przetargi lokali mieszkalnych", kind: "cooperative", url: "https://retkiniapoludnie.pl/przetargi/przetargi-lokali-mieszkalnych-i-uzytkowych/", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  // Real URL corrected 2026-10-03: the site's own "/aktualnosci/przetargi/"
  // nav link, not the homepage.
  { id: "sm-radogoszcz-wschod", label: "SM Radogoszcz-Wschód", kind: "cooperative", url: "https://smrw.pl/aktualnosci/przetargi/", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  // Real URL corrected 2026-10-03: the site's own "/category/przetargi/"
  // nav link, not the homepage.
  { id: "sm-doly-marysinska", label: "SM Doły-Marysińska", kind: "cooperative", url: "https://smdmlodz.pl/category/przetargi/", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  // Real URL corrected 2026-10-03: the registered URL was a category MENU;
  // the real listing is one level deeper, under its own "Mieszkania" link.
  { id: "uml-sale", label: "UMŁ — sprzedaż nieruchomości (mieszkania)", kind: "municipal", url: "https://uml.lodz.pl/dla-biznesu/nieruchomosci-na-sprzedaz/sprzedaz-nieruchomosci/mieszkania/", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  // Real URL confirmed 2026-10-03, but it lists announcement-level entries
  // (several addresses per announcement, no per-unit price) -- see the
  // file-level doc comment. Left wired, not independently implemented.
  { id: "bip-uml-sale", label: "BIP UMŁ — przetargi i sprzedaż nieruchomości", kind: "municipal", url: "https://bip.uml.lodz.pl/urzad-miasta/przetargi/sprzedaz-nieruchomosci/", status: "access_blocked", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  // Confirmed 2026-10-03 via the page's own __NUXT_DATA__ SSR payload:
  // auction search results load client-side only, never server-rendered.
  { id: "krk-licytacje", label: "KRK — portal obwieszczeń i licytacji", kind: "krk", url: "https://licytacje.komornik.pl/", status: "access_blocked", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  // Confirmed 2026-10-03: the registered URL is the generic Ministry
  // homepage; the real registers (krz.ms.gov.pl, ems.ms.gov.pl) are
  // session/JS-gated and excluded by the no-login-bypass rule.
  { id: "syndic-public-notices", label: "Publiczne ogłoszenia syndyków i mas upadłości", kind: "syndic", url: "https://www.gov.pl/web/sprawiedliwosc", status: "access_blocked", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "mieszkanie-za-remont", label: "Łódź — Mieszkanie za remont (program najmu)", kind: "rental_program", url: "https://uml.lodz.pl/mieszkanie-za-remont/", status: "excluded_rental_program", saleNoticeKeywords: [], excludedNoticeKeywords: ["najem", "wynajem", "czynsz", "mieszkanie za remont"] },
];

export function classifyOfficialNotice(text: string, source: OfficialLodzSource): "sale_candidate" | "excluded" | "manual_review" {
  if (source.kind === "rental_program" || source.status === "excluded_rental_program") return "excluded";
  const normalized = text.toLocaleLowerCase("pl-PL");
  if (source.excludedNoticeKeywords.some((keyword) => normalized.includes(keyword.toLocaleLowerCase("pl-PL")))) return "excluded";
  if (source.saleNoticeKeywords.some((keyword) => normalized.includes(keyword.toLocaleLowerCase("pl-PL")))) return "sale_candidate";
  return "manual_review";
}
