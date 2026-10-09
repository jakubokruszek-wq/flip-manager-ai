import assert from "node:assert/strict";
import test, { mock } from "node:test";

let closeCount = 0;
let gotoStarted: (() => void) | null = null;
let rejectNavigation: ((reason: Error) => void) | null = null;
const navigationStarted = new Promise<void>((resolve) => { gotoStarted = resolve; });

mock.module("playwright", { namedExports: {
  chromium: {
    launch: async () => ({
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => new Promise((_resolve, reject) => { rejectNavigation = reject; gotoStarted?.(); }),
          content: async () => "",
          url: () => "https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/",
          title: async () => "OLX",
        }),
      }),
      close: async () => { closeCount += 1; rejectNavigation?.(new Error("browser closed")); },
    }),
  },
} });
const { fetchOlxWithBrowser } = await import("./browser.ts");

test("lease-loss abort closes Chromium during an in-flight OLX navigation", async () => {
  closeCount = 0;
  const controller = new AbortController();
  const result = assert.rejects(fetchOlxWithBrowser("https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/", controller.signal));
  await navigationStarted;
  controller.abort(new Error("lease lost"));
  await result;
  assert.ok(closeCount >= 1, "browser.close must be invoked promptly when the lease signal aborts");
});
