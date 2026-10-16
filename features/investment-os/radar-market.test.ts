import assert from "node:assert/strict";
import test from "node:test";
import { radarMarketEvidence } from "./radar-market";
import type { RadarListing } from "../price-radar/types";
import type { DealListingInput } from "./types";
const now = "2026-10-16T10:00:00Z";
const subject = { id: "subject", source: "facebook", sourceUrl: "https://facebook.com/groups/1/posts/2/", externalListingId: "2", city: "Łódź", district: "Bałuty", areaM2: 45, rooms: 2, buildingType: "blok" } as DealListingInput;
function row(i: number): RadarListing { return { id: String(i), source: "otodom", externalListingId: String(i), originalUrl: `https://www.otodom.pl/pl/oferta/mieszkanie-ID${i}.html`, normalizedUrl: `https://www.otodom.pl/pl/oferta/mieszkanie-ID${i}.html`, title: "Mieszkanie po remoncie", description: null, price: (8000+i*50)*45, area: 45, pricePerSqm: 8000+i*50, rooms: 2, yearBuilt: null, yearBuiltSourceField: null, city: "Łódź", district: "Bałuty", buildingType: "blok", marketType: "secondary", renovationStatus: "fresh_renovation", qualityCategory: "fresh_renovation", contentHash: String(i), firstSeenAt: now, lastSeenAt: now, publishedAt: null, sourceUpdatedAt: null, collectedAt: now, crossSourceIdentity: null, crossSourceAlternates: [], status: "active", excludedAt: null, excludedReason: null }; }
const rows = () => Array.from({ length: 20 }, (_, i) => row(i+1));
test("20 independent qualified asking offers retain all units and auditable weighted scenarios", () => { const { evidence, audit } = radarMarketEvidence(subject, rows(), now); assert.equal(evidence.compCount,20); assert.equal(evidence.priceEvidenceType,"ASKING"); assert.equal(evidence.confidence,70); assert.ok(evidence.low <= evidence.base && evidence.base <= evidence.high); assert.equal(audit.filter(a=>a.accepted).length,20); });
test("20 confirmed syndicated advertisements count as five units", () => { const data=rows().map((r,i)=>({...r,crossSourceIdentity:`canonical_unit_id:${Math.floor(i/4)}`})); const result=radarMarketEvidence(subject,data,now); assert.equal(result.evidence.compCount,5); assert.equal(result.evidence.confidence,30); assert.equal(result.audit.filter(a=>a.reasons.includes("CONFIRMED_DUPLICATE")).length,15); });
test("fresh last seen cannot rejuvenate stale collection dates", () => { const data=rows().map(r=>({...r,collectedAt:"2026-01-01T00:00:00Z"})); const e=radarMarketEvidence(subject,data,now).evidence; assert.equal(e.compCount,0); assert.equal(e.base,0); assert.equal(e.priceEvidenceType,"ASKING"); });
test("missing dimensions, finish and tenements fail closed", () => { const data=rows(); data[0].area=0; data[1].rooms=null; data[2].verificationIssues=["building_type"]; const result=radarMarketEvidence({...subject,buildingType:"kamienica"},data,now); assert.equal(result.evidence.compCount,0); });
test("operator exclusion and cross-portal contradictions never contribute",()=>{ const data=rows(); data[0].excludedAt=now; data[1].crossSourceAlternates=[{id:"copy",source:"morizon",originalUrl:"https://morizon.pl/1",title:null,price:1,area:45,rooms:2,publishedAt:null,sourceUpdatedAt:null,collectedAt:now}]; assert.equal(radarMarketEvidence(subject,data,now).evidence.compCount,18); });
test("no fuzzy merge of equal prices, areas and titles; district isolation and unsafe links",()=>{ const data=rows().map(r=>({...r,price:360000,pricePerSqm:8000})); assert.equal(radarMarketEvidence(subject,data,now).evidence.compCount,20); data[0].district="Widzew"; data[1].originalUrl="javascript:alert(1)"; assert.equal(radarMarketEvidence(subject,data,now).evidence.compCount,18); });

test("comparison prices invalidate MARKET, UNDERWRITER and CEO; small samples cannot BUY", async()=>{
 const { buildCanonicalDeal } = await import("./engine");
 const { lodzDeal } = await import("./test-fixtures/lodz-deals");
 const input=lodzDeal(); input.now=now; input.listing={...input.listing,...subject};
 const first=buildCanonicalDeal({...input,market:radarMarketEvidence(subject,rows(),now).evidence});
 const second=buildCanonicalDeal({...input,market:radarMarketEvidence(subject,rows().map(r=>({...r,price:r.price*.8,pricePerSqm:r.pricePerSqm*.8})),now).evidence});
 const { buildDealBrain } = await import("./brain/index");
 const sale=buildDealBrain(first).directors.SALE;
 assert.ok(sale); assert.match(sale.summary,/ofertowe, nie transakcyjne/);
 assert.notEqual(first.market.inputFingerprint,second.market.inputFingerprint);
 assert.notEqual(first.underwriting.inputFingerprint,second.underwriting.inputFingerprint);
 assert.notEqual(first.ceo.inputFingerprint,second.ceo.inputFingerprint);
 assert.ok(first.underwriting.result && second.underwriting.result);
 assert.ok(second.underwriting.result.profitBase! < first.underwriting.result.profitBase!);
 for(const data of [rows().slice(0,5),rows().map(r=>({...r,collectedAt:"2020-01-01"}))]) { const d=buildCanonicalDeal({...input,market:radarMarketEvidence(subject,data,now).evidence}); assert.equal(d.market.status,"BLOCKED"); assert.notEqual(d.ceo.result?.action,"KUP"); assert.ok(d.ceo.result?.missingBeforePurchase.includes("marketEvidence")); }
 const manual=buildCanonicalDeal({...input,overrides:{resalePerM2:10000},market:radarMarketEvidence(subject,rows(),now).evidence}); assert.equal(manual.market.result?.resalePricePerM2Base,10000); assert.equal(manual.market.result?.sourceComparison?.compCount,20);
});
