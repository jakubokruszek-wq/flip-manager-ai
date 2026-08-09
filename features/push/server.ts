import "server-only";
import webpush from "web-push";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import type { BrowserPushSubscription, PushPayload } from "./types";

type Stored = BrowserPushSubscription & { userAgent: string | null; enabled: boolean };
const memory: Map<string, Stored> = (globalThis as typeof globalThis & { __flipPushSubscriptions?: Map<string, Stored> }).__flipPushSubscriptions ?? new Map();
(globalThis as typeof globalThis & { __flipPushSubscriptions?: Map<string, Stored> }).__flipPushSubscriptions = memory;

export async function savePushSubscription(subscription: BrowserPushSubscription, userAgent: string | null) {
  validate(subscription); const supabase = createFacebookWatcherAdminClient();
  const row = { endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, user_agent: userAgent, enabled: true, last_used_at: new Date().toISOString() };
  const result = await supabase.from("push_subscriptions").upsert(row, { onConflict: "endpoint" }).select("id").single();
  if (!result.error) return { persisted: true };
  if (!missing(result.error.message)) throw new Error(`Nie udało się zapisać subskrypcji: ${result.error.message}`);
  memory.set(subscription.endpoint, { ...subscription, userAgent, enabled: true }); return { persisted: false };
}
export async function disablePushSubscription(endpoint: string) {
  const supabase = createFacebookWatcherAdminClient(); const result = await supabase.from("push_subscriptions").update({ enabled: false }).eq("endpoint", endpoint);
  if (result.error && !missing(result.error.message)) throw new Error(`Nie udało się wyłączyć subskrypcji: ${result.error.message}`);
  const stored = memory.get(endpoint); if (stored) memory.set(endpoint, { ...stored, enabled: false });
}
export async function sendPushToAll(payload: PushPayload) {
  configureVapid(); const subscriptions = await listSubscriptions(); let sent = 0; let failed = 0;
  for (const subscription of subscriptions) { try { await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 300, urgency: "high" }); sent += 1; } catch (error) { failed += 1; const status = statusCode(error); if (status === 404 || status === 410) await disablePushSubscription(subscription.endpoint); else console.error("WEB PUSH ERROR", { endpointHost: safeHost(subscription.endpoint), status, message: error instanceof Error ? error.message : String(error) }); } }
  return { attempted: subscriptions.length, sent, failed };
}
export function testPayload(): PushPayload { return { title: "🔥 Test Flip Manager", body: "Powiadomienia działają na tym urządzeniu.", icon: "/icon", badge: "/icon", data: { url: "/alerts", eventType: "test" } }; }

async function listSubscriptions(): Promise<BrowserPushSubscription[]> { const supabase = createFacebookWatcherAdminClient(); const result = await supabase.from("push_subscriptions").select("endpoint,p256dh,auth").eq("enabled", true); if (!result.error) return (result.data ?? []).map(row => ({ endpoint: String(row.endpoint), keys: { p256dh: String(row.p256dh), auth: String(row.auth) } })); if (!missing(result.error.message)) throw new Error(`Nie udało się pobrać subskrypcji: ${result.error.message}`); return [...memory.values()].filter(item => item.enabled).map(item => ({ endpoint: item.endpoint, expirationTime: item.expirationTime, keys: item.keys })); }
function configureVapid() { const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY; const privateKey = process.env.VAPID_PRIVATE_KEY; const subject = process.env.VAPID_SUBJECT; if (!publicKey || !privateKey || !subject) throw new Error("Brak konfiguracji VAPID. Ustaw NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY i VAPID_SUBJECT."); webpush.setVapidDetails(subject, publicKey, privateKey); }
function validate(value: BrowserPushSubscription) { const url = new URL(value.endpoint); if (url.protocol !== "https:" || !value.keys?.p256dh || !value.keys?.auth) throw new Error("Nieprawidłowa subskrypcja Web Push."); }
function missing(message: string) { return /does not exist|schema cache/i.test(message); }
function statusCode(error: unknown) { return typeof error === "object" && error !== null && "statusCode" in error ? Number((error as { statusCode: unknown }).statusCode) : null; }
function safeHost(endpoint: string) { try { return new URL(endpoint).hostname; } catch { return "invalid"; } }
