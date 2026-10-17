import assert from "node:assert/strict";
import test from "node:test";
import { offlineTestOrigin, remoteOfflineTestConfig } from "./offline-test-config.ts";
import { collectorSigningKey } from "../protocol.ts";
const valid = () => ({ FLIP_OFFLINE_REMOTE_TEST: "true", FLIP_OFFLINE_TEST_ORIGIN: "https://watcher-test.example.org", FLIP_OFFLINE_DEVICE_SIGNING_KEY: "a".repeat(64), FLIP_OFFLINE_TEST_EXPIRES_AT: String(Date.now() + 3600_000) });
test("remote offline API stays disabled by default", () => assert.equal(remoteOfflineTestConfig({}), null));
test("remote test requires a dedicated HTTPS origin", () => {
  for (const origin of ["http://test.example.org", "https://flip-manager-ai.vercel.app", "https://project.supabase.co", "https://localhost", "https://user:pass@test.example.org", "https://test.example.org/path", "https://test.example.org/?token=secret", "https://test.example.org/#secret"])
    assert.throws(() => offlineTestOrigin(origin));
  assert.equal(offlineTestOrigin("https://watcher-test.example.org/"), "https://watcher-test.example.org");
});
test("remote test refuses production credentials and enabled production queues", () => {
  for (const key of ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY", "FACEBOOK_ANDROID_QUEUE_ENABLED", "FACEBOOK_ANDROID_INTEGRATION_ENABLED"])
    assert.throws(() => remoteOfflineTestConfig({ ...valid(), [key]: "true" }), /PRODUCTION_CONFIG_FORBIDDEN/);
});
test("remote test requires provisioned key and bounded expiration", () => {
  assert.throws(() => remoteOfflineTestConfig({ ...valid(), FLIP_OFFLINE_DEVICE_SIGNING_KEY: "isolated-ci-device-token" }), /KEY_REQUIRED/);
  assert.throws(() => remoteOfflineTestConfig({ ...valid(), FLIP_OFFLINE_DEVICE_SIGNING_KEY: collectorSigningKey("isolated-ci-device-token") }), /KEY_REQUIRED/);
  for (const expiry of ["", "NaN", "1", String(Date.now() + 8 * 86400_000)])
    assert.throws(() => remoteOfflineTestConfig({ ...valid(), FLIP_OFFLINE_TEST_EXPIRES_AT: expiry }), /EXPIRY_REQUIRED/);
  assert.equal(remoteOfflineTestConfig(valid())?.origin, "https://watcher-test.example.org");
});
