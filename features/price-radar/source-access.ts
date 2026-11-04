/** Source-side restrictions are not application crashes. Keep raw errors for diagnostics. */
export function radarAccessRestriction(message:string):"access"|"rate_limit"|null {
  if(/captcha|access.denied|forbidden|\b403\b|TERMINAL_ACCESS_ERROR/iu.test(message))return "access";
  if(/\b429\b|rate.limit/iu.test(message))return "rate_limit";
  return null;
}
export function radarCooldownUntil(message:string):string|null {
  const match=/^SOURCE_COOLDOWN_UNTIL:([^|]+)\|/u.exec(message);
  return match && Number.isFinite(Date.parse(match[1].trim())) ? match[1].trim() : null;
}
export function radarAccessLabel(message:string):string {
  const kind=radarAccessRestriction(message);
  return kind==="access"?"Portal odmówił dostępu (CAPTCHA lub blokada). Pozostałe portale działają dalej.":kind==="rate_limit"?"Portal ograniczył liczbę zapytań (429). Pozostałe portale działają dalej.":"Nie udało się odczytać źródła. Szczegóły są w diagnostyce poniżej.";
}

type HistoryRow={finished_at?:unknown;checkpoint?:unknown;source_statuses?:unknown};
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
/** A skipped run carries the original deadline; restarting cannot extend it. */
export function radarSourceCooldown(history:HistoryRow[],source:string,now=Date.now()):{until:string;reason:string}|null {
  const rows=[...history].sort((a,b)=>Date.parse(String(b.finished_at))-Date.parse(String(a.finished_at)));
  for(const row of rows){
    if(!Number.isFinite(Date.parse(String(row.finished_at))))continue;
    const cp=object(row.checkpoint);const error=object(cp.sourceErrors)[source];
    const status=object(row.source_statuses)[source]??object(cp.sourceStatuses)[source];
    if(status==="completed")return null;
    if(typeof error!=="string")continue;
    const carried=radarCooldownUntil(error);
    if(carried)return Date.parse(carried)>now?{until:carried,reason:error.slice(error.indexOf("|")+1).trim()}:null;
    const kind=radarAccessRestriction(error);
    if(!kind)continue;
    const until=Date.parse(String(row.finished_at))+(kind==="access"?24:2)*60*60_000;
    return until>now?{until:new Date(until).toISOString(),reason:error}:null;
  }
  return null;
}
