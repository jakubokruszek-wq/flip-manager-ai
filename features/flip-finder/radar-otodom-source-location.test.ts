import assert from "node:assert/strict";
import test from "node:test";
import { parseRadarOfferDetail } from "./external-source-adapters.ts";

function page(title: string, address: Record<string, unknown> = {}, unifiedAddress: Record<string, unknown> = {}) {
  const data = { props: { pageProps: {
    ad: { title: "Komfortowe mieszkanie", status: "active", attributes: { m: 50, rooms_num: 2, market: "secondary", building_type: "block" }, adCategory: { name: "flat", type: "sell" }, location: { address } },
    unifiedAd: { location: { address: unifiedAddress }, price: { salePrice: { value: 500000 } }, description: "Świeżo po generalnym remoncie, gotowe do zamieszkania." },
  } } };
  return `<title>${title}</title><h1>Komfortowe mieszkanie</h1><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
}

test("Otodom reads its own SEO sale-title location when structured city is absent", () => {
  const detail = parseRadarOfferDetail("otodom", page("3 pokoje, mieszkanie na sprzedaż - Łódź, Bałuty - 68293724 • www.otodom.pl"));
  assert.equal(detail.city, "Łódź");
  assert.equal(detail.district, "Bałuty");
  assert.ok(!detail.unconfirmedFields.includes("city_lodz"));
});

test("an explicit different city is never replaced by Łódź in the SEO title", () => {
  const detail = parseRadarOfferDetail("otodom", page("mieszkanie na sprzedaż - Łódź, Bałuty - 123 • www.otodom.pl", { city: { name: "Zgierz" } }));
  assert.notEqual(detail.city, "Łódź");
  assert.equal(detail.verified, false);
});

test("an empty ad address does not mask the unified own structured address", () => {
  const detail = parseRadarOfferDetail("otodom", page("Komfortowe mieszkanie", {}, { city: { name: "Łódź" }, district: { name: "Bałuty" } }));
  assert.equal(detail.city, "Łódź");
  assert.equal(detail.district, "Bałuty");
});

test("advertising a connection to Łódź is not proof of the offer location", () => {
  const detail = parseRadarOfferDetail("otodom", page("2 pokoje, mieszkanie na sprzedaż - Zgierz - 123 • www.otodom.pl. Dobry dojazd do Łodzi"));
  assert.notEqual(detail.city, "Łódź");
  assert.equal(detail.verified, false);
});
