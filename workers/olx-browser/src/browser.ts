import { chromium } from "playwright";

import { assertAllowedOlxUrl, isOlxChallengeHtml, parseOlxHtml } from "../../../features/flip-finder/olx-parser.ts";
import { ControlledOlxFailure } from "./retry.ts";

export function classifyOlxResponse(status: number | null, html: string): { blocked: boolean; code: string | null } {
  if (status === 403 || status === 405 || status === 429) return { blocked: true, code: `OLX_HTTP_${status}` };
  if (isOlxChallengeHtml(html)) return { blocked: true, code: "OLX_HUMAN_VERIFICATION" };
  return { blocked: false, code: null };
}

export async function fetchOlxWithBrowser(requestUrl: string, signal: AbortSignal) {
  const url = assertAllowedOlxUrl(requestUrl).toString();
  const startedAt = Date.now();
  const browser = await chromium.launch({ headless: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({ locale: "pl-PL" });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    signal.throwIfAborted();
    const status = response?.status() ?? null;
    const html = await page.content();
    const classification = classifyOlxResponse(status, html);
    if (classification.blocked) throw new ControlledOlxFailure(classification.code ?? "OLX_BLOCKED", `OLX refused normal browser access (${classification.code}).`);
    if (!response?.ok()) throw new Error(`OLX_HTTP_${status ?? "UNKNOWN"}`);
    const parsed = parseOlxHtml(html);
    return {
      ...parsed,
      diagnostics: { status, finalUrl: page.url(), title: await page.title(), bodyLength: html.length, marker: html.includes("window.__PRERENDERED_STATE__"), challenge: false },
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await browser.close();
  }
}
