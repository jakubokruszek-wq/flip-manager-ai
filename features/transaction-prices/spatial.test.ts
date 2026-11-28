import assert from 'node:assert/strict';
import test from 'node:test';
import { distanceMeters, pointInPolygon, validCenter } from './geo.ts';
import { nearbyResales } from './nearby.ts';
import { districtSummary, inAreaBand } from './districts.ts';
import { locateRcnAddress } from './geocode.ts';
import type { RcnSnapshot, StoredRcnCandidate } from './snapshot-types.ts';
const now = new Date('2026-11-28T12:00:00Z');
const base = { id:'one',street:'Tatrzańska',building:'94',area:37.48,buyDate:'2025-10-23',sellDate:'2025-12-17',buyPrice:260000,sellPrice:367000,buyPricePerM2:6937.03,sellPricePerM2:9791.89,holdingDays:55,approxMonths:1.8,priceIncrease:107000,priceIncreasePct:41.15,strongSignal:true,buyMarket:'secondary',sellMarket:'secondary',latitude:51.74,longitude:19.49,district:'Górna'} satisfies StoredRcnCandidate;
const snapshot = (candidates: StoredRcnCandidate[]): RcnSnapshot => ({schemaVersion:1,importedAt:now.toISOString(),latestRegistryVersion:'2026-11-12T12:00:00',sourceUrl:'https://nowa.mapa.lodz.pl/dla-profesjonalistow/',boundarySourceUrl:'https://www.mapa.lodz.pl/3/rest/services/SMM/MapServer/14',archiveCount:13,observationCount:43000,locatedCandidateCount:candidates.length,unlocatedCandidateCount:1,candidates});
test('distance is geographic metres and projected bounding-box corners do not count inside the radius',()=>{
 assert.equal(distanceMeters(base,base),0);
 assert(Math.abs(distanceMeters({latitude:0,longitude:0},{latitude:0,longitude:1})-111195)<2);
 const inside={...base,id:'inside',latitude:51.744};const outside={...base,id:'outside',latitude:51.747,longitude:19.5};
 const result=nearbyResales(snapshot([inside,outside]),{latitude:51.74,longitude:19.49,radiusMeters:1000},now);
 assert.equal(result.candidateCount,1);assert.equal(result.rows[0].id,'inside');assert(result.rows[0].distanceMeters>400);
 assert(!('latitude' in result.rows[0]));assert(!('longitude' in result.rows[0]));
 assert.equal(nearbyResales(snapshot([inside]),{latitude:51.74,longitude:19.49,radiusMeters:250},now).candidateCount,0);
});
test('invalid or foreign centers/radii are rejected; old/future/weak sales are excluded',()=>{
 for(const center of [{latitude:NaN,longitude:19.49,radiusMeters:1000},{latitude:52.23,longitude:21,radiusMeters:1000},{latitude:51.74,longitude:19.49,radiusMeters:10},{latitude:51.74,longitude:19.49,radiusMeters:10001}])assert.equal(validCenter(center),false);
 assert.throws(()=>nearbyResales(snapshot([]),{latitude:51.74,longitude:19.49,radiusMeters:99999},now));
 const rows=[{...base,strongSignal:false},{...base,sellDate:'2023-01-01'},{...base,sellDate:'2027-01-01'},base];
 assert.equal(nearbyResales(snapshot(rows),{latitude:51.74,longitude:19.49,radiusMeters:1000},now).strongCandidateCount,1);
});
test('official polygon assignment respects holes rather than guessing a district from a street',()=>{
 const polygon=[[[0,0],[10,0],[10,10],[0,10],[0,0]],[[4,4],[6,4],[6,6],[4,6],[4,4]]];
 assert(pointInPolygon(2,2,polygon));assert(!pointInPolygon(5,5,polygon));assert(!pointInPolygon(20,2,polygon));
});
test('district means/medians use only same-market strong pairs in the selected area band; small samples suppressed',()=>{
 const rows: StoredRcnCandidate[]=Array.from({length:5},(_,i)=>({...base,id:String(i),buyPricePerM2:5000+i*1000,sellPricePerM2:8000+i*1000}));
 rows.push({...base,id:'primary',buyMarket:'primary'});rows.push({...base,id:'weak',strongSignal:false});rows.push({...base,id:'large',area:80});
 const result=districtSummary(snapshot(rows),'medium',now);const gorna=result.districts.find(d=>d.district==='Górna')!;
 assert.equal(gorna.count,5);assert.equal(gorna.medianBuyPerM2,7000);assert.equal(gorna.averageSellPerM2,10000);assert.equal(gorna.medianMonths,1.8);
 const small=districtSummary(snapshot(rows.slice(0,4)),'medium',now).districts.find(d=>d.district==='Górna')!;assert.equal(small.count,4);assert.equal(small.medianBuyPerM2,null);
 assert(!inAreaBand(35,'small'));assert(inAreaBand(35,'medium'));assert(!inAreaBand(50,'medium'));assert(inAreaBand(70,'extra'));
});
test('typed street and numbered address use actual RCN coordinates in Łódź, never the device location',()=>{
 const street=locateRcnAddress('ul. Tatrzańska');const address=locateRcnAddress('Tatrzańska 94, Łódź');
 assert(street&&address);assert.equal(street.precision,'street');assert.equal(address.precision,'address');assert.match(address.label,/94/);
 assert(validCenter({...address,radiusMeters:1000}));assert.equal(locateRcnAddress('Nieistniejąca ulica 999999'),null);
});
