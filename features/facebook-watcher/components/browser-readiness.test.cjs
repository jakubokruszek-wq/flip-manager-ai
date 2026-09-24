/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const test = require("node:test");
const { isValidReadinessResponse } = require("./browser-readiness.cjs");

const headers = { "content-type": "application/json; charset=utf-8" };
const body = { commitSha: null, environment: null };

test("browser readiness rejects 404 responses", () => {
  assert.equal(isValidReadinessResponse({ statusCode: 404, headers, body }), false);
});

test("browser readiness rejects 500 responses", () => {
  assert.equal(isValidReadinessResponse({ statusCode: 500, headers, body }), false);
});

test("browser readiness rejects malformed JSON bodies", () => {
  assert.equal(isValidReadinessResponse({ statusCode: 200, headers, body: null }), false);
});

test("browser readiness accepts the real build-info response shape", () => {
  assert.equal(isValidReadinessResponse({ statusCode: 200, headers, body }), true);
});

test("browser readiness requires JSON content type and both build-info fields", () => {
  assert.equal(isValidReadinessResponse({ statusCode: 200, headers: { "content-type": "text/html" }, body }), false);
  assert.equal(isValidReadinessResponse({ statusCode: 200, headers, body: { commitSha: null } }), false);
});
