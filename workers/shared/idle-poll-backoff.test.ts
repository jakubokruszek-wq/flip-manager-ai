import assert from "node:assert/strict";
import test from "node:test";
import { createIdlePollBackoff } from "./idle-poll-backoff.ts";

test("idle claims back off while retaining a bounded delay", () => {
  const backoff = createIdlePollBackoff(10_000);
  assert.equal(backoff.currentDelayMs(), 10_000);
  backoff.recordEmptyClaim();
  assert.equal(backoff.currentDelayMs(), 20_000);
  backoff.recordEmptyClaim();
  assert.equal(backoff.currentDelayMs(), 40_000);
  backoff.recordEmptyClaim();
  assert.equal(backoff.currentDelayMs(), 60_000);
  backoff.recordEmptyClaim();
  assert.equal(backoff.currentDelayMs(), 60_000);
});

test("a claimed job resets idle delay so the next empty poll remains responsive", () => {
  const backoff = createIdlePollBackoff(2_000);
  backoff.recordEmptyClaim();
  backoff.recordEmptyClaim();
  assert.equal(backoff.currentDelayMs(), 8_000);
  backoff.recordClaimWithJob();
  assert.equal(backoff.currentDelayMs(), 2_000);
});

test("request errors use the same bounded idle backoff without weakening claim semantics", () => {
  const backoff = createIdlePollBackoff(5_000, 15_000);
  backoff.recordRequestError();
  assert.equal(backoff.currentDelayMs(), 10_000);
  backoff.recordRequestError();
  assert.equal(backoff.currentDelayMs(), 15_000);
  backoff.recordClaimWithJob();
  assert.equal(backoff.currentDelayMs(), 5_000);
});

test("invalid backoff bounds fail closed", () => {
  assert.throws(() => createIdlePollBackoff(0), /baseDelayMs/);
  assert.throws(() => createIdlePollBackoff(10_000, 9_999), /maxDelayMs/);
});

test("a configured base interval above the default cap remains valid", () => {
  const backoff = createIdlePollBackoff(300_000);
  assert.equal(backoff.currentDelayMs(), 300_000);
});
