import test from "node:test";
import assert from "node:assert/strict";
import { buildResaleCandidates } from "./resales.ts";
import type { RcnRawRow } from "./types.ts";
const subject = { city: "Łódź", street: "Tatrzańska" };
const options = { now: new Date("2026-11-28T12:00:00Z"), fetchedAt: "2026-11-28T12:00:00Z", truncated: false };
function row(transaction: string, date: string, price: number, extra: RcnRawRow = {}): RcnRawRow {
 return { TRAN_LOKALNY_ID_IIP: transaction, TRAN_WERSJA_ID: "2026-11-01 12:00:00", LOK_ID_LOKALU: "private-unit-1",
  LOK_ADRES: "MSC:Łódź;UL:Tatrzańska;NR_PORZ:66/68 m.17", LOK_POW_UZYT: "40", DOK_DATA: `${date} 00:00:00`,
  NIER_UDZIAL: "1/1", LOK_FUNKCJA: "mieszkalna", TRAN_RODZAJ_TRANS: "wolnyRynek", TRAN_RODZAJ_RYNKU: "rynekWtorny",
  LOK_CENA_BRUTTO: String(price), TRAN_CENA_BRUTTO: "9000000", ...extra };
}
const buy = () => row("private-buy-transaction", "2026-02-01", 200000);
const sell = () => row("private-sell-transaction", "2026-08-01", 300000);
const compare = (rows: RcnRawRow[]) => buildResaleCandidates(subject, rows, options);

test("same flat rising resale uses local prices, exact address/area and measured holding time", () => {
 const result=compare([buy(),sell()]); assert.equal(result.status,"ready");assert.equal(result.candidateCount,1);assert.equal(result.strongCandidateCount,1);
 const value=result.rows[0]; assert.equal(value.buyPrice,200000);assert.equal(value.sellPrice,300000);
 assert.equal(value.buyPricePerM2,5000);assert.equal(value.sellPricePerM2,7500);
 assert.equal(value.holdingDays,181);assert.equal(value.approxMonths,5.9);assert.equal(value.priceIncrease,100000);assert.equal(value.priceIncreasePct,50);assert.equal(value.strongSignal,true);
 assert.equal(value.building,"66/68");assert.equal(value.area,40);
 const json=JSON.stringify(result);for(const secret of ["private-unit","private-buy","private-sell","m.17","9000000"])assert(!json.includes(secret));
});
test("same street/area/price without matching unit ID never invents a flip", () => {
 assert.equal(compare([buy(),sellWith({LOK_ID_LOKALU:"other-unit"})]).candidateCount,0);
});
function sellWith(extra:RcnRawRow){return {...sell(),...extra};}
test("changed apartment number, building, street, city or area rejects conflicting identity", () => {
 for(const extra of [{LOK_ADRES:"MSC:Łódź;UL:Tatrzańska;NR_PORZ:66/68 m.18"},{LOK_ADRES:"MSC:Łódź;UL:Tatrzańska;NR_PORZ:67 m.17"},{LOK_ADRES:"MSC:Łódź;UL:Rojna;NR_PORZ:66/68 m.17"},{LOK_ADRES:"MSC:Pabianice;UL:Tatrzańska;NR_PORZ:66/68 m.17"},{LOK_POW_UZYT:"40.01"}] as RcnRawRow[]) assert.equal(compare([buy(),sellWith(extra)]).candidateCount,0);
 assert.equal(compare([buy(),sellWith({LOK_ADRES:"MSC:Lodz;UL:ul. TATRZAŃSKA;NR_PORZ:66 / 68 m. 17",LOK_POW_UZYT:"40,00"})]).candidateCount,1);
});
test("invalid observed intermediate sale is a barrier rather than a skipped record", () => {
 for(const extra of [{NIER_UDZIAL:"1/2"},{LOK_CENA_BRUTTO:""},{TRAN_RODZAJ_TRANS:"przetarg"},{NIER_OPIS:"wraz z garażem"},{TRAN_RODZAJ_RYNKU:"unknown"}] as RcnRawRow[]){
  const middle=row("intermediate","2026-05-01",240000,extra);
  assert.equal(compare([buy(),middle,sell()]).candidateCount,0,JSON.stringify(extra));
 }
});
test("unknown transaction/date/version cannot be bypassed in the same flat history", () => {
 for(const extra of [{TRAN_LOKALNY_ID_IIP:""},{DOK_DATA:"bad"},{DOK_DATA:"2026-02-30"},{TRAN_WERSJA_ID:"bad"}] as RcnRawRow[])assert.equal(compare([buy(),row("middle","2026-05-01",240000,extra),sell()]).candidateCount,0);
});
test("multiple units bundled into a transaction are evaluated before unit filtering", () => {
 const middle=row("bundle","2026-05-01",250000);
 const other=row("bundle","2026-05-01",20000,{LOK_ID_LOKALU:"garage-unit",LOK_FUNKCJA:"garazowa",LOK_ADRES:"MSC:Łódź;UL:Rojna;NR_PORZ:1"});
 assert.equal(compare([buy(),middle,other,sell()]).candidateCount,0);
});
test("only consecutive observed events are paired, never first purchase to ultimate resale", () => {
 const result=compare([buy(),row("middle","2026-05-01",240000),sell()]);
 assert.equal(result.candidateCount,2);
 assert.deepEqual(result.rows.map(value=>[value.buyPrice,value.sellPrice]),[[240000,300000],[200000,240000]]);
 assert.equal(result.strongCandidateCount,0);
});
test("duplicate transaction versions collapse; current conflicting values fail closed", () => {
 assert.equal(compare([buy(),buy(),sell(),sell()]).candidateCount,1);
 const updated=sellWith({TRAN_WERSJA_ID:"2026-11-02 12:00:00",LOK_CENA_BRUTTO:"320000"});
 assert.equal(compare([buy(),sell(),updated]).rows[0].sellPrice,320000);
 assert.equal(compare([buy(),sell(),sellWith({LOK_CENA_BRUTTO:"320000"})]).candidateCount,0);
});
test("same-day distinct transactions have unknowable ordering and cannot anchor pairs", () => {
 assert.equal(compare([buy(),sell(),{...sell(),TRAN_LOKALNY_ID_IIP:"other-same-day"}]).candidateCount,0);
 assert.equal(compare([buy(),row("same-day","2026-02-01",220000),sell()]).candidateCount,0);
});
test("final sale is inside last24months; purchase may precede this window by up to365days", () => {
 assert.equal(compare([row("old-buy","2024-01-01",200000),row("old-sell","2024-12-01",280000)]).candidateCount,1);
 assert.equal(compare([row("old-buy","2023-12-01",200000),row("old-sell","2024-11-27",280000)]).candidateCount,0);
 assert.equal(compare([row("old-buy","2023-12-01",200000),row("old-sell","2024-11-28",280000)]).candidateCount,1);
 assert.equal(compare([buy(),row("future","2026-11-29",300000)]).candidateCount,0);
});
test("365days qualifies,366doesnot; same/lower price is not a rising-resale candidate", () => {
 assert.equal(compare([row("a","2025-08-01",200000),row("b","2026-08-01",300000)]).candidateCount,1);
 assert.equal(compare([row("a","2025-07-31",200000),row("b","2026-08-01",300000)]).candidateCount,0);
 for(const price of [200000,190000])assert.equal(compare([buy(),row("b","2026-08-01",price)]).candidateCount,0);
});
test("primary purchase to secondary resale is explicit, never a mixed-market price benchmark", () => {
 const result=compare([{...buy(),TRAN_RODZAJ_RYNKU:"rynekPierwotny"},sell()]);
 assert.equal(result.candidateCount,1);assert.equal(result.rows[0].buyMarket,"primary");assert.equal(result.rows[0].sellMarket,"secondary");
});
test("30percent strong threshold uses unrounded change and all sample pairs, not only displayed20", () => {
 const near=compare([row("a","2026-02-01",1000000),row("b","2026-08-01",1299999)]);
 assert.equal(near.rows[0].priceIncreasePct,30);assert.equal(near.rows[0].strongSignal,false);assert.equal(near.strongCandidateCount,0);
 const all=Array.from({length:25},(_,i)=>[row(`buy-${i}`,"2026-02-01",200000,{LOK_ID_LOKALU:`unit-${i}`}),row(`sell-${i}`,"2026-08-01",260000,{LOK_ID_LOKALU:`unit-${i}`})]).flat();
 const result=buildResaleCandidates(subject,all,{...options,truncated:true});
 assert.equal(result.candidateCount,25);assert.equal(result.strongCandidateCount,25);assert.equal(result.rows.length,20);assert.equal(result.truncated,true);
});
test("empty/missing/unsupported locations remain honest empty states", () => {
 assert.equal(compare([]).status,"no_candidates");
 assert.equal(buildResaleCandidates({...subject,street:null},[buy(),sell()],options).status,"missing_location");
 assert.equal(buildResaleCandidates({...subject,city:"Warszawa"},[buy(),sell()],options).status,"unsupported_location");
});
