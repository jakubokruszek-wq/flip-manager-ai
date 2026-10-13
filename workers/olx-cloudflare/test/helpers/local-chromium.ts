/**
 * Local stand-in for Cloudflare Browser Run: the regular `playwright` package
 * (root devDependency) driving the pre-installed Chromium. `@cloudflare/playwright`
 * exposes the same Browser/BrowserContext/Page API, so the cloud session code
 * runs unchanged against it. Every request to olx.pl is answered from fixtures;
 * everything else is aborted, so tests never touch the network.
 */
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext } from "playwright";

import type { BrowserLike, BrowserProvider } from "../../src/browser-session.ts";
import { decodeExtractedPage, extractionExpression, type ExtractedOlxPage } from "../../src/olx-page.ts";

export type FixtureResponse = { status: number; body: string };

export type LocalChromium = {
  extract(url: string, html: string): Promise<ExtractedOlxPage>;
  /** Evaluates an arbitrary expression on a fixture page (e.g. the full in-page pipeline). */
  evaluate(url: string, html: string, expression: string, options?: { javaScriptEnabled?: boolean }): Promise<unknown>;
  provider(routes: (url: string) => FixtureResponse, options?: { failLaunch?: () => Error | null }): BrowserProvider & { stats: { launches: number; closes: number; pagesOpened: number; olxRequests: string[] } };
  close(): Promise<void>;
};

export async function localChromium(): Promise<LocalChromium | null> {
  let browser: Browser;
  try {
    // OLX_TEST_CHROMIUM_PATH (or a pre-installed /opt/pw-browsers/chromium) when Playwright's own download is absent.
    const executablePath = process.env.OLX_TEST_CHROMIUM_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
    browser = await chromium.launch({ headless: true, executablePath });
  } catch {
    return null;
  }
  async function routed(context: BrowserContext, routes: (url: string) => FixtureResponse, seen: string[]) {
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (/^https:\/\/(www\.)?olx\.pl\//.test(url) && route.request().resourceType() === "document") {
        seen.push(url);
        const response = routes(url);
        await route.fulfill({ status: response.status, contentType: "text/html; charset=utf-8", body: response.body });
      } else {
        await route.abort();
      }
    });
  }
  return {
    async extract(url, html) {
      const context = await browser.newContext({ locale: "pl-PL" });
      try {
        await routed(context, () => ({ status: 200, body: html }), []);
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return decodeExtractedPage(await page.evaluate(extractionExpression()));
      } finally {
        await context.close();
      }
    },
    async evaluate(url, html, expression, options = {}) {
      const context = await browser.newContext({ locale: "pl-PL", javaScriptEnabled: options.javaScriptEnabled ?? true });
      try {
        await routed(context, () => ({ status: 200, body: html }), []);
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return await page.evaluate(expression);
      } finally {
        await context.close();
      }
    },
    provider(routes, options = {}) {
      const stats = { launches: 0, closes: 0, pagesOpened: 0, olxRequests: [] as string[] };
      return {
        stats,
        async launch() {
          const failure = options.failLaunch?.();
          if (failure) throw failure;
          stats.launches += 1;
          let open = true;
          // One "session" = a dedicated browser context group; closing it ends the session.
          const contexts: BrowserContext[] = [];
          const session: BrowserLike = {
            async newContext(contextOptions) {
              if (!open) throw new Error("Target page, context or browser has been closed");
              const context = await browser.newContext(contextOptions);
              contexts.push(context);
              await routed(context, routes, stats.olxRequests);
              context.on("page", () => { stats.pagesOpened += 1; });
              return context as unknown as Awaited<ReturnType<BrowserLike["newContext"]>>;
            },
            async close() {
              if (!open) return;
              open = false;
              stats.closes += 1;
              await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
            },
          };
          return { browser: session, sessionId: `local-session-${stats.launches}` };
        },
      };
    },
    close: () => browser.close(),
  };
}
