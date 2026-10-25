const test=require('node:test'),assert=require('node:assert/strict');
require('../../../../../../extensions/facebook-collector/collector-core.js');
const core=globalThis.FlipFacebookCollectorCore,p=require('../../main/extension/desktop-preview.js');
const group='lodzsprzedazzakupwynajem',id='550000000000091',other='550000000000092',mid='880000000000001';
const link=n=>`https://www.facebook.com/groups/${group}/posts/${n}/`;
const source={sourceType:'GROUP',sourceId:group,sourceUrl:`https://www.facebook.com/groups/${group}/`,allowGroupRedirect:false};
const photo=()=>({__typename:'Photo',id:mid,image:{uri:'https://scontent.fbcdn.net/small.jpg?signed=PRIVATE'},viewer_image:{uri:'https://scontent.fbcdn.net/large.jpg?x=PRIVATE'}});
const story=(attachments)=>({__typename:'Story',id,url:link(id),message:{text:'Sprzedam mieszkanie 42m2 za 319000 zł.'},attachments});
const supplement=n=>{const body=JSON.stringify(n),r=core.extractStructuredRecordsFromText(body,'NETWORK',source);return p.networkMedia(r,body,source,core);};
test('typed Photo id and distinct rendition URLs survive only as media evidence',()=>{
 const n=story([{media:photo()}]),old=core.extractStructuredRecordsFromText(JSON.stringify(n),'NETWORK',source);
 assert(old[0].media.every(m=>m.mediaId!==mid));const rows=supplement(n),m=p.createModel(core,globalThis.FlipDesktopFields||require('../../main/extension/desktop-fields.js'),group);
 m.add(rows[0],'NETWORK');const binding=m.mediaBindings()[0];assert(binding.ids.includes(mid));assert(binding.urls.includes('https://scontent.fbcdn.net/large.jpg'));
 assert(!JSON.stringify(binding).includes('PRIVATE'));assert.equal(rows[0].postId,id);assert.equal(rows[0].text,old[0].text);
});
test('deep own attachment paths beyond the old seven levels retain exact ownership',()=>{
 let a={media:photo()};for(let i=0;i<9;i++)a={styles:a};const rows=supplement(story([a]));assert(rows[0].media.some(m=>m.mediaId===mid&&m.exactPostId===id));
});
test('supplement refuses borrowed stories profiles comments video and foreign owners',()=>{
 for(const key of ['shared_story','quoted_story','original_story','crosspost','actor','owner','profile','avatar','comments','feedback','video']){
  const n=story([{[key]:{media:photo()}}]);assert(!supplement(n)[0].media.some(m=>m.mediaId===mid),key);
 }
 for(const child of [{__typename:'Story',id:other,url:link(other),attachments:[{media:photo()}]},{__typename:'Story',id,url:`https://www.facebook.com/groups/foreign/posts/${id}/`,attachments:[{media:photo()}]}])assert(!supplement(story([child]))[0].media.some(m=>m.mediaId===mid));
});
test('no direct exact permalink or Photo type means no supplementary ownership',()=>{
 for(const change of [n=>delete n.url,n=>n.url=`https://www.facebook.com/groups/foreign/posts/${id}/`,n=>n.attachments[0].media.__typename='User',n=>n.attachments[0].media.id='pfbidNOT_EXACT']){
  const n=story([{media:photo()}]);change(n);const records=[{postId:id,permalink:link(id),media:[]}];assert.equal(p.networkMedia(records,JSON.stringify(n),source,core)[0].media.length,0);
 }
});
test('newline and guarded JSON use same bounded parser without retaining bodies',()=>{
 const n=story([{media:photo()}]),body=JSON.stringify(n),records=core.extractStructuredRecordsFromText(body,'NETWORK',source);
 for(const b of [body,'for (;;);'+body,'{}\n'+body])assert(p.networkMedia(records,b,source,core)[0].media.some(m=>m.mediaId===mid));
 assert.deepEqual(p.networkMedia(records,'x'.repeat(2097153),source,core),records);
 let deep={media:photo()};for(let i=0;i<30;i++)deep={styles:deep};assert(!supplement(story([deep]))[0].media.some(m=>m.mediaId===mid));
});

test('conflicting IDs and typed video or profile ancestry fail closed',()=>{
 for(const media of [{...photo(),photo_id:'880000000000002'},{__typename:'Video',child:photo()},{__typename:'User',child:photo()}])assert(!supplement(story([{media}]))[0].media.some(m=>m.mediaId===mid));
 const n=story([{media:photo()}]);n.story_id=other;const records=[{postId:id,permalink:link(id),media:[]}];assert.equal(p.networkMedia(records,JSON.stringify(n),source,core)[0].media.length,0);
});

test('opaque or missing nested story identity and generic foreign permalinks cannot inherit an owner',()=>{
 for(const child of [{__typename:'Story',id:'opaque',url:link(other),attachments:[{media:photo()}]},{__typename:'Story',attachments:[{media:photo()}]},{url:`https://www.facebook.com/groups/foreign/posts/${other}/`,media:photo()},{url:link(other),media:photo()}]){
 const n=story([{target:child}]);const records=[{postId:id,permalink:link(id),media:[]}];assert.equal(p.networkMedia(records,JSON.stringify(n),source,core)[0].media.length,0);
 }
});
