import test from "node:test";
import assert from "node:assert/strict";
import { freshMarketDate, eligibleGeneralComp, generalCompKey, markIndicative, usableRadar } from "./market-fallback";
import type { DealListingInput, MarketEvidence } from "./types";
import type { ResaleCompRecord } from "../market-intelligence/resale-comps";
const now="2026-10-16T10:00:00Z";
const subject={id:"subject",source:"facebook",sourceUrl:"https://facebook.com/1",city:"Łódź",district:"Górna",buildingType:"blok",rooms:2} as DealListingInput;
const comp={id:"comp",source:"otodom",externalListingId:"1",canonicalUrl:"https://otodom.pl/1",lastSeenAt:now,city:"Łódź",district:"Górna",buildingType:"BLOCK",rooms:2,price:450000,areaM2:45,pricePerM2:10000,description:"rynek wtórny",classification:{renovationStatus:"RENOVATED",renovationConfidence:"HIGH"}} as ResaleCompRecord;
const benchmark={id:"benchmark",matchedBy:"RESALE_COMPS",low:9000,base:9500,high:10000,confidence:90,provenance:"DERIVED",compCount:4,fallbackLevel:1,confidencePenalty:0,observedAt:now,evidenceId:"test",priceEvidenceType:"ASKING",comparables:[],fallbackReason:null} satisfies MarketEvidence;
test("general evidence rejects private, stale, contradictory, wrong market, district and finish",()=>{
 assert.ok(eligibleGeneralComp({},comp,subject,"owner",now));
 for(const row of [{owner_id:"other"},{excluded_at:now},{outlier_reason:"conflict"}]) assert.equal(eligibleGeneralComp(row,comp,subject,"owner",now),false);
 for(const change of [{lastSeenAt:"2020-01-01"},{district:"Bałuty"},{rooms:null},{description:"rynek pierwotny"},{pricePerM2:1},{classification:{...comp.classification,renovationStatus:"UNKNOWN" as const}}]) assert.equal(eligibleGeneralComp({}, {...comp,...change},subject,"owner",now),false);
});
test("confirmed cross identity dedups general copies without merging equal-price units",()=>{ assert.equal(generalCompKey({cross_source_identity:"canonical_unit_id:unit1"},comp),generalCompKey({cross_source_identity:"canonical_unit_id:unit1"},{...comp,source:"morizon",externalListingId:"2"})); assert.notEqual(generalCompKey({},comp),generalCompKey({},{...comp,externalListingId:"2"})); });
test("indicative fallback retains asking provenance and caps confidence with explicit investor question",()=>{const e=markIndicative(benchmark,"ogólne porównania",null);assert.equal(e.indicative,true);assert.equal(e.confidence,60);assert.match(e.fallbackReason!,/WYCENA ORIENTACYJNA/);assert.match(e.assumptionQuestion!,/9500/);assert.equal(e.priceEvidenceType,"ASKING");});
test("only sufficient fresh Radar wins; future or missing dates cannot be fresh",()=>{assert.equal(usableRadar({...benchmark,minimumSample:10},now),false);assert.ok(usableRadar({...benchmark,compCount:12,minimumSample:10},now));assert.equal(freshMarketDate(null,now),false);assert.equal(freshMarketDate("2030-01-01",now),false);});
