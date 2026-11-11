import sharp from "sharp";
import type { PhotoFingerprint } from "../visual-reposts";
function hex(bits:boolean[]) { return Array.from({length:16},(_,i)=>parseInt(bits.slice(i*4,i*4+4).map(b=>b?"1":"0").join(""),2).toString(16)).join(""); }
/** Tiny, lossy-compression-tolerant signatures; all image decoding stays on the server. */
export async function fingerprintImage(bytes:Uint8Array,assetHash:string):Promise<PhotoFingerprint> {
  const image=sharp(bytes,{limitInputPixels:12_000_000,sequentialRead:true}).rotate().removeAlpha();
  const metadata=await image.metadata();if(!metadata.width||!metadata.height||metadata.width<48||metadata.height<48)throw Error("Image too small");
  const d=await image.clone().resize(9,8,{fit:"fill"}).greyscale().raw().toBuffer();
  const a=await image.clone().resize(8,8,{fit:"fill"}).greyscale().raw().toBuffer();
  const color=await image.clone().resize(16,16,{fit:"fill"}).toColourspace("srgb").raw().toBuffer();
  const average=a.reduce((sum,v)=>sum+v,0)/64;
  const mean:[number,number,number]=[0,0,0];for(let i=0;i<color.length;i+=3){mean[0]+=color[i];mean[1]+=color[i+1];mean[2]+=color[i+2];}for(let c=0;c<3;c++)mean[c]=Math.round(mean[c]/256);
  return {assetHash,dhash:hex(Array.from({length:64},(_,i)=>d[Math.floor(i/8)*9+i%8]>d[Math.floor(i/8)*9+i%8+1])),ahash:hex([...a].map(v=>v>=average)),mean,detail:Math.round(Math.sqrt(a.reduce((sum,v)=>sum+(v-average)**2,0)/64)),aspect:metadata.width/metadata.height};
}
