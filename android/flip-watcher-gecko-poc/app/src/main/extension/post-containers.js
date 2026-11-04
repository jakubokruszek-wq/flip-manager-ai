/* Only bounded, explicitly delimited Facebook feed units. Identity still requires exact post links. */
(function(root){'use strict';
const article='[role="article"],article',unit='[data-pagelet^="FeedUnit_"],[data-testid="post_container"]';
function owner(n){return n?.closest?.(article)||n?.closest?.(unit)||null;}
function list(doc){
 const articles=Array.from(doc.querySelectorAll(article));
 if(articles.length>100)return articles.slice(0,101);
 const units=Array.from(doc.querySelectorAll(unit)).filter(n=>!articles.includes(n)&&!n.querySelector?.(article));
 return [...articles,...units].filter((n,i,a)=>a.indexOf(n)===i&&!owner(n.parentElement)).slice(0,101);
}
const api={owner,list};if(typeof module!=='undefined')module.exports=api;root.FlipPostContainers=api;
})(globalThis);
