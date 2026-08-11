import { chromium } from "playwright";
import type { FacebookGroupSnapshot } from "../../../features/facebook-worker/types.ts";
import { ControlledFacebookFailure } from "./errors.ts";
import { assertWorkerFacebookGroupUrl, readFacebookGroup } from "./group-reader.ts";
import { logFacebookWorker } from "./logger.ts";
import { classifyFacebookSession } from "./session.ts";

export async function fetchFacebookGroupWithBrowser(profileDir: string, group: FacebookGroupSnapshot, signal: AbortSignal) {
  const started = Date.now(); const url = assertWorkerFacebookGroupUrl(group.url).toString();
  logFacebookWorker("FACEBOOK_BROWSER_START", { groupId: group.id });
  const context = await chromium.launchPersistentContext(profileDir, { headless: true, locale: "pl-PL" });
  try {
    signal.throwIfAborted(); const page = context.pages()[0] ?? await context.newPage();
    logFacebookWorker("FACEBOOK_GROUP_START", { groupId: group.id });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    signal.throwIfAborted();
    const visibleText = (await page.locator("body").innerText({ timeout: 10_000 })).slice(0, 20_000);
    const failure = classifyFacebookSession({ url: page.url(), title: await page.title(), visibleText });
    if (failure) throw new ControlledFacebookFailure(failure, `Facebook access stopped: ${failure}`);
    if (response && !response.ok()) throw new ControlledFacebookFailure(response.status() === 403 ? "FACEBOOK_ACCESS_DENIED" : "FACEBOOK_GROUP_UNAVAILABLE", `Facebook group returned HTTP ${response.status()}`);
    logFacebookWorker("FACEBOOK_SESSION_OK", { groupId: group.id });
    const posts = await readFacebookGroup(page, group);
    logFacebookWorker("FACEBOOK_GROUP_DONE", { groupId: group.id, posts: posts.length, durationMs: Date.now() - started });
    return { posts, warnings: posts.length ? [] : ["Facebook group returned no visible posts."], durationMs: Date.now() - started };
  } finally { await context.close(); }
}

