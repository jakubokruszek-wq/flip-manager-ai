import { createHash } from "node:crypto";
import type { AlertType, InvestmentAlert } from "./types.ts";

export type AlertListing = { id:string;title:string;description:string|null;source:string;price:number|null;area:number|null;pricePerSqm:number|null;city:string|null;district:string|null;originalUrl:string|null;flipScore:number|null;createdAt:string;firstSeenAt:string;sellerType:string|null;condition:string|null;opportunityScore:number|null;neighborhood:string|null;facebookUrl:string|null;groupName:string|null;groupPriority:string|null;flags:string[] };
export type PricePoint = { price:number|null; capturedAt:string };

export function createAlertsForListing(listing:AlertListing,snapshots:PricePoint[],now=Date.now()):InvestmentAlert[]{
  const alerts:InvestmentAlert[]=[]; const searchable=[listing.title,listing.description,...listing.flags].filter(Boolean).join(" ").toLocaleLowerCase("pl-PL");
  const keyword=/bezpośrednio|bez pośredników|po babci|pilnie|do remontu/.test(searchable);
  if((listing.opportunityScore??0)>=85||(listing.source==="facebook"&&keyword)) alerts.push(make("facebook_opportunity",listing,listing.createdAt,"v1"));
  if((listing.flipScore??0)>=85) alerts.push(make("high_flip_score",listing,listing.createdAt,"v1"));
  if(listing.sellerType==="private"&&listing.condition==="renovation") alerts.push(make("private_seller",listing,listing.createdAt,"v1"));
  const age=now-Date.parse(listing.firstSeenAt); const isRecentFacebook=listing.source==="facebook"&&age>=0&&age<=15*60_000; const isHighGroupPost=listing.source==="facebook"&&listing.groupPriority==="high"&&age>=0&&age<=86_400_000;
  if(isRecentFacebook||isHighGroupPost) alerts.push(make("new_listing",listing,listing.firstSeenAt,"v1"));
  const ordered=[...snapshots].filter(point=>point.price!==null).sort((a,b)=>Date.parse(b.capturedAt)-Date.parse(a.capturedAt));
  if(ordered.length>=2&&ordered[0].price!<ordered[1].price!) alerts.push(make("price_drop",listing,ordered[0].capturedAt,String(ordered[0].price)));
  return alerts;
}

function make(type:AlertType,listing:AlertListing,detectedAt:string,eventVersion:string):InvestmentAlert {
  const eventKey=`${listing.id}:${type}:${eventVersion}`;
  return {id:createHash("sha256").update(eventKey).digest("hex").slice(0,32),eventKey,type,listingId:listing.id,title:listing.title,source:listing.source,sellerType:listing.sellerType,price:listing.price,area:listing.area,neighborhood:listing.neighborhood??listing.district,city:listing.city,pricePerSqm:listing.pricePerSqm,flipScore:listing.flipScore,opportunityScore:listing.opportunityScore,condition:listing.condition,groupName:listing.groupName,flags:listing.flags,detectedAt,readAt:null,detailsUrl:listing.source==="facebook"?`/facebook-watcher?listing=${listing.id}`:`/flip-finder?listing=${listing.id}`,originalUrl:listing.facebookUrl??listing.originalUrl};
}
