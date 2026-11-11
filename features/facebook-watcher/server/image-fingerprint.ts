import sharp from "sharp";
import type { PhotoFingerprint,VisualSignature } from "../visual-reposts";
function hex(bits:boolean[]) { return Array.from({length:16},(_,i)=>parseInt(bits.slice(i*4,i*4+4).map(b=>b?"1":"0").join(""),2).toString(16)).join(""); }
/** Tiny, lossy-compression-tolerant signatures; all image decoding stays on the server. */
export async function fingerprintImage(bytes:Uint8Array,assetHash:string):Promise<PhotoFingerprint> {
  const image=sharp(bytes,{limitInputPixels:12_000_000,sequentialRead:true}).rotate().removeAlpha();
  const metadata=await image.metadata();if(!metadata.width||!metadata.height||metadata.width<48||metadata.height<48)throw Error("Image too small");
  const variants:VisualSignature[]=[];
  const signature=async(image:ReturnType<typeof sharp>,width:number,height:number):Promise<VisualSignature>=>{
  const d=await image.clone().resize(9,8,{fit:"fill"}).greyscale().raw().toBuffer();
  const a=await image.clone().resize(8,8,{fit:"fill"}).greyscale().raw().toBuffer();
  const color=await image.clone().resize(16,16,{fit:"fill"}).toColourspace("srgb").raw().toBuffer();
  const average=a.reduce((sum,v)=>sum+v,0)/64;
  const mean:[number,number,number]=[0,0,0];for(let i=0;i<color.length;i+=3){mean[0]+=color[i];mean[1]+=color[i+1];mean[2]+=color[i+2];}for(let c=0;c<3;c++)mean[c]=Math.round(mean[c]/256);
  return {dhash:hex(Array.from({length:64},(_,i)=>d[Math.floor(i/8)*9+i%8]>d[Math.floor(i/8)*9+i%8+1])),ahash:hex([...a].map(v=>v>=average)),mean,detail:Math.round(Math.sqrt(a.reduce((sum,v)=>sum+(v-average)**2,0)/64)),aspect:width/height};
  };
  const width=metadata.width,height=metadata.height;
  const main=await signature(image,width,height);
  for(const fraction of [0.7,0.8,0.9])for(const offset of [0,0.25,0.5,0.75,1]){
    const w=Math.round(width*fraction),h=Math.round(height*fraction);
    if(w>=48)variants.push(await signature(image.clone().extract({left:Math.round((width-w)*offset),top:0,width:w,height}),w,height));
    if(h>=48)variants.push(await signature(image.clone().extract({left:0,top:Math.round((height-h)*offset),width,height:h}),width,h));
  }
  return {assetHash,...main,variants};
}
