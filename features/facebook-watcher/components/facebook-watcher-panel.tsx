"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ExternalLink, Filter, Flame, Plus, Search, Undo2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExpandableListingCard } from "@/features/flip-finder/components/inline-filter-results";
import type { FilterResult } from "@/features/flip-finder/results";
import { EMPTY_FACEBOOK_INBOX_FILTERS, filterFacebookInbox, sortFacebookInbox, type FacebookInboxFilters, type FacebookInboxSort } from "../facebook-inbox";
import { facebookPriceReviewExplanation, isFacebookPriceSuspect } from "../price-quality";
import type { FacebookWatcherListing, FacebookWorkflowStatus } from "../types";
import { composeFacebookLocation } from "../facebook-location-quality";
import { countFacebookWatcherLifecycle } from "../lifecycle-counts";
import { canonicalVisibilityDebug, summarizeCanonicalVisibility } from "@/features/flip-finder/canonical-visibility";
import { resolveListingStatusPresentation } from "../listing-status-presentation";
import { createHistoryClearRunner, runAddToCrm, runGalleryRepairAndRefresh, runUpdateWorkflow, type UpdateWorkflowResult } from "../watcher-action-flows";
import { resolveListingUrl } from "@/features/listing-url";
import { WATCHER_FILTER_STORAGE_KEY, readSavedInboxFilters, inboxRangeError, subscribeInboxFilters, inboxFilterStorageSnapshot, inboxFilterServerSnapshot } from "../saved-inbox-filters";
import { useVisualReposts } from "../use-visual-reposts";
import { groupFacebookReposts } from "../group-facebook-reposts";
const priceSuspect = (item: FacebookWatcherListing) => isFacebookPriceSuspect(item.priceQuality?.status ?? "LIKELY");

type InboxTab = FacebookWorkflowStatus | "all";
const TABS: Array<{ value: InboxTab; label: string }> = [{value:"all",label:"Wszystkie"},{value:"new",label:"Nowe"},{value:"review",label:"Do analizy"},{value:"interesting",label:"Okazje"},{value:"crm",label:"Dodane do CRM"},{value:"rejected",label:"Odrzucone"}];
const STATUS_LABELS: Record<FacebookWorkflowStatus,string> = {new:"Nowa",review:"Do analizy",interesting:"Interesująca",crm:"W CRM",rejected:"Odrzucona"};

type Toast = { id: number; tone: "success" | "error"; text: string };

const HISTORY_CLEAR_ERROR_MESSAGES: Record<string, string> = {
  ACTIVE_FACEBOOK_JOB: "Poczekaj na zakończenie aktywnego skanu lub hydracji Facebooka.",
  FACEBOOK_WATCHER_ACTION_FORBIDDEN: "Akcja została odrzucona przez zabezpieczenia przeglądarki. Odśwież stronę i spróbuj ponownie.",
};
const GALLERY_REPAIR_ERROR_MESSAGES: Record<string, string> = {
  FACEBOOK_GALLERY_LISTING_NOT_FOUND: "Nie znaleziono oferty.",
  FACEBOOK_GALLERY_LISTING_NOT_ELIGIBLE: "Ta oferta nie kwalifikuje się do naprawy galerii.",
  FACEBOOK_GALLERY_EXACT_POST_REQUIRED: "Brak jednoznacznego posta źródłowego — nie można bezpiecznie odświeżyć galerii.",
  FACEBOOK_GALLERY_FILTER_CONTEXT_MISSING: "Brak aktywnego filtra Facebooka wymaganego do naprawy galerii.",
  FACEBOOK_GALLERY_REPAIR_ALREADY_RUNNING: "Naprawa galerii już trwa dla tej oferty.",
  FACEBOOK_GALLERY_METADATA_IDENTITY_AMBIGUOUS: "Tożsamość posta jest niejednoznaczna — naprawa galerii została wstrzymana.",
  FACEBOOK_GALLERY_METADATA_GROUP_MISMATCH: "Grupa źródłowa nie zgadza się z zapisaną — naprawa galerii została wstrzymana.",
  FACEBOOK_GALLERY_REPAIR_LIMIT_REACHED: "Osiągnięto limit prób naprawy galerii dla tej oferty. Skontaktuj się z administratorem, jeśli problem się powtarza.",
};

export function FacebookWatcherPanel() {
  const [cleanupDate,setCleanupDate]=useState("");
  const [page,setPage]=useState({key:"",count:24});
  const [linkedListingId]=useState(()=>typeof window==="undefined"?null:new URLSearchParams(window.location.search).get("listing"));
  const [refreshing,setRefreshing]=useState(false);
  const [lastRefreshedAt,setLastRefreshedAt]=useState<string|null>(null);
  const refreshListingsRef=useRef<()=>Promise<void>>(async()=>{});
  const cleanupLock=useRef(false);
  const handledDeepLink=useRef(false);
  const analysisButtonsRef=useRef(new Map<string,HTMLButtonElement>());
  const registerAnalysisButton=useCallback((id:string,button:HTMLButtonElement|null)=>{if(button)analysisButtonsRef.current.set(id,button);else analysisButtonsRef.current.delete(id);},[]);
  const [rawListings,setListings]=useState<FacebookWatcherListing[]>([]);
  const {listings,progress:photoComparisonProgress}=useVisualReposts(rawListings); const [loading,setLoading]=useState(true); const [error,setError]=useState<string|null>(null);
  const [tab,setTab]=useState<InboxTab>("all"); const [sort,setSort]=useState<FacebookInboxSort>("newest"); const [draftFilters,setDraftFilters]=useState<FacebookInboxFilters|null>(null); const [busyId,setBusyId]=useState<string|null>(null); const [historyClearing,setHistoryClearing]=useState(false); const [toast,setToast]=useState<Toast|null>(null);
  const savedFilterValue=useSyncExternalStore(subscribeInboxFilters,inboxFilterStorageSnapshot,inboxFilterServerSnapshot);
  const savedFilters=useMemo(()=>readSavedInboxFilters(savedFilterValue),[savedFilterValue]);
  const filters=draftFilters??savedFilters??EMPTY_FACEBOOK_INBOX_FILTERS;
  const setFilters=useCallback((update:React.SetStateAction<FacebookInboxFilters>)=>setDraftFilters(current=>typeof update==="function"?update(current??savedFilters??EMPTY_FACEBOOK_INBOX_FILTERS):update),[savedFilters]);
  const filterError=inboxRangeError(filters);
  const saveFilters=()=>{
    if(filterError){showToast("error",filterError);return;}
    try{window.localStorage.setItem(WATCHER_FILTER_STORAGE_KEY,JSON.stringify({version:1,filters}));showToast("success","Filtry zapisane na tym urządzeniu.");}
    catch{showToast("error","Przeglądarka nie pozwoliła zapisać filtrów. Ustawienia działają do zamknięcia widoku.");}
  };
  const toastSeq=useRef(0);
  const showToast=(tone:"success"|"error",text:string)=>{const id=++toastSeq.current;setToast({id,tone,text});window.setTimeout(()=>setToast(current=>current?.id===id?null:current),4000);};
  const loadListings=async():Promise<FacebookWatcherListing[]>=>{const response=await fetch("/api/facebook-watcher/listings",{cache:"no-store"});const body=await response.json();if(!response.ok)throw new Error(body.error??"Nie udało się pobrać Inboxu.");return body.listings??[];};
  useEffect(()=>{
    let active=true;
    let pending=false;
    const refresh=async()=>{
      if(pending || !active)return;
      pending=true;setRefreshing(true);
      try{const data=await loadListings();if(active){setListings(data);setError(null);setLastRefreshedAt(new Date().toISOString());}}
      catch(reason){if(active)setError(reason instanceof Error?reason.message:"Nie udało się odświeżyć ofert. Zachowano ostatni wynik.");}
      finally{pending=false;if(active){setRefreshing(false);setLoading(false);}}
    };
    refreshListingsRef.current=refresh;
    const onReturn=()=>{if(document.visibilityState==="visible")void refresh();};
    void refresh();
    window.addEventListener("focus",onReturn);
    window.addEventListener("online",onReturn);
    document.addEventListener("visibilitychange",onReturn);
    return()=>{active=false;window.removeEventListener("focus",onReturn);window.removeEventListener("online",onReturn);document.removeEventListener("visibilitychange",onReturn);};
  },[]);

  const visible=useMemo(()=>groupFacebookReposts(sortFacebookInbox(filterFacebookInbox(listings,tab,filters),sort)),[filters,listings,sort,tab]);
  const pageKey=JSON.stringify([tab,sort,filters]);
  const linkedIndex=linkedListingId?visible.findIndex(item=>item.listingId===linkedListingId||item.relatedPosts?.some(post=>post.listingId===linkedListingId)):-1;
  const shownCount=Math.max(page.key===pageKey?page.count:24,linkedIndex+1);
  const rendered=visible.slice(0,shownCount);
  useEffect(()=>{
    if(handledDeepLink.current||!listings.length||!linkedListingId)return;
    const target=linkedIndex>=0?visible[linkedIndex].listingId:linkedListingId;
    const timeout=window.setTimeout(()=>{const button=analysisButtonsRef.current.get(target);if(button){handledDeepLink.current=true;button.click();}},0);return()=>window.clearTimeout(timeout);
  },[linkedIndex,linkedListingId,listings,visible]);
  const groupedListings=useMemo(()=>groupFacebookReposts(sortFacebookInbox(listings,"newest")),[listings]);
  const today=groupedListings.filter(item=>item.isNew).length; const lifecycle=countFacebookWatcherLifecycle(groupedListings); const consistency=useMemo(()=>summarizeCanonicalVisibility(listings.map(item=>canonicalVisibilityDebug({listingId:item.listingId,canonicalBucket:item.currentFilterDecision??"REJECTED",lifecycleStatus:item.lifecycleStatus??null,isCurrentMatch:item.currentFilterDecision==="MATCHED",matchReasons:item.currentFilterReasons??[],visibilityInFinder:item.finderVisible===true,visibilityInWatcher:true,finderStatus:item.finderStatus,reason:item.finderStatus==="HISTORICAL"?"historical_operational_state":"current_evaluation"}))),[listings]);
  // Returns an explicit result the caller MUST check — a failed PATCH can
  // never be silently treated as success by whoever awaits this (see addToCrm).
  const updateWorkflow=async(item:FacebookWatcherListing,change:{status?:FacebookWorkflowStatus;markRead?:boolean;crmPropertyId?:string}):Promise<UpdateWorkflowResult>=>{
    setBusyId(item.listingId);
    const result=await runUpdateWorkflow({fetchPatch:()=>fetch(`/api/facebook-watcher/listings/${item.listingId}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(change)}).then(async response=>({ok:response.ok,body:await response.json()}))});
    if(result.ok)setListings(current=>current.map(value=>value.listingId===item.listingId?{...value,...(change.status?{workflowStatus:change.status}:{}),...(change.markRead?{readAt:new Date().toISOString(),isNew:false}:{})}:value));
    setBusyId(null);
    return result;
  };
  const guardedUpdateWorkflow=async(item:FacebookWatcherListing,change:{status?:FacebookWorkflowStatus;markRead?:boolean;crmPropertyId?:string})=>{const result=await updateWorkflow(item,change);if(!result.ok)showToast("error",result.message);};
  const addToCrm=async(item:FacebookWatcherListing)=>{
    setBusyId(item.listingId);
    const result=toFilterResult(item);
    const outcome=await runAddToCrm({
      fetchImport:()=>fetch("/api/properties/import-from-finder",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...result,investmentAnalysis:null})}).then(async response=>({ok:response.ok,body:await response.json()})),
      updateWorkflow:propertyId=>updateWorkflow(item,{status:"crm",crmPropertyId:propertyId}),
    });
    showToast(outcome.kind==="success"?"success":"error",outcome.message);
    setBusyId(null);
  };
  // The lock lives inside this runner (created exactly once), acquired
  // synchronously before any await, so a rapid second click is a guaranteed
  // no-op instead of a race that could start a second preview/delete request.
  const [runHistoryClear]=useState(()=>createHistoryClearRunner(
    {
      fetchPreview:()=>fetch("/api/facebook-watcher/history",{cache:"no-store"}).then(async response=>({ok:response.ok,body:await response.json()})),
      fetchDelete:()=>fetch("/api/facebook-watcher/history",{method:"DELETE",credentials:"same-origin"}).then(async response=>({ok:response.ok,body:await response.json()})),
      confirm:message=>window.confirm(message),
      errorMessages:HISTORY_CLEAR_ERROR_MESSAGES,
    },
    {onBusyChange:setHistoryClearing},
  ));
  const clearWatcherHistory=async()=>{
    const outcome=await runHistoryClear();
    if(outcome.kind==="cleared"){setListings([]);showToast("success","Historia Watchera została wyczyszczona.");}
    else if(outcome.kind!=="cancelled"&&outcome.kind!=="already-running")showToast("error",outcome.message);
  };
  const cleanupSavedBefore=async()=>{
    if(cleanupLock.current||historyClearing||!cleanupDate)return;
    const before=new Date(cleanupDate+"T00:00:00").toISOString();
    cleanupLock.current=true;setHistoryClearing(true);
    try{
      const previewResponse=await fetch(`/api/facebook-watcher/history/by-saved-date?before=${encodeURIComponent(before)}`,{cache:"no-store"});
      const preview=await previewResponse.json() as {total?:number;protectedCount?:number;token?:string;code?:string};
      if(!previewResponse.ok||typeof preview.total!=="number"||!preview.token)throw new Error(preview.code??"CLEANUP_PREVIEW_FAILED");
      if(!window.confirm(`Usunąć ${preview.total} ofert Facebooka zapisanych w bazie przed ${cleanupDate}? Chronione rekordy CRM, Deal Room i powiązania innych źródeł pozostają (${preview.protectedCount??0}). Usunięte posty nie wrócą przez ponowienie wysyłki. Android ma osobne czyszczenie lokalne.`))return;
      const response=await fetch("/api/facebook-watcher/history/by-saved-date",{method:"DELETE",credentials:"same-origin",headers:{"Content-Type":"application/json","x-facebook-watcher-action":"clear-watcher-history"},body:JSON.stringify({before,token:preview.token})});
      const result=await response.json() as {listingIds?:string[];code?:string};
      if(!response.ok||!Array.isArray(result.listingIds))throw new Error(result.code??"CLEANUP_FAILED");
      const removed=new Set(result.listingIds);setListings(current=>current.filter(item=>!removed.has(item.listingId)));
      showToast("success",`Usunięto starsze oferty: ${result.listingIds.length}.`);
    }catch(error){
      const code=error instanceof Error?error.message:"";
      showToast("error",code==="CLEANUP_PREVIEW_CHANGED"?"Baza zmieniła się od podglądu. Przygotuj nowy podgląd.":code==="ACTIVE_FACEBOOK_WORK"?"Poczekaj na zakończenie aktywnego skanu Facebooka.":"Nie potwierdzono czyszczenia. Odśwież stan i spróbuj ponownie.");
    }finally{cleanupLock.current=false;setHistoryClearing(false);}
  };
  const repairGallery=async(item:FacebookWatcherListing)=>{
    setBusyId(item.listingId);
    const outcome=await runGalleryRepairAndRefresh({
      fetchRepair:()=>fetch(`/api/facebook-watcher/listings/${item.listingId}/gallery-repair`,{method:"POST",credentials:"same-origin"}).then(async response=>({ok:response.ok,body:await response.json()})),
      fetchListings:loadListings,
      errorMessages:GALLERY_REPAIR_ERROR_MESSAGES,
    });
    if(outcome.kind==="repaired"){
      setListings(outcome.listings);
      showToast("success",`Galeria zgłoszona do ponownego pobrania (status: ${outcome.status}).`);
    }else{
      showToast("error",outcome.message);
    }
    setBusyId(null);
  };
  const restoreToFinder=async(item:FacebookWatcherListing)=>{setBusyId(item.listingId);try{const response=await fetch(`/api/facebook-watcher/listings/${item.listingId}/restore`,{method:"POST",credentials:"same-origin"});const body=await response.json();if(!response.ok)throw new Error(body.code??"Nie udało się przywrócić oferty do Flip Finder.");if(body.restored===false)throw new Error("Oferta nie spełnia aktualnych filtrów Facebooka i nie została przywrócona.");setListings(current=>current.map(value=>value.listingId===item.listingId?{...value,lifecycleStatus:body.lifecycleStatus??value.lifecycleStatus,archivedAt:null}:value));showToast("success",body.bucket==="REVIEW"?"Oferta przywrócona do Flip Finder jako Do oceny.":"Oferta przywrócona do Flip Finder.");}catch(reason){showToast("error",reason instanceof Error?reason.message:"Nie udało się przywrócić oferty do Flip Finder.");}finally{setBusyId(null);}};
  const openAnalysis=(id:string)=>analysisButtonsRef.current.get(id)?.click();
  return <main className="mx-auto min-w-0 w-full max-w-[1500px] space-y-7 px-4 py-5 sm:px-6 lg:px-8">
    <section aria-label="Cykl życia ofert Facebook" className="grid grid-cols-2 gap-3 sm:grid-cols-5"><Counter label="Oferty po zgrupowaniu" value={lifecycle.database}/><Counter label="Bieżące" value={lifecycle.current}/><Counter label="Do oceny" value={lifecycle.review}/><Counter label="Archiwum / stare / odrzucone" value={lifecycle.archived+lifecycle.stale+lifecycle.rejected}/><Counter label="Nowe dziś" value={today}/></section>
    <div className="flex flex-wrap items-center gap-3 text-sm" aria-live="polite"><Button variant="outline" className="min-h-11" disabled={refreshing} onClick={()=>void refreshListingsRef.current()}>{refreshing?"Odświeżanie…":"Odśwież oferty"}</Button><span className="text-muted-foreground">Oferty: {groupedListings.length} · Publikacje: {listings.length} · Powtórki: {listings.length-groupedListings.length}</span>{lastRefreshedAt?<span className="text-xs text-muted-foreground">Ostatnie pobranie: {new Date(lastRefreshedAt).toLocaleTimeString("pl-PL")}</span>:null}</div>
    <details className="rounded-2xl border border-border/60 bg-card/40 p-4"><summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">Diagnostyka spójności Finder / Watcher</summary><p className="mt-2 text-xs text-muted-foreground">Watcher pokazuje obserwacje Facebooka i ich cykl życia. Finder pokazuje populację ofert dopasowanych do aktywnych filtrów; te liczniki nie muszą być równe.</p><div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4"><Counter label="MATCHED" value={consistency.matched}/><Counter label="REVIEW" value={consistency.review}/><Counter label="REJECTED" value={consistency.rejected}/><Counter label="HISTORICAL" value={consistency.historical}/></div></details>
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><div className="mb-2 inline-flex items-center gap-2 rounded-full border border-gold/25 bg-gold/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-gold"><Flame className="size-3.5"/>Premium inbox</div><h1 className="font-heading text-3xl font-bold tracking-tight">Facebook Watcher / Inbox</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">Jedno miejsce do przeglądania, analizowania i przekazywania ofert Facebooka do CRM.</p></div><div className="flex flex-wrap gap-2"><Button nativeButton={false} variant="outline" render={<Link href="/facebook-watcher/groups"/>} className="min-h-11">Obserwowane grupy</Button><Button nativeButton={false} render={<Link href="/properties/new"/>} className="min-h-11"><Plus className="size-4"/>Dodaj post z Facebooka</Button><Button disabled={historyClearing} variant="outline" className="min-h-11" onClick={()=>void clearWatcherHistory()}>{historyClearing?"Czyszczenie…":"Wyczyść historię Watchera"}</Button></div></header>
    <section className="flex flex-wrap items-end gap-3 rounded-xl border p-3" aria-label="Czyszczenie według daty zapisu">
      <label className="text-sm">Usuń oferty zapisane przed<Input aria-label="Data zapisu oferty" type="date" value={cleanupDate} max={new Date().toISOString().slice(0,10)} onChange={event=>setCleanupDate(event.target.value)} disabled={historyClearing}/></label>
      <Button variant="outline" disabled={!cleanupDate||historyClearing} onClick={()=>void cleanupSavedBefore()}>Podgląd i usuń starsze</Button>
      <p className="w-full text-xs text-muted-foreground">Wiek według daty zapisania w bazie, nie publikacji ani ostatniego odczytu. Najpierw zobaczysz liczbę ofert. CRM i Deal Room pozostają chronione.</p>
    </section>
    <nav aria-label="Status ofert Facebook" className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">{TABS.map(item=><button aria-pressed={tab===item.value} className={`min-h-11 shrink-0 snap-start rounded-xl border px-4 text-sm font-semibold ${tab===item.value?"border-gold/40 bg-gold/15 text-gold":"border-border bg-card text-muted-foreground hover:text-foreground"}`} key={item.value} onClick={()=>setTab(item.value)}>{item.label}<span className="ml-2 rounded-full bg-black/15 px-2 py-0.5 text-xs">{item.value==="all"?groupedListings.filter(value=>value.workflowStatus!=="rejected").length:groupedListings.filter(value=>value.workflowStatus===item.value).length}</span></button>)}</nav>
    <section className="min-w-0 space-y-4" aria-label="Wyszukiwanie ofert Facebook"><div className="min-w-0 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_240px_auto]"><label className="relative min-w-0"><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground"/><Input aria-label="Szukaj ofert Facebook" className="h-11 pl-10" placeholder="Szukaj: tytuł, opis, ulica, osiedle, grupa" value={filters.query} onChange={event=>setFilters(current=>({...current,query:event.target.value}))}/></label><select aria-label="Sortowanie" className="h-11 min-w-0 w-full rounded-xl border border-input bg-background px-3 text-sm" value={sort} onChange={event=>setSort(event.target.value as FacebookInboxSort)}><option value="newest">Najnowsze</option><option value="opportunity">Najwyższy Opportunity Score</option><option value="flip">Najwyższy Flip Score</option><option value="price_per_sqm">Najniższa cena/m²</option><option value="price">Najniższa cena</option><option value="profit">Największy potencjalny zysk</option></select><details className="relative min-w-0 md:hidden"><summary className="flex min-h-11 cursor-pointer list-none items-center justify-center gap-2 rounded-xl border bg-card px-4 text-sm font-semibold"><Filter className="size-4"/>Filtry</summary><div className="mt-2 min-w-0 max-w-full rounded-xl border bg-card p-4"><FilterControls filters={filters} listings={listings} setFilters={setFilters}/></div></details></div><div className="hidden rounded-2xl border border-border/70 bg-card p-4 md:block"><FilterControls filters={filters} listings={listings} setFilters={setFilters}/></div>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Button type="button" disabled={Boolean(filterError)} onClick={saveFilters}>Zapisz filtry</Button>
        <p className="text-xs text-muted-foreground">Zapis na tym urządzeniu. Po powrocie i odświeżeniu przywracamy zapisany zakres.</p>
        <Link className="text-sm underline" href="/flip-finder/filters">Zarządzaj filtrami skanowania w Finderze</Link>
      </div>
      {filterError?<p role="alert" className="text-sm text-destructive">{filterError}</p>:null}
      <div className="text-sm text-muted-foreground">Wyniki: <strong className="text-foreground">{visible.length}</strong></div>
      {visible.some(item=>(item.relatedPosts?.length??0)>1)?<p className="text-xs text-muted-foreground">Po zgrupowaniu: {visible.length} kart · {visible.reduce((total,item)=>total+(item.relatedPosts?.length??1),0)} publikacji. „Możliwe duplikaty” oznaczają zgodne parametry bez potwierdzenia zdjęciem lub pełnym opisem. Każdy post pozostaje dostępny w „Powiązane publikacje”.</p>:null}
      {error?<p className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">{error}</p>:null}{loading?<p className="py-12 text-center text-sm text-muted-foreground">Ładowanie Inboxu…</p>:null}
      {!loading&&visible.length===0?<div className="rounded-2xl border border-dashed p-10 text-center text-muted-foreground">Brak ofert spełniających wybrane kryteria.</div>:null}
      {photoComparisonProgress?<p role="status" className="text-xs text-muted-foreground">{photoComparisonProgress}</p>:null}<div className="grid gap-5 xl:grid-cols-2">{rendered.map(item=><InboxItem addToCrm={addToCrm} registerAnalysisButton={registerAnalysisButton} busy={busyId===item.listingId} item={item} key={item.listingId} onAnalyze={openAnalysis} onRepairGallery={repairGallery} onRestoreToFinder={restoreToFinder} updateWorkflow={guardedUpdateWorkflow}/>)}</div>
      {rendered.length<visible.length?<div className="flex flex-wrap items-center justify-center gap-3 py-4"><p className="text-sm text-muted-foreground">Pokazano {rendered.length} z {visible.length} mieszkań</p><Button variant="outline" onClick={()=>setPage({key:pageKey,count:shownCount+24})}>Pokaż kolejne mieszkania</Button></div>:null}
    </section>
    {toast?<div aria-live="polite" className={`fixed inset-x-0 bottom-5 z-50 mx-auto w-fit max-w-[calc(100%-2rem)] rounded-xl border px-4 py-3 text-sm font-medium shadow-xl ${toast.tone==="success"?"border-emerald-500/30 bg-emerald-500/10 text-emerald-600":"border-destructive/30 bg-destructive/10 text-destructive"}`}>{toast.text}</div>:null}
  </main>;
}

function InboxItem({item,busy,updateWorkflow,addToCrm,onAnalyze,onRepairGallery,onRestoreToFinder,registerAnalysisButton}:{item:FacebookWatcherListing;busy:boolean;updateWorkflow:(item:FacebookWatcherListing,change:{status?:FacebookWorkflowStatus;markRead?:boolean;crmPropertyId?:string})=>Promise<void>;addToCrm:(item:FacebookWatcherListing)=>Promise<void>;onAnalyze:(id:string)=>void;onRepairGallery:(item:FacebookWatcherListing)=>Promise<void>;onRestoreToFinder:(item:FacebookWatcherListing)=>Promise<void>;registerAnalysisButton:(id:string,button:HTMLButtonElement|null)=>void}) { const result=toFilterResult(item); const listingUrl=resolveListingUrl({source:"facebook",sourcePostUrl:item.sourcePostUrl,originalUrl:item.originalUrl}); const suspect=priceSuspect(item); const priceExplanation=item.priceQuality?facebookPriceReviewExplanation(item.priceQuality,item.price):null; const finderStatus=item.finderStatus??"HISTORICAL"; const presentation=resolveListingStatusPresentation({finderStatus,lifecycleStatus:facebookLifecycleStatus(item.lifecycleStatus)}); const currentLabel=item.currentFilterDecision&&item.currentFilterDecision!==finderStatus?` · teraz ${item.currentFilterDecision}`:""; return <article className="space-y-2 overflow-hidden rounded-[1.125rem] !border-2 !border-gold/55 transition-colors duration-300 hover:!border-gold/80 focus-within:!border-gold/80" id={`facebook-inbox-${item.listingId}`}><div className="bg-card px-3 py-3"><div className="flex flex-wrap items-center gap-2"><WorkflowBadge status={item.workflowStatus}/>{item.highPriority?<Badge text="🔥 Wysoki priorytet" tone="fire"/>:null}{suspect?<Badge text="Cena do weryfikacji"/>:null}{item.locationState==="AMBIGUOUS"||item.locationState==="MISSING"?<Badge text="Niepewna lokalizacja"/>:null}{item.availability&&item.availability!=="ACTIVE"?<Badge text={item.availability==="SOLD"?"Sprzedane":item.availability==="RESERVED"?"Zarezerwowane":"Nieaktualne"}/>:null}{item.freshness==="STALE"?<Badge text="Nieaktualny wpis"/>:null}{item.sellerType==="private"?<Badge text="Prywatny właściciel"/>:null}{item.condition==="renovation"?<Badge text="Do remontu"/>:null}{item.flags.filter(flag=>/bez pośred|pilne/i.test(flag)).slice(0,2).map(flag=><Badge key={flag} text={flag}/>)}</div>{priceExplanation?<p className="mt-2 text-xs text-muted-foreground">{priceExplanation}</p>:null}<div className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2"><span>Publikacja: {dateTime(item.publishedAt)}</span><span>Import: {dateTime(item.importedAt)}</span><span>Grupa: {item.groupName??"Facebook"}</span><span>{presentation.mode==="distinct"?<>Finder: <strong className="text-foreground">{presentation.finderLabel}</strong>{currentLabel} · cykl życia: <strong className="text-foreground">{presentation.lifecycleLabel}</strong></>:<>Status: <strong className="text-foreground">{presentation.label}</strong>{currentLabel}</>}</span><span>Opportunity Score: <strong className="text-gold">{item.opportunityScore}</strong> · Flip Score: <strong className="text-foreground">{item.flipScore}</strong></span></div>{item.crossSourceLinks.length?<div className="mt-2 flex flex-wrap gap-2">{item.crossSourceLinks.map(link=><a className="text-xs font-semibold text-sky-400 hover:underline" href={link.url} key={link.url} rel="noopener noreferrer" target="_blank">Znaleziona też na {sourceName(link.source)} ↗</a>)}</div>:null}<div className="mt-3 flex flex-wrap gap-2"><Action buttonRef={button=>registerAnalysisButton(item.listingId,button)} disabled={busy} label="Analizuj" onClick={()=>onAnalyze(item.listingId)}/><Action disabled={busy} label="Napraw galerię" onClick={()=>void onRepairGallery(item)}/>{item.lifecycleStatus==="ARCHIVED"||item.lifecycleStatus==="STALE"?<Action disabled={busy} label="Przywróć do Flip Finder" onClick={()=>void onRestoreToFinder(item)}/>:null}<Action disabled={busy} label="Interesująca" onClick={()=>void updateWorkflow(item,{status:"interesting"})}/><Action disabled={busy} label="Dodaj do CRM" onClick={()=>void addToCrm(item)}/>{item.workflowStatus==="rejected"?<Action disabled={busy} icon={<Undo2 className="size-3.5"/>} label="Przywróć" onClick={()=>void updateWorkflow(item,{status:"review"})}/>:<Action disabled={busy} icon={<XCircle className="size-3.5"/>} label="Odrzuć" onClick={()=>void updateWorkflow(item,{status:"rejected"})}/>} {listingUrl?<a className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold" href={listingUrl} rel="noopener noreferrer" target="_blank"><ExternalLink className="size-3.5"/>Facebook</a>:<button className="min-h-11 shrink-0 rounded-lg border px-3 text-xs font-semibold text-muted-foreground" disabled type="button">Brak prawidłowego linku do ogłoszenia</button>}</div></div>{item.relatedPosts&&item.relatedPosts.length>1?<details className="min-w-0 px-4 pb-3"><summary className="cursor-pointer text-sm">{item.relatedPostMatch === "possible" ? "Możliwe duplikaty" : "Duplikaty"}: {item.relatedPosts.length - 1} · Powiązane publikacje ({item.relatedPosts.length})</summary><ul className="mt-2 space-y-2 text-sm">{item.relatedPosts.map((post,index)=><li key={post.listingId}>{post.url?<a className="break-words underline" href={post.url} target="_blank" rel="noopener noreferrer">{post.groupName??`Publikacja ${index+1}`}</a>:"Brak linku do posta"}</li>)}</ul></details>:null}<ExpandableListingCard averagePricePerSqm={null} hideLifecycleBadge={presentation.mode!=="distinct"} marketType={item.marketType} onCrmImported={propertyId=>void updateWorkflow(item,{status:"crm",crmPropertyId:propertyId})} onOpen={()=>{if(!item.readAt)void updateWorkflow(item,{markRead:true});}} result={result} variant="watcher"/></article>; }

function FilterControls({filters,listings,setFilters}:{filters:FacebookInboxFilters;listings:FacebookWatcherListing[];setFilters:React.Dispatch<React.SetStateAction<FacebookInboxFilters>>}) {
  const update=<K extends keyof FacebookInboxFilters>(key:K,value:FacebookInboxFilters[K])=>setFilters(current=>({...current,[key]:value}));
  const options=(key:"neighborhood"|"district"|"groupName")=>[...new Set([...listings.map(item=>item[key]),key==="groupName"?filters.group:filters[key]].filter((value):value is string=>Boolean(value)))].sort((a,b)=>a.localeCompare(b,"pl"));
  return <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
    <Select label="Osiedle" value={filters.neighborhood} onChange={value=>update("neighborhood",value)} options={options("neighborhood")}/>
    <Select label="Dzielnica" value={filters.district} onChange={value=>update("district",value)} options={options("district")}/>
    <Select label="Grupa" value={filters.group} onChange={value=>update("group",value)} options={options("groupName")}/>
    <NumberFilter label="Cena minimalna (PLN)" value={filters.minPrice??null} onChange={value=>update("minPrice",value)}/>
    <NumberFilter label="Cena maksymalna (PLN)" value={filters.maxPrice} onChange={value=>update("maxPrice",value)}/>
    <NumberFilter label="Powierzchnia min. (m²)" value={filters.minArea??null} onChange={value=>update("minArea",value)}/>
    <NumberFilter label="Powierzchnia maks. (m²)" value={filters.maxArea??null} onChange={value=>update("maxArea",value)}/>
    <NumberFilter label="Maks. cena za m² (PLN)" value={filters.maxPricePerSqm} onChange={value=>update("maxPricePerSqm",value)}/>
    <p className="text-xs text-muted-foreground">Przy limicie zł/m² oferty bez ceny za m² pozostają widoczne.</p>
    <fieldset className="min-w-0"><legend className="mb-1 text-xs text-muted-foreground">Pokoje</legend><div className="flex flex-wrap gap-2">{[1,2,3,4,5,6].map(room=><label key={room} className="flex min-h-11 items-center gap-1 rounded-lg border px-2 text-sm"><input type="checkbox" checked={filters.roomOptions?.includes(room)??false} onChange={()=>setFilters(current=>({...current,rooms:null,roomOptions:current.roomOptions?.includes(room)?current.roomOptions.filter(value=>value!==room):[...(current.roomOptions??[]),room]}))}/>{room}</label>)}</div></fieldset>
    <NumberFilter label="Piętro minimalne" value={filters.minFloor??null} onChange={value=>update("minFloor",value)}/>
    <NumberFilter label="Piętro maksymalne" value={filters.maxFloor??null} onChange={value=>update("maxFloor",value)}/>
    <label className="flex min-w-0 items-center gap-2 text-sm"><input type="checkbox" checked={filters.excludeGroundFloor??false} onChange={event=>update("excludeGroundFloor",event.target.checked)}/>Wyklucz parter</label>
    <label className="flex min-w-0 items-center gap-2 text-sm"><input type="checkbox" checked={filters.excludeTopFloor??false} onChange={event=>update("excludeTopFloor",event.target.checked)}/>Wyklucz ostatnie piętro</label>
    <NumberFilter label="Minimalny Flip Score" value={filters.minFlipScore} onChange={value=>update("minFlipScore",value)}/>
    <NumberFilter label="Minimalny zysk (PLN)" value={filters.minProfit??null} onChange={value=>update("minProfit",value)}/>
    <NumberFilter label="Opportunity min." value={filters.minOpportunityScore} onChange={value=>update("minOpportunityScore",value)}/>
    <Select label="Rynek" value={filters.marketType==="all"?"":filters.marketType??""} onChange={value=>update("marketType",value?value as "primary"|"secondary":"all")} options={["primary","secondary"]} labels={{primary:"Pierwotny",secondary:"Wtórny"}}/>
    <Select label="Sprzedający" value={filters.sellerType==="all"?"":filters.sellerType} onChange={value=>update("sellerType",value?value as "private"|"agency":"all")} options={["private","agency"]} labels={{private:"Prywatny",agency:"Pośrednik"}}/>
    <Select label="Stan" value={filters.condition==="all"?"":filters.condition} onChange={value=>update("condition",value?value as "renovation"|"ready":"all")} options={["renovation","ready"]} labels={{renovation:"Do remontu",ready:"Do wejścia"}}/>
    <Select label="Data publikacji" value={filters.publishedDays?.toString()??""} onChange={value=>update("publishedDays",value?Number(value):null)} options={["1","7","30","90"]} labels={{"1":"24 godziny","7":"7 dni","30":"30 dni","90":"90 dni"}}/>
    <button type="button" className="min-h-11 min-w-0 self-end rounded-xl border px-3 text-sm font-semibold" onClick={()=>setFilters({...EMPTY_FACEBOOK_INBOX_FILTERS,roomOptions:[],query:filters.query})}>Wyczyść filtry</button>
  </div>;
}
function Counter({label,value,tone}:{label:string;value:number;tone?:"fire"}){return <div className={`ui-card p-4 ${tone==="fire"?"border-orange-500/25 bg-orange-500/[0.06]":""}`}><p className="text-xs text-muted-foreground">{label}</p><p className={`mt-1 font-mono text-2xl font-bold ${tone==="fire"?"text-orange-400":""}`}>{value}</p></div>}
function WorkflowBadge({status}:{status:FacebookWorkflowStatus}){return <Badge text={STATUS_LABELS[status]} tone={status==="interesting"?"gold":status==="rejected"?"fire":undefined}/>}
function Badge({text,tone}:{text:string;tone?:"gold"|"fire"}){return <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${tone==="gold"?"border-gold/30 bg-gold/10 text-gold":tone==="fire"?"border-orange-500/30 bg-orange-500/10 text-orange-400":"border-border bg-muted text-muted-foreground"}`}>{text}</span>}
function Action({label,onClick,disabled,icon,buttonRef}:{label:string;onClick:()=>void;disabled:boolean;icon?:React.ReactNode;buttonRef?: (element:HTMLButtonElement|null)=>void}){return <button className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold hover:border-gold/40 hover:text-gold disabled:opacity-50" disabled={disabled} onClick={onClick} ref={buttonRef}>{icon}{label}</button>}
function Select({label,value,onChange,options,labels={}}:{label:string;value:string;onChange:(value:string)=>void;options:string[];labels?:Record<string,string>}){return <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">{label}<select aria-label={label} className="h-11 min-w-0 w-full max-w-full rounded-xl border bg-background px-2 text-sm text-foreground" value={value} onChange={event=>onChange(event.target.value)}><option value="">Wszystkie</option>{options.map(option=><option key={option} value={option}>{labels[option]??option}</option>)}</select></label>}
function NumberFilter({label,value,onChange}:{label:string;value:number|null;onChange:(value:number|null)=>void}){return <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">{label}<input className="h-11 min-w-0 w-full max-w-full rounded-xl border bg-background px-3 text-sm text-foreground" min="0" step="any" inputMode="decimal" type="number" value={value??""} onChange={event=>onChange(event.target.value?Number(event.target.value):null)}/></label>}
function dateTime(value:string|null){return value?new Intl.DateTimeFormat("pl-PL",{dateStyle:"medium",timeStyle:"short"}).format(new Date(value)):"brak"}
function sourceName(value:string){return value==="olx"?"OLX":value==="otodom"?"Otodom":value==="morizon"?"Morizon":value}
const LIFECYCLE_STATUS_VALUES=new Set(["ACTIVE","REVIEW","STALE","ARCHIVED","REJECTED"]);
function facebookLifecycleStatus(value:string|null|undefined):"ACTIVE"|"REVIEW"|"STALE"|"ARCHIVED"|"REJECTED"|undefined{return typeof value==="string"&&LIFECYCLE_STATUS_VALUES.has(value)?value as never:undefined;}
function toFilterResult(item:FacebookWatcherListing):FilterResult { const eventAt=item.publishedAt??item.importedAt; const bucket=item.currentFilterDecision??"REJECTED"; const review=item.currentFilterReasons?.includes("review")===true; return {id:item.listingId,title:item.title,price:item.price,area:item.area,rooms:item.rooms,floor:item.floor===null?null:String(item.floor),totalFloors:item.totalFloors===null?null:String(item.totalFloors),buildingType:null,ownership:null,description:item.description,images:item.images,pricePerSqm:item.pricePerSqm,locationText:composeFacebookLocation({street:item.street,neighborhood:item.neighborhood,district:item.district,city:item.city}),address:item.street,city:item.city,district:item.district,thumbnailUrl:item.images[0]??null,sourcePostUrl:item.sourcePostUrl??null,originalUrl:resolveListingUrl({source:"facebook",sourcePostUrl:item.sourcePostUrl,originalUrl:item.originalUrl}),source:"facebook",listingStatus:item.status==="removed"||item.status==="sold"||item.status==="watched"?item.status:"active",lifecycleStatus:facebookLifecycleStatus(item.lifecycleStatus),isActive:item.status==="active",publishedAt:item.publishedAt,firstSeenAt:item.importedAt,lastSeenAt:eventAt,firstMatchedAt:item.importedAt,lastMatchedAt:item.importedAt,previousPrice:null,currentPrice:item.price,isNew:item.isNew,hasPriceDrop:false,priceDropAmount:null,matchReasons:item.currentFilterReasons??item.flags,unknownFields:item.currentFilterMissingFields??[],decisionBucket:bucket,canonicalDecisionDebug:undefined,finderStatus:item.finderStatus??(review?"REVIEW":bucket)}; }
