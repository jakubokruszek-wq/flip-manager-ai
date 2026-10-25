const test=require('node:test'),assert=require('node:assert/strict');
require('../../../../../../extensions/facebook-collector/collector-core.js');
const core=globalThis.FlipFacebookCollectorCore,p=require('../../main/extension/desktop-preview.js'),v=require('../../main/extension/desktop-viewport.js');
const group='lodzsprzedazzakupwynajem',id='550000000000091',media='880000000000001',url='https://scontent.fbcdn.net/a.jpg';
function env(){
 const doc={},region={},anchor={href:`https://www.facebook.com/photo/?fbid=${media}`},rect={left:20,top:100,right:320,bottom:260,width:300,height:160};
 const state={region,article:null,blocked:null,unit:null,images:[],imgQueries:0};
 const image={tagName:'IMG',ownerDocument:doc,isConnected:true,complete:true,naturalWidth:300,currentSrc:url+'?PRIVATE_TOKEN',getBoundingClientRect:()=>({...rect}),getAttribute:()=>null,
 closest(s){if(s==='[role="article"],article')return state.article;if(s==='a[href]')return anchor;if(s.includes('form,input,textarea'))return state.blocked;if(s==='[data-pagelet*="FeedUnit"],[data-testid="post_container"]')return state.unit;if(s==='[role="feed"],[data-pagelet*="Feed"],main,[role="main"]')return state.region;return null;}};
 state.images=[image];doc.querySelectorAll=s=>{if(s==='img'){state.imgQueries++;return state.images;}return[];};doc.elementFromPoint=()=>image;
 const w={document:doc,innerWidth:980,innerHeight:800},audit=p.zero(),slots=new Map(),allowed=new Set([id]);
 const bindings=[{postId:id,ids:[media],urls:[url]}];
 const shot=(b=bindings)=>v.photos(w,core,group,p.photoNodes,slots,allowed,b,audit,p);
 return{w,doc,region,anchor,rect,state,image,audit,slots,allowed,bindings,shot};
}
test('rendered image outside all article boundaries uses exact network attachment ownership',()=>{
 const h=env(),shot=h.shot();assert(shot);assert.equal(shot.network,true);assert.deepEqual(shot.tiles.map(t=>t.postId),[id]);assert.equal(shot.valid(),true);assert.equal(h.audit.photoExactCards,0);assert.equal(h.audit.photoNetworkCards,0);assert.equal(h.audit.photoDocumentBound,1);assert.equal(h.audit.photoDocumentSelected,1);
 const wire=JSON.stringify({width:shot.width,height:shot.height,tiles:shot.tiles});for(const privateValue of ['http','PRIVATE_TOKEN',media,'currentSrc'])assert(!wire.includes(privateValue));
});
test('document discovery requires current exact evidence and never guesses from geometry',()=>{
 for(const variant of ['missing','unretained','shared','conflict']){const h=env();let b=h.bindings;if(variant==='missing')b=[];if(variant==='unretained')h.allowed.clear();if(variant==='shared')b=[...b,{postId:'550000000000092',ids:[],urls:[url]}];if(variant==='conflict')b=[{postId:id,ids:[media],urls:[]},{postId:'550000000000092',ids:[],urls:[url]}];assert.equal(h.shot(b),null,variant);if(variant==='missing')assert.equal(h.state.imgQueries,0);}
});
test('profile,foreign post,other own post and outside-feed images remain refused',()=>{
 for(const href of ['https://www.facebook.com/profile.php?id=777777','https://evil.test/a','https://www.facebook.com/groups/foreign/posts/550000000000091/',`https://www.facebook.com/groups/${group}/posts/550000000000092/`]){const h=env();h.anchor.href=href;assert.equal(h.shot(),null,href);}
 for(const kind of ['article','blocked','region','unit']){const h=env();if(kind==='article')h.state.article={};if(kind==='blocked')h.state.blocked={};if(kind==='region')h.state.region=null;if(kind==='unit')h.state.unit={querySelectorAll:()=>[{href:`https://www.facebook.com/groups/foreign/posts/${id}/`}]};assert.equal(h.shot(),null,kind);}
});
test('visibility,decoded-image andlarge-image gates apply to document crops too',()=>{
 for(const kind of ['small','unloaded','offscreen','occluded','foreignDoc']){const h=env();if(kind==='small')h.rect.width=199;if(kind==='unloaded')h.image.complete=false;if(kind==='offscreen')h.rect.top=790,h.rect.bottom=950;if(kind==='occluded')h.doc.elementFromPoint=()=>({});if(kind==='foreignDoc')h.image.ownerDocument={};assert.equal(h.shot(),null,kind);}
});
test('commit rejects changed ownership,source,link,scope andmoved images',()=>{
 for(const kind of ['owner','source','link','scope','move','detached','article']){const h=env(),shot=h.shot();assert(shot);if(kind==='owner'){assert.equal(shot.valid([{postId:'550000000000092',ids:[media],urls:[url]}]),false);continue;}if(kind==='source')h.image.currentSrc+='new';if(kind==='link')h.anchor.href='https://www.facebook.com/profile.php?id=777777';if(kind==='scope')h.state.blocked={};if(kind==='move')h.rect.top++;if(kind==='detached')h.image.isConnected=false;if(kind==='article')h.state.article={};assert.equal(shot.valid(),false,kind);}
});
test('repeated rendered nodes cannot create duplicate native post-slot entries',()=>{
 const h=env();h.state.images=[h.image,h.image];const shot=h.shot();assert(shot);assert.equal(shot.tiles.length,1);assert.equal(shot.keys.length,1);shot.keys[0].done=true;assert.equal(h.shot(),null);
});
test('data image needs independently known numeric media route andenumeration is bounded',()=>{
 const h=env();h.image.currentSrc='data:image/svg+xml,%3Csvg/%3E';assert(h.shot());h.anchor.href='https://www.facebook.com/photo/?fbid=pfbidUNKNOWN';assert.equal(h.shot(),null);
 const many=env();many.state.images=Array(1000).fill(many.image);assert(many.shot());assert.equal(many.audit.photoDocumentNodes,500);
});
