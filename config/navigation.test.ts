import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { getModuleTitle } from "./modules.ts";
import {
  hiddenNavigationIds,
  isNavigationItemActive,
  navigationSections,
  workingNavigationItems,
} from "./navigation.ts";

const routeFiles = new Map([
  ["/dashboard", "app/(app)/dashboard/page.tsx"],
  ["/properties", "app/(app)/properties/page.tsx"],
  ["/flip-finder", "app/(app)/flip-finder/page.tsx"],
  ["/facebook-watcher", "app/(app)/facebook-watcher/page.tsx"],
  ["/settings", "app/(app)/settings/page.tsx"],
]);

test("every active navigation item points to an existing App Router page", () => {
  for (const item of workingNavigationItems) {
    assert.ok(item.href, `${item.title} has no href`);
    const routeFile = routeFiles.get(item.href);
    assert.ok(routeFile, `${item.href} is missing from the audited route registry`);
    assert.equal(existsSync(routeFile), true, `${item.href} would render as 404`);
  }
});

test("placeholder modules are hidden from active navigation", () => {
  assert.deepEqual(hiddenNavigationIds.sort(), ["ai", "crm", "documents", "market", "renovations"]);
  const activeTitles = new Set(workingNavigationItems.map((item) => item.title));
  for (const title of ["Analiza AI", "CRM", "Dokumenty", "Rynek", "Remonty"]) {
    assert.equal(activeTitles.has(title), false);
  }
});

test("desktop navigation and mobile navigation use the same active item list", () => {
  const desktopItems = navigationSections.flatMap((section) => section.items);
  assert.deepEqual(desktopItems.map((item) => item.href), workingNavigationItems.map((item) => item.href));
  const mobileSource = readFileSync("components/layout/mobile-bottom-nav.tsx", "utf8");
  assert.match(mobileSource, /workingNavigationItems\.map/);
});

test("active state matches exact and nested routes without activating Dashboard globally", () => {
  assert.equal(isNavigationItemActive("/flip-finder", "/flip-finder"), true);
  assert.equal(isNavigationItemActive("/properties/new", "/properties"), true);
  assert.equal(isNavigationItemActive("/facebook-watcher/groups", "/facebook-watcher"), true);
  assert.equal(isNavigationItemActive("/settings/alerts", "/settings"), true);
  assert.equal(isNavigationItemActive("/properties", "/dashboard"), false);
});

test("nested pages receive the correct top navigation title", () => {
  assert.equal(getModuleTitle("/properties/new"), "Nieruchomości");
  assert.equal(getModuleTitle("/facebook-watcher/groups"), "Facebook Watcher");
  assert.equal(getModuleTitle("/flip-finder/filters/new"), "Flip Finder");
});
