import assert from "node:assert/strict";
import test from "node:test";
import { authorizeInvestmentMutation } from "./request-auth.ts";

test("rejects missing and cross-site mutation context", async () => {
  assert.equal((authorizeInvestmentMutation(new Request("https://flip-manager-ai.vercel.app/api/x", { method: "PUT" }))!).status, 403);
  assert.equal((authorizeInvestmentMutation(new Request("https://flip-manager-ai.vercel.app/api/x", { method: "PUT", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "x-flip-finder-action": "investment-os" } }))!).status, 403);
});

test("allows only canonical same-origin Investment OS mutation", () => {
  assert.equal(authorizeInvestmentMutation(new Request("https://flip-manager-ai.vercel.app/api/x", { method: "PUT", headers: { origin: "https://flip-manager-ai.vercel.app", "sec-fetch-site": "same-origin", "x-flip-finder-action": "investment-os" } })), null);
});
