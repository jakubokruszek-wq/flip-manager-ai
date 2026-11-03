import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {verifyMobileJpeg} from "./mobile-jpeg.ts";
test("a real JPEG graphic containing text counts as a stored offer image",async()=>{
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="192" height="144"><rect width="192" height="144" fill="white"/><text x="8" y="60" font-size="15">SPRZEDAM MIESZKANIE</text><text x="8" y="95">42 m2, 430000 zl</text></svg>');
  await verifyMobileJpeg(await sharp(svg).jpeg().toBuffer());
});
test("JPEG-looking garbage and oversized images cannot satisfy the one-photo requirement",async()=>{
  const fake=Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,144,0,192,1,1,0x11,0,0xff,0xd9]);
  await assert.rejects(()=>verifyMobileJpeg(fake));
  const large=await sharp({create:{width:1080,height:1920,channels:3,background:'white'}}).jpeg().toBuffer();
  await assert.rejects(()=>verifyMobileJpeg(large));
});
