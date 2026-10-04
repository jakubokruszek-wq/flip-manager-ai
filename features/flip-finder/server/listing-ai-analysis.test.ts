import assert from "node:assert/strict";
import test from "node:test";

/**
 * Pure unit tests. No real network call is ever made: every test either
 * provides no API key (the real no-op path) or replaces global.fetch with a
 * local stub for the duration of that one test and restores it immediately
 * after. OPENAI_API_KEY is always a literal dummy string here, never read
 * from the real environment/.env.local.
 */
const { confirmedListingImages, analyzeListingDescriptionWithAi, analyzeListingPhotosWithAi, analyzeListingWithAiIfNeeded } = await import("./listing-ai-analysis.ts");
const { calculateContentHash: hashOf } = await import("../otodom-search.ts");

function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function withConsoleWarn<T>(run: (calls: Array<[string, ...unknown[]]>) => Promise<T>): Promise<T> {
  const calls: Array<[string, ...unknown[]]> = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { calls.push(args as [string, ...unknown[]]); };
  return run(calls).finally(() => {
    console.warn = original;
  });
}

function withApiKey<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const original = process.env.OPENAI_API_KEY;
  if (value === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = value;
  return run().finally(() => {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  });
}

function responsesApiReply(findings: Record<string, unknown>, usage: Record<string, unknown> = { input_tokens: 100, output_tokens: 20, total_tokens: 120 }): Response {
  return new Response(
    JSON.stringify({
      model: "gpt-6-luna",
      output: [{ content: [{ type: "output_text", text: JSON.stringify(findings) }] }],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// --- confirmedListingImages ---------------------------------------------

test("confirmedListingImages: keeps only well-formed https URLs, never a relative path or a non-https scheme", () => {
  const result = confirmedListingImages([
    "https://cdn.example.com/a.jpg",
    "http://cdn.example.com/insecure.jpg",
    "/relative/path.jpg",
    "not a url at all",
    "ftp://cdn.example.com/b.jpg",
  ]);
  assert.deepEqual(result, ["https://cdn.example.com/a.jpg"]);
});

test("confirmedListingImages: deduplicates and caps at 4, never silently invents or reorders beyond that", () => {
  const urls = Array.from({ length: 10 }, (_, i) => `https://cdn.example.com/${i}.jpg`);
  const withDuplicate = [urls[0], urls[0], ...urls.slice(1)];
  const result = confirmedListingImages(withDuplicate);
  assert.equal(result.length, 4);
  assert.deepEqual(result, urls.slice(0, 4));
});

test("confirmedListingImages: null/undefined/empty input all yield an empty array, never throwing", () => {
  assert.deepEqual(confirmedListingImages(null), []);
  assert.deepEqual(confirmedListingImages(undefined), []);
  assert.deepEqual(confirmedListingImages([]), []);
  assert.deepEqual(confirmedListingImages([42, null, "", "   "] as never), []);
});

// --- analyzeListingDescriptionWithAi -------------------------------------

test("analyzeListingDescriptionWithAi: no API key configured -> null, no network call attempted", async () => {
  let called = false;
  await withApiKey(undefined, () =>
    withFetch(async () => { called = true; throw new Error("must not be called"); }, async () => {
      const result = await analyzeListingDescriptionWithAi("Ładne mieszkanie po remoncie", { title: "Mieszkanie", city: "Łódź" });
      assert.equal(result, null);
    }),
  );
  assert.equal(called, false);
});

test("analyzeListingDescriptionWithAi: empty/whitespace-only description -> null, no network call attempted", async () => {
  let called = false;
  await withApiKey("test-dummy-key", () =>
    withFetch(async () => { called = true; throw new Error("must not be called"); }, async () => {
      assert.equal(await analyzeListingDescriptionWithAi(null, { title: null, city: null }), null);
      assert.equal(await analyzeListingDescriptionWithAi("   ", { title: null, city: null }), null);
    }),
  );
  assert.equal(called, false);
});

test("analyzeListingDescriptionWithAi: parses the mocked structured response and clamps confidence into [0,1]", async () => {
  const findings = { buildingTypeHint: "kamienica", ownershipHint: null, yearBuiltHint: 1910, conditionSummary: "do remontu", renovationMentioned: true, confidence: 4.5, missingInfo: ["ownershipHint"] };
  const result = await withApiKey("test-dummy-key", () =>
    withFetch(async () => responsesApiReply(findings), () => analyzeListingDescriptionWithAi("Kamienica z 1910 roku, do remontu.", { title: "Mieszkanie", city: "Łódź" })),
  );
  assert.ok(result);
  assert.equal(result!.findings.buildingTypeHint, "kamienica");
  assert.equal(result!.findings.yearBuiltHint, 1910);
  assert.equal(result!.findings.confidence, 1, "confidence must be clamped to the [0,1] range even if the model returns something outside it");
  assert.deepEqual(result!.findings.missingInfo, ["ownershipHint"]);
});

test("analyzeListingDescriptionWithAi: sends the request with a strict json_schema that forbids additional properties", async () => {
  let capturedBody: unknown = null;
  await withApiKey("test-dummy-key", () =>
    withFetch(async (_url, init) => {
      capturedBody = JSON.parse(String((init as RequestInit).body));
      return responsesApiReply({ buildingTypeHint: null, ownershipHint: null, yearBuiltHint: null, conditionSummary: null, renovationMentioned: null, confidence: 0.5, missingInfo: [] });
    }, () => analyzeListingDescriptionWithAi("Opis", { title: null, city: null })),
  );
  const format = (capturedBody as Record<string, unknown>).text as Record<string, unknown>;
  const schema = (format.format as Record<string, unknown>).schema as Record<string, unknown>;
  assert.equal(schema.additionalProperties, false);
  assert.equal((format.format as Record<string, unknown>).strict, true);
});

test("analyzeListingDescriptionWithAi: a non-OK HTTP response throws instead of silently returning null (after exhausting retries)", async () => {
  let calls = 0;
  await withApiKey("test-dummy-key", () =>
    withFetch(async () => { calls += 1; return new Response(JSON.stringify({ error: "boom" }), { status: 500 }); }, async () => {
      await assert.rejects(() => analyzeListingDescriptionWithAi("Opis", { title: null, city: null }, { retryDelayMs: 0 }), /HTTP 500/);
    }),
  );
  assert.equal(calls, 3, "a 500 is retryable -- all 3 attempts must be exhausted before giving up");
});

test("analyzeListingDescriptionWithAi: a non-retryable HTTP error (400) fails on the first attempt, no retry wasted", async () => {
  let calls = 0;
  await withApiKey("test-dummy-key", () =>
    withFetch(async () => { calls += 1; return new Response(JSON.stringify({ error: "bad request" }), { status: 400 }); }, async () => {
      await assert.rejects(() => analyzeListingDescriptionWithAi("Opis", { title: null, city: null }, { retryDelayMs: 0 }), /HTTP 400/);
    }),
  );
  assert.equal(calls, 1, "a 400 will never succeed on retry -- it must not be retried");
});

test("analyzeListingDescriptionWithAi: a transient 500 followed by success is recovered via retry, not surfaced as a failure", async () => {
  let calls = 0;
  const findings = { buildingTypeHint: "blok", ownershipHint: null, yearBuiltHint: null, conditionSummary: null, renovationMentioned: null, confidence: 0.5, missingInfo: [] };
  const result = await withApiKey("test-dummy-key", () =>
    withFetch(async () => {
      calls += 1;
      if (calls < 3) return new Response(JSON.stringify({ error: "temporary" }), { status: 503 });
      return responsesApiReply(findings);
    }, () => analyzeListingDescriptionWithAi("Opis", { title: null, city: null }, { retryDelayMs: 0 })),
  );
  assert.equal(calls, 3, "it must have failed twice before succeeding on the 3rd attempt");
  assert.ok(result);
  assert.equal(result!.findings.buildingTypeHint, "blok");
});

test("analyzeListingDescriptionWithAi: an oversized response body is rejected rather than parsed", async () => {
  await withApiKey("test-dummy-key", () =>
    withFetch(async () => new Response("x".repeat(250_000), { status: 200 }), async () => {
      await assert.rejects(() => analyzeListingDescriptionWithAi("Opis", { title: null, city: null }), /przekroczyła dozwolony rozmiar/);
    }),
  );
});

test("analyzeListingDescriptionWithAi: truncates an extremely long description before sending it, never an unbounded request", async () => {
  let sentTextLength = 0;
  await withApiKey("test-dummy-key", () =>
    withFetch(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const content = body.input[0].content[0].text as string;
      sentTextLength = content.length;
      return responsesApiReply({ buildingTypeHint: null, ownershipHint: null, yearBuiltHint: null, conditionSummary: null, renovationMentioned: null, confidence: 0.5, missingInfo: [] });
    }, () => analyzeListingDescriptionWithAi("a".repeat(50_000), { title: null, city: null })),
  );
  assert.ok(sentTextLength < 5_000, `sent prompt text (${sentTextLength} chars) must be bounded, never the full 50000-char description`);
});

// --- analyzeListingPhotosWithAi ------------------------------------------

test("analyzeListingPhotosWithAi: no confirmed images -> null, no network call attempted", async () => {
  let called = false;
  await withApiKey("test-dummy-key", () =>
    withFetch(async () => { called = true; throw new Error("must not be called"); }, async () => {
      assert.equal(await analyzeListingPhotosWithAi([], { title: null }), null);
    }),
  );
  assert.equal(called, false);
});

test("analyzeListingPhotosWithAi: the response schema structurally excludes ownership and apartment parameters -- never just a prompt instruction", async () => {
  let capturedSchema: unknown = null;
  await withApiKey("test-dummy-key", () =>
    withFetch(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      capturedSchema = body.text.format.schema;
      return responsesApiReply({ visibleCondition: "do remontu", visibleFinish: "stare okna", visibleRenovationNeeds: ["widoczne pęknięcia na suficie"], confidence: 0.6, missingInfo: [] });
    }, () => analyzeListingPhotosWithAi(["https://cdn.example.com/a.jpg"], { title: "Mieszkanie" })),
  );
  const properties = Object.keys((capturedSchema as Record<string, unknown>).properties as Record<string, unknown>);
  for (const forbidden of ["ownership", "rooms", "area", "price", "hiddenDefects", "ownershipHint"]) {
    assert.ok(!properties.includes(forbidden), `schema must never include "${forbidden}"`);
  }
  assert.equal((capturedSchema as Record<string, unknown>).additionalProperties, false);
});

test("analyzeListingPhotosWithAi: parses findings and records how many confirmed photos were actually sent", async () => {
  const images = ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"];
  const result = await withApiKey("test-dummy-key", () =>
    withFetch(async () => responsesApiReply({ visibleCondition: "wymaga remontu", visibleFinish: null, visibleRenovationNeeds: ["odpadający tynk"], confidence: 0.7, missingInfo: ["brak zdjęcia łazienki"] }), () =>
      analyzeListingPhotosWithAi(images, { title: "Mieszkanie" }),
    ),
  );
  assert.ok(result);
  assert.equal(result!.findings.photosAnalyzed, 2);
  assert.deepEqual(result!.findings.visibleRenovationNeeds, ["odpadający tynk"]);
});

// --- analyzeListingWithAiIfNeeded (cache + graceful degradation) --------

function fakeAdmin(seedAnalysis: Record<string, unknown> | null) {
  let row = seedAnalysis ? { ...seedAnalysis } : null;
  const upserts: Record<string, unknown>[] = [];
  let tableMissing = false;
  const client = {
    from(table: string) {
      assert.equal(table, "listing_ai_analysis");
      return {
        select: () => ({
          eq: () => ({
            async maybeSingle() {
              if (tableMissing) return { data: null, error: { code: "42P01", message: 'relation "public.listing_ai_analysis" does not exist' } };
              return { data: row, error: null };
            },
          }),
        }),
        upsert: (value: Record<string, unknown>) => ({
          then: (resolve: (v: unknown) => unknown) => {
            if (tableMissing) return Promise.resolve({ error: { code: "42P01", message: 'relation "public.listing_ai_analysis" does not exist' } }).then(resolve);
            upserts.push(value);
            row = { content_hash: value.content_hash, images_hash: value.images_hash, model: value.model, text_findings: value.text_findings, photo_findings: value.photo_findings };
            return Promise.resolve({ error: null }).then(resolve);
          },
        }),
      };
    },
  };
  return { client, upserts, setTableMissing: (value: boolean) => { tableMissing = value; }, get row() { return row; } };
}

test("analyzeListingWithAiIfNeeded: unchanged description and unchanged (absent) images -> cache hit, zero network calls", async () => {
  const admin = fakeAdmin({ content_hash: hashOf({ description: "Opis" }), images_hash: null, model: "gpt-6-luna", text_findings: { cached: true }, photo_findings: null });
  let called = false;
  await withApiKey("test-dummy-key", () =>
    withFetch(async () => { called = true; throw new Error("must not be called"); }, () =>
      analyzeListingWithAiIfNeeded(admin.client as never, "listing-1", { title: null, city: null, description: "Opis", images: [] }),
    ),
  );
  assert.equal(called, false);
  assert.equal(admin.upserts.length, 0, "a true cache hit must not even write an upsert");
});

test("analyzeListingWithAiIfNeeded: changed description triggers a fresh text call and caches it; unrelated photo cache is preserved untouched", async () => {
  const images = ["https://cdn.example.com/a.jpg"];
  const priorImagesHash = hashOf({ images });
  const admin = fakeAdmin({ content_hash: hashOf({ description: "Stary opis" }), images_hash: priorImagesHash, model: "gpt-6-luna", text_findings: { old: true }, photo_findings: { keepMe: true } });
  const result = await withApiKey("test-dummy-key", () =>
    withFetch(async (url) => {
      assert.ok(String(url).includes("api.openai.com"));
      return responsesApiReply({ buildingTypeHint: "blok", ownershipHint: null, yearBuiltHint: null, conditionSummary: null, renovationMentioned: null, confidence: 0.8, missingInfo: [] });
    }, async () => {
      await analyzeListingWithAiIfNeeded(admin.client as never, "listing-2", { title: null, city: null, description: "Nowy opis", images });
      return admin.upserts.at(-1);
    }),
  );
  assert.ok(result);
  assert.deepEqual((result as Record<string, unknown>).photo_findings, { keepMe: true }, "the untouched photo half must keep its previously cached value, not be wiped");
  assert.equal(((result as Record<string, unknown>).text_findings as Record<string, unknown>).buildingTypeHint, "blok");
});

test("analyzeListingWithAiIfNeeded: the draft migration's table missing on READ never throws, but is logged loudly, not silently", async () => {
  const admin = fakeAdmin(null);
  admin.setTableMissing(true);
  const warnings = await withConsoleWarn((calls) =>
    withApiKey("test-dummy-key", () =>
      withFetch(async () => { throw new Error("must not be called"); }, async () => {
        await analyzeListingWithAiIfNeeded(admin.client as never, "listing-3", { title: null, city: null, description: "Opis", images: [] });
        return calls;
      }),
    ),
  );
  assert.equal(admin.upserts.length, 0, "a missing table means there is nothing to upsert");
  const tableMissingWarning = warnings.find(([tag]) => tag === "LISTING_AI_ANALYSIS_TABLE_MISSING");
  assert.ok(tableMissingWarning, "a missing table must be logged, never pass as silent success");
  assert.equal((tableMissingWarning?.[1] as Record<string, unknown>).stage, "read");
});

test("analyzeListingWithAiIfNeeded: the draft migration's table missing on WRITE is also logged loudly, not silently", async () => {
  // A dedicated fake: the read succeeds normally (as if the table exists),
  // but the write/upsert fails with the real missing-table error code --
  // the one combination fakeAdmin() cannot express, since there it is a
  // single flag shared by both steps.
  const client = {
    from(table: string) {
      assert.equal(table, "listing_ai_analysis");
      return {
        select: () => ({ eq: () => ({ async maybeSingle() { return { data: null, error: null }; } }) }),
        upsert: () => ({
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ error: { code: "42P01", message: 'relation "public.listing_ai_analysis" does not exist' } }).then(resolve),
        }),
      };
    },
  };
  const warnings = await withConsoleWarn((calls) =>
    withApiKey("test-dummy-key", () =>
      withFetch(async () => responsesApiReply({ buildingTypeHint: null, ownershipHint: null, yearBuiltHint: null, conditionSummary: null, renovationMentioned: null, confidence: 0.5, missingInfo: [] }), async () => {
        await analyzeListingWithAiIfNeeded(client as never, "listing-3b", { title: null, city: null, description: "Opis", images: [] });
        return calls;
      }),
    ),
  );
  const tableMissingWarning = warnings.find(([tag]) => tag === "LISTING_AI_ANALYSIS_TABLE_MISSING");
  assert.ok(tableMissingWarning, "a missing table on write must be logged, never pass as silent success");
  assert.equal((tableMissingWarning?.[1] as Record<string, unknown>).stage, "write");
});

test("analyzeListingWithAiIfNeeded: a real AI call failure (even after exhausting retries) never throws, preserves the prior cache, and marks the half pending retry instead of caching it as success", async () => {
  const admin = fakeAdmin(null);
  let calls = 0;
  await withApiKey("test-dummy-key", () =>
    withFetch(async () => { calls += 1; throw new Error("simulated network failure"); }, () =>
      analyzeListingWithAiIfNeeded(admin.client as never, "listing-4", { title: null, city: null, description: "Opis", images: [] }, { retryDelayMs: 0 }),
    ),
  );
  assert.equal(calls, 3, "a thrown/network failure is retryable -- all 3 attempts must be exhausted");
  assert.equal(admin.upserts.length, 1, "a failed call still writes a row, so the scan itself is never blocked");
  assert.equal(admin.upserts[0]?.text_findings, null, "no prior cached findings existed, so there is nothing to fall back to");
  assert.equal(admin.upserts[0]?.content_hash, "__pending_retry__", "a failure must never be cached under the real content hash -- that would make an unchanged re-scan skip retrying it forever");
});

test("analyzeListingWithAiIfNeeded: a failure on a listing that already had a successful cached analysis keeps that prior result instead of wiping it to null", async () => {
  const admin = fakeAdmin({ content_hash: hashOf({ description: "Stary opis" }), images_hash: null, model: "gpt-6-luna", text_findings: { buildingTypeHint: "blok", stillGood: true }, photo_findings: null });
  await withApiKey("test-dummy-key", () =>
    withFetch(async () => { throw new Error("simulated network failure"); }, () =>
      analyzeListingWithAiIfNeeded(admin.client as never, "listing-4b", { title: null, city: null, description: "Nowy opis, inny niz stary", images: [] }, { retryDelayMs: 0 }),
    ),
  );
  assert.deepEqual(admin.upserts[0]?.text_findings, { buildingTypeHint: "blok", stillGood: true }, "a failed re-analysis must keep the last known-good findings, not wipe them to null");
  assert.equal(admin.upserts[0]?.content_hash, hashOf({ description: "Stary opis" }), "the hash must stay at the last successfully-analyzed value, not advance to the new (unanalyzed) content, and never equal the pending sentinel when a real prior hash exists");
});

test("analyzeListingWithAiIfNeeded: a pending-retry hash from a prior failure is retried on the next scan even though the listing's own content did not change again", async () => {
  const admin = fakeAdmin({ content_hash: "__pending_retry__", images_hash: null, model: "gpt-6-luna", text_findings: null, photo_findings: null });
  let calls = 0;
  const findings = { buildingTypeHint: "blok", ownershipHint: null, yearBuiltHint: null, conditionSummary: null, renovationMentioned: null, confidence: 0.9, missingInfo: [] };
  await withApiKey("test-dummy-key", () =>
    withFetch(async () => { calls += 1; return responsesApiReply(findings); }, () =>
      // Same description as before -- a plain run-of-the-mill unchanged
      // re-scan would normally be a cache hit, but __pending_retry__ can
      // never equal a real hash, so this must still call the API.
      analyzeListingWithAiIfNeeded(admin.client as never, "listing-4c", { title: null, city: null, description: "Opis", images: [] }, { retryDelayMs: 0 }),
    ),
  );
  assert.equal(calls, 1, "a pending-retry row must trigger a fresh attempt, not be treated as a cache hit");
  assert.equal((admin.upserts[0]?.text_findings as Record<string, unknown> | null)?.buildingTypeHint, "blok");
  assert.notEqual(admin.upserts[0]?.content_hash, "__pending_retry__", "a successful retry must advance past the pending sentinel to the real hash");
});

// --- Cost calculation for the real gpt-6-luna rates ---------------------

test("analyzeListingWithAiIfNeeded: a successful call reports a real, non-UNAVAILABLE cost for gpt-6-luna (not just token counts)", async () => {
  const admin = fakeAdmin(null);
  const infoCalls: Array<[string, Record<string, unknown>]> = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => { infoCalls.push(args as [string, Record<string, unknown>]); };
  try {
    await withApiKey("test-dummy-key", () =>
      withFetch(
        async () => responsesApiReply(
          { buildingTypeHint: "blok", ownershipHint: null, yearBuiltHint: null, conditionSummary: null, renovationMentioned: null, confidence: 0.8, missingInfo: [] },
          { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_000_000 },
        ),
        () => analyzeListingWithAiIfNeeded(admin.client as never, "listing-5", { title: null, city: null, description: "Opis", images: [] }),
      ),
    );
  } finally {
    console.info = originalInfo;
  }
  const usageLog = infoCalls.find(([tag]) => tag === "LISTING_AI_USAGE");
  assert.ok(usageLog, "a successful call must log LISTING_AI_USAGE");
  const usage = usageLog![1];
  assert.equal(usage.dataQuality, "EXACT", "token counts and gpt-6-luna pricing are both available -- this must not be UNAVAILABLE");
  // $0.10/M input * 1M + $0.50/M output * 1M = $0.10 + $0.50 = $0.60
  assert.equal(usage.estimatedCostUsd, 0.6);
});
