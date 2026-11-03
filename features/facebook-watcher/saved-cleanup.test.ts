import assert from "node:assert/strict";
import test from "node:test";
import {savedCutoff} from "./saved-cleanup.ts";
test("cutoff is explicit, unambiguous and never defaults to clearing all",()=>{
  const now=Date.parse("2026-11-03T12:00:00Z");
  assert.equal(savedCutoff("2026-11-01T23:00:00.000Z",now),"2026-11-01T23:00:00.000Z");
  for(const value of [undefined,null,"","2026-11-01","bad-date","2026-11-04T00:00:00.000Z"])assert.throws(()=>savedCutoff(value,now));
});
