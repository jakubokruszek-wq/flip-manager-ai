/* Isolated-world consent/context and bounded adaptive scrolling for MAIN transport. */
(function(scope){
  'use strict';
  async function run(w,m,safe,send,setAbort){
    const stopped=()=>({status:'STOP',counts:null});
    if(m.consent!==true||!safe(m))return stopped();
    let invalid=false,wake,dispose=null;const cancelled=new Promise(r=>{wake=r;});
    const wait=Math.max(1000,Math.min(20000,Number(m.windowMs)||20000)),end=w.performance.now()+wait;
    const abort=()=>{if(invalid)return;invalid=true;wake();void send({type:'stopMainTransport',nonce:m.nonce}).catch(()=>{});};
    setAbort(abort);let steps=0,moves=0;
    const pause=ms=>Promise.race([new Promise(r=>w.setTimeout(r,ms)),cancelled]);
    const state=async()=>{
      if(invalid||!safe(m)||w.performance.now()>=end)return false;
      const context=await send({type:'mainTransportContext',nonce:m.nonce});
      return !invalid&&safe(m)&&w.performance.now()<end&&context?.active===true;
    };
    try{
      const armed=await send({type:'startMainTransport',consent:true,nonce:m.nonce,groupId:m.groupId,fixture:m.allowLoopback===true,windowMs:wait});
      if(armed?.status!=='ARMED')return armed||stopped();
      dispose=w.FlipVisiblePosts.watch(w,m,abort);
      if(invalid||!safe(m)){abort();return stopped();}
      if(m.autoScrollConsent===true){
        await pause(1000);
        for(let i=0;i<5;i++){
          if(!await state()){if(w.performance.now()>=end)break;abort();return stopped();}
          const doc=w.document;
          const candidates=[doc.scrollingElement,...doc.querySelectorAll('[role="feed"], [data-pagelet*="Feed"]')].filter(n=>n&&n.clientHeight>0&&n.scrollHeight>n.clientHeight);
          const container=candidates.sort((a,b)=>b.scrollHeight-a.scrollHeight)[0]||doc.scrollingElement;
          if(!container)break;
          const root=container===doc.scrollingElement;
          const before=root?w.scrollY:container.scrollTop;
          const height=container.scrollHeight;
          const top=Math.max(400,Math.min(900,Math.round((root?w.innerHeight:container.clientHeight)*0.85)));
          if(root)w.scrollBy({left:0,top,behavior:'instant'});else container.scrollBy({left:0,top,behavior:'instant'});
          steps++;if((root?w.scrollY:container.scrollTop)!==before)moves++;
          // Desktop-style 100ms polls, 4 stable samples; never more than 1.6s.
          let stable=0,last=container.scrollHeight;
          for(let poll=0;poll<16&&w.performance.now()<end;poll++){
            await pause(100);if(invalid||!safe(m)){abort();return stopped();}
            const current=container.scrollHeight;
            if(current>height)break;
            stable=current===last?stable+1:0;last=current;if(stable>=4)break;
          }
        }
      }
      await pause(Math.max(0,end-w.performance.now()));
      if(invalid||!safe(m)){abort();return stopped();}
      const result=await Promise.race([send({type:'readMainTransport',nonce:m.nonce}),cancelled.then(()=>null)]);
      if(invalid||!safe(m)){abort();return stopped();}
      if(result?.status==='OK'&&result.counts){result.counts.scrollSteps=steps;result.counts.scrollMoves=moves;}
      return result||stopped();
    }catch{return stopped();}
    finally{setAbort(null);if(dispose)dispose();void send({type:'stopMainTransport',nonce:m.nonce}).catch(()=>{});}
  }
  const exported={run};if(typeof module!=='undefined')module.exports=exported;scope.FlipMainContent=exported;
})(globalThis);
