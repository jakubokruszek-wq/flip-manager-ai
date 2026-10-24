/* Only aggregate fixture counters cross this public laboratory bridge. Not a production trust boundary. */
(function(){
  const u=new URL(location.href),nonce=u.searchParams.get('labNonce')||'';
  if(u.hostname!=='127.0.0.1'||u.searchParams.get('fixture')!=='main-world'||!/^[a-f0-9-]{36}$/.test(nonce))return;
  const keys=['fetchIntact','xhrIntact','installed','beforePage','armed','fetchBodies','xhrBodies','bytes','exactIds','duplicates','textRecords','priceSignals','areaSignals','rejected','stopped'];
  const port=browser.runtime.connectNative('mainLab');let pending=null;
  window.addEventListener('message',e=>{
    if(!pending||e.source!==window||e.origin!==u.origin||e.data?.channel!=='MAIN_LAB_COUNTS'||e.data.nonce!==nonce)return;
    const c=e.data.counts;if(!c||Object.keys(c).length!==keys.length||keys.some(k=>!Number.isInteger(c[k])||c[k]<0||c[k]>(k==='bytes'?1048576:2000)))return;
    port.postMessage({type:'mainLabResult',nonce:pending,counts:Object.fromEntries(keys.map(k=>[k,c[k]]))});pending=null;
  });
  port.onMessage.addListener(m=>{if(!m||typeof m.nonce!=='string'||!['read','stop'].includes(m.op))return;pending=m.nonce;window.postMessage({channel:'MAIN_LAB_COMMAND',nonce,op:m.op},u.origin);});
  port.onDisconnect.addListener(()=>{pending=null;window.postMessage({channel:'MAIN_LAB_COMMAND',nonce,op:'stop'},u.origin);});
})();
