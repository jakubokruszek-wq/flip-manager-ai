import assert from "node:assert/strict";
import test from "node:test";
import type { Page, Response } from "playwright";
import { openFacebookPostPage, shouldEarlyRejectFacebookFeed, waitForFacebookGroupFeed } from "./browser.ts";

function navigationTimeout(): Error {
  return Object.assign(new Error("page.goto: Timeout 60000ms exceeded."), { name: "TimeoutError" });
}

function fakePage(gotoResults: Array<Response | null | Error>, session: { url?: string; title?: string; text?: string } = {}) {
  let gotoCalls = 0;
  const waits: number[] = [];
  const page = {
    url: () => session.url ?? "https://www.facebook.com/groups/1/",
    goto: async () => {
      const result = gotoResults[gotoCalls++];
      if (result instanceof Error) throw result;
      return result ?? null;
    },
    waitForTimeout: async (milliseconds: number) => { waits.push(milliseconds); },
    locator: () => ({ innerText: async () => session.text ?? "Facebook post" }),
    title: async () => session.title ?? "Facebook",
  } as unknown as Page;
  return { page, gotoCalls: () => gotoCalls, waits };
}

function fakeFeedPage(postLinkCounts: number[], text = "Public group", structuredRecords: unknown[] = []) {
  const waits: number[] = [];
  let reads = 0;
  const page = {
    url: () => "https://www.facebook.com/groups/1/",
    title: async () => "Facebook group",
    waitForTimeout: async (milliseconds: number) => { waits.push(milliseconds); },
    evaluate: async () => structuredRecords,
    locator: (selector: string) => selector === "body"
      ? { innerText: async () => text }
      : { count: async () => postLinkCounts[Math.min(reads++, postLinkCounts.length - 1)] ?? 0 },
  } as unknown as Page;
  return { page, waits };
}

test("retries one dedicated post navigation timeout and succeeds", async () => {
  const fixture = fakePage([navigationTimeout(), null]);
  assert.equal(await openFacebookPostPage(fixture.page, "https://www.facebook.com/groups/1/posts/123/", "group-1", "123"), true);
  assert.equal(fixture.gotoCalls(), 2);
  assert.deepEqual(fixture.waits, [1_000, 1_000]);
});

test("fails after two dedicated post navigation timeouts", async () => {
  const fixture = fakePage([navigationTimeout(), navigationTimeout()]);
  await assert.rejects(() => openFacebookPostPage(fixture.page, "https://www.facebook.com/groups/1/posts/123/", "group-1", "123"), { name: "TimeoutError" });
  assert.equal(fixture.gotoCalls(), 2);
  assert.deepEqual(fixture.waits, [1_000]);
});

test("does not retry a navigation timeout that landed on a Facebook login or challenge page", async () => {
  for (const [session, expectedCode] of [
    [{ url: "https://www.facebook.com/login/", text: "Email or phone" }, "FACEBOOK_LOGIN_REQUIRED"],
    [{ url: "https://www.facebook.com/checkpoint/", title: "Security check", text: "Complete this CAPTCHA challenge" }, "FACEBOOK_SESSION_EXPIRED"],
  ]) {
    const fixture = fakePage([navigationTimeout()], session as { url: string; title?: string; text: string });
    await assert.rejects(() => openFacebookPostPage(fixture.page, "https://www.facebook.com/groups/1/posts/123/", "group-1", "123"), new RegExp(expectedCode as string));
    assert.equal(fixture.gotoCalls(), 1);
    assert.deepEqual(fixture.waits, []);
  }
});

test("does not retry non-timeout navigation errors", async () => {
  const fixture = fakePage([new Error("page.goto: net::ERR_NAME_NOT_RESOLVED")]);
  await assert.rejects(() => openFacebookPostPage(fixture.page, "https://www.facebook.com/groups/1/posts/123/", "group-1", "123"), /ERR_NAME_NOT_RESOLVED/);
  assert.equal(fixture.gotoCalls(), 1);
  assert.deepEqual(fixture.waits, []);
});

test("waits boundedly for a Facebook group feed rendered after navigation", async () => {
  const fixture = fakeFeedPage([0, 0, 1]);
  assert.equal(await waitForFacebookGroupFeed(fixture.page, { timeoutMs: 4_000, pollIntervalMs: 1_000 }), true);
  assert.deepEqual(fixture.waits, [1_000, 1_000]);
});

test("accepts an exact structured feed post when the authenticated DOM has no post anchor", async () => {
  const fixture = fakeFeedPage([0], "Joined public group", [
    { postId: "101", url: "https://www.facebook.com/groups/1/posts/101/", publishedAt: null, unsafeContext: false },
  ]);
  assert.equal(await waitForFacebookGroupFeed(fixture.page), true);
  assert.deepEqual(fixture.waits, []);
});

test("stops a private group without membership instead of reporting zero posts", async () => {
  const fixture = fakeFeedPage([0], "Grupa Prywatna · 28 tys. członków Dołącz do grupy");
  await assert.rejects(() => waitForFacebookGroupFeed(fixture.page), /FACEBOOK_ACCESS_DENIED/);
  assert.deepEqual(fixture.waits, []);
});

test("ends an empty public feed wait after the configured bound", async () => {
  const fixture = fakeFeedPage([0, 0, 0]);
  assert.equal(await waitForFacebookGroupFeed(fixture.page, { timeoutMs: 3_000, pollIntervalMs: 1_000 }), false);
  assert.deepEqual(fixture.waits, [1_000, 1_000]);
});

test("early feed intent rejects deterministic BUY/RENT/SERVICE before a page open", () => {
  assert.equal(shouldEarlyRejectFacebookFeed("Kupię mieszkanie 2 pokoje do 500000 zł"), true);
  assert.equal(shouldEarlyRejectFacebookFeed("Szukam mieszkania do wynajęcia"), true);
  assert.equal(shouldEarlyRejectFacebookFeed("Pośrednictwo nieruchomości"), true);
  assert.equal(shouldEarlyRejectFacebookFeed("Sprzedam mieszkanie 2 pokoje"), false);
  assert.equal(shouldEarlyRejectFacebookFeed("Mieszkanie 2 pokoje"), false);
  assert.equal(shouldEarlyRejectFacebookFeed("Kupię mieszkanie"), true);
});
