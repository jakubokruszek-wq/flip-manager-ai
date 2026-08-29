import test from "node:test";
import assert from "node:assert/strict";

import { createPairingChallenge, verifyPairingChallenge } from "./pairing.ts";

test("accepts issued challenge and rejects mismatched values", () => {
    process.env.FLIP_COLLECTOR_PAIRING_SECRET = "test-secret";
    const issued = createPairingChallenge();
    assert.equal(verifyPairingChallenge(issued.cookie, issued.challenge), true);
    assert.equal(verifyPairingChallenge(issued.cookie, "wrong"), false);
});

test("fails closed when pairing secret unavailable", () => {
    delete process.env.FLIP_COLLECTOR_PAIRING_SECRET;
    assert.throws(() => createPairingChallenge(), /COLLECTOR_PAIRING_NOT_CONFIGURED/);
});
