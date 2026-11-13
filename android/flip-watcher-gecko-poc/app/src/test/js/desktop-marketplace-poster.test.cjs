const test=require('node:test'),assert=require('node:assert/strict');
require('../../../../../../extensions/facebook-collector/collector-core.js');
const core=globalThis.FlipFacebookCollectorCore,p=require('../../main/extension/desktop-preview.js'),v=require('../../main/extension/desktop-viewport.js');
const group='1424921570856189',id='30239092879012341',imageUrl='https://scontent.fbcdn.net/own-marketplace.jpg';
function imageFixture(){
 const doc={},card={ownerDocument:doc,isConnected:true,closest:()=>null,getAttribute:()=>null,contains:n=>n===card||n===image};
 const anchor={href:'https://www.facebook.com/marketplace/item/123456789012345/'};
 const rect={left:20,top:100,right:620,bottom:450,width:600,height:350};
 const image={tagName:'IMG',ownerDocument:doc,isConnected:true,complete:true,naturalWidth:600,currentSrc:imageUrl,closest:s=>s==='[role="article"],article'?card:s==='a[href]'?anchor:null,getBoundingClientRect:()=>({...rect})};
 card.querySelector=()=>null;card.querySelectorAll=s=>s==='img,svg image'?[image]:s==='a[href]'?[{href:`https://www.facebook.com/groups/${group}/posts/${id}/`,closest:()=>card}]:[];
 doc.querySelectorAll=s=>s.includes('aria-modal')?[]:[card];doc.elementFromPoint=()=>image;
 const w={document:doc,innerWidth:980,innerHeight:800};return{doc,card,anchor,image,w,rect};
}
test('Marketplace preview image requires exact independent ownership, then yields own native crop',()=>{
 const h=imageFixture(),nodes=p.photoNodes(h.card,id,group,core);assert.equal(nodes.length,1);assert.equal(nodes[0].item.networkRequired,true);
 const allowed=new Set([id]),binding=[{postId:id,urls:[imageUrl],ids:[]}];
 const shot=v.photos(h.w,core,group,p.photoNodes,new Map(),allowed,binding,null,p);assert(shot);assert.equal(shot.tiles[0].postId,id);assert(shot.valid());
 assert.equal(v.photos(h.w,core,group,p.photoNodes,new Map(),allowed,[],null,p),null);
 assert.equal(v.photos(h.w,core,group,p.photoNodes,new Map(),allowed,[...binding,{postId:'30239092879012342',urls:[imageUrl],ids:[]}],null,p),null);
 h.anchor.href='https://www.facebook.com/marketplace/item/999999999999999/';assert.equal(shot.valid(),false);
});
test('Marketplace wrapper never authorizes external, profile, malformed or insecure links',()=>{
 for(const href of ['http://www.facebook.com/marketplace/item/123456789012345/','https://evil.test/marketplace/item/123456789012345/','https://www.facebook.com:444/marketplace/item/123456789012345/','https://operator@www.facebook.com/marketplace/item/123456789012345/','https://www.facebook.com/marketplace/item/not-an-id/','https://www.facebook.com/profile.php?id=123456789012345']){const h=imageFixture();h.anchor.href=href;assert.equal(p.photoNodes(h.card,id,group,core).length,0,href);}
});
function posterFixture(kind){
 const text='OFF-MARKET!\nsprzedam mieszkanie\n37,64m2 Łódź Tatrzańska\n66/68\n260000zł';
 const doc={defaultView:{getComputedStyle:()=>({fontSize:'30px',backgroundImage:'none',backgroundColor:'rgb(0, 128, 105)'})}};
 const card={ownerDocument:doc,getAttribute:k=>k==='aria-describedby'&&kind==='aria'?'own-message':null,contains:n=>n===message};
 const message={id:'own-message',ownerDocument:doc,isConnected:true,innerText:text,contains:n=>n===message,matches:s=>kind==='role'&&s.includes('story_message'),closest:s=>s==='[role="article"],article'?card:null,querySelectorAll:()=>[],getBoundingClientRect:()=>({width:600,height:350})};
 card.querySelectorAll=s=>kind==='role'&&s.includes('story_message')?[message]:[];doc.getElementById=k=>k==='own-message'?message:null;
 return{card,message,doc};
}
test('green off-market poster is retained for story-message and exact ARIA message variants',()=>{
 for(const kind of ['role','aria']){const h=posterFixture(kind),nodes=p.textPosterNodes(h.card,id);assert.equal(nodes.length,1,kind);assert.equal(nodes[0].item.posterKey,'poster:'+id);assert(nodes[0].ready());h.message.innerText+=' changed';assert.equal(nodes[0].ready(),false);}
});
test('green poster cannot borrow an external or conflicting ARIA message',()=>{
 const h=posterFixture('aria');h.card.contains=()=>false;assert.equal(p.textPosterNodes(h.card,id).length,0);
});
