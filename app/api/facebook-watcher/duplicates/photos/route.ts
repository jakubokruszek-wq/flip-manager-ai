import { createHash } from "node:crypto";
import { unstable_cache } from "next/cache.js";
import { operatorAuthorizationResponse, OperatorAuthorizationError, requireOperator } from "@/features/auth/operator";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import { fingerprintImage } from "@/features/facebook-watcher/server/image-fingerprint";
import { mobileImageAsset, type PhotoFingerprint } from "@/features/facebook-watcher/visual-reposts";
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const cachedFingerprint=unstable_cache(async(url:string,hash:string)=>{
  const response=await fetch(url,{redirect:"error",signal:AbortSignal.timeout(4000),cache:"no-store"});if(!response.ok||Number(response.headers.get("content-length")??0)>2*1024*1024)throw Error("Image unavailable");
  const reader=response.body?.getReader();if(!reader)throw Error("No image");const parts:Uint8Array[]=[];let size=0;
  try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>2*1024*1024)throw Error("Image too large");parts.push(r.value);}}finally{await reader.cancel();}
  const bytes=Buffer.concat(parts);if(createHash("sha256").update(bytes).digest("hex")!==hash)throw Error("Image checksum mismatch");return fingerprintImage(bytes,hash);
},["watcher-photo-fingerprint-v2-crops"],{revalidate:604800});
export async function POST(request:Request) {
  try {
    await requireOperator();if(Number(request.headers.get("content-length")??0)>2048)return Response.json({message:"Za dużo danych."},{status:400});
    const reader=request.body?.getReader();if(!reader)return Response.json({message:"Brak danych."},{status:400});const parts:Uint8Array[]=[];let size=0;
    try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>2048)return Response.json({message:"Za dużo danych."},{status:400});parts.push(r.value);}}finally{await reader.cancel();}
    let body;try{body=JSON.parse(Buffer.concat(parts).toString("utf8"));}catch{return Response.json({message:"Nieprawidłowe dane."},{status:400});}
    if(!body||typeof body!=="object"||!Array.isArray(body.ids)||body.ids.length<1||body.ids.length>4||body.ids.some((id:unknown)=>typeof id!=="string"||!uuid.test(id)))return Response.json({message:"Nieprawidłowe identyfikatory."},{status:400});
    const db=createFacebookWatcherAdminClient();const rows=await db.from("listings").select("id,images").eq("source","facebook").in("id",body.ids);if(rows.error)throw Error("Nie udało się pobrać ofert.");
    const origin=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin;
    const result:Array<{listingId:string;fingerprints:PhotoFingerprint[]}> = [];
    // At most two downloads/decoders concurrently, four cards per request; no browser image decode.
    for(const row of rows.data??[]){const fingerprints:PhotoFingerprint[]=[];const assets=(Array.isArray(row.images)?row.images:[]).flatMap((u:unknown)=>typeof u==="string"?mobileImageAsset(u)??[]:[]).filter(a=>new URL(a.url).origin===origin).slice(0,3);
      for(let i=0;i<assets.length;i+=2)await Promise.all(assets.slice(i,i+2).map(async a=>{try{fingerprints.push(await cachedFingerprint(a.url,a.hash));}catch{/* A failed photo never hides the listing. */}}));result.push({listingId:row.id,fingerprints});}
    return Response.json({results:result},{headers:{"Cache-Control":"private, no-store"}});
  } catch(error){if(error instanceof OperatorAuthorizationError)return operatorAuthorizationResponse(error);return Response.json({message:"Nie udało się porównać zdjęć."},{status:500});}
}
