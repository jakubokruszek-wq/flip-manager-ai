import "server-only";
import { getAlerts } from "@/features/alerts/server";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import { sendPushToAll } from "./server";

const delivered: Set<string> = (globalThis as typeof globalThis & { __deliveredPushAlerts?: Set<string> }).__deliveredPushAlerts ?? new Set();
(globalThis as typeof globalThis & { __deliveredPushAlerts?: Set<string> }).__deliveredPushAlerts = delivered;

export async function sendPendingAlertPush(){const supabase=createFacebookWatcherAdminClient();const alerts=await getAlerts();let sent=0;let skipped=0;for(const alert of alerts){if(alert.readAt||delivered.has(alert.eventKey)){skipped++;continue;}const stored=await supabase.from("alerts").select("push_delivered_at").eq("event_key",alert.eventKey).maybeSingle();if(!stored.error&&stored.data?.push_delivered_at){delivered.add(alert.eventKey);skipped++;continue;}const result=await sendPushToAll({title:`🔥 Nowa okazja • ${alert.neighborhood??alert.city??"Flip Manager"}`,body:[alert.price?`${Math.round(alert.price).toLocaleString("pl-PL")} zł`:null,alert.area?`${alert.area} m²`:null,alert.flipScore!==null?`Flip Score ${Math.round(alert.flipScore)}`:null,alert.sellerType==="private"?"Bezpośrednio od właściciela":null].filter(Boolean).join(" • "),icon:"/icon",badge:"/icon",data:{listingId:alert.listingId,url:alert.detailsUrl,originalUrl:alert.originalUrl,eventType:alert.type}});if(result.sent>0){sent+=result.sent;delivered.add(alert.eventKey);await supabase.from("alerts").update({push_delivered_at:new Date().toISOString()}).eq("event_key",alert.eventKey);}}
return{sent,skipped};}
