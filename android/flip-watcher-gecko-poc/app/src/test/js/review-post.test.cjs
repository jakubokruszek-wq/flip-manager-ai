const test=require('node:test'),assert=require('node:assert/strict');
require('../../../../../../extensions/facebook-collector/collector-core.js');const core=globalThis.FlipFacebookCollectorCore,p=require('../../main/extension/desktop-preview.js'),f=require('../../main/extension/desktop-fields.js'),reader=require('../../main/extension/review-post.js');
const group='lodzsprzedazzakupwynajem',id='550000000000091',link=`https://www.facebook.com/groups/${group}/posts/${id}/`,nonce='12345678-1234-1234-1234-123456789012';
function env(){const doc={title:'Own post',readyState:'complete',visibilityState:'visible',hidden:false,hasFocus:()=>true},w={document:doc,location:{href:link},innerWidth:980,getComputedStyle:()=>({display:'block',visibility:'visible'})};
 const previous=p.createModel(core,f,group);previous.add({postId:id,permalink:link,text:'',media:[]},'DOM');
 const m={consent:true,reviewConsent:true,nonce,groupId:group,postId:id,expectedUrl:link,previousRow:previous.rows()[0]};
 const card={ownerDocument:doc,isConnected:true,parentElement:null,closest:()=>null};const anchor={href:link,closest:s=>s==='[role="article"],article'?card:null};
 const marker={ownerDocument:doc,closest:s=>s==='[role="article"],article'?card:null,contains:()=>false,checkVisibility:()=>true};
 const text={nodeType:3,textContent:'Sprzedam mieszkanie 42m2. Cena 319000 zł. 2 pokoje. ul. Testowa 12.'};
 card.querySelectorAll=s=>s==='a[href]'?[anchor]:[marker];doc.querySelector=()=>null;doc.querySelectorAll=s=>s==='[role="article"],article'?[card]:[];
 doc.createTreeWalker=()=>{let done=false;return{nextNode(){if(done)return null;done=true;return text}}};
 return{w,doc,m,card,anchor,marker,text,run:(r=reader.create())=>r.read(w,m,core,f,p)};
}
test('own exact permalink reads full fields and merges the existing RAM row',()=>{const h=env(),r=h.run();assert.equal(r.status,'OK');assert.equal(r.bound,1);assert.equal(r.textRead,1);assert.equal(r.rows[0].price,319000);assert.equal(r.rows[0].area,42);assert.equal(r.rows[0].rooms,2);assert.equal(r.rows[0].street,'Testowa 12');assert(!('text'in r.rows[0]));assert(!JSON.stringify(r).includes('Sprzedam'));});
test('new consent exact context visibility and security gates precede DOM reads',()=>{for(const kind of ['consent','grant','location','id','hidden','focus','title','form']){const h=env();if(kind==='consent')h.m.consent=false;if(kind==='grant')h.m.reviewConsent=false;if(kind==='location')h.w.location.href=link.replace(group,'foreign');if(kind==='id')h.m.postId='550000000000092';if(kind==='hidden')h.doc.hidden=true;if(kind==='focus')h.doc.hasFocus=()=>false;if(kind==='title')h.doc.title='Logowanie';if(kind==='form')h.doc.querySelector=()=>({});h.doc.querySelectorAll=()=>{throw Error('must not inspect')};assert.equal(h.run().status,'STOP',kind);}});
test('URL identity alone never promotes arbitrary suggested article text',()=>{const h=env();h.anchor.href=link.replace(id,'550000000000092');let reads=0;h.doc.createTreeWalker=()=>{reads++;throw Error('wrong target')};const r=h.run();assert.equal(r.status,'OK');assert.equal(r.bound,0);assert.equal(r.textRead,0);assert.equal(r.rows[0].price,null);assert.equal(reads,0);});
test('new grants are single-use and changed contexts erase all fields',()=>{const h=env(),r=reader.create();assert.equal(h.run(r).status,'OK');assert.equal(h.run(r).status,'STOP');const b=env();b.doc.createTreeWalker=()=>{b.w.location.href=link.replace(id,'550000000000092');return{nextNode:()=>null}};assert.equal(b.run().status,'STOP');});
test('exact host path group and post are required without guessing aliases',()=>{for(const raw of [link.replace('https:','http:'),link.replace(group,'402796264871862'),link+'?x=1',link+'#x',link.replace('www.facebook.com','www.facebook.com:444'),link.replace('www.facebook.com','user@www.facebook.com')])assert.equal(reader.exact(raw,group,id),false,raw);assert(reader.exact(link,group,id));});
test('missing text remains an unconfirmed read, not evidence of an empty listing',()=>{const h=env();h.doc.createTreeWalker=()=>({nextNode:()=>null});const r=h.run();assert.equal(r.bound,1);assert.equal(r.textRead,0);assert.equal(r.rows[0].qualification,'NO_TEXT');});

test('a comment permalink cannot bind an unmarked comment as the main post',()=>{const h=env();h.anchor.href=link+'?comment_id=777777777';const r=h.run();assert.equal(r.bound,0);assert.equal(r.textRead,0);assert.equal(r.rows[0].price,null);});

test('interactive own DOM is readable without waiting for media completion; loading DOM is rejected',()=>{const h=env();h.doc.readyState='interactive';assert.equal(h.run().status,'OK');const b=env();b.doc.readyState='loading';b.doc.querySelectorAll=()=>{throw Error('loading DOM must not be read')};assert.equal(b.run().status,'STOP');});

test('an exact nested article is readable inside an unlabelled wrapper without borrowing parent fields',()=>{const h=env();const wrapper={ownerDocument:h.doc,parentElement:null,closest:()=>null,querySelectorAll:()=>[]};h.card.parentElement={closest:()=>wrapper};const r=h.run();assert.equal(r.bound,1);assert.equal(r.textRead,1);assert.equal(r.evidence.nestedCards,1);assert.equal(r.rows[0].price,319000);});
test('a foreign parent article rejects an otherwise exact nested card',()=>{const h=env();const wrapper={ownerDocument:h.doc,parentElement:null,closest:()=>null};const a={href:link.replace(id,'550000000000092'),closest:()=>wrapper};wrapper.querySelectorAll=()=>[a];h.card.parentElement={closest:()=>wrapper};const r=h.run();assert.equal(r.bound,0);assert.equal(r.evidence.foreignParents,1);assert.equal(r.rows[0].price,null);});
test('unrelated bootstrap scripts never enter the expensive structured parser',()=>{const h=env();const prior=h.doc.querySelectorAll;h.doc.querySelectorAll=s=>s==='script:not([src])'?[{textContent:'{"bootstrap":"no own permalink"}'}]:prior(s);let calls=0;const stub={...core,extractStructuredRecordsFromText(){calls++;throw Error('must not parse unrelated script')}};const r=reader.create().read(h.w,h.m,stub,f,p);assert.equal(r.status,'OK');assert.equal(calls,0);assert.equal(r.evidence.scriptSkipped,1);assert.equal(r.evidence.scriptParsed,0);});
test('parser exception becomes a bounded ERROR reply without exception text or post content',()=>{const h=env();const prior=h.doc.querySelectorAll;h.doc.querySelectorAll=s=>s==='script:not([src])'?[{textContent:'window.payload='+JSON.stringify({url:link})+';'}]:prior(s);const stub={...core,extractStructuredRecordsFromText(){throw Error('PRIVATE_EXCEPTION_AND_TOKEN')}};const r=reader.create().read(h.w,h.m,stub,f,p);assert.equal(r.status,'STOP');assert.equal(r.reason,'ERROR');assert.equal(r.evidence.readerStage,5);assert.equal(r.evidence.readerErrors,1);assert.equal(r.rows.length,0);assert(!JSON.stringify(r).includes('PRIVATE_EXCEPTION'));assert(!JSON.stringify(r).includes('Sprzedam'));});
test('a bounded script work budget returns an honest incomplete result instead of blocking the port',()=>{const h=env();let tick=0;h.w.performance={now:()=>tick+=501};const prior=h.doc.querySelectorAll;h.doc.querySelectorAll=s=>s==='script:not([src])'?[{textContent:'window.payload='+JSON.stringify({url:link})+';'}]:prior(s);const r=h.run();assert.equal(r.status,'OK');assert.equal(r.evidence.budgetLimited,1);assert.equal(r.evidence.scriptParsed,0);});

test('a nested article under an identified same-post parent is not mistaken for the main post comment',()=>{const h=env();const wrapper={ownerDocument:h.doc,parentElement:null,closest:()=>null};const a={href:link,closest:()=>wrapper};wrapper.querySelectorAll=()=>[a];h.card.parentElement={closest:()=>wrapper};const r=h.run();assert.equal(r.bound,0);assert.equal(r.rows[0].price,null);});

test('an interactive anchor with exact data-href can bind without fabricating a post ID',()=>{const h=env();delete h.anchor.href;h.anchor.getAttribute=k=>k==='data-href'?link:null;const prior=h.card.querySelectorAll;h.card.querySelectorAll=s=>s==='a[href]'?[]:s.startsWith('a[data-href]')?[h.anchor]:prior(s);const r=h.run();assert.equal(r.bound,1);assert.equal(r.rows[0].price,319000);assert.equal(r.evidence.attrExact,1);assert.equal(r.evidence.hrefExact,0);});
test('interactive identity rejects other groups, other posts and comment targets with numeric diagnostics only',()=>{for(const kind of ['group','post','comment']){const h=env();delete h.anchor.href;h.anchor.getAttribute=k=>k==='data-href'?(kind==='group'?link.replace(group,'foreign'):kind==='post'?link.replace(id,'550000000000092'):link+'?comment_id=999999'):null;const prior=h.card.querySelectorAll;h.card.querySelectorAll=s=>s==='a[href]'?[]:s.startsWith('a[data-href]')?[h.anchor]:prior(s);const r=h.run();assert.equal(r.bound,0);assert.equal(r.rows[0].price,null);assert.equal(r.evidence[kind==='group'?'foreignGroup':kind==='post'?'foreignPost':'identityMissing'],1);assert(!JSON.stringify(r.evidence).includes('http'));}});
test('an article metadata attribute alone is not promoted to an interactive permalink',()=>{const h=env();h.card.getAttribute=()=>link;h.card.querySelectorAll=()=>[];const r=h.run();assert.equal(r.bound,0);assert.equal(r.evidence.identityMissing,1);});

function canonicalEnv(){const h=env(),prior=h.doc.querySelectorAll;const meta={tagName:'LINK',getAttribute:()=>meta.url,url:link};h.doc.head={querySelectorAll:()=>[meta]};const main={ownerDocument:h.doc,isConnected:true,closest:()=>null,checkVisibility:()=>true,querySelectorAll:()=>[h.card]};h.doc.querySelectorAll=s=>s==='main,[role="main"]'?[main]:prior(s);h.anchor.href=link+'?comment_id=999999';return{...h,meta,main};}
test('canonical exact document plus one own primary card binds without using comment links as identity',()=>{const h=canonicalEnv(),r=h.run();assert.equal(r.bound,1);assert.equal(r.textRead,1);assert.equal(r.rows[0].price,319000);assert.equal(r.evidence.hrefExact,0);assert.equal(r.evidence.rejectQuery,1);assert.equal(r.evidence.canonicalBound,1);assert.equal(r.evidence.primaryCandidates,1);});
test('canonical fallback refuses conflicting metadata, foreign own links or ambiguous main cards',()=>{for(const kind of ['metadata','group','post','ambiguous']){const h=canonicalEnv();if(kind==='metadata')h.meta.url=link.replace(id,'550000000000092');if(kind==='group')h.anchor.href=link.replace(group,'foreign');if(kind==='post')h.anchor.href=link.replace(id,'550000000000092');if(kind==='ambiguous')h.main.querySelectorAll=()=>[h.card,{ownerDocument:h.doc,isConnected:true,parentElement:null,closest:()=>null}];const r=h.run();assert.equal(r.bound,0,kind);assert.equal(r.rows[0].price,null,kind);assert.equal(r.evidence.canonicalBound,0,kind);}});
test('URL and a sole card without head canonical metadata never establish this alternative proof',()=>{const h=canonicalEnv();delete h.doc.head;assert.equal(h.run().bound,0);});
test('an explicitly labelled comment cannot become a canonical primary post',()=>{const h=canonicalEnv();h.card.getAttribute=()=> 'Comment by someone';assert.equal(h.run().bound,0);});

function hydrationEnv(scripts){const h=env();h.w.performance={now:()=>0};h.anchor.href='https://www.facebook.com/';const prior=h.doc.querySelectorAll;h.doc.querySelectorAll=s=>s==='script:not([src])'?scripts:prior(s);return h;}
const ownHydration=()=>JSON.stringify({__typename:'Story',post_id:id,permalink_url:link,message:{text:'Sprzedam mieszkanie 42 m2. Cena 319000 zł. 2 pokoje.'}});
test('exact own JSON after 64 bootstrap scripts is read with the real structured parser',()=>{
 const scripts=Array.from({length:150},()=>({textContent:'{"bootstrap":true}'}));scripts.push({textContent:ownHydration()});
 const r=hydrationEnv(scripts).run();assert.equal(r.bound,1);assert.equal(r.textRead,1);assert.equal(r.rows[0].price,319000);assert.equal(r.rows[0].area,42);assert.equal(r.evidence.scriptParsed,1);assert.equal(r.evidence.scriptSkipped,150);
});
test('typed JSON is inspected before bootstrap scripts exhaust the existing byte budget',()=>{
 const scripts=Array.from({length:10},()=>({textContent:'x'.repeat(250000)}));scripts.push({getAttribute:k=>k==='type'?'application/json':null,textContent:ownHydration()});
 const r=hydrationEnv(scripts).run();assert.equal(r.bound,1);assert.equal(r.textRead,1);assert.equal(r.evidence.scriptParsed,1);assert.equal(r.evidence.budgetLimited,1);
});
test('inspection never reads past 256 script nodes and reports incomplete coverage',()=>{
 let outside=0;const scripts=Array.from({length:256},()=>({textContent:'{"bootstrap":true}'}));scripts.push({get textContent(){outside++;return ownHydration()}});
 const r=hydrationEnv(scripts).run();assert.equal(outside,0);assert.equal(r.bound,0);assert.equal(r.evidence.budgetLimited,1);assert.equal(r.evidence.scriptParsed,0);
});
test('more inspection never exceeds 64 expensive parses or accepts a neighboring post',()=>{
 const scripts=Array.from({length:100},()=>({textContent:'window.payload='+JSON.stringify({url:link})+';'}));let calls=0;
 const stub={...core,extractStructuredRecordsFromText(){calls++;return[{postId:'550000000000092',permalink:link.replace(id,'550000000000092'),text:'Sprzedam mieszkanie 999 m2',media:[]}]}};
 const h=hydrationEnv(scripts),r=reader.create().read(h.w,h.m,stub,f,p);assert.equal(calls,64);assert.equal(r.bound,0);assert.equal(r.rows[0].area,null);assert.equal(r.evidence.budgetLimited,1);
});

test('matched block with zero parser records is distinguished from rejected records',()=>{
 const h=hydrationEnv([{getAttribute:()=> 'application/json',textContent:ownHydration()}]);
 const r=reader.create().read(h.w,h.m,{...core,extractStructuredRecordsFromText:()=>[]},f,p);
 assert.equal(r.evidence.parsedDataBlocks,1);assert.equal(r.evidence.recordReturned,0);assert.equal(r.evidence.recordAccepted,0);assert.equal(r.bound,0);
});
test('record diagnostics distinguish format, other ID, permalink, quoted text and accepted empty text',()=>{
 const h=hydrationEnv([{textContent:'window.payload='+JSON.stringify({url:link})+';'}]);
 const records=[null,'PRIVATE_RECORD', {postId:'550000000000092',permalink:link.replace(id,'550000000000092')}, {postId:id,permalink:link.replace(group,'foreign')}, {postId:id,permalink:link,text:'PRIVATE_QUOTED',__structuredDiagnostics:{structuredTextPath:'shared_story.message'}}, {postId:id,permalink:link,text:'',media:[]}];
 const r=reader.create().read(h.w,h.m,{...core,extractStructuredRecordsFromText:()=>records},f,p),e=r.evidence;
 assert.equal(e.recordReturned,6);assert.equal(e.recordInvalid,2);assert.equal(e.recordOtherId,1);assert.equal(e.recordLinkRejected,1);assert.equal(e.recordShared,1);assert.equal(e.recordAccepted,1);assert.equal(e.recordNoText,1);assert.equal(e.parsedOtherBlocks,1);
 assert.equal(r.bound,1);assert.equal(r.textRead,0);assert.equal(r.rows[0].price,null);assert(Object.values(e).every(Number.isInteger));assert(!JSON.stringify(e).includes('PRIVATE'));assert(!JSON.stringify(e).includes(id));
});
test('record truncation is explicit and never inspects a later record as the requested post',()=>{
 const h=hydrationEnv([{textContent:'window.payload='+JSON.stringify({url:link})+';'}]);
 const records=Array.from({length:100},()=>({postId:'550000000000092',permalink:link.replace(id,'550000000000092')}));records.push({postId:id,permalink:link,text:'Sprzedam mieszkanie 42m2',media:[]});
 const r=reader.create().read(h.w,h.m,{...core,extractStructuredRecordsFromText:()=>records},f,p);
 assert.equal(r.evidence.recordReturned,101);assert.equal(r.evidence.recordOtherId,100);assert.equal(r.evidence.recordLimit,1);assert.equal(r.evidence.budgetLimited,1);assert.equal(r.bound,0);
});

function wrapRelay(story,n=15){let value=story;for(let i=0;i<n;i++)value={__bbox:{result:{data:value}}};return value;}
const selectedStory=()=>({__typename:'Story',post_id:id,permalink_url:link,message:{text:'Sprzedam mieszkanie 42 m2. Cena 319000 zł. 2 pokoje. Retkinia. ul. Testowa 12.'}});
const selectData=body=>reader.selectOwnStoryData(body,group,id,()=>0,500);
test('large deeply nested Relay data recovers fields without sending the large payload to the parser',()=>{
 const body=JSON.stringify({padding:'x'.repeat(900000),require:[['RelayPrefetchedStreamCache','next',[],[wrapRelay(selectedStory())]]]});
 assert.equal(core.extractStructuredRecordsFromText(body,'HYDRATION',{sourceType:'GROUP',sourceId:group,sourceUrl:`https://www.facebook.com/groups/${group}/`,allowGroupRedirect:false}).length,0);
 let max=0;const stub={...core,extractStructuredRecordsFromText(payload,...args){max=Math.max(max,payload.length);assert(payload.length<=131072);return core.extractStructuredRecordsFromText(payload,...args)}};
 const h=hydrationEnv([{getAttribute:()=> 'application/json',textContent:body}]),r=reader.create().read(h.w,h.m,stub,f,p);
 assert.equal(r.bound,1);assert.equal(r.textRead,1);assert.equal(r.rows[0].price,319000);assert.equal(r.rows[0].area,42);assert.equal(r.rows[0].rooms,2);assert.equal(r.rows[0].street,'Testowa 12');assert(max<1000);assert.equal(r.evidence.scriptOversize,1);assert.equal(r.evidence.selectedStories,1);assert(r.evidence.selectedCoreRecords>0);
});
test('two large data blocks and exhausted legacy inspection do not discard a selected own story',()=>{
 const scripts=[{getAttribute:()=> 'application/json',textContent:JSON.stringify({padding:'x'.repeat(1500000)})},{getAttribute:()=> 'application/json',textContent:JSON.stringify({padding:'y'.repeat(1500000),data:wrapRelay(selectedStory())})}];
 const r=hydrationEnv(scripts).run();assert.equal(r.bound,1);assert.equal(r.rows[0].price,319000);assert.equal(r.evidence.scriptOversize,2);assert.equal(r.evidence.selectedStories,1);
});
test('a small story beyond the legacy depth cap is also selected',()=>{const r=hydrationEnv([{textContent:JSON.stringify(wrapRelay(selectedStory()))}]).run();assert.equal(r.bound,1);assert.equal(r.rows[0].area,42);});
test('same-owner content and timestamp sections may establish one root story without taking foreign text',()=>{
 const story={__typename:'Story',id,comet_sections:{content:{story:{__typename:'Story',id,message:{text:'Sprzedam mieszkanie 42 m2 za 319000 zł'}}},timestamp:{story:{__typename:'Story',id,url:link}}}};
 const r=hydrationEnv([{textContent:JSON.stringify(wrapRelay(story))}]).run();assert.equal(r.bound,1);assert.equal(r.rows[0].price,319000);assert.equal(r.rows[0].area,42);
});
test('comment, feedback, quote, shared and attachment ancestors cannot become an own post after projection',()=>{
 for(const key of ['comments','feedback','quoted_story','shared_story','attachments','media','caption']){
  const body=JSON.stringify({data:{[key]:selectedStory()}}),r=hydrationEnv([{textContent:body}]).run();assert.equal(r.bound,0,key);assert.equal(r.rows[0].price,null,key);assert(r.evidence.selectorRejected>0,key);
 }
});
test('an enclosing foreign story or comment discovered after the target subtree still rejects it',()=>{
 for(const parent of [{child:selectedStory(),post_id:'550000000000092',__typename:'Story'},{child:selectedStory(),__typename:'Comment'}]){
  const r=hydrationEnv([{textContent:JSON.stringify(parent)}]).run();assert.equal(r.bound,0);assert.equal(r.rows[0].price,null);assert(r.evidence.selectorRejected>0);
 }
});
test('serialized story text, duplicate keys and malformed JSON never create projected identity',()=>{
 const cases=[JSON.stringify({caption:JSON.stringify(selectedStory())}),'{"data":'+JSON.stringify(selectedStory())+',"data":{}}','{"data":'+JSON.stringify(selectedStory())+',}',JSON.stringify({data:selectedStory()}).slice(0,-1)];
 for(const body of cases){const r=hydrationEnv([{getAttribute:()=> 'application/json',textContent:body}]).run();assert.equal(r.bound,0);assert.equal(r.rows[0].price,null);}
});
test('projection respects exact group, conflicting IDs, structural depth and deadline caps',()=>{
 for(const story of [{...selectedStory(),permalink_url:link.replace(group,'foreign')},{...selectedStory(),id:'550000000000092'}])assert.equal(selectData(JSON.stringify(story)).bodies.length,0);
 const deep=selectData(JSON.stringify(wrapRelay(selectedStory(),50)));assert.equal(deep.valid,false);assert.equal(deep.limited,true);
 const timed=reader.selectOwnStoryData(JSON.stringify(selectedStory()),group,id,()=>501,500);assert.equal(timed.valid,false);assert.equal(timed.bodies.length,0);
 assert.equal(selectData('x'.repeat(4194305)).limited,true);
});
test('escaped delimiters and unicode ID strings keep JSON boundaries exact',()=>{
 const story=selectedStory();story.message.text+=' { escaped "quote" and \\ slash }';const body=JSON.stringify({padding:'{"fake":"}"}',data:story}).replace('"post_id":"'+id+'"','"post_id":"\\u0035'+id.slice(1)+'"');
 const selected=selectData(body);assert.equal(selected.valid,true);assert.equal(selected.bodies.length,1);assert.equal(JSON.parse(selected.bodies[0]).post_id,id);
});

test('a neighboring story message cannot fill a target story with no own text',()=>{
 const story={__typename:'Story',post_id:id,permalink_url:link,neighbor:{...selectedStory(),post_id:'550000000000092',permalink_url:link.replace(id,'550000000000092')}};
 const r=hydrationEnv([{textContent:JSON.stringify(wrapRelay(story))}]).run();assert.equal(r.bound,1);assert.equal(r.textRead,0);assert.equal(r.rows[0].price,null);
});
test('bounded projections retain a text-bearing own root after textless duplicate scopes',()=>{
 const story={...selectedStory(),sections:Array.from({length:12},()=>({__typename:'Story',post_id:id,url:link}))};
 const r=hydrationEnv([{textContent:JSON.stringify(wrapRelay(story))}]).run();assert.equal(r.bound,1);assert.equal(r.rows[0].price,319000);assert.equal(r.evidence.selectorIncomplete,1);assert(r.evidence.selectedStories<=8);
});

test('a huge navigation block containing only the target URL cannot spend the structural story budget',()=>{
 const scripts=[{getAttribute:()=> 'application/json',textContent:JSON.stringify({url:link,padding:'x'.repeat(3000000)})},{getAttribute:()=> 'application/json',textContent:JSON.stringify({padding:'y'.repeat(3000000),data:wrapRelay(selectedStory())})}];
 const r=hydrationEnv(scripts).run();assert.equal(r.bound,1);assert.equal(r.rows[0].price,319000);assert.equal(r.evidence.selectedBlocks,1);assert(r.evidence.sourceKiB<4096);
});

test('a foreign parent permalink rejects a nested target even when the parent GraphQL ID is opaque',()=>{
 const parent={child:selectedStory(),__typename:'Story',id:'opaque-graphql-id',url:link.replace(id,'550000000000092')};
 const r=hydrationEnv([{textContent:JSON.stringify(parent)}]).run();assert.equal(r.bound,0);assert.equal(r.rows[0].price,null);assert(r.evidence.selectorRejected>0);
});

test('tracking on an actual structured permalink is canonicalized but comment/reply/hash targets remain rejected',()=>{
 const tracked={...selectedStory(),permalink_url:link+'?__cft__[0]=PRIVATE_TRACKING&__tn__=X'};
 const r=hydrationEnv([{textContent:JSON.stringify(wrapRelay(tracked))}]).run();assert.equal(r.bound,1);assert.equal(r.rows[0].price,319000);assert.equal(r.rows[0].permalink,link);assert(!JSON.stringify(r).includes('PRIVATE_TRACKING'));
 for(const suffix of ['?comment_id=999999','?reply_comment_id=999999','#comment']){
  const bad=hydrationEnv([{textContent:JSON.stringify(wrapRelay({...selectedStory(),permalink_url:link+suffix}))}]).run();assert.equal(bad.bound,0);assert.equal(bad.rows[0].price,null);
 }
});

test('malformed long type hints and whitespace prefixes do not enter an unbounded regex path',()=>{
 const malformed='{"id":"'+id+'","__typename":"'+'Story'.repeat(120000);
 const whitespace=' '.repeat(600000)+'window.route="'+link+'";';
 for(const body of [malformed,whitespace]){const r=hydrationEnv([{textContent:body}]).run();assert.equal(r.bound,0);assert.equal(r.rows[0].price,null);}
});
