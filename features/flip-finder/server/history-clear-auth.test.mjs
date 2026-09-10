import assert from "node:assert/strict";
import test from "node:test";

import { authorizeHistoryClear } from "./history-clear-auth.ts";

function request(origin, action = "clear-search-history", fetchSite = "same-origin") {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  if (action) headers.set("x-flip-finder-action", action);
  if (fetchSite) headers.set("sec-fetch-site", fetchSite);
  return new Request("https://flip-manager-ai.vercel.app/api/flip-finder/history", { method: "DELETE", headers });
}

test("allows the explicit same-origin history clear action", () => {
  assert.equal(authorizeHistoryClear(request("https://flip-manager-ai.vercel.app")), null);
  assert.equal(authorizeHistoryClear(request("http://localhost:3000")), null);
});

test("rejects missing, cross-site, and incorrectly labeled actions", async () => {
  for (const value of [
    request(null),
    request("https://attacker.example"),
    request("https://flip-manager-ai.vercel.app", "gallery"),
    request("https://flip-manager-ai.vercel.app", "clear-search-history", "cross-site"),
  ]) {
    const response = authorizeHistoryClear(value);
    assert.equal(response?.status, 403);
    assert.deepEqual(await response?.json(), { ok: false, code: "HISTORY_CLEAR_FORBIDDEN" });
  }
});
