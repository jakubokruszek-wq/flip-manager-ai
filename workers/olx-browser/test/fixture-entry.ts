// TEST-ONLY container entry point. Runs the production process wiring
// (startWorkerProcess: config, signals, watchdog, monitoring) and the real
// headless Chromium of the image, but answers www.olx.pl navigations from a
// local fixture and aborts every other request, so no OLX page is fetched.
// The image does not contain this file; the container test mounts it.
import type { Route } from "playwright";

import { createOlxBrowserFetcher } from "../src/browser.ts";
import { startWorkerProcess } from "../src/process-main.ts";

const mode = process.env.OLX_FIXTURE_MODE ?? "ok"; // ok | hang | http403 | captcha
const adCount = Number(process.env.OLX_FIXTURE_ADS ?? 3);
const delayMs = Number(process.env.OLX_FIXTURE_DELAY_MS ?? 0);
const heartbeatIntervalMs = process.env.OLX_FIXTURE_HEARTBEAT_MS ? Number(process.env.OLX_FIXTURE_HEARTBEAT_MS) : undefined;

function fixtureHtml(count: number): string {
  const ads = Array.from({ length: count }, (_, index) => ({
    id: `fixture-ID${index + 1}.html`,
    url: `https://www.olx.pl/d/oferta/fixture-ID${index + 1}.html`,
    title: `Mieszkanie testowe ${index + 1}`,
    price: { regularPrice: { value: 300_000 + index * 1_000 } },
    params: [{ key: "m", normalizedValue: "50" }, { key: "rooms", normalizedValue: "two" }],
    location: { cityName: "Łódź", districtName: "Bałuty" },
    photos: [],
    createdTime: "2026-10-01T10:00:00Z",
  }));
  const state = JSON.stringify(JSON.stringify({ listing: { listing: { ads } } }));
  return `<!doctype html><html><head><title>OLX fixture</title></head><body><script>window.__PRERENDERED_STATE__ = ${state};</script></body></html>`;
}

async function answer(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  if ((url.hostname !== "www.olx.pl" && url.hostname !== "olx.pl") || route.request().resourceType() !== "document") {
    await route.abort();
    return;
  }
  if (mode === "hang") return; // never answered: a page stuck until abort or container kill
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (mode === "http403") return route.fulfill({ status: 403, contentType: "text/html", body: "<title>403 Forbidden</title>" });
  if (mode === "captcha") return route.fulfill({ status: 200, contentType: "text/html", body: "<html><head><title>Human Verification</title></head></html>" });
  return route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml(adCount) });
}

const scrape = createOlxBrowserFetcher({ prepareContext: async (context) => { await context.route("**/*", answer); } });
void startWorkerProcess({ scrape, jobTiming: heartbeatIntervalMs ? { heartbeatIntervalMs } : undefined });
