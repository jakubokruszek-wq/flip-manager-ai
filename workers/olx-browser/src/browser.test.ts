import assert from "node:assert/strict";
import test from "node:test";

import { classifyOlxResponse } from "./browser.ts";

test("classifies OLX access failures without retry/bypass", () => {
  assert.deepEqual(classifyOlxResponse(403, ""), { blocked: true, code: "OLX_HTTP_403" });
  assert.deepEqual(classifyOlxResponse(405, "<title>Human Verification</title>"), { blocked: true, code: "OLX_HTTP_405" });
  assert.deepEqual(classifyOlxResponse(429, ""), { blocked: true, code: "OLX_HTTP_429" });
  assert.deepEqual(classifyOlxResponse(200, "<title>Human Verification</title>"), { blocked: true, code: "OLX_HUMAN_VERIFICATION" });
  assert.deepEqual(classifyOlxResponse(200, "<title>Mieszkania Łódź</title>"), { blocked: false, code: null });
});
