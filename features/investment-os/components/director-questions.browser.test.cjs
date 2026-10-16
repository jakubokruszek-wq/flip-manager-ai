/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { addOperatorSessionCookie, ensureProductionBuild, startFakeSupabaseAuthServer } = require('../../test-support/browser-auth.cjs');
async function freePort() { return new Promise((resolve,reject) => { const s=net.createServer(); s.on('error',reject); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));}); }); }
test('mobile: answer 260k, save, reanalyze, reload, renovation 100k, legal remains conditional', {timeout:180000},async(t)=>{
  const {lodzDeal}=await import('../test-fixtures/lodz-deals.ts');
  const {buildCanonicalDeal}=await import('../engine.ts');
  const {buildDealBrain}=await import('../brain/index.ts');
  const {mergeAnswers,answerOverrides,parseAnswerCommand,affectedDirectors}=await import('../deal-room-answers.ts');
  const input=lodzDeal("UNCLEAR_RENOVATION"); let current=buildCanonicalDeal(input);
  let room={version:1,answers:{},baselineOverrides:{},rounds:[]}; const receipts=new Map();
  const root=path.resolve(__dirname,'../../..'), auth=await startFakeSupabaseAuthServer();t.after(()=>auth.server.close());
  const env={...process.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',NEXT_PUBLIC_SUPABASE_URL:auth.url,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'isolated-ui-only',SUPABASE_SERVICE_ROLE_KEY:'isolated-ui-only',DEAL_ROOM_TEST_ENABLED:'true',DEAL_ROOM_TEST_STORAGE_VERSION:'1',DEAL_ROOM_QA_ENABLED:'true',DEAL_ROOM_TEST_OPERATOR_IDS:'44444444-4444-4444-8444-444444444444',DEAL_ROOM_TEST_DATABASE_ORIGIN:auth.url};
  const nextBin=require.resolve('next/dist/bin/next'); await ensureProductionBuild(nextBin,root,env);
  const port=await freePort(), base=`http://127.0.0.1:${port}`;
  const server=spawn(process.execPath,[nextBin,'start','--hostname','127.0.0.1','--port',String(port)],{cwd:root,env,stdio:'ignore'});t.after(()=>server.kill());
  for(let i=0;i<120;i++){try{if((await fetch(base+'/login')).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844}});await addOperatorSessionCookie(page.context(),base);
  // Transport/persistence fixture only. Actual PostgreSQL CAS/RLS is exercised in the separate postgres job.
  await page.route('**/api/**',async route=>{
    const req=route.request(), url=new URL(req.url()); let body;
    if(url.pathname.endsWith('/investment/answers')){
      if(req.method()==='GET')body={enabled:true,room};
      else {
        const cmd=parseAnswerCommand(req.postDataJSON());
        if(receipts.has(cmd.requestId)) body=receipts.get(cmd.requestId);
        else {
          assert.equal(cmd.expectedVersion,room.version);
          const before=current, answers=mergeAnswers(current,room,cmd,'33333333-3333-4333-8333-333333333333',input.now);
          current=buildCanonicalDeal({...input,overrides:answerOverrides(current,room.baselineOverrides,answers)});
          room={...room,version:room.version+1,answers,rounds:[{requestId:cmd.requestId,savedAt:input.now,actorId:'synthetic',changedFields:cmd.answers.map(a=>a.field),invalidated:affectedDirectors(cmd.answers.map(a=>a.field)),before:buildDealBrain(before),after:buildDealBrain(current)}]};
          body={ok:true,deal:current,room};receipts.set(cmd.requestId,body);
        }
      }
    } else if(url.pathname.endsWith('/investment/history')) body={rounds:room.rounds.map(r=>({requestId:r.requestId,createdAt:r.savedAt,changedFields:r.changedFields,beforeProfit:r.before.financials?.profitBase??null,afterProfit:r.after.financials?.profitBase??null,recommendation:r.after.ceo.reasoningSummary})),nextBefore:null};
    else if(url.pathname.endsWith('/investment')) body={ok:true,deal:current,media:[]};
    else body={ok:true};
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(base+'/flip-finder');
  await page.getByRole('heading',{name:'Deal Room 2.0 · TEST',exact:true}).waitFor();
  await page.getByRole('button',{name:'Przygotuj / wznów testy',exact:true}).click();
  await page.getByRole('link',{name:'Otwórz Deal Room TEST',exact:true}).first().waitFor();
  assert.equal(await page.getByRole('link',{name:'Otwórz Deal Room TEST',exact:true}).count(),3);
  assert.match(await page.getByRole('link',{name:'Otwórz Deal Room TEST',exact:true}).first().getAttribute('href'),/^\/deals\/deadbeef-/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'test Finder stays within mobile viewport');
  await page.goto(base+`/deals/${input.listing.id}`);
  await page.getByRole('heading',{name:'Dyrektorzy pytają Ciebie'}).waitFor();
  const before=current.underwriting.result.profitBase;
  const more=page.getByRole('button',{name:/Pozostałe pytania/});if(await more.count())await more.click();
  await page.getByLabel('Odpowiedź: negotiatedPrice',{exact:true}).fill('260000');
  await page.getByRole('button',{name:'Zapisz odpowiedzi i przelicz'}).click();
  await page.getByRole('heading',{name:'Co zmieniły odpowiedzi?'}).waitFor();
  await page.getByRole('button',{name:'Wczytaj / odśwież historię'}).click();
  await page.getByLabel('Historia analiz',{exact:true}).getByText(/Zmienione pola: negotiatedPrice/).waitFor();
  assert.equal(current.underwriting.result.purchasePrice,260000);assert.ok(current.underwriting.result.profitBase>before);
  await page.reload();await page.getByRole('heading',{name:'Co zmieniły odpowiedzi?'}).waitFor();
  assert.equal(room.answers.negotiatedPrice.value,260000);
  const max=current.underwriting.result.maxPurchasePrice;
  assert.ok(current.underwriting.result.renovationTotal<100000, "fixture starts below the new 100k quote");
  const moreAgain=page.getByRole('button',{name:/Pozostałe pytania/});if(await moreAgain.count())await moreAgain.click();
  await page.getByLabel('Odpowiedź: renovationBudget',{exact:true}).fill('100000');
  await page.getByRole('button',{name:'Zapisz odpowiedzi i przelicz'}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Rekomendacja przed i po odpowiedziach"]')?.textContent.includes('renovationBudget'));
  assert.equal(current.underwriting.result.renovationTotal,100000);assert.ok(current.underwriting.result.maxPurchasePrice<max);assert.notEqual(current.ceo.result.action,'KUP');
  assert.ok(await page.getByRole('region',{name:'Rekomendacja przed i po odpowiedziach'}).count() || await page.locator('[aria-label="Rekomendacja przed i po odpowiedziach"]').count());
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  process.env.DEAL_ROOM_CFO_ENABLED='true';t.after(()=>delete process.env.DEAL_ROOM_CFO_ENABLED);
  current=buildCanonicalDeal({...input,overrides:answerOverrides(current,room.baselineOverrides,room.answers)});
  await page.reload();await page.getByRole('heading',{name:'Dyrektorzy pytają Ciebie'}).waitFor();
  const cfoMore=page.getByRole('button',{name:/Pozostałe pytania/});if(await cfoMore.count())await cfoMore.click();
  for(const [field,value] of Object.entries({costScope:'BRUTTO',financingMode:'CASH',equity:'500000',liquidityReserve:'30000',deposit:'20000',renovationMonths:'3',equipment:'0'}))await page.getByLabel(`Odpowiedź: ${field}`,{exact:true}).fill(value);
  await page.getByRole('button',{name:'Zapisz odpowiedzi i przelicz'}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Rekomendacja przed i po odpowiedziach"]')?.textContent.includes('equity'));
  assert.equal(current.underwriting.result.cfo.selected.mode,'CASH');assert.equal(current.ceo.result.action,'HOLD / ZBIERZ DANE');
  await page.reload();await page.getByRole('tab',{name:'Finanse',exact:true}).click();await page.getByRole('heading',{name:'CFO — płynność i finansowanie'}).waitFor();
  assert.equal(room.answers.equity.value,500000);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  process.env.DEAL_ROOM_TAX_REVIEW_ENABLED='true';t.after(()=>delete process.env.DEAL_ROOM_TAX_REVIEW_ENABLED);
  current=buildCanonicalDeal({...input,overrides:answerOverrides(current,room.baselineOverrides,room.answers)});
  await page.reload();await page.getByRole('heading',{name:'Dyrektorzy pytają Ciebie'}).waitFor();
  const taxMore=page.getByRole('button',{name:/Pozostałe pytania/});if(await taxMore.count())await taxMore.click();
  await page.getByLabel('Odpowiedź: taxScenario',{exact:true}).fill('JDG');await page.getByRole('button',{name:'Zapisz odpowiedzi i przelicz'}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Rekomendacja przed i po odpowiedziach"]')?.textContent.includes('taxScenario'));
  await page.reload();await page.getByRole('tab',{name:'Finanse',exact:true}).click();await page.getByRole('heading',{name:'Podatki — nieustalone'}).waitFor();assert.equal(room.answers.taxScenario.value,'JDG');assert.equal(current.underwriting.result.cfo.netProfit,null);assert.equal(current.ceo.result.action,'HOLD / ZBIERZ DANE');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  process.env.DEAL_ROOM_TAX_ARITHMETIC_ENABLED='true';t.after(()=>delete process.env.DEAL_ROOM_TAX_ARITHMETIC_ENABLED);
  current=buildCanonicalDeal({...input,overrides:answerOverrides(current,room.baselineOverrides,room.answers)});
  const taxLedgerBefore=JSON.stringify(current.underwriting.result.cfo.selected.months);
  for(const fields of [
    {taxAcquiredOn:'2026-01-01',taxSaleOn:'2026-10-16',taxActivity:'Syntetyczny scenariusz do kwalifikacji',taxVatStatus:'Nieustalone — brak prawa do automatycznego odliczenia',taxCosts:'Odrębna podstawa do sprawdzenia'},
    {taxOtherIncome:'Wpływ nieustalony',taxEvidence:'Źródła Sejm w dokumentacji, kwalifikacja niepotwierdzona',taxRule:'JDG_LINEAR19',taxRuleBase:'100000.00'}
  ]) {
    await page.reload();await page.getByRole('heading',{name:'Dyrektorzy pytają Ciebie'}).waitFor();
    const moreTax=page.getByRole('button',{name:/Pozostałe pytania/});if(await moreTax.count())await moreTax.click();
    for(const [field,value] of Object.entries(fields))await page.getByLabel(`Odpowiedź: ${field}`,{exact:true}).fill(value);
    const version=room.version;await page.getByRole('button',{name:'Zapisz odpowiedzi i przelicz'}).click();
    for(let i=0;i<100 && room.version===version;i++)await page.waitForTimeout(50);
    assert.equal(room.version,version+1);
  }
  await page.reload();await page.getByRole('tab',{name:'Finanse',exact:true}).click();
  await page.getByText(/Wyłącznie warunkowa arytmetyka: JDG_LINEAR19/).waitFor();
  assert.equal(room.answers.taxRuleBase.value,'100000.00');assert.equal(current.underwriting.result.cfo.taxReview.conditional.amountPLN,19000);
  assert.equal(current.underwriting.result.cfo.taxReview.conditional.actualLiabilityPLN,null);assert.equal(current.underwriting.result.cfo.netProfit,null);assert.equal(current.ceo.result.action,'HOLD / ZBIERZ DANE');
  assert.equal(JSON.stringify(current.underwriting.result.cfo.selected.months),taxLedgerBefore);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  process.env.DEAL_ROOM_PRIVATE_TAX_ENABLED='true';t.after(()=>delete process.env.DEAL_ROOM_PRIVATE_TAX_ENABLED);
  current=buildCanonicalDeal({...input,overrides:answerOverrides(current,room.baselineOverrides,room.answers)});
  await page.reload();await page.getByText('Zapisane odpowiedzi — edycja i cofnięcie',{exact:true}).click();
  for(const [field,value] of Object.entries({taxScenario:'PRIVATE',taxAcquiredOn:'2026-04-01',taxSaleOn:'2026-10-01'})) {
    await page.locator('details article').filter({has:page.locator('strong',{hasText:new RegExp('^'+field+'$')})}).getByRole('button',{name:'Edytuj',exact:true}).click();
    await page.getByLabel(`Odpowiedź: ${field}`,{exact:true}).fill(value);
  }
  const privateVersion=room.version;await page.getByRole('button',{name:'Zapisz odpowiedzi i przelicz'}).click();
  for(let i=0;i<100&&room.version===privateVersion;i++)await page.waitForTimeout(50);assert.equal(room.version,privateVersion+1);
  for(const fields of [
    {privateActivity:'NON_BUSINESS',privateTitle:'PAID_SOLE_OWNER',privateVat:'OUTSIDE_VAT_NO_DEDUCTION',privateExclusions:'STANDARD_ONLY',privatePcc:'STANDARD_MARKET_PRICE'},
    {privateSaleMarket:'MARKET_PRICE',privateCostEvidence:'DOCUMENTED',privateAcquisitionFees:'0',privateImprovements:'0',privateDisposalCosts:'0'},
    {privateQualificationRef:'https://example.test/synthetic-qualification'}
  ]) {
    await page.reload();await page.getByRole('heading',{name:'Dyrektorzy pytają Ciebie'}).waitFor();
    const morePrivate=page.getByRole('button',{name:/Pozostałe pytania/});if(await morePrivate.count())await morePrivate.click();
    for(const [field,value] of Object.entries(fields))await page.getByLabel(`Odpowiedź: ${field}`,{exact:true}).fill(value);
    const version=room.version;await page.getByRole('button',{name:'Zapisz odpowiedzi i przelicz'}).click();
    for(let i=0;i<100&&room.version===version;i++)await page.waitForTimeout(50);assert.equal(room.version,version+1);
  }
  await page.reload();await page.getByRole('tab',{name:'Finanse',exact:true}).click();await page.getByRole('heading',{name:'PRIVATE — zamknięty scenariusz warunkowy'}).waitFor();
  assert.equal(current.underwriting.result.cfo.privateTax.status,'MODELLED_ESTIMATE');assert.equal(current.underwriting.result.cfo.privateTax.actualLiability,null);
  assert.equal(current.ceo.result.action,'HOLD / ZBIERZ DANE');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  process.env.DEAL_ROOM_JDG_TAX_ENABLED='true';t.after(()=>delete process.env.DEAL_ROOM_JDG_TAX_ENABLED);
  current=buildCanonicalDeal({...input,overrides:answerOverrides(current,room.baselineOverrides,room.answers)});
  await page.reload();await page.getByText('Zapisane odpowiedzi — edycja i cofnięcie',{exact:true}).click();
  await page.locator('details article').filter({has:page.locator('strong',{hasText:/^taxScenario$/})}).getByRole('button',{name:'Edytuj',exact:true}).click();
  await page.getByLabel('Odpowiedź: taxScenario',{exact:true}).fill('JDG');
  const jdgVersion=room.version;await page.getByRole('button',{name:'Zapisz odpowiedzi i przelicz'}).click();for(let i=0;i<100&&room.version===jdgVersion;i++)await page.waitForTimeout(50);assert.equal(room.version,jdgVersion+1);
  const jdgU=current.underwriting.result,jdgIncome=jdgU.scenarios.base.resaleValue-jdgU.purchasePrice-Math.round(Math.round(jdgU.purchasePrice)*.02)-12000-1000-5000,jdgPit=Math.round(Math.round(Math.max(0,jdgIncome))*.19);
  const paymentPlan=`2026-05-20 | SOCIAL | 12000\n2026-05-20 | FUND | 1000\n2026-12-20 | HEALTH | 6000\n2026-11-20 | PIT | ${jdgPit}`;
  for(const fields of [
   {jdgForm:'LINEAR_2026_ELECTED_ELIGIBLE',jdgAsset:'TRADING_GOOD_KPIR_FULLY_SOLD',jdgVat:'EXEMPT_43_1_10_NO_OPTION_NO_INPUT_CORRECTION',jdgOccupationOn:'2020-01-01',jdgPcc:'STANDARD_MARKET_PRICE'},
   {jdgAnnual:'SOLE_2026_ZERO_OTHER_INVENTORY_LOSSES_RELIEFS',jdgSolidarity:'UNDER_1M_ALL_RELEVANT',jdgZus:'RECONCILED_2026_NO_LATER_ADJUSTMENTS',jdgCosts:'DOCUMENTED_ZUS_OUTSIDE_CFO',jdgAcquisitionFees:'0'},
   {jdgOperatingCosts:'0',jdgDisposalCosts:'0',jdgHealthDeduction:'5000',jdgPayments:paymentPlan,jdgQualificationRef:'https://example.test/synthetic-assessment'}
  ]) {
   await page.reload();await page.getByRole('heading',{name:'Dyrektorzy pytają Ciebie'}).waitFor();const moreJdg=page.getByRole('button',{name:/Pozostałe pytania/});if(await moreJdg.count())await moreJdg.click();
   for(const [field,value] of Object.entries(fields))await page.getByLabel(`Odpowiedź: ${field}`,{exact:true}).fill(value);
   const v=room.version;await page.getByRole('button',{name:'Zapisz odpowiedzi i przelicz'}).click();for(let i=0;i<100&&room.version===v;i++)await page.waitForTimeout(50);assert.equal(room.version,v+1);
  }
  await page.reload();await page.getByRole('tab',{name:'Finanse',exact:true}).click();await page.getByRole('heading',{name:'JDG — model warunkowy'}).waitFor();
  assert.equal(current.underwriting.result.cfo.jdgTax.status,'MODELLED_ESTIMATE');assert.equal(room.answers.jdgPayments.value,paymentPlan);assert.equal(current.ceo.result.action,'HOLD / ZBIERZ DANE');
  const jdgBrain=buildDealBrain(current);assert.ok(jdgBrain.directors.CFO.metrics.some(m=>m.key==='conditionalAfterTaxProfit'&&m.value===current.underwriting.result.cfo.jdgTax.profitAfterTaxAndContributions));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  fs.mkdirSync(path.join(root,'artifacts/deal-room-qa'),{recursive:true});await page.screenshot({path:path.join(root,'artifacts/deal-room-qa/mobile-after.png'),fullPage:true});
});

test('mobile main Finder virtual TEST: dedicated API only, persisted answers and history with real-deal features OFF',{timeout:180000},async(t)=>{
 const {buildTestDeal}=await import('../test-engine.ts');
 const {testCases}=await import('../test-mode.ts');
 const {TEST_DEAL_FEATURES}=await import('../feature-context.ts');
 const {buildDealBrain}=await import('../brain/index.ts');
 const {parseAnswerCommand,mergeAnswers,answerOverrides,affectedDirectors}=await import('../deal-room-answers.ts');
 const owner='44444444-4444-4444-8444-444444444444',cases=testCases(owner),id=cases[0].id;
 let current=buildTestDeal(owner,id),room={version:1,answers:{},baselineOverrides:{},rounds:[]},normalInvestmentCalls=0;const paths=[],errors=[];
 const receipts=new Map(),root=path.resolve(__dirname,'../../..'),auth=await startFakeSupabaseAuthServer();t.after(()=>auth.server.close());
 const env={...process.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',NEXT_PUBLIC_SUPABASE_URL:auth.url,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'isolated-ui-only',SUPABASE_SERVICE_ROLE_KEY:'isolated-ui-only',DEAL_ROOM_TEST_ENABLED:'true',DEAL_ROOM_TEST_STORAGE_VERSION:'1',DEAL_ROOM_TEST_OPERATOR_IDS:owner,DEAL_ROOM_QA_ENABLED:'false',DEAL_ROOM_CFO_ENABLED:'false',DEAL_ROOM_TAX_REVIEW_ENABLED:'false'};
 const nextBin=require.resolve('next/dist/bin/next');await ensureProductionBuild(nextBin,root,env);const port=await freePort(),base=`http://127.0.0.1:${port}`;
 const server=spawn(process.execPath,[nextBin,'start','--hostname','127.0.0.1','--port',String(port)],{cwd:root,env,stdio:'ignore'});t.after(()=>server.kill());
 for(let i=0;i<120;i++){try{if((await fetch(base+'/login')).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:390,height:844}});await addOperatorSessionCookie(page.context(),base);
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url());let body={ok:true};
  paths.push(req.method()+' '+url.pathname);if(url.pathname.startsWith('/api/flip-finder/listings/'))normalInvestmentCalls++;
  if(url.pathname==='/api/deal-room/test')body={cases};
  else if(url.pathname===`/api/deal-room/test/${id}/answers`){
   if(req.method()==='GET')body={enabled:true,room};
   else{
    const cmd=parseAnswerCommand(req.postDataJSON(),TEST_DEAL_FEATURES);
    if(receipts.has(cmd.requestId))body=receipts.get(cmd.requestId);
    else{assert.equal(cmd.expectedVersion,room.version);const before=current,answers=mergeAnswers(current,room,cmd,owner,new Date().toISOString(),TEST_DEAL_FEATURES);current=buildTestDeal(owner,id,answerOverrides(current,{},answers));room={...room,version:room.version+1,answers,rounds:[{requestId:cmd.requestId,savedAt:new Date().toISOString(),actorId:owner,changedFields:cmd.answers.map(a=>a.field),invalidated:affectedDirectors(cmd.answers.map(a=>a.field)),before:buildDealBrain(before),after:buildDealBrain(current)}]};body={deal:current,room};receipts.set(cmd.requestId,body);}
   }
  }else if(url.pathname===`/api/deal-room/test/${id}/history`)body={rounds:room.rounds.map(r=>({requestId:r.requestId,createdAt:r.savedAt,changedFields:r.changedFields,beforeProfit:r.before.financials?.profitBase,afterProfit:r.after.financials?.profitBase,recommendation:r.after.ceo.reasoningSummary})),nextBefore:null};
  else if(url.pathname===`/api/deal-room/test/${id}`)body={deal:current,media:[]};
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/flip-finder');await page.getByRole('button',{name:'Przygotuj / wznów testy',exact:true}).click();await page.getByRole('link',{name:'Otwórz Deal Room TEST',exact:true}).first().click();
 await page.getByRole('heading',{name:'Dyrektorzy pytają Ciebie'}).waitFor();await page.getByRole('button',{name:/Pozostałe pytania/}).click();await page.getByLabel('Odpowiedź: renovationBudget',{exact:true}).fill('40000');await page.getByRole('button',{name:'Zapisz odpowiedzi i przelicz'}).click();
 for(let i=0;i<100&&room.version===1;i++)await page.waitForTimeout(50);
 assert.equal(room.version,2,JSON.stringify({paths,errors,alerts:await page.getByRole('alert').allTextContents()}));
 await page.getByRole('heading',{name:'Co zmieniły odpowiedzi?'}).waitFor();await page.reload();await page.getByRole('heading',{name:'Dyrektorzy pytają Ciebie'}).waitFor();assert.equal(room.answers.renovationBudget.value,40000);
 await page.getByRole('button',{name:'Wczytaj / odśwież historię'}).click();await page.getByLabel('Historia analiz',{exact:true}).getByText(/Zmienione pola: renovationBudget/).waitFor();
 assert.notEqual(current.ceo.result.action,'KUP');assert.equal(current.underwriting.result.cfo.taxStatus,'UNKNOWN');assert.equal(normalInvestmentCalls,0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 fs.mkdirSync(path.join(root,'artifacts/deal-room-qa'),{recursive:true});await page.screenshot({path:path.join(root,'artifacts/deal-room-qa/virtual-test-main-finder.png'),fullPage:true});
});
