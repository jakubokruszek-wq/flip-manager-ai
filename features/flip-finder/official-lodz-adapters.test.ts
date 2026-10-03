import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { OFFICIAL_LODZ_PARSERS, fetchOfficialLodzGroup, fetchOfficialSource, isOfficialSourceRuntimeEligible, type OfficialCanonicalSource } from "./official-lodz-adapters.ts";
import { OFFICIAL_LODZ_SOURCES } from "./official-lodz-sources.ts";

mock.module("@/features/flip-finder/listing-images", { namedExports: { resolveListingImages: (existing: string[], thumbnail: string | null, images?: string[]) => [...new Set([...existing, ...(thumbnail ? [thumbnail] : []), ...(images ?? [])])] } });
mock.module("@/features/market-intelligence/resale-comps-store", { namedExports: { syncResaleCompFromListing: async () => ({ saved: false, created: false, compId: null, available: true }) } });
mock.module("@/features/flip-finder/server/canonical-reconciliation", { namedExports: { reconcileCanonicalListingDecision: async () => ({ isCurrentMatch: true }) } });

function source(id: string) { return OFFICIAL_LODZ_SOURCES.find((item) => item.id === id)!; }
async function parse(id: string, html: string, fetchDetail: (url: string) => Promise<string> = async () => "") {
  return OFFICIAL_LODZ_PARSERS[id]!(html, source(id), fetchDetail);
}

// ---------------------------------------------------------------------------
// sm-dabrowa: Joomla list -> detail. The list page only teases a title; the
// detail page's prose carries the real price/area/rooms.
// ---------------------------------------------------------------------------
test("sm-dabrowa: a Joomla list teaser is followed to its detail page for the real price/area/rooms", async () => {
  const list = `<h2><a href="/informacje/oferty-przetargi/501-lokal-mieszkalny-na-przetarg">Lokal mieszkalny przy ul. Testowej 9 przeznaczony na przetarg</a></h2>
<h2><a href="/informacje/oferty-przetargi/502-konkurs-malowanie">Konkurs ofert na malowanie klatek schodowych</a></h2>`;
  const detail = `<div class="com-content-article__body"><time datetime="2026-09-29T08:00:00+02:00">Opublikowano</time><p>w dyspozycji Spółdzielni znajduje się lokal mieszkalny nr 10 położony w Łodzi przy ul. Testowej 9 przeznaczony na przetarg.</p><p>lokal położony jest na III piętrze, składa się z 2-ch pokoi, kuchni, łazienki o łącznej pow. użytkowej 40,00 m<sup>2</sup></p><p>Cena wywoławcza wynosi 200 000,00 zł</p></div>`;
  const fetched: string[] = [];
  const result = await parse("sm-dabrowa", list, async (url) => { fetched.push(url); return detail; });
  assert.equal(fetched.length, 1, "only the non-excluded (residential) notice's detail page must be fetched, never the maintenance one");
  assert.ok(fetched[0]!.startsWith("https://smdabrowa.pl/informacje/oferty-przetargi/501"));
  assert.equal(result.listings.length, 1);
  const listing = result.listings[0]!;
  assert.equal(listing.price, 200000);
  assert.equal(listing.area, 40);
  assert.equal(listing.rooms, 2);
  assert.equal(listing.officialOffer.eventDate, "2026-09-29T08:00:00+02:00");
  assert.equal(listing.officialOffer.sourceId, "sm-dabrowa");
  assert.equal(listing.officialOffer.noticeType, "cooperative_sale");
  assert.equal(listing.officialOffer.priceKind, "asking_price");
});

// Real public page excerpt (read-only GET of smdabrowa.pl/informacje/
// oferty-przetargi/397-lokal-mieszkalny-na-przetarg, 2026-10-03), trimmed.
const SM_DABROWA_REAL_DETAIL = `<div class="com-content-article__body">
<dd class="published"><time datetime="2026-09-29T08:00:00+02:00">Opublikowano: 29 wrzesień 2026</time></dd>
<p style="text-align: center;"><strong><span>w dyspozycji Spółdzielni znajduje się lokal mieszkalny nr 83 położony w Łodzi przy ul. Zbaraskiej nr 25 <u>przeznaczony na przetarg.</u></span></strong></p>
<p><span>lokal położony jest na IV piętrze, składa się z 2-ch pokoi, kuchni, łazienki z wc oraz przedpokoju o łącznej pow. użytkowej 36,74 m<sup>2</sup></span></p>
<p><strong><span>Cena wywoławcza wynosi 222 000,00 zł </span></strong></p>
<p>Bliższych informacji udzieli Dział członkowsko - mieszkaniowy</p>
</div>`;

test("the real smdabrowa.pl detail-page prose (captured 2026-10-03) reaches persistListing and the Finder gate", async () => {
  const list = `<h2><a href="/informacje/oferty-przetargi/397-lokal-mieszkalny-na-przetarg">Lokal mieszkalny przy ul. Zbaraskiej 25 przeznaczony na przetarg</a></h2>`;
  const result = await parse("sm-dabrowa", list, async () => SM_DABROWA_REAL_DETAIL);
  assert.equal(result.listings.length, 1);
  const listing = result.listings[0]!;
  assert.equal(listing.price, 222000);
  assert.equal(listing.area, 36.74);
  assert.equal(listing.rooms, 2);

  const rows: Record<string, unknown>[] = [];
  const db = fakeDb(rows, []);
  const { persistListing } = await import("./server/persist-listing.ts");
  const persisted = await persistListing(db as never, "filter-1", listing, true, [], "scan-1", "2026-10-03T10:00:00Z", AbortSignal.timeout(1000));
  assert.ok(persisted.listingId, "the real listing must reach the canonical listings table");
  assert.equal(rows[0]?.price, 222000);
});

// ---------------------------------------------------------------------------
// sm-teofilow: bespoke HTML, nested `.przetarg` divs, stale notices wrapped
// in HTML comments, non-UTF-8 source encoding handled separately below.
// ---------------------------------------------------------------------------
test("sm-teofilow: nested przetarg divs are read once, HTML-commented stale notices are ignored, maintenance is excluded", async () => {
  const html = `<main>
<div class="przetarg"><h4>Konkurs ofert na malowanie klatek schodowych</h4><p>roboty budowlane</p></div>
<div class="przetarg">
  <h4 class="p_nagl1">Ogłoszenie przetargu ustnego nieograniczonego na ustanowienie odrębnej własności lokalu mieszkalnego</h4>
  <div class="hide1"><div class="przetarg">
    <p>lokal mieszkalny nr 10 przy ul. Testowej 9 o powierzchni użytkowej 40,00 m<sup>2</sup> (2 pokoje).</p>
    <p>Kwota wywoławcza wynosi 200 000 zł. Wadium wynosi 20 000 zł.</p>
  </div></div>
</div>
<!-- <div class="przetarg"><h4>Stary, nieaktualny przetarg na lokal mieszkalny</h4><p>Cena wywoławcza wynosi 999 999 zł</p></div> -->
</main>`;
  const result = await parse("sm-teofilow", html);
  assert.equal(result.listings.length, 1, "the maintenance notice must be excluded and the HTML-commented stale notice must never be read");
  const listing = result.listings[0]!;
  assert.equal(listing.price, 200000);
  assert.equal(listing.area, 40);
  assert.equal(listing.rooms, 2);
  assert.equal(listing.officialOffer.deposit, 20000);
});

// The charset wiring itself: sm-teofilow's own <meta charset> declares
// iso-8859-2 (confirmed 2026-10-03), not UTF-8. response.text() would
// mojibake every diacritic here, so fetchOfficialHtml must decode via
// TextDecoder("iso-8859-2") instead.
test("sm-teofilow: the declared ISO-8859-2 charset is decoded correctly end to end, not mojibake'd", async () => {
  const text = "<main><div class=\"przetarg\"><h4>lokal mieszkalny</h4><p>o powierzchni użytkowej 40 m2 (2 pokoje). Cena wywoławcza wynosi 200 000 zł. Wadium wynosi 20 000 zł.</p></div></main>";
  const encoder = new TextEncoder();
  // Round-trip through the real iso-8859-2 byte values for the Polish
  // characters this fixture needs (verified once via `iconv -f utf-8 -t
  // iso-8859-2`, then reproduced here byte-for-byte so the test has no
  // external dependency at run time).
  const polishToIso88592: Record<string, number> = { ł: 0xb3, ą: 0xb1, ę: 0xea, ś: 0xb6, ż: 0xbf, ź: 0xbc, ć: 0xe6, ń: 0xf1, ó: 0xf3 };
  const bytes: number[] = [];
  for (const char of text) {
    const mapped = polishToIso88592[char];
    if (mapped !== undefined) { bytes.push(mapped); continue; }
    bytes.push(...encoder.encode(char));
  }
  const buffer = Uint8Array.from(bytes);
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => buffer.buffer } as unknown as Response);
    const result = await fetchOfficialSource("sm-teofilow", { city: "Łódź" });
    assert.equal(result.listings.length, 1, "decoding must succeed and the real notice must be found");
    assert.equal(result.listings[0]?.price, 200000);
    assert.equal(result.listings[0]?.area, 40);
  } finally { globalThis.fetch = previousFetch; }
});

// ---------------------------------------------------------------------------
// sm-srodmiescie: single page, a numbered list of units inside one tender
// announcement; classification applies per unit, not to the whole page.
// ---------------------------------------------------------------------------
test("sm-srodmiescie: a residential unit inside the numbered list is kept, commercial/storage units stay excluded", async () => {
  const html = `<div class="entry-content"><article>I. Lokali mieszkalnych: 1__ M 5 [zobacz] / powierzchnia: 45,00 m 2 , ul. Testowa 1, za cenę nie niższą niż 300 000 zł , kwota wadium 30 000 zł II. Lokali użytkowych: 2__ U 1 [zobacz] / powierzchnia: 20,00 m 2 , ul. Testowa 1, za cenę nie niższą niż 100 000 zł , kwota wadium 10 000 zł</article></div>`;
  const result = await parse("sm-srodmiescie", html);
  assert.equal(result.listings.length, 1, "only the residential unit (M 5) must survive, the commercial unit (U 1) must be excluded");
  const listing = result.listings[0]!;
  assert.equal(listing.price, 300000);
  assert.equal(listing.area, 45);
  assert.equal(listing.officialOffer.deposit, 30000);
});

// ---------------------------------------------------------------------------
// sm-karolew: single page, plain text tender entries.
// ---------------------------------------------------------------------------
test("sm-karolew: a real residential tender entry is kept, a maintenance entry is excluded", async () => {
  const html = `<body>najnowsze: 02/10/2026 Przetarg na sprzedaż lokalu mieszkalnego przy ul. Testowej 3, powierzchnia 38,00 m2. Cena wywoławcza wynosi 180 000 zł. najnowsze: 01/09/2026 Wyniki przetargu na remont WLZ i wymianę przykanalików.</body>`;
  const result = await parse("sm-karolew", html);
  assert.equal(result.listings.length, 1, "the maintenance/works entry must be excluded");
  assert.equal(result.listings[0]?.price, 180000);
  assert.equal(result.listings[0]?.area, 38);
});

// ---------------------------------------------------------------------------
// sm-retkinia-polnoc: bespoke "Strony,ID" CMS, list -> detail.
// ---------------------------------------------------------------------------
test("sm-retkinia-polnoc: list links are followed to their detail sub-page, non-sale sub-pages are excluded by title", async () => {
  const list = `<div id="c_text"><ul><li><a href="przetarg-na-sprzedaz-lokalu,60">przetarg na sprzedaż lokalu mieszkalnego</a></li><li><a href="przetarg-dotyczacy-wyboru-wykonawcow,49">przetarg dotyczący wyboru wykonawców</a></li></ul></div>`;
  const detail = `<div id="c_text">Spółdzielnia ogłasza przetarg na sprzedaż lokalu mieszkalnego nr 5, powierzchnia 30,00 m2, 1 pokój. Cena wywoławcza wynosi 150 000 zł.</div>`;
  const fetched: string[] = [];
  const result = await parse("sm-retkinia-polnoc", list, async (url) => { fetched.push(url); return detail; });
  assert.equal(fetched.length, 1, "only the sale-looking title's detail page must be fetched");
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0]?.price, 150000);
  assert.equal(result.listings[0]?.rooms, 1);
});

// ---------------------------------------------------------------------------
// sm-retkinia-poludnie: single page, a real table, no price anywhere in the
// HTML -- the listing must be dropped rather than given a fabricated price.
// ---------------------------------------------------------------------------
test("sm-retkinia-poludnie: a real residential-unit row with no price in the HTML is never persisted with a fabricated price", async () => {
  const html = `<h4>Przetarg nieograniczony – ustalenie odrębnej własności lokalu nr 15 przy al. Testowej 70</h4>
<table><tbody>
<tr><td><h4>Zdjęcie</h4></td><td><h4>Adres</h4></td><td><h4>Opis</h4></td></tr>
<tr><td><img src="x.jpg"></td><td>ul. Testowa 109</td><td>80 m² w budynku wolnostojącym</td></tr>
</tbody></table>`;
  const result = await parse("sm-retkinia-poludnie", html);
  assert.equal(result.listings.length, 0, "no price is published in the HTML, so the row must be dropped, never kept with an invented price");
});

// ---------------------------------------------------------------------------
// sm-radogoszcz-wschod: WordPress list -> detail, full structured notice.
// ---------------------------------------------------------------------------
test("sm-radogoszcz-wschod: the real detail-page prose preserves price, area, rooms, eligibility and the auction date", async () => {
  const list = `<article><a href="https://smrw.pl/spoldzielnia-mieszkaniowa-oglasza-pisemny-przetarg-ofertowy-5/">Spółdzielnia Mieszkaniowa „Radogoszcz – Wschód” ogłasza pisemny przetarg ofertowy</a></article>`;
  const detail = `<div class="entry-content">Spółdzielnia ogłasza pisemny przetarg ofertowy na ustanowienie odrębnej własności niżej wymienionego lokalu mieszkalnego: Lokal nr 14, przy ul. Sitowie 15A, blok 9, o powierzchni 42,36 m 2 , 2 pokoje, IV piętro. Cena wywoławcza wynosi: 259 000,00 zł. Zainteresowani składają pisemne oferty cenowe, w terminie do dnia 25.05.2026 r. do godz. 1300 OGRANICZONY – do którego mogą przystąpić wyłącznie: pełnoletnie dzieci i byli małżonkowie członków Spółdzielni. Przetargi odbędą się dnia 27.05.2026r. w siedzibie Spółdzielni.</div>`;
  const result = await parse("sm-radogoszcz-wschod", list, async () => detail);
  assert.equal(result.listings.length, 1);
  const listing = result.listings[0]!;
  assert.equal(listing.price, 259000);
  assert.equal(listing.area, 42.36);
  assert.equal(listing.rooms, 2);
  assert.equal(listing.officialOffer.eventDate, "27.05.2026r.");
  assert.ok(listing.officialOffer.eligibilityCriteria[0]?.includes("pełnoletnie dzieci"), "eligibility criteria must be preserved when present");
});

// ---------------------------------------------------------------------------
// sm-doly-marysinska: WordPress category archive, list -> detail, every
// current real title is maintenance and must never trigger a detail fetch.
// ---------------------------------------------------------------------------
test("sm-doly-marysinska: maintenance-titled archive entries are excluded before any detail page is fetched", async () => {
  const list = `<article><a href="https://smdmlodz.pl/2026/02/24/przetarg-na-roboty-ogolnobudowlane-malowanie-elewacji/">Przetarg na roboty ogólnobudowlane - malowanie elewacji</a></article>
<article><a href="https://smdmlodz.pl/2026/03/01/przetarg-na-sprzedaz-lokalu-mieszkalnego/">Przetarg na sprzedaż lokalu mieszkalnego</a></article>
<a href="https://smdmlodz.pl/category/przetargi/page/2/">2</a>`;
  const detail = `<div class="entry-content">Przetarg na sprzedaż lokalu mieszkalnego, powierzchnia 33,00 m2. Cena wywoławcza wynosi 160 000 zł.</div>`;
  const fetched: string[] = [];
  const result = await parse("sm-doly-marysinska", list, async (url) => { fetched.push(url); return detail; });
  assert.equal(fetched.length, 1, "the maintenance entry must never be fetched for detail");
  assert.ok(fetched[0]!.includes("sprzedaz-lokalu-mieszkalnego"));
  assert.equal(result.listings.length, 1);
  assert.equal(result.hasNextPage, true, "the real page/2/ pagination link must be detected");
});

// ---------------------------------------------------------------------------
// uml-sale: TYPO3 Edge Registers, single page, real structured key/value
// table -- the richest source in the catalogue.
// ---------------------------------------------------------------------------
test("uml-sale: the real accordion/table structure maps cleanly to price, area, district, rooms and the auction date", async () => {
  const html = `<article id="register-element-779156" class="js-accordion-article">
  <div class="accordion-item-heading"><p>ul. Testowa 12A, lokal mieszkalny nr 52 - AUKCJA</p></div>
  <div class="accordion-item-body"><table class="accordion--registers--table">
    <tr><td><strong>Powierzchnia wyrażona w m2:</strong></td><td>25</td></tr>
    <tr><td><strong>Cena wywoławcza (PLN):</strong></td><td>180000</td></tr>
    <tr><td><strong>Dzielnica:</strong></td><td>Bałuty</td></tr>
    <tr><td><strong>Struktura mieszkania:</strong></td><td>1 pokój, kuchnia, łazienka z WC, przedpokój.</td></tr>
    <tr><td><strong>Data przetargu:</strong></td><td>08.10.2026</td></tr>
  </table></div>
</article>`;
  const result = await parse("uml-sale", html);
  assert.equal(result.listings.length, 1);
  const listing = result.listings[0]!;
  assert.equal(listing.price, 180000);
  assert.equal(listing.area, 25);
  assert.equal(listing.rooms, 1);
  assert.equal(listing.district, "Bałuty");
  assert.equal(listing.officialOffer.eventDate, "08.10.2026");
  assert.equal(listing.externalListingId, "uml-sale:779156");
});

// Real public page excerpt (read-only GET of uml.lodz.pl/dla-biznesu/
// nieruchomosci-na-sprzedaz/sprzedaz-nieruchomosci/mieszkania/, 2026-10-03),
// trimmed to 1 of the page's real 67 listings.
const UML_REAL_ENTRY = `<article id="register-element-779156" class="js-accordion-article ">
<div class="accordion-item-heading accordion-item-heading--html-inside" data-accordion="heading">
<p><strong><span style="font-size:12.0pt">ul. Aleksandrowska 12A</span></strong><strong><span style="font-size:12.0pt">, lokal mieszkalny nr 52 -<span style="color:#e74c3c"> AUKCJA - godzina 12:00 ! Wzór oświadczenia do pobrania znajduje się na końcu ogłoszenia.</span></span></strong></p>
</div>
<div class="accordion-item-body"><table class="accordion--registers--table">
<tr><td width="180"><strong>Powierzchnia wyrażona w m2:</strong></td><td>25</td></tr>
<tr><td width="180"><strong>Cena wywoławcza (PLN):</strong></td><td>180000</td></tr>
<tr><td width="180"><strong>Dzielnica:</strong></td><td>Bałuty</td></tr>
<tr><td width="180"><strong>Struktura mieszkania:</strong></td><td>1 pokój, kuchnia, łazienka z WC, przedpokój - budynek frontowy, parter.</td></tr>
</table></div>
</article>`;

test("the real uml.lodz.pl accordion/table structure (captured 2026-10-03) reaches persistListing and the Finder gate", async () => {
  const result = await parse("uml-sale", UML_REAL_ENTRY);
  assert.equal(result.listings.length, 1);
  const listing = result.listings[0]!;
  assert.equal(listing.price, 180000);
  assert.equal(listing.area, 25);
  assert.equal(listing.rooms, 1);
  assert.equal(listing.district, "Bałuty");

  const rows: Record<string, unknown>[] = [];
  const db = fakeDb(rows, []);
  const { persistListing } = await import("./server/persist-listing.ts");
  const persisted = await persistListing(db as never, "filter-1", listing, true, [], "scan-1", "2026-10-03T10:00:00Z", AbortSignal.timeout(1000));
  assert.ok(persisted.listingId, "the real listing must reach the canonical listings table");
  assert.equal(rows[0]?.price, 180000);
});

// ---------------------------------------------------------------------------
// Blocked sources: wired, read-only GET still attempted where applicable,
// fail closed with a concrete, documented reason -- never silently empty,
// never a crash, never bypassed.
// ---------------------------------------------------------------------------
test("blocked sources (sm-chojny, bip-uml-sale, krk-licytacje, syndic-public-notices) fail closed with a concrete reason, not an empty silent result", async () => {
  for (const id of ["sm-chojny", "bip-uml-sale", "krk-licytacje", "syndic-public-notices"]) {
    const result = await parse(id, "<html>whatever this site actually returns</html>");
    assert.deepEqual(result.listings, [], id);
    assert.equal(result.warnings.length, 1, id);
    assert.ok(result.warnings[0]!.length > 20, `${id} warning must explain the concrete blocker, not be a generic placeholder`);
  }
});

test("group runtime selects only verified public catalog entries and never schedules blocked official sources", async () => {
  assert.equal(isOfficialSourceRuntimeEligible(source("uml-sale")), true);
  assert.equal(isOfficialSourceRuntimeEligible(source("bip-uml-sale")), false);
  assert.equal(isOfficialSourceRuntimeEligible(source("krk-licytacje")), false);

  const previousFetch = globalThis.fetch;
  const requested: string[] = [];
  try {
    globalThis.fetch = async (input) => {
      requested.push(String(input));
      return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    };
    await fetchOfficialLodzGroup("official_uml", { city: "ĹĂłdĹş" });
    const requestedAfterUml = [...requested];
    await fetchOfficialLodzGroup("official_auction", { city: "ĹĂłdĹş" });
    assert.ok(requestedAfterUml.some((url) => url.includes("uml.lodz.pl")), "the verified UMŁ source must be selected");
    assert.ok(!requestedAfterUml.some((url) => url.includes("bip.uml.lodz.pl")), "the blocked BIP source must be filtered before fetch");
    assert.equal(requested.length, requestedAfterUml.length, "the all-blocked auction category must not issue a request");
  } finally { globalThis.fetch = previousFetch; }
});

test("smtl fails closed at the connection level (TLS certificate mismatch), never with insecure fallback", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError("fetch failed: self-signed certificate / hostname mismatch"); };
    await assert.rejects(fetchOfficialSource("smtl", { city: "Łódź" }));
  } finally { globalThis.fetch = previousFetch; }
});

// ---------------------------------------------------------------------------
// Group-level fetch isolation: one source's connection failure must never
// take down the other real sources in the same group.
// ---------------------------------------------------------------------------
test("one source failing (HTTP error, thrown connection error) does not prevent the rest of the group from reporting real listings", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("smteofilow")) throw new TypeError("connection reset");
      if (url.includes("informacje/oferty-przetargi/1")) return new Response("<div class=\"com-content-article__body\">lokal mieszkalny o pow. użytkowej 30,00 m2. Cena wywoławcza wynosi 150 000 zł.</div>", { status: 200, headers: { "content-type": "text/html" } });
      if (url.includes("smdabrowa.pl")) return new Response("<h2><a href=\"/informacje/oferty-przetargi/1-lokal-mieszkalny\">Lokal mieszkalny na przetarg</a></h2>", { status: 200, headers: { "content-type": "text/html" } });
      return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    };
    const result = await fetchOfficialLodzGroup("official_cooperative", { city: "Łódź" });
    assert.ok(result.listings.some((listing) => listing.price === 150000), "sm-dabrowa's real listing must still come through");
    assert.ok(result.warnings.some((warning) => warning.includes("SM Teofilów")), "the broken source's failure must be reported as a warning, not silently swallowed or crashing the group");
  } finally { globalThis.fetch = previousFetch; }
});

// ---------------------------------------------------------------------------
// Idempotency through the existing canonical persistListing path.
// ---------------------------------------------------------------------------
test("official listings from different sites remain idempotent through persistListing and keep their officialOffer metadata", async () => {
  const { persistListing } = await import("./server/persist-listing.ts");
  const rows: Record<string, unknown>[] = [];
  const snapshots: Record<string, unknown>[] = [];
  const db = fakeDb(rows, snapshots);
  const cases: [string, string][] = [
    ["sm-teofilow", "<main><div class=\"przetarg\"><h4>lokal mieszkalny</h4><p>o powierzchni użytkowej 40 m2 (2 pokoje). Cena wywoławcza wynosi 200 000 zł.</p></div></main>"],
    ["sm-karolew", "<body>najnowsze: 1/1/2026 Przetarg na sprzedaż lokalu mieszkalnego, powierzchnia 38,00 m2. Cena wywoławcza wynosi 180 000 zł.</body>"],
    ["uml-sale", UML_REAL_ENTRY],
  ];
  const groups = new Set<OfficialCanonicalSource>();
  for (const [id, html] of cases) {
    const listing = (await parse(id, html)).listings[0]!;
    groups.add(listing.source as OfficialCanonicalSource);
    const first = await persistListing(db as never, "filter-official", listing, true, [], "scan-official", "2026-10-02T10:00:00Z", AbortSignal.timeout(1000));
    const second = await persistListing(db as never, "filter-official", listing, true, [], "scan-official", "2026-10-02T10:01:00Z", AbortSignal.timeout(1000));
    assert.equal(first.listingId, second.listingId, id);
  }
  assert.equal(rows.length, cases.length);
  assert.equal(snapshots.filter((row) => row.raw_data && typeof row.raw_data === "object" && "officialOffer" in (row.raw_data as object)).length, cases.length);
  assert.deepEqual([...groups].sort(), ["official_cooperative", "official_uml"]);
});

function fakeDb(rows: Record<string, unknown>[], snapshots: Record<string, unknown>[]) {
  let sequence = 0;
  return { from(table: string) { const filters: Record<string, unknown> = {}; let operation = "select"; let payload: Record<string, unknown> | null = null; const builder: Record<string, unknown> = { select: () => builder, eq: (key: string, value: unknown) => { filters[key] = value; return builder; }, order: () => builder, limit: () => builder, abortSignal: () => builder, insert: (value: Record<string, unknown>) => { operation = "insert"; payload = value; return builder; }, upsert: (value: Record<string, unknown>) => { operation = "upsert"; payload = value; return builder; }, maybeSingle: async () => ({ data: rows.find((row) => Object.entries(filters).every(([key, value]) => row[key] === value)) ?? null, error: null }), single: async () => { if (table === "listings" && operation === "upsert" && payload) { const existing = rows.find((row) => row.source === payload?.source && row.external_listing_id === payload?.external_listing_id); if (existing) Object.assign(existing, payload); else rows.push({ ...payload, id: `listing-${++sequence}` }); return { data: { id: existing?.id ?? rows.at(-1)?.id }, error: null }; } return { data: { id: `row-${++sequence}` }, error: null }; }, then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => { if (table === "listing_snapshots" && operation === "insert" && payload) snapshots.push(payload); return Promise.resolve({ data: [], error: null }).then(resolve, reject); } }; return builder; } };
}
