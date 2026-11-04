import assert from "node:assert/strict";
import test from "node:test";
import {radarAccessLabel,radarCooldownUntil,radarSourceCooldown} from "./source-access.ts";
const now=Date.parse("2026-11-04T12:00:00Z");
const row=(source:string,error:string,finished="2026-11-04T11:00:00Z")=>({finished_at:finished,source_statuses:{[source]:"failed"},checkpoint:{sourceErrors:{[source]:error}}});
test("access restrictions pause 24 hours and rate limits two hours, independently by source",()=>{
  const rows=[row("gratka","HTTP 403 CAPTCHA_OR_ACCESS_DENIED"),row("allegro_lokalnie","HTTP 429")];
  assert.equal(radarSourceCooldown(rows,"gratka",now)?.until,"2026-11-05T11:00:00.000Z");
  assert.equal(radarSourceCooldown(rows,"allegro_lokalnie",now)?.until,"2026-11-04T13:00:00.000Z");
  assert.equal(radarSourceCooldown(rows,"otodom",now),null);
  assert.equal(radarSourceCooldown(rows,"allegro_lokalnie",now+2*3600000),null);
});
test("skipped runs preserve the original deadline without extending the restriction",()=>{
  const error="SOURCE_COOLDOWN_UNTIL:2026-11-04T13:00:00.000Z | HTTP 429";
  const rows=[row("allegro_lokalnie",error,"2026-11-04T11:59:00Z"),row("allegro_lokalnie","HTTP 429")];
  assert.equal(radarSourceCooldown(rows,"allegro_lokalnie",now)?.until,"2026-11-04T13:00:00.000Z");
  assert.equal(radarSourceCooldown(rows,"allegro_lokalnie",now+3600000),null);
  assert.equal(radarCooldownUntil("SOURCE_COOLDOWN_UNTIL:garbage | 429"),null);
});
test("a later successful source clears old errors; arbitrary failures are not source restrictions",()=>{
  const old=row("gratka","HTTP 403 CAPTCHA");
  assert.equal(radarSourceCooldown([{finished_at:"2026-11-04T11:30:00Z",source_statuses:{gratka:"completed"}},old],"gratka",now),null);
  assert.equal(radarSourceCooldown([row("gratka","DATABASE_ERROR")],"gratka",now),null);
  assert.match(radarAccessLabel("HTTP 429"),/ograniczył/);
});
