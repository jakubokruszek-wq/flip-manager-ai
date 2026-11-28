import test from "node:test";
import assert from "node:assert/strict";
import { fetchRcnStreet, rcnStreetUrl } from "./wfs.ts";

const now = () => new Date("2026-11-27T20:00:00Z");
function xml(count: number, more = false): string {
  return `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ms="http://mapserver.gis.umn.edu/mapserver" numberMatched="unknown" numberReturned="${count}"${more ? ' next="https://evil.example/collect"' : ""}>${Array.from({ length: count }, (_, i) => `<wfs:member><ms:lokale><ms:LOK_ID_LOKALU>${i}</ms:LOK_ID_LOKALU></ms:lokale></wfs:member>`).join("")}</wfs:FeatureCollection>`;
}

test("query has fixed source, escapes XML/wildcards, projects no parties or notary and sorts by deed date", () => {
  const url = rcnStreetUrl("Dąbrowskiego *?&'", 100);
  assert.equal(url.origin, "https://mapa.lodz.pl");
  assert.equal(url.searchParams.get("startIndex"), "100");
  assert.equal(url.searchParams.get("count"), "100");
  assert.equal(url.searchParams.get("sortBy"), "DOK_DATA D");
  assert.match(url.searchParams.get("filter")!, /!\*!\?&amp;&apos;/);
  const fields = url.searchParams.get("propertyName")!;
  assert.match(fields, /LOK_CENA_BRUTTO/);
  assert.doesNotMatch(fields, /DOK_TWORCA|DOK_OZNACZENIE|TRAN_KUPUJACY|TRAN_SPRZEDAJACY|TRAN_CENA_BRUTTO/);
  assert.throws(() => rcnStreetUrl("<invalid>"));
  assert.throws(() => rcnStreetUrl("Tatrzańska", 200));
});

test("at most two pages use our own URL even when the source supplies a foreign next URL", async () => {
  const urls: URL[] = [];
  const result = await fetchRcnStreet("Tatrzańska", { now, fetcher: async (input, init) => {
    urls.push(new URL(input));
    assert.equal(init?.next?.revalidate, 21600);
    assert.equal(init?.redirect, "manual");
    return new Response(xml(100, true), { headers: { date: "Fri, 27 Nov 2026 19:00:00 GMT" } });
  } });
  assert.equal(urls.length, 2);
  assert.deepEqual(urls.map(url => url.searchParams.get("startIndex")), ["0", "100"]);
  assert.ok(urls.every(url => url.hostname === "mapa.lodz.pl"));
  assert.equal(result.rows.length, 200);
  assert.equal(result.truncated, true);
  assert.equal(result.fetchedAt, "2026-11-27T19:00:00.000Z");
});

test("short response stops paging; cache timestamp is retained and unknown geometry is not needed", async () => {
  let calls = 0;
  const result = await fetchRcnStreet("Hipoteczna", { now, fetcher: async () => { calls++; return new Response(xml(1)); } });
  assert.equal(calls, 1); assert.equal(result.rows.length, 1); assert.equal(result.truncated, false);
});

test("redirects to other hosts are rejected before any second request", async () => {
  let calls = 0;
  await assert.rejects(fetchRcnStreet("Hipoteczna", { fetcher: async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }); } }), /SOURCE_REJECTED/);
  assert.equal(calls, 1);
});

test("an advertised oversized body, oversized streamed body and invalid source document all fail closed", async () => {
  for (const response of [new Response("tiny", { headers: { "content-length": "512001" } }), new Response("x".repeat(512001)), new Response("<html>upstream error</html>")]) {
    await assert.rejects(fetchRcnStreet("Tatrzańska", { fetcher: async () => response }));
  }
});

test("the whole municipal request has an abort deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let signal: AbortSignal | undefined;
    const pending = fetchRcnStreet("Tatrzańska", { fetcher: async (_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } });
    const assertion = assert.rejects(pending, /aborted/);
    t.mock.timers.tick(12_001);
    await assertion;
    assert.equal(signal?.aborted, true);
  } finally { t.mock.timers.reset(); }
});
