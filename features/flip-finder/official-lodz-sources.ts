/**
 * Catalogue and safety policy for Łódź municipal, cooperative and insolvency
 * notices. Their adapters remain schema-gated because pages publish mixed
 * tenders (apartments, commercial units, works and services); the parser must
 * classify each notice before a sale listing can be persisted.
 *
 * Investigated with a sample of real, read-only GETs (2026-10-03), one per
 * kind: smdabrowa.pl (cooperative), uml.lodz.pl's own sale page (municipal),
 * bip.uml.lodz.pl (municipal/BIP), licytacje.komornik.pl (krk). All four
 * returned 200, but the shared parser's selector (official-lodz-adapters.ts's
 * parseNoticeCards, matching `[data-notice-id]`) matched ZERO elements on
 * every one -- none of these small, independently-run municipal/cooperative/
 * court sites use that attribute, or any other markup convention in common
 * with each other. uml.lodz.pl's own registered sale page in particular
 * turned out to be a category MENU (linking to a separate "Mieszkania"
 * sub-page), not a listings page itself, zero price mentions anywhere.
 * Reaching genuine, parseable listing content for even one of these 14
 * sources would need its own dedicated exploration (follow the real
 * sub-navigation, then design a bespoke selector against its specific
 * markup) comparable to what each portal adapter in external-source-adapters.ts
 * already required individually -- realistically well beyond "a few
 * read-only GETs" for all 14 at once. Left exactly as implemented
 * (OFFICIAL_LODZ_SOURCES/OFFICIAL_LODZ_PARSERS unchanged, nothing removed),
 * genuinely unverified rather than silently assumed working.
 */
export type OfficialLodzSourceKind = "cooperative" | "municipal" | "krk" | "syndic" | "rental_program";
export type OfficialLodzSource = {
  id: string;
  label: string;
  kind: OfficialLodzSourceKind;
  url: string;
  status: "verified_public_page" | "manual_review_required" | "excluded_rental_program";
  saleNoticeKeywords: string[];
  excludedNoticeKeywords: string[];
};

const SALE_KEYWORDS = ["lokal mieszkalny", "mieszkanie", "ustanowienie odrębnej własności", "sprzedaż nieruchomości", "licytacja nieruchomości"];
const EXCLUDED_KEYWORDS = ["lokal użytkowy", "remont", "roboty budowlane", "usługi", "malowanie", "docieplenie", "najem", "wynajem", "czynsz"];

export const OFFICIAL_LODZ_SOURCES: OfficialLodzSource[] = [
  { id: "sm-dabrowa", label: "SM Dąbrowa — przetargi i oferty", kind: "cooperative", url: "https://smdabrowa.pl/", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "sm-teofilow", label: "SM Teofilów — przetargi", kind: "cooperative", url: "https://www.smteofilow.com.pl/strony/hprzetargi.html", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "smtl", label: "SM Towarzystwo Lokator", kind: "cooperative", url: "https://smtl.pl/", status: "manual_review_required", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "sm-chojny", label: "SM Chojny", kind: "cooperative", url: "https://www.chojny.lodz.pl/", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "sm-srodmiescie", label: "SM Śródmieście", kind: "cooperative", url: "https://www.srodmiescie.lodz.pl/przetarg-na-sprzedaz-nieruchomosci/", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "sm-karolew", label: "SM Karolew", kind: "cooperative", url: "https://karolew.eu/", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "sm-retkinia-polnoc", label: "SM Retkinia-Północ — przetargi", kind: "cooperative", url: "https://www.smlodz.pl/pl/index.php?id=38", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "sm-retkinia-poludnie", label: "SM Retkinia-Południe — wyniki przetargów", kind: "cooperative", url: "https://retkiniapoludnie.pl/przetargi/wyniki-przetargow/", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "sm-radogoszcz-wschod", label: "SM Radogoszcz-Wschód", kind: "cooperative", url: "https://smrw.pl/", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "sm-doly-marysinska", label: "SM Doły-Marysińska", kind: "cooperative", url: "https://smdmlodz.pl/", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "uml-sale", label: "UMŁ — sprzedaż nieruchomości", kind: "municipal", url: "https://uml.lodz.pl/dla-biznesu/nieruchomosci-na-sprzedaz/sprzedaz-nieruchomosci/", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "bip-uml-sale", label: "BIP UMŁ — przetargi i sprzedaż nieruchomości", kind: "municipal", url: "https://bip.uml.lodz.pl/urzad-miasta/przetargi/sprzedaz-nieruchomosci/", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "krk-licytacje", label: "KRK — portal obwieszczeń i licytacji", kind: "krk", url: "https://licytacje.komornik.pl/", status: "verified_public_page", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "syndic-public-notices", label: "Publiczne ogłoszenia syndyków i mas upadłości", kind: "syndic", url: "https://www.gov.pl/web/sprawiedliwosc", status: "manual_review_required", saleNoticeKeywords: SALE_KEYWORDS, excludedNoticeKeywords: EXCLUDED_KEYWORDS },
  { id: "mieszkanie-za-remont", label: "Łódź — Mieszkanie za remont (program najmu)", kind: "rental_program", url: "https://uml.lodz.pl/mieszkanie-za-remont/", status: "excluded_rental_program", saleNoticeKeywords: [], excludedNoticeKeywords: ["najem", "wynajem", "czynsz", "mieszkanie za remont"] },
];

export function classifyOfficialNotice(text: string, source: OfficialLodzSource): "sale_candidate" | "excluded" | "manual_review" {
  if (source.kind === "rental_program" || source.status === "excluded_rental_program") return "excluded";
  const normalized = text.toLocaleLowerCase("pl-PL");
  if (source.excludedNoticeKeywords.some((keyword) => normalized.includes(keyword.toLocaleLowerCase("pl-PL")))) return "excluded";
  if (source.saleNoticeKeywords.some((keyword) => normalized.includes(keyword.toLocaleLowerCase("pl-PL")))) return "sale_candidate";
  return "manual_review";
}
