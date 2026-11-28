import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTransactionComparison, parseRcnWfs } from "./model.ts";
import type { RcnRawRow } from "./types.ts";
const subject = { city: "Łódź", street: "Tatrzańska", area: 40, price: 300000 };
const options = { market: "secondary" as const, now: new Date("2026-11-27T12:00:00Z"), fetchedAt: "2026-11-27T12:00:00Z", truncated: false };
const row = (i = 1, extra: RcnRawRow = {}): RcnRawRow => ({ TRAN_LOKALNY_ID_IIP: `transaction-${i}`, TRAN_WERSJA_ID: "2026-11-03 16:29:43", LOK_ID_LOKALU: `unit-${i}`, LOK_ADRES: `MSC:Łódź;UL:Tatrzańska ;NR_PORZ:98 m.${i}`, DOK_DATA: "2026-10-02 00:00:00", NIER_UDZIAL: "1/1", LOK_FUNKCJA: "mieszkalna", TRAN_RODZAJ_TRANS: "wolnyRynek", TRAN_RODZAJ_RYNKU: "rynekWtorny", LOK_CENA_BRUTTO: "280000", LOK_POW_UZYT: "40", ...extra });
const compare = (rows: RcnRawRow[]) => buildTransactionComparison(subject, rows, options);
const xml = (body: string, attrs = 'numberMatched="1" numberReturned="1" timeStamp="2026-11-27T12:00:00"') => `<?xml version="1.0"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ms="http://mapserver.gis.umn.edu/mapserver" ${attrs}>${body}</wfs:FeatureCollection>`;
test("WFS parser validates count, metadata, flat feature fields and response completeness", () => {
 const page = parseRcnWfs(xml('<wfs:member><ms:lokale><ms:LOK_CENA_BRUTTO>310000</ms:LOK_CENA_BRUTTO></ms:lokale></wfs:member>', 'numberMatched="2" numberReturned="1"'));
 assert.equal(page.returned, 1); assert.equal(page.hasMore, true); assert.equal(page.rows[0].LOK_CENA_BRUTTO, "310000");
 for (const input of [xml(""), xml("", 'numberReturned="0"'), xml("", 'numberMatched="0" numberReturned="-1"'), xml("", 'numberMatched="0" numberReturned="0" timeStamp="wrong"'), '<ExceptionReport/>', '<html/>', '<bad:FeatureCollection xmlns:bad="https://evil.test" numberReturned="0" numberMatched="0"/>', '<wfs:FeatureCollection numberReturned="0" numberMatched="0">', '<!DOCTYPE x [<!ENTITY a SYSTEM "file:///secret">]>'+xml("",'numberMatched="0" numberReturned="0"'), xml('<wfs:member xlink:href="secret"/>')]) assert.throws(() => parseRcnWfs(input));
});
test("unit price never falls back to property or transaction totals", () => {
 for (const bad of ["", "0", "-1", "NaN"]) assert.equal(compare([row(1, { LOK_CENA_BRUTTO: bad, TRAN_CENA_BRUTTO: "500000", NIER_CENA_BRUTTO: "500000" })]).sampleCount, 0);
 assert.equal(compare([row(1, { LOK_CENA_BRUTTO: "200000", TRAN_CENA_BRUTTO: "900000" })]).rows[0].pricePerM2, 5000);
});
test("exact city, street, market, residential function and full ownership gates", () => {
 for (const extra of [{LOK_ADRES:"MSC:Pabianice;UL:Tatrzańska;NR_PORZ:1"}, {LOK_ADRES:"MSC:Łódź;UL:Tatrzańska Boczna;NR_PORZ:1"}, {TRAN_RODZAJ_RYNKU:"rynekPierwotny"}, {TRAN_RODZAJ_TRANS:"przetarg"}, {NIER_UDZIAL:"1/2"}, {LOK_FUNKCJA:"uzytkowa"}, {LOK_POW_UZYT:"51"}] as RcnRawRow[]) assert.equal(compare([row(1, extra)]).sampleCount, 0);
 assert.equal(buildTransactionComparison({...subject,city:"Warszawa"},[row()],options).status,"unsupported_location");
 assert.equal(buildTransactionComparison({...subject,street:null},[row()],options).status,"missing_location");
 assert.equal(buildTransactionComparison(subject,[row(1,{TRAN_RODZAJ_RYNKU:"rynekPierwotny"})],{...options,market:"primary"}).sampleCount,1);
 assert.equal(compare([row(1,{LOK_ADRES:"MSC:Lodz;UL:ul. TATRZAŃSKA;NR_PORZ:66/68 m.17"})]).sampleCount,1);
});
test("date window excludes old, future and malformed calendar dates", () => {
 for (const date of ["2024-11-26", "2026-11-28", "2026-02-30", "not-a-date"]) assert.equal(compare([row(1,{DOK_DATA:date})]).sampleCount,0);
 assert.equal(compare([row(1,{DOK_DATA:"2024-11-27"})]).sampleCount,1);
});
test("bundles and multiple local units in a transaction are not comparable single flats", () => {
 for (const text of ["Lokal wraz z garażem", "cena łączna dwóch lokali", "udział w lokalu", "miejsce postojowe"]) assert.equal(compare([row(1,{NIER_OPIS:text})]).sampleCount,0);
 assert.equal(compare([row(),row(2,{TRAN_LOKALNY_ID_IIP:"transaction-1",LOK_POW_UZYT:"500"})]).sampleCount,0);
});
test("duplicates collapse, newest version wins and conflicting same-version economics fail closed", () => {
 assert.equal(compare([row(),row()]).sampleCount,1);
 assert.equal(compare([row(),row(1,{TRAN_LOKALNY_ID_IIP:"reimported-transaction"})]).sampleCount,1);
 assert.equal(compare([row(1,{TRAN_WERSJA_ID:"bad-version"})]).sampleCount,0);
 assert.equal(compare([row(),row(1,{TRAN_WERSJA_ID:"2026-11-04 00:00:00",LOK_CENA_BRUTTO:"320000"})]).rows[0].price,320000);
 assert.equal(compare([row(),row(1,{LOK_CENA_BRUTTO:"320000"})]).sampleCount,0);
});
test("quartiles resist one outlier without pretending the observed sale did not occur", () => {
 const rows=[200000,240000,280000,320000,2000000].map((price,i)=>row(i,{LOK_CENA_BRUTTO:String(price)}));
 const result=compare(rows);
 assert.equal(result.status,"ready");assert.equal(result.sampleCount,5);assert.equal(result.medianPricePerM2,7000);assert.equal(result.q1PricePerM2,6000);assert.equal(result.q3PricePerM2,8000);
 assert.deepEqual(result.estimatedRange,{low:240000,high:320000});assert.equal(result.rows.length,5);
 assert.equal(result.differencePct,7.14);
});
test("small sample suppresses subject estimate; truncation stays explicit; output excludes private identifiers", () => {
 const small=compare([row()]);assert.equal(small.status,"insufficient_data");assert.equal(small.estimatedRange,null);assert.equal(small.differencePct,null);
 const result=buildTransactionComparison(subject,Array.from({length:12},(_,i)=>row(i,{DOK_TWORCA:"PRIVATE NOTARY",DOK_OZNACZENIE:"PRIVATE DEED"})),{...options,truncated:true});
 assert.equal(result.truncated,true);assert.equal(result.sampleCount,12);assert.equal(result.rows.length,10);
 const publicJson=JSON.stringify(result);for(const secret of ["PRIVATE","transaction-","unit-","m.0","LOK_LICZBA_IZB"])assert(!publicJson.includes(secret));
 assert.equal(result.rows[0].building,"98");
 assert.equal(compare([row(1,{LOK_ADRES:"MSC:Łódź;UL:Tatrzańska;NR_PORZ:66/68m.17"})]).rows[0].building,"66/68");
});
test("actual WFS fixture contains strictly qualifying local prices", {skip:!process.env.RCN_SAMPLE_FILE}, () => {
 const page=parseRcnWfs(readFileSync(process.env.RCN_SAMPLE_FILE!,"utf8"));
 const result=compare(page.rows);assert(result.sampleCount>0);assert.equal(result.status,"insufficient_data");
});

test("missing or invalid subject area is distinct from insufficient comparable evidence", () => {
 for (const area of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(buildTransactionComparison({...subject,area},[row()],options).status,"missing_area");
 assert.equal(compare([]).status,"insufficient_data");
});
