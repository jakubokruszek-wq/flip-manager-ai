/** Android scans cannot carry the browser scheduler's cycle marker. */
export function facebookJobFilterSnapshot<T extends object>(filter: T, consumerType: "BROWSER_EXTENSION" | "ANDROID_WEBVIEW"): T {
  if (consumerType === "BROWSER_EXTENSION") return filter;
  const snapshot = { ...filter };
  delete (snapshot as T & { _facebookScheduler?: unknown })._facebookScheduler;
  return snapshot;
}
