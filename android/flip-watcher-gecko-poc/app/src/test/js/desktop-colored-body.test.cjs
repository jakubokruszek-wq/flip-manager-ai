const test=require('node:test'),assert=require('node:assert/strict');
require('../../../../../../extensions/facebook-collector/collector-core.js');
const fields=require('../../main/extension/desktop-fields.js'),p=require('../../main/extension/desktop-preview.js');
const group='1234567890123',id='1655103482946831',url=`https://www.facebook.com/groups/${group}/posts/${id}/`;
const text='OFF-MARKET!\nsprzedam mieszkanie\n37,64m2 Łódź Tatrzańska\n66/68\n260000zł';
function fixture(marked=false){
 const doc={},rect={left:10,top:100,right:610,bottom:450,width:600,height:350};let blocked=false,painted=true;
 const card={ownerDocument:doc,isConnected:true,parentElement:null,getAttribute:()=>null,contains:n=>n===panel||n===message};
 const closest=s=>s==='[role="article"],article'?card:blocked&&s.includes('role="comment"')?{}:null;
 const panel={ownerDocument:doc,parentElement:card,isConnected:true,innerText:text,textContent:text,tagName:'DIV',closest,contains:n=>n===panel||n===message,matches:()=>false,querySelector:s=>marked&&s===p.messageSelector?message:null,querySelectorAll:s=>s==='[dir="auto"]'?[message]:s==='span,div,p'?[message]:[],getBoundingClientRect:()=>({...rect})};
 const message={...panel,parentElement:panel,innerText:text,textContent:text,contains:n=>n===message,matches:s=>marked&&s===p.messageSelector,querySelector:()=>null,querySelectorAll:()=>[],getBoundingClientRect:()=>({...rect})};
 const anchor={href:url,closest:()=>card};
 card.querySelectorAll=s=>s==='a[href]'?[anchor]:s==='[dir="auto"]'?[message]:marked&&s.includes('data-ad-preview')?[message]:[];
 doc.defaultView={getComputedStyle:n=>({display:'block',visibility:'visible',opacity:'1',fontSize:'32px',backgroundImage:'none',backgroundColor:n===panel&&painted?'rgb(0,128,105)':'rgba(0, 0, 0, 0)'})};
 return{card,panel,message,anchor,doc,block:()=>blocked=true,unpaint:()=>painted=false};
}
test('own unmarked painted sale panel keeps original text, exact fields and a genuine poster target',()=>{
 const h=fixture();assert.equal(p.ownMessageText(h.card),text);
 const posters=p.textPosterNodes(h.card,id);assert.equal(posters.length,1);assert.equal(posters[0].node,h.panel);assert(posters[0].ready());
 const m=p.createModel(globalThis.FlipFacebookCollectorCore,fields,group,true);m.add({postId:id,permalink:url,text:p.ownMessageText(h.card),media:posters.map(x=>x.item)},'DOM');
 const row=m.rows()[0];assert.equal(row.price,260000);assert.equal(row.area,37.64);assert.equal(row.intent,'SELL_PROPERTY');assert.equal(row.street,'Tatrzańska 66/68');assert.equal(m.postTexts()[0].text,text);
 h.panel.innerText+=' changed';assert.equal(posters[0].ready(),false);
});
test('CSS-painted ancestor of an ordinary message marker is a valid text poster',()=>{
 const h=fixture(true);assert.equal(p.ownMessageText(h.card),text);const posters=p.textPosterNodes(h.card,id);assert.equal(posters.length,1);assert.equal(posters[0].node,h.panel);
});
test('unmarked fallback rejects ambiguous post identity, comments, unpainted text and non-sale panels',()=>{
 for(const kind of ['foreign','comment','plain','rental','search','detached','multi']){
  const h=fixture();if(kind==='foreign')h.anchor.href='https://www.facebook.com/profile.php?id=123456789';
  if(kind==='comment')h.block();if(kind==='plain')h.unpaint();if(kind==='detached')h.panel.isConnected=false;
  if(kind==='rental'||kind==='search'){const t=kind==='rental'?'Wynajmę mieszkanie 37,64m2 Łódź za 260000 zł':'Kupię mieszkanie 37,64m2 Łódź budżet 260000 zł';h.panel.innerText=t;h.message.innerText=t;}
  if(kind==='multi'){const get=h.card.querySelectorAll;h.card.querySelectorAll=s=>s==='a[href]'?[h.anchor,{...h.anchor,href:url.replace(id,'1655103482946839')}]:get(s);}
  assert.equal(p.ownMessageText(h.card),'',kind);assert.equal(p.textPosterNodes(h.card,id).length,0,kind);
 }
});

test('a clickable standalone coloured panel is captured without clicking it',()=>{
 const h=fixture();const closest=h.panel.closest;
 h.panel.closest=s=>s.includes('[role="button"]')?h.panel:closest(s);
 assert.equal(p.ownMessageText(h.card),text);assert.equal(p.textPosterNodes(h.card,id).length,1);
});
