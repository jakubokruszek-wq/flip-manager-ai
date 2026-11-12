"use client";
import { startTransition,useEffect,useMemo,useRef,useState } from "react";
import type { FacebookWatcherListing } from "./types";
import { mobileImageAsset,readFingerprints,visualCandidates,type PhotoFingerprint } from "./visual-reposts";
export function useVisualReposts(raw:FacebookWatcherListing[]) {
  const known=useRef(new Set<string>());
  const [cache,setCache]=useState<Record<string,PhotoFingerprint[]>>({});const [progress,setProgress]=useState("");
  const signature=useMemo(()=>JSON.stringify(visualCandidates(raw).map(r=>({id:r.listingId,assets:r.images.map(u=>mobileImageAsset(u)?.hash??"")})).sort((a,b)=>a.id.localeCompare(b.id))),[raw]);
  useEffect(()=>{const candidates=(JSON.parse(signature) as Array<{id:string;assets:string[]}>).filter(c=>!known.current.has(JSON.stringify(c)));if(!candidates.length)return;const controller=new AbortController();
    void(async()=>{let completed=0,unread=0;let pending:Record<string,PhotoFingerprint[]>={};let pendingKnown:string[]=[];
    const flush=()=>{if(!Object.keys(pending).length)return;const delta=pending;pending={};for(const key of pendingKnown)known.current.add(key);pendingKnown=[];startTransition(()=>setCache(previous=>({...previous,...delta})));};
    try{for(let i=0;i<candidates.length;i+=4){if(controller.signal.aborted)return;if(i%16===0)setProgress(`Porównywanie zdjęć powtórek: ${completed}/${candidates.length} ofert`);const batch=candidates.slice(i,i+4);const response=await fetch("/api/facebook-watcher/duplicates/photos",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids:batch.map(r=>r.id)}),signal:controller.signal});if(!response.ok)throw Error("Photo comparison failed");const body=await response.json();if(controller.signal.aborted)return;
      const entries=Array.isArray(body.results)?body.results.flatMap((r:{listingId?:unknown;fingerprints?:unknown})=>typeof r.listingId==="string"&&batch.some(b=>b.id===r.listingId)?[[r.listingId,readFingerprints(r.fingerprints)]]:[]):[];for(const c of batch){const entry=entries.find((e:unknown[])=>e[0]===c.id);if(entry&&Array.isArray(entry[1])&&entry[1].length)pendingKnown.push(JSON.stringify(c));else unread++;}
      pending={...pending,...Object.fromEntries(entries)};completed+=batch.length;if(completed%16===0)flush();}
      flush();
      setProgress(`Porównano zdjęcia ${completed-unread}/${completed} ofert. ${unread?"Część zdjęć jest niedostępna; te oferty pozostają osobno.":"Dopasowane powtórki są zgrupowane z linkami do publikacji."}`);
    }catch{if(!controller.signal.aborted){flush();setProgress("Porównywanie zdjęć nie zostało zakończone. Wszystkie oferty są zachowane.");}}})();return()=>controller.abort();
  },[signature]);
  const listings=useMemo(()=>raw.map(r=>cache[r.listingId]?{...r,photoFingerprints:cache[r.listingId]}:r),[raw,cache]);return {listings,progress};
}
