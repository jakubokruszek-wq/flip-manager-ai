const test=require('node:test'),assert=require('node:assert/strict');
require('../../../../../../extensions/facebook-collector/collector-core.js');const core=globalThis.FlipFacebookCollectorCore,preview=require('../../main/extension/desktop-preview.js'),exact=require('../../main/extension/review-post.js').exact,api=require('../../main/extension/review-images.js');
const group='lodzsprzedazzakupwynajem',id='550000000000091',link=`https://www.facebook.com/groups/${group}/posts/${id}/`,nonce='12345678-1234-1234-1234-123456789012';
function env(){const doc={title:'Post',readyState:'complete',visibilityState:'visible',hidden:false,hasFocus:()=>true},w={document:doc,location:{href:link},innerWidth:980,innerHeight:1600,setTimeout:f=>{f();return 0},getComputedStyle:()=>({pointerEvents:'auto'})};const m={consent:true,ocrConsent:true,nonce,groupId:group,postId:id,expectedUrl:link};
 const card={ownerDocument:doc,isConnected:true,parentElement:null,closest:()=>null,contains:n=>n===image},anchor={href:link,closest:s=>s==='[role="article"],article'?card:null};
 const image={ownerDocument:doc,isConnected:true,complete:true,naturalWidth:800,naturalHeight:400,alt:'Text',closest:s=>s==='[role="article"],article'?card:null,checkVisibility:()=>true,scrollIntoView(){},getBoundingClientRect:()=>({left:100,top:200,right:900,bottom:600,width:800,height:400}),contains:()=>false};
 card.querySelectorAll=s=>s==='a[href]'?[anchor]:s==='img'?[image]:[];doc.querySelector=()=>null;doc.querySelectorAll=()=>[card];doc.elementFromPoint=()=>image;
 const calls=[];let beforeAck=()=>{};const request=async q=>{calls.push(q);if(q.action==='photos')beforeAck();return{accepted:true,count:1,requestId:nonce}};
 return{w,doc,m,card,image,anchor,calls,setBeforeAck:f=>beforeAck=f,run:(reader=api.create())=>reader.read(w,m,core,preview,exact,request)};
}
test('fresh exact opened post captures one photo in two phases without exporting URL or text',async()=>{const h=env(),r=await h.run();assert.deepEqual({status:r.status,count:r.count,reason:r.reason},{status:'OK',count:1,reason:'CAPTURED'});assert.equal(r.details.qualified,1);assert.equal(r.details.ownerAccepted,1);assert.deepEqual(h.calls.map(x=>x.action),['photos','commit']);assert.equal(h.calls[0].tiles[0].postId,id);assert(!JSON.stringify(h.calls).includes(link));assert(!JSON.stringify(r).includes(id));});
test('no new OCR consent or invalid context never even selects media',async()=>{for(const kind of ['consent','ocr','foreign','hidden','focus','title','login']){const h=env();if(kind==='consent')h.m.consent=false;if(kind==='ocr')h.m.ocrConsent=false;if(kind==='foreign')h.w.location.href=link.replace(group,'foreign');if(kind==='hidden')h.doc.hidden=true;if(kind==='focus')h.doc.hasFocus=()=>false;if(kind==='title')h.doc.title='Checkpoint';if(kind==='login')h.doc.querySelector=()=>({});h.doc.querySelectorAll=()=>{throw Error('must not read')};assert.equal((await h.run()).status,'STOP',kind);assert.equal(h.calls.length,0);}});
test('exact URL alone cannot select a suggested post or a comment permalink',async()=>{for(const suffix of ['foreign','comment']){const h=env();h.anchor.href=suffix==='foreign'?link.replace(id,'550000000000092'):link+'?comment_id=777777';assert.equal((await h.run()).count,0);assert.equal(h.calls.length,0);}});
test('comment or shared image and unloaded images are not cropped',async()=>{for(const kind of ['comment','unloaded']){const h=env();if(kind==='comment')h.image.closest=s=>s==='[role="article"],article'?h.card:{};else h.image.complete=false;assert.equal((await h.run()).count,0);assert.equal(h.calls.length,0);}});
test('occlusion prevents capture and context loss after pixels drops pending crop',async()=>{const h=env();h.doc.elementFromPoint=()=>({});assert.equal((await h.run()).count,0);assert.equal(h.calls.length,0);const b=env();b.setBeforeAck(()=>b.w.location.href=link.replace(group,'foreign'));assert.equal((await b.run()).status,'STOP');assert.deepEqual(b.calls.map(x=>x.action),['photos','drop']);});
test('one grant is single use even when no image exists',async()=>{const h=env(),reader=api.create();h.image.complete=false;assert.equal((await h.run(reader)).status,'OK');assert.equal((await h.run(reader)).status,'STOP');});
test('sibling image needs a unique same-post region, never the whole document',async()=>{const h=env();const zone={querySelectorAll:s=>s==='a[href]'?[h.anchor]:s==='img'?[h.image]:[h.card],contains:n=>n===h.image};h.card.closest=s=>s==='main,[role="main"]'?zone:null;h.card.querySelectorAll=s=>s==='a[href]'?[h.anchor]:[];h.image.closest=()=>null;assert.equal((await h.run()).count,1);const b=env();b.card.querySelectorAll=s=>s==='a[href]'?[b.anchor]:[];b.image.closest=()=>null;assert.equal((await b.run()).count,0);});

test('interactive DOM still requires a loaded image and loading documents never capture',async()=>{const h=env();h.doc.readyState='interactive';assert.equal((await h.run()).count,1);const b=env();b.doc.readyState='loading';assert.equal((await b.run()).status,'STOP');assert.equal(b.calls.length,0);});

test('photo without alt or any message/caption is still offered to pixel OCR',async()=>{const h=env();delete h.image.alt;assert.equal((await h.run()).count,1);assert.deepEqual(h.calls.map(x=>x.action),['photos','commit']);});

test('a nested exact card can supply its own image without accepting a foreign parent',async()=>{const h=env();const wrapper={ownerDocument:h.doc,parentElement:null,closest:()=>null,querySelectorAll:()=>[]};h.card.parentElement={closest:()=>wrapper};assert.equal((await h.run()).count,1);const b=env();const outer={ownerDocument:b.doc,parentElement:null,closest:()=>null};const a={href:link.replace(id,'550000000000092'),closest:()=>outer};outer.querySelectorAll=()=>[a];b.card.parentElement={closest:()=>outer};assert.equal((await b.run()).count,0);assert.equal(b.calls.length,0);});

test('an exact interactive data-url binds a photo through the same strict identity helper',async()=>{const h=env();delete h.anchor.href;h.anchor.getAttribute=k=>k==='data-url'?link:null;const prior=h.card.querySelectorAll;h.card.querySelectorAll=s=>s==='a[href]'?[]:s.startsWith('a[data-href]')?[h.anchor]:prior(s);assert.equal((await h.run()).count,1);});

function canonicalImageEnv(){const h=env(),prior=h.doc.querySelectorAll,meta={tagName:'LINK',url:link,getAttribute:()=>meta.url};h.doc.head={querySelectorAll:()=>[meta]};const main={ownerDocument:h.doc,isConnected:true,closest:()=>null,checkVisibility:()=>true,querySelectorAll:()=>[h.card]};h.doc.querySelectorAll=s=>s==='main,[role="main"]'?[main]:prior(s);h.anchor.href=link+'?comment_id=999999';return{...h,meta};}
test('canonical primary proof permits only its own loaded photo without a header permalink',async()=>{const h=canonicalImageEnv();assert.equal((await h.run()).count,1);assert.deepEqual(h.calls.map(x=>x.action),['photos','commit']);});
test('changing canonical proof after pixels drops the pending crop',async()=>{const h=canonicalImageEnv();h.setBeforeAck(()=>h.meta.url=link.replace(id,'550000000000092'));assert.equal((await h.run()).status,'STOP');assert.deepEqual(h.calls.map(x=>x.action),['photos','drop']);});

test('numeric report gets one explicit image-selection outcome without source URLs',async()=>{
 for(const kind of ['CAPTURED','NO_PROOF','NO_IMAGE','UNLOADED','OCCLUDED','NO_ACK']){
  const h=env();if(kind==='NO_PROOF')h.anchor.href=link+'?comment_id=777';if(kind==='NO_IMAGE')h.image.getBoundingClientRect=()=>({width:20,height:20});if(kind==='UNLOADED')h.image.complete=false;if(kind==='OCCLUDED')h.doc.elementFromPoint=()=>({});
  const r=kind==='NO_ACK'?await api.create().read(h.w,h.m,core,preview,exact,async()=>({accepted:false})):await h.run();
  assert.equal(r.reason,kind);assert.equal(r.count,kind==='CAPTURED'?1:0);assert(!JSON.stringify(r).includes(link));
 }
});

test('single-photo counters distinguish owner rejection from small geometry without exporting sources',async()=>{
 const foreign=env();foreign.image.closest=()=>({});const a=await foreign.run();assert.equal(a.reason,'NO_IMAGE');assert.equal(a.details.rawImg,1);assert.equal(a.details.ownerRejected,1);assert.equal(a.details.qualified,0);
 const small=env();small.image.getBoundingClientRect=()=>({left:1,top:1,right:81,bottom:81,width:80,height:80});const b=await small.run();assert.equal(b.reason,'NO_IMAGE');assert.equal(b.details.ownerAccepted,1);assert.equal(b.details.sizeRejected,1);assert.equal(b.details.qualified,0);
 for(const result of [a,b]){assert(Object.values(result.details).every(Number.isInteger));assert(!JSON.stringify(result).includes('facebook.com'));assert(!JSON.stringify(result).includes(id));}
});

test('missing own-card proof still reports bounded image inventory without choosing a foreign photo',async()=>{
 const h=env(),old=h.doc.querySelectorAll;h.doc.querySelectorAll=s=>s==='img'?[h.image]:old(s);h.anchor.href=link.replace(id,'550000000000092');const r=await h.run();
 assert.equal(r.count,0);assert.equal(r.details.documentImg,1);assert.equal(r.details.ownerAccepted,0);assert.equal(r.details.qualified,0);assert.equal(h.calls.length,0);assert(!JSON.stringify(r).includes('facebook.com'));
});
