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
test('parser exception becomes a bounded ERROR reply without exception text or post content',()=>{const h=env();const prior=h.doc.querySelectorAll;h.doc.querySelectorAll=s=>s==='script:not([src])'?[{textContent:JSON.stringify({url:link})}]:prior(s);const stub={...core,extractStructuredRecordsFromText(){throw Error('PRIVATE_EXCEPTION_AND_TOKEN')}};const r=reader.create().read(h.w,h.m,stub,f,p);assert.equal(r.status,'STOP');assert.equal(r.reason,'ERROR');assert.equal(r.evidence.readerStage,5);assert.equal(r.evidence.readerErrors,1);assert.equal(r.rows.length,0);assert(!JSON.stringify(r).includes('PRIVATE_EXCEPTION'));assert(!JSON.stringify(r).includes('Sprzedam'));});
test('a bounded script work budget returns an honest incomplete result instead of blocking the port',()=>{const h=env();let tick=0;h.w.performance={now:()=>tick+=501};const prior=h.doc.querySelectorAll;h.doc.querySelectorAll=s=>s==='script:not([src])'?[{textContent:JSON.stringify({url:link})}]:prior(s);const r=h.run();assert.equal(r.status,'OK');assert.equal(r.evidence.budgetLimited,1);assert.equal(r.evidence.scriptParsed,0);});

test('a nested article under an identified same-post parent is not mistaken for the main post comment',()=>{const h=env();const wrapper={ownerDocument:h.doc,parentElement:null,closest:()=>null};const a={href:link,closest:()=>wrapper};wrapper.querySelectorAll=()=>[a];h.card.parentElement={closest:()=>wrapper};const r=h.run();assert.equal(r.bound,0);assert.equal(r.rows[0].price,null);});

test('an interactive anchor with exact data-href can bind without fabricating a post ID',()=>{const h=env();delete h.anchor.href;h.anchor.getAttribute=k=>k==='data-href'?link:null;const prior=h.card.querySelectorAll;h.card.querySelectorAll=s=>s==='a[href]'?[]:s.startsWith('a[data-href]')?[h.anchor]:prior(s);const r=h.run();assert.equal(r.bound,1);assert.equal(r.rows[0].price,319000);assert.equal(r.evidence.attrExact,1);assert.equal(r.evidence.hrefExact,0);});
test('interactive identity rejects other groups, other posts and comment targets with numeric diagnostics only',()=>{for(const kind of ['group','post','comment']){const h=env();delete h.anchor.href;h.anchor.getAttribute=k=>k==='data-href'?(kind==='group'?link.replace(group,'foreign'):kind==='post'?link.replace(id,'550000000000092'):link+'?comment_id=999999'):null;const prior=h.card.querySelectorAll;h.card.querySelectorAll=s=>s==='a[href]'?[]:s.startsWith('a[data-href]')?[h.anchor]:prior(s);const r=h.run();assert.equal(r.bound,0);assert.equal(r.rows[0].price,null);assert.equal(r.evidence[kind==='group'?'foreignGroup':kind==='post'?'foreignPost':'identityMissing'],1);assert(!JSON.stringify(r.evidence).includes('http'));}});
test('an article metadata attribute alone is not promoted to an interactive permalink',()=>{const h=env();h.card.getAttribute=()=>link;h.card.querySelectorAll=()=>[];const r=h.run();assert.equal(r.bound,0);assert.equal(r.evidence.identityMissing,1);});

function canonicalEnv(){const h=env(),prior=h.doc.querySelectorAll;const meta={tagName:'LINK',getAttribute:()=>meta.url,url:link};h.doc.head={querySelectorAll:()=>[meta]};const main={ownerDocument:h.doc,isConnected:true,closest:()=>null,checkVisibility:()=>true,querySelectorAll:()=>[h.card]};h.doc.querySelectorAll=s=>s==='main,[role="main"]'?[main]:prior(s);h.anchor.href=link+'?comment_id=999999';return{...h,meta,main};}
test('canonical exact document plus one own primary card binds without using comment links as identity',()=>{const h=canonicalEnv(),r=h.run();assert.equal(r.bound,1);assert.equal(r.textRead,1);assert.equal(r.rows[0].price,319000);assert.equal(r.evidence.hrefExact,0);assert.equal(r.evidence.rejectQuery,1);assert.equal(r.evidence.canonicalBound,1);assert.equal(r.evidence.primaryCandidates,1);});
test('canonical fallback refuses conflicting metadata, foreign own links or ambiguous main cards',()=>{for(const kind of ['metadata','group','post','ambiguous']){const h=canonicalEnv();if(kind==='metadata')h.meta.url=link.replace(id,'550000000000092');if(kind==='group')h.anchor.href=link.replace(group,'foreign');if(kind==='post')h.anchor.href=link.replace(id,'550000000000092');if(kind==='ambiguous')h.main.querySelectorAll=()=>[h.card,{ownerDocument:h.doc,isConnected:true,parentElement:null,closest:()=>null}];const r=h.run();assert.equal(r.bound,0,kind);assert.equal(r.rows[0].price,null,kind);assert.equal(r.evidence.canonicalBound,0,kind);}});
test('URL and a sole card without head canonical metadata never establish this alternative proof',()=>{const h=canonicalEnv();delete h.doc.head;assert.equal(h.run().bound,0);});
test('an explicitly labelled comment cannot become a canonical primary post',()=>{const h=canonicalEnv();h.card.getAttribute=()=> 'Comment by someone';assert.equal(h.run().bound,0);});

function hydrationEnv(scripts){const h=env();h.anchor.href='https://www.facebook.com/';const prior=h.doc.querySelectorAll;h.doc.querySelectorAll=s=>s==='script:not([src])'?scripts:prior(s);return h;}
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
 const scripts=Array.from({length:100},()=>({textContent:JSON.stringify({url:link})}));let calls=0;
 const stub={...core,extractStructuredRecordsFromText(){calls++;return[{postId:'550000000000092',permalink:link.replace(id,'550000000000092'),text:'Sprzedam mieszkanie 999 m2',media:[]}]}};
 const h=hydrationEnv(scripts),r=reader.create().read(h.w,h.m,stub,f,p);assert.equal(calls,64);assert.equal(r.bound,0);assert.equal(r.rows[0].area,null);assert.equal(r.evidence.budgetLimited,1);
});

test('matched block with zero parser records is distinguished from rejected records',()=>{
 const h=hydrationEnv([{getAttribute:()=> 'application/json',textContent:JSON.stringify({url:link})}]);
 const r=reader.create().read(h.w,h.m,{...core,extractStructuredRecordsFromText:()=>[]},f,p);
 assert.equal(r.evidence.parsedDataBlocks,1);assert.equal(r.evidence.recordReturned,0);assert.equal(r.evidence.recordAccepted,0);assert.equal(r.bound,0);
});
test('record diagnostics distinguish format, other ID, permalink, quoted text and accepted empty text',()=>{
 const h=hydrationEnv([{textContent:JSON.stringify({url:link})}]);
 const records=[null,'PRIVATE_RECORD', {postId:'550000000000092',permalink:link.replace(id,'550000000000092')}, {postId:id,permalink:link.replace(group,'foreign')}, {postId:id,permalink:link,text:'PRIVATE_QUOTED',__structuredDiagnostics:{structuredTextPath:'shared_story.message'}}, {postId:id,permalink:link,text:'',media:[]}];
 const r=reader.create().read(h.w,h.m,{...core,extractStructuredRecordsFromText:()=>records},f,p),e=r.evidence;
 assert.equal(e.recordReturned,6);assert.equal(e.recordInvalid,2);assert.equal(e.recordOtherId,1);assert.equal(e.recordLinkRejected,1);assert.equal(e.recordShared,1);assert.equal(e.recordAccepted,1);assert.equal(e.recordNoText,1);assert.equal(e.parsedOtherBlocks,1);
 assert.equal(r.bound,1);assert.equal(r.textRead,0);assert.equal(r.rows[0].price,null);assert(Object.values(e).every(Number.isInteger));assert(!JSON.stringify(e).includes('PRIVATE'));assert(!JSON.stringify(e).includes(id));
});
test('record truncation is explicit and never inspects a later record as the requested post',()=>{
 const h=hydrationEnv([{textContent:JSON.stringify({url:link})}]);
 const records=Array.from({length:100},()=>({postId:'550000000000092',permalink:link.replace(id,'550000000000092')}));records.push({postId:id,permalink:link,text:'Sprzedam mieszkanie 42m2',media:[]});
 const r=reader.create().read(h.w,h.m,{...core,extractStructuredRecordsFromText:()=>records},f,p);
 assert.equal(r.evidence.recordReturned,101);assert.equal(r.evidence.recordOtherId,100);assert.equal(r.evidence.recordLimit,1);assert.equal(r.evidence.budgetLimited,1);assert.equal(r.bound,0);
});
