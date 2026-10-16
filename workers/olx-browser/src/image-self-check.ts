// Build-time check for the container image (see Dockerfile). Loads every
// module the entry point uses and launches the bundled headless Chromium once.
// It never contacts OLX or the Flip Manager API.
import "./api-client.ts";
import "./config.ts";
import "./worker.ts";
import { createOlxBrowserFetcher } from "./browser.ts";
import { chromium } from "playwright";

if (typeof createOlxBrowserFetcher !== "function") throw new Error("browser module did not load");
const browser = await chromium.launch({ headless: true });
process.stdout.write(`IMAGE_SELF_CHECK_OK chromium=${browser.version()}\n`);
await browser.close();
