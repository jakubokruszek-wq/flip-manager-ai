const test=require('node:test'),assert=require('node:assert/strict');
require('../../../../../../extensions/facebook-collector/collector-core.js');
const p=require('../../main/extension/desktop-preview.js'),f=require('../../main/extension/desktop-fields.js'),reader=require('../../main/extension/profile-reader.js');
const owner='61563667387467',post='pfbidAbCdEf0123456789';
function page(id=owner,canonical='https://www.facebook.com/dawid.test/',current='https://www.facebook.com/profile.php?id='+owner){
 const nodes=[{property:'al:android:url',content:'fb://profile/'+id},{rel:'canonical',href:canonical}].map(data=>({getAttribute:key=>data[key]||null}));
 return {location:{href:current},document:{head:{querySelectorAll:()=>nodes}}};
}
test('numeric profile ownership must be proved independently before accepting vanity post links',()=>{
 const proof=reader.identity(page(),owner);assert.ok(proof);assert.equal(reader.link('https://www.facebook.com/dawid.test/posts/'+post+'/',proof),post);
 assert.equal(reader.identity(page('100008036582269'),owner),null);
 assert.equal(reader.identity(page(owner,undefined,'https://www.facebook.com/100008036582269/'),owner),null);
 assert.equal(reader.identity(page(owner,'https://www.facebook.com/profile.php?id=100008036582269'),owner),null);
 assert.equal(reader.identity(page(owner,'https://www.facebook.com/groups/123456/'),owner),null);
});
test('foreign profiles, group posts and comment URLs never become own posts',()=>{
 const proof=reader.identity(page(),owner);
 for(const url of ['https://www.facebook.com/foreign/posts/'+post+'/', 'https://www.facebook.com/groups/'+owner+'/posts/123456/', 'https://www.facebook.com/dawid.test/posts/'+post+'/?comment_id=42'])assert.equal(reader.link(url,proof),null);
 const card=links=>({querySelectorAll:()=>links.map(href=>({href}))});
 assert.equal(reader.onePost(card(['https://www.facebook.com/dawid.test/posts/'+post+'/']),proof),post);
 assert.equal(reader.onePost(card(['https://www.facebook.com/dawid.test/posts/'+post+'/','https://www.facebook.com/dawid.test/posts/'+post+'/?comment_id=42']),proof),post);
 assert.equal(reader.onePost(card(['https://www.facebook.com/dawid.test/posts/'+post+'/','https://www.facebook.com/foreign/posts/123456/']),proof),null);
});
test('profile OCR preserves actual profile URL and selected fields without returning raw text',()=>{
 const text='ŁÓDŹ (ul.Łagiewnicka/Goplańska) 62,4M2 - 3/3piętro z balkonem - do remontu, niski blok z 2000r. Cena 368K - chętni?';
 const message={consent:true,nonce:'12345678-1234-1234-1234-123456789012',sourceId:owner,postId:post,texts:[text]};
 const result=reader.ocr(message,f,p),row=result.rows[0];
 assert.equal(result.status,'OK');assert.equal(row.price,368000);assert.equal(row.area,62.4);assert.equal(row.rooms,null);assert.equal(row.intent,'SELL_PROPERTY');assert.equal(row.usable,true);
 assert.equal(row.permalink,`https://www.facebook.com/${owner}/posts/${post}/`);assert(!JSON.stringify(result).includes(text));
 const conflict=reader.ocr({...message,texts:['Sprzedam mieszkanie Łódź 42m2 cena 319000 zł','Sprzedam mieszkanie Łódź 42m2 cena 499000 zł']},f,p).rows[0];assert.equal(conflict.usable,false);assert.equal(conflict.qualification,'CONFLICT');
 const foreign=reader.ocr({...message,texts:['Sprzedam mieszkanie Warszawa 42m2 cena 319000 zł']},f,p).rows[0];assert.equal(foreign.usable,false);
});

test('cold native frame gets one bounded retry while identity and geometry remain exact',async()=>{
 let calls=0,commits=0;const request=async m=>{if(m.action==='photos')return {accepted:++calls===2,requestId:'frame'};if(m.action==='commit'){commits++;return {accepted:true,count:1};}};
 assert.equal(await reader.capturePhoto(request,{action:'photos'},()=>true,async()=>{},()=>true),true);assert.equal(calls,2);assert.equal(commits,1);
 let valid=true;const sent=[];const changed=async m=>{sent.push(m.action);if(m.action==='photos'){valid=false;return {accepted:true,requestId:'frame'};}return {accepted:true,count:1};};
 assert.equal(await reader.capturePhoto(changed,{action:'photos'},()=>valid,async()=>{},()=>true),false);assert.deepEqual(sent,['photos','drop']);
});
