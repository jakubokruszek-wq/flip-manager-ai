"use client";
import { useState } from "react";
type Round={requestId:string;createdAt:string;changedFields:string[];beforeProfit:number|null;afterProfit:number|null;recommendation:string};
export function AnalysisHistory({listingId}:{listingId:string}) {
 const [rows,setRows]=useState<Round[]>([]),[next,setNext]=useState<string|null>(null),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false);
 async function load(more:boolean){
  setBusy(true);setError(false);
  try{const response=await fetch(`/api/flip-finder/listings/${encodeURIComponent(listingId)}/investment/history${more&&next?`?before=${encodeURIComponent(next)}`:""}`,{cache:"no-store"});if(!response.ok)throw Error();const body=await response.json() as {rounds:Round[];nextBefore:string|null};setRows(old=>more?[...old,...body.rounds]:body.rounds);setNext(body.nextBefore);setLoaded(true);}catch{setError(true);}finally{setBusy(false);}
 }
 return <section aria-label="Historia analiz" className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">Historia analiz i odpowiedzi</h2><button className="min-h-11 underline" type="button" disabled={busy} onClick={()=>void load(false)}>Wczytaj / odśwież historię</button>{error?<p role="alert">Historia niedostępna lub funkcja wyłączona. Zapisane rundy nie zostały usunięte.</p>:null}{loaded&&!rows.length?<p>Brak zapisanych rund.</p>:null}<ol className="space-y-3">{rows.map(row=><li className="break-words border-t pt-2" key={row.requestId}><p>{new Date(row.createdAt).toLocaleString("pl-PL")}</p><p>Zmienione pola: {row.changedFields.join(", ")}</p><p>Zysk operacyjny przed podatkiem: {row.beforeProfit??"nieustalony"} → {row.afterProfit??"nieustalony"} zł</p><p>{row.recommendation}</p></li>)}</ol>{next?<button className="min-h-11 underline" type="button" disabled={busy} onClick={()=>void load(true)}>Starsze rundy</button>:null}</section>;
}
