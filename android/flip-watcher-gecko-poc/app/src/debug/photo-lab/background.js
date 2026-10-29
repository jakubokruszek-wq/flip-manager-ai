/* Installed only by Android tests. Never installed by PocActivity/GeckoHost. */
'use strict';
const base='https://scontent-fra3-2.xx.fbcdn.net/v/t39.30808-6/123456789_987654321_555555555_n.jpg';
let config=null,port=null;
browser.webRequest.onBeforeRequest.addListener(d=>{
 // Always cancel the literal test asset outside the configured loopback page.
 // In a configured test return local pixels before any CDN request is sent.
 if(!config||d.url!==config.image||d.documentUrl!==config.document)return {cancel:true};
 try{port?.postMessage({type:'redirected'});}catch{}
 return {redirectUrl:config.pixels};
},{urls:[base+'*'],types:['image']},['blocking']);
function connect(){
 try{
  port=browser.runtime.connectNative('photo_binding_lab');
  port.onMessage.addListener(m=>{
   try{
    const doc=new URL(m.document),image=new URL(m.image);
    if(m.type!=='configure'||doc.protocol!=='http:'||doc.hostname!=='127.0.0.1'||!/^\/groups\/[A-Za-z0-9._-]+\/posts\/\d{5,30}\/$/.test(doc.pathname)||doc.search||doc.hash||image.origin+image.pathname!==base||typeof m.pixels!=='string'||m.pixels.length>1000000||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(m.pixels))return;
    config={document:doc.href,image:image.href,pixels:m.pixels};port.postMessage({type:'configured'});
   }catch{}
  });
  port.onDisconnect.addListener(()=>{port=null;setTimeout(connect,250);});
 }catch{setTimeout(connect,250);}
}
connect();
