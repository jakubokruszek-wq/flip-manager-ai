const test=require('node:test'),assert=require('node:assert/strict'),reader=require('../../main/extension/joined-groups.js');
function anchor(href,text,attrs={}){const a={href,innerText:text,isConnected:true,parentElement:null,closest:()=>null,getAttribute:k=>attrs[k]||null,getBoundingClientRect:()=>({width:300,height:30})};return a;}
function env(links){const main={querySelectorAll:()=>links,scrollHeight:2000,clientHeight:800};const doc={querySelector:s=>s.includes('main')?main:null,querySelectorAll:()=>[],visibilityState:'visible',hidden:false};return {document:doc,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1',overflowY:'visible'})};}
test('only exact joined-directory routes and direct Facebook group URLs are eligible',()=>{
 assert(reader.page('https://www.facebook.com/groups/joins/'));
 for(const url of ['https://evil.test/groups/joins/','https://www.facebook.com/groups/feed/','https://www.facebook.com/groups/123456/']){assert(!reader.page(url));}
 assert.equal(reader.group('https://www.facebook.com/groups/joins/'),null);assert.equal(reader.group('https://www.facebook.com/groups/123456/posts/98765/'),null);assert.equal(reader.group('https://evil.test/groups/123456/'),null);
 assert.deepEqual(reader.group('https://m.facebook.com/groups/ABc.Lodz/?ref=source'),{id:'abc.lodz',url:'https://www.facebook.com/groups/abc.lodz/'});
});
test('names come from rendered links, nameless duplicates upgrade and recommendations never become memberships',()=>{
 const url='https://www.facebook.com/groups/123456/';const first=anchor(url,''),named=anchor(url,'Nieruchomości Łódź');
 const suggestion=anchor('https://www.facebook.com/groups/987654/','Domy Łódź');suggestion.parentElement={parentElement:null,querySelectorAll:s=>s==='a[href]'?[suggestion]:[{innerText:'Dołącz'}]};
 const sidebar=anchor('https://www.facebook.com/groups/444444/','Grupa Łódź');sidebar.closest=()=>({});
 const result=reader.inspect(env([first,named,suggestion,sidebar,anchor('https://www.facebook.com/groups/joins/','Twoje grupy')]));
 assert.deepEqual(result.groups,[{url,name:'Nieruchomości Łódź'}]);assert.equal(result.duplicates,1);
 assert.equal(reader.name(anchor(url,'',{ 'aria-label':'Zdjęcie profilowe grupy' }),'123456'),null);
});
test('scroll accumulation keeps virtualized earlier memberships and proves zero results without inventing groups',async()=>{
 const first=anchor('https://www.facebook.com/groups/123456/','Nieruchomości Łódź'),second=anchor('https://www.facebook.com/groups/987654/','Mieszkania Łódź');
 let links=[first],now=0;const w=env(links);w.document.querySelector('[role="main"],main').querySelectorAll=()=>links;
 w.location={href:'https://www.facebook.com/groups/joins/'};w.performance={timeOrigin:1000,now:()=>now};w.setTimeout=f=>{now+=750;f();};
 const scroller={scrollTop:0,clientHeight:800,scrollHeight:1600,scrollBy(){this.scrollTop=800;links=[second];}};w.document.scrollingElement=scroller;
 const reply=await reader.run(w,{consent:true,nonce:'12345678-1234-1234-1234-123456789012'});
 assert.equal(reply.status,'OK');assert.deepEqual(reply.groups.map(g=>g.name),['Nieruchomości Łódź','Mieszkania Łódź']);assert.equal(reply.stats.stabilized,1);assert.equal(reply.stats.scrollMoves,1);
});

test('wrong page, password and empty directory stop without creating invented memberships',async()=>{
 const w=env([]);let now=0;w.location={href:'https://www.facebook.com/groups/joins/'};w.performance={timeOrigin:1000,now:()=>now};w.setTimeout=f=>{now+=750;f();};w.document.scrollingElement={scrollTop:0,clientHeight:800,scrollHeight:800,scrollBy(){}};
 const message={consent:true,nonce:'12345678-1234-1234-1234-123456789012'};
 const empty=await reader.run(w,message);assert.equal(empty.reason,'DISCOVERY_NO_GROUP_LINKS');assert.deepEqual(empty.groups,[]);
 w.location.href='https://www.facebook.com/groups/feed/';assert.equal((await reader.run(w,message)).status,'STOP');
 w.location.href='https://www.facebook.com/groups/joins/';const query=w.document.querySelector;w.document.querySelector=s=>s.includes('password')?{}:query(s);assert.equal((await reader.run(w,message)).reason,'LOGIN_REQUIRED');
});
