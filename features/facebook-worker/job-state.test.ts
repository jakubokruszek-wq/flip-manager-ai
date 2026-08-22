import assert from "node:assert/strict";
import test from "node:test";
import { claimFacebookJobState, facebookJobIdempotencyKey, heartbeatFacebookJobState, settleFacebookJobState, type FacebookJobState } from "./types.ts";

const queued: FacebookJobState = { status: "queued", attempts: 0, maxAttempts: 3, leaseToken: null, leasedUntil: null, heartbeatAt: null };

test("claims queued job and creates a lease", () => { const state = claimFacebookJobState(queued, 1_000); assert.equal(state.status, "running"); assert.equal(state.attempts, 1); assert.equal(state.leasedUntil, 181_000); });
test("heartbeat extends the lease", () => { const state = heartbeatFacebookJobState(claimFacebookJobState(queued, 1_000), 31_000); assert.equal(state.heartbeatAt, 31_000); assert.equal(state.leasedUntil, 211_000); });
test("expired lease can be claimed again", () => { const first = claimFacebookJobState(queued, 1_000, 100); const second = claimFacebookJobState(first, 1_101, 100); assert.equal(second.attempts, 2); });
test("complete and fail settle running jobs", () => { const running = claimFacebookJobState(queued, 1_000); assert.equal(settleFacebookJobState(running, "completed").status, "completed"); assert.equal(settleFacebookJobState(running, "failed").status, "failed"); });
test("idempotency key is stable and group-specific", () => { assert.equal(facebookJobIdempotencyKey("filter", "run", "group-a"), "filter:facebook:run:group-a"); assert.notEqual(facebookJobIdempotencyKey("filter", "run", "group-a"), facebookJobIdempotencyKey("filter", "run", "group-b")); });
