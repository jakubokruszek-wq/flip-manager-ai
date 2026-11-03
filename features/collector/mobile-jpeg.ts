import sharp from "sharp";
import { MobileInputError } from "./facebook-mobile";

/** Decode actual pixels before storage. A fabricated JPEG header is not a photo. */
export async function verifyMobileJpeg(bytes:Buffer):Promise<void>{
  try{
    if(bytes.length>96*1024||bytes.length<5||bytes[0]!==0xff||bytes[1]!==0xd8)throw new Error();
    const {info}=await sharp(bytes,{limitInputPixels:192*144,failOn:"warning"}).raw().toBuffer({resolveWithObject:true});
    if(info.width<1||info.width>192||info.height<1||info.height>144)throw new Error();
  }catch{throw new MobileInputError("INVALID_MOBILE_JPEG");}
}
