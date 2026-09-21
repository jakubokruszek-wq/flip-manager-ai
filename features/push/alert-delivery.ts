import "server-only";
import { getAlerts } from "@/features/alerts/server";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import { sendPushToAll } from "./server";
import { isPushEligibleAlertType, type InvestmentAlert } from "@/features/alerts/types";

const delivered: Set<string> = (globalThis as typeof globalThis & { __deliveredPushAlerts?: Set<string> }).__deliveredPushAlerts ?? new Set();
(globalThis as typeof globalThis & { __deliveredPushAlerts?: Set<string> }).__deliveredPushAlerts = delivered;

/** Pure so the exact copy per alert type is directly testable without a database or push transport. */
export function pushTitleFor(alert: Pick<InvestmentAlert, "type" | "neighborhood" | "city">): string {
  const place = alert.neighborhood ?? alert.city ?? "Flip Manager";
  return alert.type === "price_drop" ? `📉 Spadek ceny • ${place}` : `🔥 Nowa okazja • ${place}`;
}

export async function sendPendingAlertPush(){const supabase=createFacebookWatcherAdminClient();
// getAlerts() already re-checks each alert's listing against its CURRENT
// lifecycle_status/manual_decision (one bounded query, shared with the
// in-app alert list) before returning anything here, so a listing that
// became REJECTED/STALE/ARCHIVED after its alert was created is already
// excluded by this point. This filter narrows further, to only the alert
// types worth a push at all — see isPushEligibleAlertType's own comment for
// why new_listing is excluded; every other type already gates on a real
// attractiveness/urgency signal before it is ever created.
const alerts=(await getAlerts()).filter(alert=>isPushEligibleAlertType(alert.type));let sent=0;let skipped=0;for(const alert of alerts){if(alert.readAt||delivered.has(alert.eventKey)){skipped++;continue;}const stored=await supabase.from("alerts").select("push_delivered_at").eq("event_key",alert.eventKey).maybeSingle();if(!stored.error&&stored.data?.push_delivered_at){delivered.add(alert.eventKey);skipped++;continue;}const result=await sendPushToAll({title:pushTitleFor(alert),body:[alert.price?`${Math.round(alert.price).toLocaleString("pl-PL")} zł`:null,alert.area?`${alert.area} m²`:null,alert.flipScore!==null?`Flip Score ${Math.round(alert.flipScore)}`:null,alert.sellerType==="private"?"Bezpośrednio od właściciela":null].filter(Boolean).join(" • "),icon:"/icon",badge:"/icon",data:{listingId:alert.listingId,url:alert.detailsUrl,originalUrl:alert.originalUrl,eventType:alert.type}});if(result.sent>0){sent+=result.sent;delivered.add(alert.eventKey);await supabase.from("alerts").update({push_delivered_at:new Date().toISOString()}).eq("event_key",alert.eventKey);}}
return{sent,skipped};}
