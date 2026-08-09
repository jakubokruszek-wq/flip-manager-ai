import assert from "node:assert/strict";
import test from "node:test";
import { isLikelySameFacebookProperty } from "./deduplicate-facebook-listing.ts";

const target = { price: 289000, area: 46, neighborhood: "Teofilów", district: "Bałuty", street: null };
test("wykrywa duplikat istniejącej oferty OLX", () => assert.equal(isLikelySameFacebookProperty(target, { price: 289000, area: 46, district: "Bałuty", address: "Teofilów" }), true));
test("wykrywa ten sam lokal z innego źródła mimo małej różnicy ceny", () => assert.equal(isLikelySameFacebookProperty(target, { price: 292000, area: 46.5, district: "Bałuty", address: "os. Teofilów" }), true));
test("nie łączy lokali z innej lokalizacji", () => assert.equal(isLikelySameFacebookProperty(target, { price: 289000, area: 46, district: "Widzew", address: "Widzew" }), false));
