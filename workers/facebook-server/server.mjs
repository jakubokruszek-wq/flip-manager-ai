import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { accessConfig, createDesktopServer } from "./access.mjs";

const config = accessConfig(process.env); // Refuse to start an unprotected desktop.
const children = [];
let context, closing = false, desktop, ready = false;
async function stop(code = 0) {
  if (closing) return; closing = true; ready = false;
  const deadline = setTimeout(() => process.exit(code || 1), 10_000);
  await desktop?.close();
  await context?.close().catch(() => {});
  for (const child of children) child.kill("SIGTERM");
  clearTimeout(deadline); process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void stop());
function start(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, DISPLAY: ":99" } });
  children.push(child);
  child.once("error", () => { console.error("WATCHER_COMPONENT_START_FAILED", command); void stop(1); });
  child.once("exit", () => { if (!closing) { console.error("WATCHER_COMPONENT_EXITED", command); void stop(1); } });
  return child;
}
async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await delay(200); }
  throw new Error("WATCHER_COMPONENT_START_TIMEOUT");
}
try {
  start("Xvfb", [":99", "-screen", "0", "1280x900x24", "-nolisten", "tcp", "-ac"]);
  await waitFor(() => existsSync("/tmp/.X11-unix/X99"));
  start("x11vnc", ["-display", ":99", "-localhost", "-nopw", "-forever", "-shared", "-rfbport", "5901"]);
  start("websockify", ["--web", "/usr/share/novnc", "127.0.0.1:6081", "127.0.0.1:5901"]);
  await waitFor(async () => fetch("http://127.0.0.1:6081/vnc.html", { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false));
  const extension = "/app/extension";
  context = await chromium.launchPersistentContext("/data/chromium", {
    headless: false, channel: "chromium", locale: "pl-PL", viewport: null,
    env: { ...process.env, DISPLAY: ":99" },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--window-size=1280,900"],
  });
  context.once("close", () => { if (!closing) void stop(1); });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 30_000 });
  if (!worker.url().startsWith("chrome-extension://") || !worker.url().endsWith("/background.js")) throw new Error("WATCHER_EXTENSION_NOT_LOADED");
  const page = context.pages()[0] ?? await context.newPage();
  desktop = createDesktopServer({ config, healthy: () => ready && !closing, status: async () => {
    // Bounded status, never expose cookies, device tokens or page bodies.
    const current = context.serviceWorkers().find(value => value.url() === worker.url());
    if (!current) return { state: "BROWSER_RUNNING", collector: "SLEEPING" };
    return current.evaluate(async () => {
      const data = await globalThis.chrome.storage.local.get(["collectorPairingState", "collectorPollDiagnostics"]);
      return { state: "BROWSER_RUNNING", pairing: data.collectorPairingState?.status ?? "DISCONNECTED", lastPoll: data.collectorPollDiagnostics?.alarmFiredAt ?? null, pollStatus: data.collectorPollDiagnostics?.status ?? null };
    });
  } });
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("INVALID_PORT");
  desktop.server.listen(port, "0.0.0.0"); ready = true;
  desktop.server.on("error", () => { console.error("WATCHER_LISTENER_FAILED"); void stop(1); });
  // Keep the recovery desktop available even if the Manager is temporarily unreachable.
  void page.goto("https://flip-manager-ai.vercel.app/flip-finder/collector/setup", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => console.error("WATCHER_SETUP_PAGE_UNAVAILABLE"));
  console.log("WATCHER_BROWSER_RUNNING; login and pairing must be completed through the protected desktop");
} catch {
  console.error("WATCHER_START_FAILED"); await stop(1);
}
