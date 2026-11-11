import test from "node:test";
import assert from "node:assert/strict";
import { parsePriceEntry, formatPriceEntry } from "./price-entry.ts";
test("short price entry preserves grosz through both units", () => {
 assert.equal(parsePriceEntry("360", true),36000000);
 assert.equal(parsePriceEntry("360,5", true),36050000);
 for (const value of [0,1,450000,36012345,36000000,100000000000]) for (const thousands of [true,false]) assert.equal(parsePriceEntry(formatPriceEntry(value,thousands),thousands),value);
 assert.equal(parsePriceEntry("",true),null);
 for (const invalid of ["-1","1e3","3600000000000","1.000001","abc"]) assert.throws(()=>parsePriceEntry(invalid,true));
});
