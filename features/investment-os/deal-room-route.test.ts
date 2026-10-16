import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { OperatorIdentity } from "../auth/operator";
import { DealRoomInputError } from "./deal-room-answers.ts";
let actor: OperatorIdentity | null = { id: "33333333-3333-4333-8333-333333333333", email: null };
let enabled = true, foreign = false, writes = 0;
class NotFound extends Error {}
mock.module(new URL("../auth/operator.ts", import.meta.url).href, { namedExports: {
  requireOperator: async () => { if (!actor) throw Error("unauthorized"); return actor; },
  operatorAuthorizationResponse: () => Response.json({ code: "OPERATOR_SESSION_REQUIRED" }, { status: 401 }),
} });
mock.module(new URL("./server/deal-room-service.ts", import.meta.url).href, { namedExports: {
  dealRoomEnabled: () => enabled, DealRoomNotFound: NotFound,
  readDealRoom: async () => { if (foreign) throw new NotFound(); return { version: 1, answers: {} }; },
  saveDealRoomAnswers: async (_listing: string, owner: string, body: unknown) => { writes++; return { owner, body }; },
} });
// Import the real HTTP boundary after replacing only authentication and persistence.
const { GET, POST } = await import("../../app/api/flip-finder/listings/[id]/investment/answers/route.ts");
const id = "22222222-2222-4222-8222-222222222222", context = { params: Promise.resolve({ id }) };
const request = (body: unknown, headers: Record<string, string> = {}) => new Request(`http://localhost/api/flip-finder/listings/${id}/investment/answers`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
test("answers boundary authenticates before touching state", async () => {
  actor = null; const before = writes;
  assert.equal((await POST(request({}), context)).status, 401); assert.equal(writes, before);
  actor = { id: "33333333-3333-4333-8333-333333333333", email: null };
});
test("body cannot select owner; trusted getUser identity is passed to persistence", async () => {
  const response = await POST(request({ ownerId: "attacker" }), context);
  assert.equal((await response.json()).owner, actor!.id);
});
test("foreign workspace returns generic NOT_FOUND without answers", async () => {
  foreign = true; const response = await GET(new Request('http://localhost/'), context); foreign = false;
  assert.equal(response.status, 404); assert.deepEqual(await response.json(), { code: "NOT_FOUND" });
});
test("disabled flag, cross-origin, oversized and non-JSON writes are refused", async () => {
  const before = writes;
  enabled = false; assert.equal((await POST(request({}),context)).status,404); enabled = true;
  assert.equal((await POST(request({}, { origin: "https://evil.test" }),context)).status,403);
  assert.equal((await POST(request('a'.repeat(25000)),context)).status,413);
  assert.equal((await POST(request({}, { "content-type": "text/plain" }),context)).status,415);
  assert.equal(writes,before);
});
// Keep the imported input error contract explicit without exposing DB details.
test("input error is a typed validation error", () => assert.ok(new DealRoomInputError() instanceof Error));
