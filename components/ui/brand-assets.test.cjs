/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(repoRoot, relative));

function assertPng(relative) {
  const bytes = fs.readFileSync(path.join(repoRoot, relative));
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], relative);
}

test("the supplied Flip Manager artwork is installed for web and PWA branding", () => {
  for (const file of [
    "public/brand/flip-manager-icon.png",
    "app/icon.png",
    "app/apple-icon.png",
    "public/icons/flip-manager-180.png",
    "public/icons/flip-manager-48.png",
    "public/icons/flip-manager-192.png",
    "public/icons/flip-manager-512.png",
  ]) {
    assert.ok(exists(file), `${file} exists`);
    assertPng(file);
  }

  const manifest = read("app/manifest.ts");
  assert.match(manifest, /\/icons\/flip-manager-192\.png/);
  assert.match(manifest, /\/icons\/flip-manager-512\.png/);
});

test("push notifications use the installed brand artwork instead of the generated text icon", () => {
  for (const file of ["features/push/server.ts", "features/push/alert-delivery.ts", "public/sw.js"]) {
    const source = read(file);
    assert.match(source, /flip-manager-192\.png/);
    assert.doesNotMatch(source, /["']\/icon["']/);
  }
});

test("the browser extension declares and renders the same icon at every supported size", () => {
  const manifest = JSON.parse(read("extensions/facebook-collector/manifest.json"));
  const expected = {
    16: "icons/flip-manager-16.png",
    32: "icons/flip-manager-32.png",
    48: "icons/flip-manager-48.png",
    128: "icons/flip-manager-128.png",
  };
  assert.deepEqual(manifest.icons, expected);
  assert.deepEqual(manifest.action.default_icon, { 16: expected[16], 32: expected[32], 48: expected[48] });
  for (const relative of Object.values(expected)) {
    const file = path.join("extensions/facebook-collector", relative);
    assert.ok(exists(file), `${file} exists`);
    assertPng(file);
  }
  assert.match(read("extensions/facebook-collector/popup.html"), /icons\/flip-manager-48\.png/);
  assert.match(read("extensions/facebook-collector/options.html"), /icons\/flip-manager-48\.png/);
});
