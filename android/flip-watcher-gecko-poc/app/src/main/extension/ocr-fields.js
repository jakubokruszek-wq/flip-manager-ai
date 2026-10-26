/* Isolated extension background only. OCR strings are transient; output is selected fields. */
(function(root){'use strict';
function create(){const used=new Set();return{project(m,core,fields,preview){
 const stop=()=>({type:'ocrFieldsResult',status:'STOP',reason:'CONTEXT',rows:[],stats:preview.zero()});
 if(m?.consent!==true||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(m.nonce||'')||used.has(m.nonce)||m.groupId!=='lodzsprzedazzakupwynajem'||!/^\d{5,30}$/.test(m.postId||'')||!Array.isArray(m.texts)||m.texts.length<1||m.texts.length>3||m.texts.some(t=>typeof t!=='string'||!t.trim()||t.length>12000)||m.texts.reduce((n,t)=>n+t.length,0)>24000)return stop();
 used.add(m.nonce);while(used.size>32)used.delete(used.values().next().value);
 const model=preview.createModel(core,fields,m.groupId);
 try{for(const original of m.texts){
  // Explicit plural area unit only; do not reinterpret distances "metry od/do" or guess digits.
  const text=original.replace(/(\d+(?:[.,]\d+)?)\s+metr(?:y|ów|ow)\b(?!\s+(?:od|do)\b)/giu,'$1 m2').replace(/(\d)\s*m\s*2\b/giu,'$1 m²').replace(/\/\s*m\s*2\b/giu,'/m²').replace(/\bcena\s*:?\s*(?=\d[\d .,]*\s*(?:zł|zl|pln)\s*\/\s*m[²2](?![0-9]))/giu,'');
  model.add({postId:m.postId,permalink:'https://www.facebook.com/groups/'+m.groupId+'/posts/'+m.postId+'/',text,media:[]},'DOM');
 }
 const rows=model.rows(),stats=preview.zero();
 const evidence=m.texts.join('\n');
 for(const r of rows){
  if(!/\b(?:[1-9]|1[0-9]|20)\s*[-–]?\s*poko[ji]/iu.test(evidence))r.rooms=null;
  if(!/\d(?:[.,]\d+)?\s*m\s*[²2]|\d(?:[.,]\d+)?\s+metr(?:y|ów|ow)\b(?!\s+(?:od|do)\b)/iu.test(evidence))r.area=null;
  if(r.price===null&&r.area===null&&r.rooms===null&&r.qualification==='CANDIDATE')r.qualification='MISSING_FIELDS';
 }
 stats.verified=1;stats.candidates=rows.length;
 return{type:'ocrFieldsResult',status:'OK',reason:'DONE',rows,stats};
 }finally{model.clear();}
}};}
const api={create};if(typeof module!=='undefined')module.exports=api;root.FlipOcrFields=api;
})(globalThis);
