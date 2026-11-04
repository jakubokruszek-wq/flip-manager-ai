const test=require('node:test'),assert=require('node:assert/strict'),c=require('../../main/extension/post-containers.js');
test('feed unit with no article can be an owner but nested articles remain the owner',()=>{
 const article={},unit={querySelector:()=>null,parentElement:null};
 const node={closest:s=>s.includes('role="article"')?null:unit};assert.equal(c.owner(node),unit);
 node.closest=s=>s.includes('role="article"')?article:unit;assert.equal(c.owner(node),article);
 const doc={querySelectorAll:s=>s.includes('role="article"')?[]:[unit]};assert.deepEqual(c.list(doc),[unit]);
 unit.querySelector=()=>article;doc.querySelectorAll=s=>s.includes('role="article"')?[article]:[unit];assert.deepEqual(c.list(doc),[article]);
});

test('semantic article inside FeedUnit remains listed and outer wrapper cannot own its text',()=>{
 const unit={querySelector:()=>article,closest:s=>s.includes('role="article"')?null:unit,parentElement:null};
 const article={parentElement:unit};
 const doc={querySelectorAll:s=>s.includes('role="article"')?[article]:[unit]};
 assert.equal(c.owner(unit),null);assert.deepEqual(c.list(doc),[article]);
});
