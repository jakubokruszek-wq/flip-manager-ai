/** Image content is unrestricted: a verified listing graphic can contain text. */
export function visibleFacebookSale(intent:unknown,images:unknown):boolean {
  return intent==="SELL_PROPERTY"&&Array.isArray(images)&&images.some(image=>{
    if(typeof image!=="string")return false;
    try{const url=new URL(image);return url.protocol==="https:"&&!url.username&&!url.password;}catch{return false;}
  });
}
