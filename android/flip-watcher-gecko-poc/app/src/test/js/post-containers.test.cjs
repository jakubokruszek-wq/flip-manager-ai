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

require('../../../../../../extensions/facebook-collector/collector-core.js');
test('one exact feed-unit post joins an article-only header to its own sibling message',()=>{
 const unit={querySelectorAll:()=>[{href:'https://www.facebook.com/groups/123456789/posts/1234567890123/'}],querySelector:()=>article,closest:s=>s.includes('role="article"')?null:unit,parentElement:null};
 const article={parentElement:unit};const text={closest:s=>s.includes('role="article"')?null:unit};
 const doc={querySelectorAll:s=>s.includes('role="article"')?[article]:[unit]};
 assert.equal(c.owner(text),unit);assert.equal(c.owner(unit),unit);assert.deepEqual(c.list(doc),[unit]);
 unit.querySelectorAll=()=>[{href:'https://www.facebook.com/groups/123456789/posts/1234567890123/'},{href:'https://www.facebook.com/groups/123456789/posts/1234567890124/'}];
 assert.equal(c.completeUnit(unit),false);assert.equal(c.owner(unit),null);assert.deepEqual(c.list(doc),[article]);
 unit.querySelectorAll=()=>[{href:'https://www.facebook.com/groups/123456789/posts/1234567890123/'},{href:'https://www.facebook.com/another.person/posts/1234567890125/'}];
 assert.equal(c.completeUnit(unit),false,'foreign profile quotes cannot be absorbed into the group post');
});
