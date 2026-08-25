import assert from "node:assert/strict";
import test from "node:test";
import type { Page, Response } from "playwright";
import { openFacebookPostPage } from "./browser.ts";

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
