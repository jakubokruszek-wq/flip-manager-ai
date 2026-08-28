import { chromium } from "playwright";
import type { FacebookFailureCode } from "../../../features/facebook-worker/types.ts";

export function classifyFacebookSession(input: { url: string; title: string; visibleText: string }): FacebookFailureCode | null {
  const haystack = `${input.url}\n${input.title}\n${input.visibleText}`.toLocaleLowerCase("pl-PL");
  if (/\/checkpoint\//.test(input.url) || /session expired|sesja wygasła/.test(haystack)) return "FACEBOOK_SESSION_EXPIRED";
  if (/captcha|security check|human verification|challenge/.test(haystack)) return "FACEBOOK_CHALLENGE";
  if (/\/login(?:\/|\?|$)/.test(input.url) || /log into facebook|zaloguj się do facebooka|email or phone/.test(haystack)) return "FACEBOOK_LOGIN_REQUIRED";
  if (/access denied|brak dostępu|you do not have permission|content isn't available/.test(haystack)) return "FACEBOOK_ACCESS_DENIED";
  if (/(?:grupa prywatna[\s\S]{0,500}dołącz do grupy|private group[\s\S]{0,500}join group)/.test(haystack)) return "FACEBOOK_ACCESS_DENIED";
  return null;
}

export async function openFacebookLogin(profileDir: string): Promise<void> {
  const context = await chromium.launchPersistentContext(profileDir, { headless: false, locale: "pl-PL" });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await new Promise<void>((resolve) => context.once("close", () => resolve()));
}
