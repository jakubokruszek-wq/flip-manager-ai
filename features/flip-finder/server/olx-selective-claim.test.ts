import assert from "node:assert/strict";
import test from "node:test";

import { parseClaimSelector } from "./olx-selective-claim.ts";

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FILTER = "22222222-2222-4222-8222-222222222222";

test("selective claim payload: exactly one UUID selector, worker id required", () => {
  assert.deepEqual(parseClaimSelector({ workerId: "cloudflare-olx-1", jobId: JOB }), { workerId: "cloudflare-olx-1", selector: { jobId: JOB } });
  assert.deepEqual(parseClaimSelector({ workerId: "cloudflare-olx-1", filterId: FILTER }), { workerId: "cloudflare-olx-1", selector: { filterId: FILTER } });
  assert.throws(() => parseClaimSelector({ workerId: "cloudflare-olx-1" }), /INVALID_SELECTOR/, "no selector would mean 'any job'");
  assert.throws(() => parseClaimSelector({ workerId: "cloudflare-olx-1", jobId: JOB, filterId: FILTER }), /INVALID_SELECTOR/);
  assert.throws(() => parseClaimSelector({ workerId: "cloudflare-olx-1", jobId: "1; drop table olx_scan_jobs" }), /INVALID_SELECTOR/);
  assert.throws(() => parseClaimSelector({ jobId: JOB }), /INVALID_PAYLOAD/);
  assert.throws(() => parseClaimSelector(null), /INVALID_PAYLOAD/);
});
