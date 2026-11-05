/** Private numeric capture evidence, separate from offer import and identity-history batches. */
export type MobileScan = {
  version: 1 | 2; sourceType?: "PROFILE"; sourceId?: string; batchId: string; scanId: string; cycle: string; groupId: string;
  appVersion: string; versionCode: number; issue: string;
  interactive: boolean; idle: boolean; batteryExempt: boolean;
  stats: Record<string, number>;
  posts: Array<{ postId: string; intent: string; qualification: string; photos: number }>;
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, names: string[]) => Object.keys(v).sort().join() === names.sort().join();
const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export function parseMobileScan(value: unknown): MobileScan | null {
  if (!record(value)) return null;
  const profile = value.version === 2;
  if (!exact(value, [...(profile ? ["sourceType", "sourceId"] : []), "version", "batchId", "scanId", "cycle", "groupId", "appVersion", "versionCode", "issue", "interactive", "idle", "batteryExempt", "stats", "posts"])) return null;
  const j=value;
  if (profile && (j.sourceType !== "PROFILE" || typeof j.sourceId !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(j.sourceId) || j.groupId !== `profile:${j.sourceId}`)) return null;
  if ((!profile && j.version!==1) || !uuid(j.batchId) || !uuid(j.scanId) || typeof j.cycle!=="string" || !/^capture-2\/[A-Za-z0-9_/:.+-]{1,120}$/.test(j.cycle) || typeof j.groupId!=="string" || (!profile && !/^[A-Za-z0-9_.-]{1,100}$/.test(j.groupId))) return null;
  if (typeof j.appVersion!=="string" || !/^\d+\.\d+\.\d+-gecko-poc$/.test(j.appVersion) || !Number.isSafeInteger(j.versionCode) || Number(j.versionCode)<1 || Number(j.versionCode)>1000000 || typeof j.issue!=="string" || !/^[A-Z0-9_]{0,60}$/.test(j.issue)) return null;
  if (![j.interactive,j.idle,j.batteryExempt].every(v=>typeof v==="boolean") || !record(j.stats) || Object.keys(j.stats).length>160 || !Object.entries(j.stats).every(([k,v])=>/^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(k)&&Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=100000000)) return null;
  if (!Array.isArray(j.posts) || j.posts.length>50) return null;
  const seen=new Set<string>();
  for (const p of j.posts) {
    if (!record(p) || !exact(p,["postId","intent","qualification","photos"]) || typeof p.postId!=="string" || !(profile ? /^(?:\d{5,30}|pfbid[A-Za-z0-9]{10,180})$/ : /^\d{5,30}$/).test(p.postId) || seen.has(p.postId)) return null;
    if (!["SELL_PROPERTY","BUY_PROPERTY","RENT_OFFER","RENT_WANTED","SERVICE","OTHER","UNKNOWN"].includes(String(p.intent)) || !["CANDIDATE","NO_TEXT","FOREIGN_CITY","NOT_PROPERTY","INTENT","MISSING_FIELDS","CONFLICT","CLASSIFIER"].includes(String(p.qualification)) || !Number.isSafeInteger(p.photos) || Number(p.photos)<0 || Number(p.photos)>3) return null;
    seen.add(p.postId);
  }
  return j as MobileScan;
}
type Dependencies={authenticate(token:string):Promise<{id:string}>;allowed(group:string,type?:"GROUP"|"PROFILE"):Promise<boolean>;save(device:string,report:MobileScan):Promise<void>;authStatus(error:unknown):number|null};
export function createMobileScanPost(deps:Dependencies){
  return async(request:Request):Promise<Response>=>{
    try{
      const token=/^Bearer\s+(.+)$/i.exec(request.headers.get("authorization")??"")?.[1]?.trim();
      if(!token)return Response.json({code:"PAIRING_REQUIRED"},{status:401});
      const device=await deps.authenticate(token);
      const reader=request.body?.getReader();if(!reader)return Response.json({code:"INVALID_SCAN"},{status:422});
      const chunks:Uint8Array[]=[];let size=0;
      try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>65536){await reader.cancel();return Response.json({code:"TOO_LARGE"},{status:413});}chunks.push(p.value);}}finally{reader.releaseLock();}
      let input:unknown;try{input=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{return Response.json({code:"INVALID_SCAN"},{status:422});}
      const report=parseMobileScan(input);if(!report)return Response.json({code:"INVALID_SCAN"},{status:422});
      if(!await deps.allowed(report.sourceId ?? report.groupId, report.sourceType ?? "GROUP"))return Response.json({code:"SOURCE_DISABLED"},{status:409});
      await deps.save(device.id,report);
      return Response.json({batchId:report.batchId});
    }catch(error){return Response.json({code:"SCAN_REPORT_RETRY"},{status:deps.authStatus(error)??503});}
  };
}
