export function assertWorkerFacebookSourceUrl(value: string, type: "GROUP" | "PROFILE" = "GROUP"): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !/(^|\.)facebook\.com$/i.test(url.hostname)) throw new Error("FACEBOOK_SOURCE_URL_NOT_ALLOWED");
  if (type === "GROUP" && !/^\/groups\/[^/]+/i.test(url.pathname)) throw new Error("FACEBOOK_GROUP_URL_NOT_ALLOWED");
  if (type === "PROFILE" && !(/^\/profile\.php$/i.test(url.pathname) || /^\/[^/]+\/?$/i.test(url.pathname))) throw new Error("FACEBOOK_PROFILE_URL_NOT_ALLOWED");
  return url;
}
