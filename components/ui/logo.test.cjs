/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const logo = fs.readFileSync(path.join(__dirname, "logo.tsx"), "utf8");
const topNav = fs.readFileSync(path.join(__dirname, "../layout/top-nav.tsx"), "utf8");
const sidebar = fs.readFileSync(path.join(__dirname, "../layout/sidebar.tsx"), "utf8");
const login = fs.readFileSync(path.join(__dirname, "../../app/login/page.tsx"), "utf8");
const globals = fs.readFileSync(path.join(__dirname, "../../app/globals.css"), "utf8");

test("visible product branding includes the exact product and operator signature", () => {
  for (const source of [logo, topNav, sidebar, login]) {
    assert.match(source, /Flip Manager by Jakub Okruszek/);
  }
  assert.match(logo, /aria-label="Jakub Okruszek"/);
  assert.match(logo, /\/icons\/flip-manager-48\.png/);
  assert.match(globals, /Segoe Print/);
  assert.match(globals, /color: var\(--gold\)/);
  assert.doesNotMatch(globals, /https?:\/\//);
});
