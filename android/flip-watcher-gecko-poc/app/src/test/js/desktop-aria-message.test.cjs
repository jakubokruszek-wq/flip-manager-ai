const test=require('node:test'),assert=require('node:assert/strict');
require('../../../../../../extensions/facebook-collector/collector-core.js');
const p=require('../../main/extension/desktop-preview.js');
function fixture(){
 const doc={getElementById:id=>id==='body-text'?message:null};
 const card={ownerDocument:doc,querySelectorAll:()=>[],getAttribute:k=>k==='aria-describedby'?'body-text':null,contains:n=>n===message};
 const message={id:'body-text',ownerDocument:doc,innerText:'Na sprzedaż mieszkanie w Łodzi. 2 pokoje, 42.42m2. Cena 339000 zł.',closest:s=>s==='[role="article"],article'?card:null,querySelector:()=>null,contains:()=>false};
 return{doc,card,message};
}
test('an exact own ARIA description supplies the visible message without generic text fallback',()=>{
 const h=fixture();assert.equal(p.ownMessageText(h.card),h.message.innerText);
 h.card.getAttribute=()=>null;assert.equal(p.ownMessageText(h.card),'');
});
test('ARIA cannot borrow another post, comment, link, hidden message or detached node',()=>{
 for(const kind of ['outside','other-card','comment','shared','link','hidden','detached','foreign-doc','self','invalid-id','many']){
  const h=fixture();
  if(kind==='outside')h.card.contains=()=>false;
  if(kind==='other-card')h.message.closest=s=>s==='[role="article"],article'?{}:null;
  if(['comment','shared','link','hidden'].includes(kind))h.message.closest=s=>s==='[role="article"],article'?h.card:s.includes(kind==='comment'?'role="comment"':kind==='shared'?'shared':kind==='link'?'header':'aria-hidden')?{}:null;
  if(kind==='detached')h.message.isConnected=false;
  if(kind==='foreign-doc')h.message.ownerDocument={};
  if(kind==='self')h.doc.getElementById=()=>h.card;
  if(kind==='invalid-id')h.card.getAttribute=()=> 'bad#id';
  if(kind==='many')h.card.getAttribute=()=>Array.from({length:11},(_,i)=>'body'+i).join(' ');
  assert.equal(p.ownMessageText(h.card),'',kind);
 }
});
test('specific own message markers take priority and ambiguous ARIA references remain empty',()=>{
 const h=fixture(),marked={...h.message,innerText:'Sprzedam mieszkanie 57m2 za 379000 zł'};
 h.card.querySelectorAll=()=>[marked];assert.equal(p.ownMessageText(h.card),marked.innerText);
 h.card.querySelectorAll=()=>[];h.card.getAttribute=()=> 'body-text body-other';const other={...h.message,id:'body-other',innerText:'Sprzedam inne mieszkanie 60m2 za 400000 zł'};
 h.card.contains=n=>n===h.message||n===other;h.doc.getElementById=id=>id==='body-text'?h.message:other;
 assert.equal(p.ownMessageText(h.card),'');
});
