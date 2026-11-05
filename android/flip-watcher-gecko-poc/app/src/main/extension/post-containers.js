/* Only bounded, explicitly delimited Facebook feed units. Identity still requires exact post links. */
(function(root){'use strict';
const article='[role="article"],article',unit='[data-pagelet^="FeedUnit_"],[data-testid="post_container"]';
// Facebook can put only the header in an article and the own message beside it.
// Use the surrounding named feed unit only with one exact post identity across it.
function completeUnit(n){
 const core=root.FlipFacebookCollectorCore;if(!n?.querySelectorAll||!core)return false;
 const anchors=n.querySelectorAll('a[href]');if(anchors.length>100)return false;
 const links=Array.from(anchors).map(a=>core.parsePostLink(a.href,core.canonicalSource(a.href))).filter(Boolean);
 return links.length>0&&links.every(p=>p.sourceType==='GROUP')&&new Set(links.map(p=>p.sourceId+'/'+p.postId)).size===1;
}
function owner(n){const enclosing=n?.closest?.(unit);if(completeUnit(enclosing))return enclosing;const semantic=n?.closest?.(article);if(semantic)return semantic;const candidate=n?.closest?.(unit);return candidate&&!candidate.querySelector?.(article)?candidate:null;}
function list(doc){
 const articles=Array.from(doc.querySelectorAll(article));
 if(articles.length>100)return articles.slice(0,101);
 const units=Array.from(doc.querySelectorAll(unit)).filter(n=>!articles.includes(n)&&(completeUnit(n)||!n.querySelector?.(article)));
 return [...articles,...units].filter((n,i,a)=>a.indexOf(n)===i&&!owner(n.parentElement)).slice(0,101);
}
const api={owner,list,completeUnit};if(typeof module!=='undefined')module.exports=api;root.FlipPostContainers=api;
})(globalThis);
