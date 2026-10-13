/**
 * Generates `olx-lodz-sprzedaz.sample.html`: a synthetic but structurally
 * faithful OLX search-results page (Łódź, flats for sale, page 1 of 25).
 *
 * No real OLX page or personal data is stored in the repository. The page
 * reproduces what matters to the parser and the cloud worker:
 *   - `window.__PRERENDERED_STATE__ = "<JSON encoded as a JS string>"` inside an
 *     inline script that also sets other globals, with `<` escaped as \u003C;
 *   - a large state (categories, translations) around `listing.listing.ads`;
 *   - OLX's own counters (totalElements, visibleTotalCount, totalPages, pageNumber);
 *   - one rendered `[data-cy="l-card"]` per ad, promoted ads included;
 *   - the field variants seen in practice: numeric ids, relative URLs, room
 *     counts as words, decimal areas, missing building type or district,
 *     "ask for price" ads, quotes/backslashes/HTML in descriptions.
 *
 * Regenerate with:
 *   node --experimental-strip-types test/fixtures/generate-olx-fixture.ts
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DISTRICTS = ["Bałuty", "Widzew", "Polesie", "Śródmieście", "Górna"];
const ROOMS = ["one", "two", "three", "four"];
const BUILT = ["blok", "kamienica", "apartamentowiec", "blok"];

export type FixtureAd = Record<string, unknown>;

export function fixtureAds(): FixtureAd[] {
  const ads: FixtureAd[] = [];
  for (let index = 0; index < 40; index += 1) {
    const id = 913_400_000 + index;
    const district = DISTRICTS[index % DISTRICTS.length];
    const rooms = ROOMS[index % ROOMS.length];
    const area = 28 + index * 1.5;
    const price = 250_000 + index * 7_500;
    const slug = `mieszkanie-${rooms}-pokoje-${district.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l")}`;
    const params: FixtureAd[] = [
      { key: "price", name: "Cena", type: "price", value: `${price.toLocaleString("pl-PL")} zł`, normalizedValue: String(price) },
      { key: "m", name: "Powierzchnia", type: "input", value: `${String(area).replace(".", ",")} m²`, normalizedValue: String(area) },
      { key: "rooms", name: "Liczba pokoi", type: "select", value: rooms, normalizedValue: rooms },
      { key: "floor_select", name: "Poziom", type: "select", value: String(index % 5), normalizedValue: `floor_${index % 5}` },
      { key: "market", name: "Rynek", type: "select", value: "Wtórny", normalizedValue: "secondary" },
      { key: "builttype", name: "Rodzaj zabudowy", type: "select", value: BUILT[index % BUILT.length], normalizedValue: BUILT[index % BUILT.length] },
    ];
    ads.push({
      id,
      title: `Mieszkanie ${area} m², ${district}`,
      description: `<p>Mieszkanie w dzielnicy ${district}, ${area} m².</p><p>Bez pośredników.</p>`,
      category: { id: 1307, type: "real_estate" },
      url: `https://www.olx.pl/d/oferta/${slug}-CID3-ID${(1_000_000 + index).toString(36).toUpperCase()}.html`,
      isHighlighted: false,
      isPromoted: index < 3,
      promotion: { highlighted: false, urgent: false, top_ad: index < 3, options: index < 3 ? ["bundle_premium"] : [], b2c_ad_page: false, premium_ad_page: false },
      photos: [
        { link: `https://ireland.apollo.olxcdn.com:443/v1/files/fixture-${id}-a/image;s={width}x{height}`, width: 1200, height: 900, rotation: 0 },
        { link: `https://ireland.apollo.olxcdn.com:443/v1/files/fixture-${id}-b/image;s={width}x{height}`, width: 1200, height: 900, rotation: 0 },
      ],
      params,
      price: {
        budget: false, free: false, exchange: false, arranged: false, displayValue: `${price.toLocaleString("pl-PL")} zł`,
        regularPrice: { value: price, currencyCode: "PLN", currencySymbol: "zł", negotiable: index % 4 === 0, priceFormatConfig: { decimalSeparator: ",", thousandsSeparator: " " } },
      },
      location: { cityId: 10609, cityName: "Łódź", cityNormalizedName: "lodz", regionId: 7, regionName: "Łódzkie", regionNormalizedName: "lodzkie", districtId: 100 + (index % 5), districtName: district, pathName: `Łódź, ${district}` },
      map: { zoom: 13, lat: 51.76 + index / 1000, lon: 19.45 + index / 1000, radius: 2, show_detailed: false },
      user: { id: 5_000_000 + index, name: `Sprzedający ${index + 1}`, isOnline: false, lastSeen: "2026-10-12T10:00:00+02:00" },
      contact: { name: `Sprzedający ${index + 1}`, phone: true, chat: true, negotiation: true, courier: false },
      createdTime: new Date(Date.UTC(2026, 9, 12, 12, 0, 0) - index * 3_600_000).toISOString().replace(".000Z", "+00:00"),
      lastRefreshTime: "2026-10-13T06:00:00+02:00",
      validToTime: "2026-11-11T12:00:00+01:00",
      isActive: true,
      status: "active",
      offerType: "offer",
      searchReason: index < 3 ? "promoted" : "organic",
    });
  }

  // Hand-checked variants (asserted field by field in the tests).
  const special = ads[5];
  special.title = "Kamienica \"po remoncie\" — 3/4 piętro, ul. Piotrkowska <120> m² \\ okazja";
  special.description = "<p>Wysoki parter, \"klimatyczna\" kamienica. Ścieżka: C:\\mieszkanie</p><script>alert(1)</script>";
  // Relative URL, string id.
  ads[7].url = "/d/oferta/kawalerka-baluty-CID3-ID13Ab07.html";
  ads[7].id = "13Ab07";
  // "Zapytaj o cenę": no regular price.
  ads[9].price = { budget: false, free: false, exchange: false, arranged: true, displayValue: "Zapytaj o cenę", regularPrice: null };
  // No building type param, no district.
  ads[11].params = (ads[11].params as FixtureAd[]).filter((param) => param.key !== "builttype");
  ads[11].location = { cityId: 10609, cityName: "Łódź", cityNormalizedName: "lodz", regionName: "Łódzkie", pathName: "Łódź" };
  // Unix seconds instead of an ISO creation time.
  ads[13].createdTime = 1_791_806_400;
  return ads;
}

export type FixturePageOptions = {
  ads?: FixtureAd[];
  /** Number of rendered cards; defaults to one per ad. */
  domCards?: number;
  totalElements?: number;
  /** A later script deletes the global, as a hydrating app may do. */
  deleteGlobalAfterHydration?: boolean;
};

export function buildOlxListingPage(options: FixturePageOptions = {}): string {
  const ads = options.ads ?? fixtureAds();
  const totalElements = options.totalElements ?? 1000;
  const state = {
    listing: {
      listing: {
        isError: false,
        ads,
        pageNumber: 1,
        totalPages: ads.length ? 25 : 0,
        totalElements,
        visibleTotalCount: ads.length ? 1847 : 0,
        adsIds: ads.map((ad) => ad.id),
        params: { category_id: "15", region_id: "7", city_id: "10609", "filter_enum_market[0]": "secondary" },
        metaData: { filters: [], whitelisted_filters: [], source: { promoted: [0, 1, 2], organic: ads.slice(3).map((_, index) => index + 3) } },
      },
      breadcrumbs: [{ label: "Nieruchomości", href: "/nieruchomosci/" }, { label: "Mieszkania", href: "/nieruchomosci/mieszkania/" }, { label: "Sprzedaż", href: "/nieruchomosci/mieszkania/sprzedaz/" }],
      seo: { title: "Mieszkania na sprzedaż Łódź - OLX.pl", description: "Ogłoszenia mieszkań na sprzedaż w Łodzi." },
    },
    categories: { list: Object.fromEntries(Array.from({ length: 400 }, (_, index) => [String(1000 + index), { id: 1000 + index, name: `Kategoria ${index}`, normalizedName: `kategoria-${index}`, parentId: 0, children: [], icon: `icon-${index}` }])) },
    i18n: { strings: Object.fromEntries(Array.from({ length: 1200 }, (_, index) => [`listing.string.${index}`, `Tekst interfejsu numer ${index} — "cytat" <b>pogrubienie</b>`])) },
    user: { isLogged: false, id: null },
    config: { site: "olxpl", locale: "pl", currency: "PLN", features: Array.from({ length: 80 }, (_, index) => `feature-${index}`) },
  };
  // OLX encodes the state as a JS string literal holding JSON, with "<" escaped.
  const literal = JSON.stringify(JSON.stringify(state)).replace(/</g, "\\u003C");
  const cardCount = options.domCards ?? ads.length;
  const cards = Array.from({ length: cardCount }, (_, index) => {
    const ad = ads[index % Math.max(1, ads.length)] ?? {};
    const title = escapeHtml(String(ad.title ?? `Oferta ${index}`));
    return `<div data-cy="l-card" data-testid="l-card" id="${escapeHtml(String(ad.id ?? index))}" class="css-1sw7q4x"><div class="css-1apmciz"><a class="css-z3gu2d" href="${escapeHtml(String(ad.url ?? "#"))}"><h4 class="css-1g61gc2">${title}</h4></a><p data-testid="ad-price" class="css-uj7mm0">${escapeHtml(String((ad.price as { displayValue?: string } | undefined)?.displayValue ?? ""))}</p><p data-testid="location-date" class="css-vbz67q">Łódź - 12 października 2026</p></div></div>`;
  }).join("\n");
  return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mieszkania na sprzedaż Łódź - OLX.pl</title>
<link rel="stylesheet" href="https://statics.olxcdn.com/fixture/app.css">
<link rel="preload" href="https://statics.olxcdn.com/fixture/font.woff2" as="font" crossorigin>
<script src="https://www.googletagmanager.com/gtm.js?id=GTM-FIXTURE" async></script>
</head>
<body>
<div id="root">
<header class="css-header"><a href="/">OLX</a><form role="search" action="/oferty/"><input name="q" placeholder="Szukaj"></form></header>
<main>
<h1 class="css-title">Mieszkania na sprzedaż Łódź</h1>
<p data-testid="total-count">Znaleźliśmy ${ads.length ? "1847" : "0"} ogłoszeń</p>
<div data-testid="listing-grid" class="css-j0t2x2">
${cards}
</div>
<nav data-testid="pagination"><a href="?page=2">2</a></nav>
</main>
</div>
<script type="text/javascript">window.__INIT_CONFIG__ = {"site":"olxpl","env":"production"};window.__PRERENDERED_STATE__= ${literal};window.__TAURUS__ = {"lang":"pl"};</script>
${options.deleteGlobalAfterHydration ? `<script>delete window.__PRERENDERED_STATE__;</script>` : ""}
<script src="https://statics.olxcdn.com/fixture/app.js" defer></script>
</body>
</html>
`;
}

export function buildChallengePage(): string {
  return `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="challenge-running"></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = new URL("./olx-lodz-sprzedaz.sample.html", import.meta.url);
  writeFileSync(target, buildOlxListingPage());
  process.stdout.write(`written ${fileURLToPath(target)}\n`);
}
