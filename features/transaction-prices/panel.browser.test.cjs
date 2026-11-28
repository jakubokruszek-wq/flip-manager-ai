/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const proof = process.env.RCN_PROOF_DIR || path.join(root, '.rcn-proof');
const listing = '11111111-1111-4111-8111-111111111111';
const session = { access_token: 'browser-test-access-token', refresh_token: 'browser-test-refresh-token', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, user: { id: '44444444-4444-4444-8444-444444444444', email: 'operator@example.test', app_metadata: { role: 'operator' }, user_metadata: {}, aud: 'authenticated', created_at: '2026-11-28T00:00:00Z' } };
const payload = (market = 'secondary', count = 6) => ({ status: count >= 5 ? 'ready' : 'insufficient_data', source: { title: 'RCN Łódź · dane publiczne', url: 'https://nowa.mapa.lodz.pl/dla-profesjonalistow/' }, street: 'Tatrzańska', market, sampleCount: count, rows: Array.from({ length: count }, (_, i) => ({ id: `fixture-${i}`, date: '2026-10-12', street: 'Tatrzańska', building: String(66 + i), area: 40 + i, price: 320000 + i * 8000, pricePerM2: 8000, market })), medianPricePerM2: count >= 5 ? 8000 : null, q1PricePerM2: count >= 5 ? 7500 : null, q3PricePerM2: count >= 5 ? 8500 : null, estimatedRange: count >= 5 ? { low: 300000, high: 340000 } : null, differencePct: count >= 5 ? -10 : null, fetchedAt: '2026-11-28T12:00:00Z', truncated: true });
const otherListing = '22222222-2222-4222-8222-222222222222';
const resalePayload = () => ({ status: 'ready', source: { title: 'RCN Łódź · historia', url: 'https://nowa.mapa.lodz.pl/dla-profesjonalistow/' }, street: 'Tatrzańska', candidateCount: 3, strongCandidateCount: 3, rows: [29, 70, 100].map((area, i) => ({ id: `resale-fixture-${i}`, street: 'Tatrzańska', building: String(66 + i), area, buyDate: '2026-01-12', sellDate: '2026-05-12', buyPrice: 200000, sellPrice: 260000, buyPricePerM2: Math.round(200000 / area), sellPricePerM2: Math.round(260000 / area), holdingDays: 120, approxMonths: 3.9, priceIncrease: 60000, priceIncreasePct: 30, strongSignal: true, buyMarket: 'secondary', sellMarket: 'secondary' })), fetchedAt: '2026-11-28T12:00:00Z', truncated: true });
async function listen(server) { await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); }); return server.address().port; }
async function until(fn, timeout = 60000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Timed out waiting for local browser fixture'); }
test('real RCN panels: street resales, mobile/desktop, isolated loading and retries', { timeout: 600000 }, async () => {
  fs.mkdirSync(proof, { recursive: true });
  const fixture = path.join(root, 'app/(app)/rcn-browser-fixture');
  assert.equal(fs.existsSync(fixture), false, 'never overwrite an existing app route');
  let app, browser, auth;
  try {
    fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(fixture, 'page.tsx'), [
      '"use client";',
      "import { useState } from 'react';",
      "import { TransactionPricesPanel } from '@/features/transaction-prices/transaction-prices-panel';",
      "import { StreetResalesLoader } from '@/features/transaction-prices/resales-loader';",
      `export default function Page() { const [current, setCurrent] = useState('${listing}'); return <main className="mx-auto w-full max-w-5xl space-y-4 p-3"><TransactionPricesPanel listingId="${listing}" /><button type="button" onClick={() => setCurrent(current === '${listing}' ? '${otherListing}' : '${listing}')}>Zmień ofertę testową</button><StreetResalesLoader listingId={current} /></main>; }`,
    ].join('\n'));

    auth = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(req.url === '/auth/v1/user' ? session.user : [])); });
    const authPort = await listen(auth);
    const portServer = http.createServer(); const port = await listen(portServer); await new Promise(r => portServer.close(r));
    const env = { PATH: process.env.PATH, NODE_ENV: 'test', NODE_OPTIONS: `--use-system-ca --require=${path.join(root, 'features/test-support/offline-next.cjs')}`, NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${authPort}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'browser-test-publishable-key' };
    const next = require.resolve('next/dist/bin/next');
    await new Promise((ok, no) => { const build = spawn(process.execPath, [next, 'build', '--webpack'], { cwd: root, env }); const log = fs.createWriteStream(path.join(proof, 'rcn-browser-build.log')); build.stdout.pipe(log); build.stderr.pipe(log); build.once('error', no); build.once('exit', code => { log.end(); if (code === 0) ok(); else no(Error(`Build failed: ${code}; see rcn-browser-build.log`)); }); });
    app = spawn(process.execPath, [next, 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root, env });
    const log = fs.createWriteStream(path.join(proof, 'rcn-browser-server.log')); app.stdout.pipe(log); app.stderr.pipe(log);
    const base = `http://127.0.0.1:${port}`;
    await until(async () => { try { return (await fetch(`${base}/login`)).status < 500; } catch { return false; } });
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.context().addCookies([{ name: 'sb-127-auth-token', value: JSON.stringify(session), url: base, httpOnly: true, sameSite: 'Lax' }]);
    let mode = 'ready', release, requests = 0;
    await page.route(`**/api/market-intelligence/${listing}/transactions?*`, async route => {
      requests++;
      const market = new URL(route.request().url()).searchParams.get('market');
      if (mode === 'hold') await new Promise(r => { release = r; });
      if (mode === 'error') return route.fulfill({ status: 503, json: { message: 'Źródło chwilowo niedostępne' } });
      const data = payload(market, mode === 'low' ? 2 : 6);
      if (mode === 'missing') data.status = 'missing_area';
      await route.fulfill({ json: data });
    });
    let resaleMode = 'ready', resaleRelease, resaleRequests = 0;
    await page.route('**/api/market-intelligence/*/resales', async route => {
      resaleRequests++;
      if (resaleMode === 'hold') await new Promise(resolve => { resaleRelease = resolve; });
      if (resaleMode === 'error') return route.fulfill({ status: 503, json: { message: 'Historia odsprzedaży chwilowo niedostępna — test' } });
      await route.fulfill({ json: resalePayload() });
    });
    let radarMode = 'ready', radarRelease, radarRequests = 0;
    const legacyWrites = [];
    page.on('request', request => { if (request.url().includes('/api/price-radar/') && request.method() !== 'GET') legacyWrites.push(request.url()); });
    await page.route('**/api/price-radar/rcn?*', async route => {
      radarRequests++;
      if (radarMode === 'hold') await new Promise(resolve => { radarRelease = resolve; });
      if (radarMode === 'error') return route.fulfill({ status: 503, json: { message: 'Dane RCN chwilowo niedostępne — test' } });
      const street = new URL(route.request().url()).searchParams.get('street');
      const data = resalePayload(); data.candidateCount = 4; data.rows.push({ ...data.rows[0], id: 'resale-weak', building: '69', area: 40, sellPrice: 250000, buyPricePerM2: 5000, sellPricePerM2: 6250, priceIncrease: 50000, priceIncreasePct: 25, strongSignal: false }); data.street = street; data.rows.forEach(row => { row.street = street; });
      await route.fulfill({ json: data });
    });
    const resales = page.getByRole('region', { name: 'Możliwe flipy na ulicy', exact: true });
    const resaleState = page.getByRole('region', { name: 'Historia odsprzedaży na ulicy', exact: true });
    const panel = page.getByRole('region', { name: 'Porównanie z cenami transakcyjnymi' });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(`${base}/rcn-browser-fixture`);
      await panel.getByText('Przykładowe porównywalne transakcje').waitFor();
      assert.equal(await panel.locator('article').count(), 6);
      assert.match(await panel.innerText(), /8\s*000/);
      assert.equal(await panel.getByRole('link', { name: 'RCN Łódź · dane publiczne' }).getAttribute('href'), 'https://nowa.mapa.lodz.pl/dla-profesjonalistow/');
      await resales.getByText('Wszystkie szybkie odsprzedaże ze wzrostem ceny:', { exact: false }).waitFor();
      assert.equal(await resales.locator('article').count(), 3);
      assert.match(await resales.innerText(), /Wzrost ≥30% w ciągu roku/);
      assert.equal(await resales.getByText('Wzrost ≥30% · silniejszy sygnał', { exact: true }).count(), 3);
      const summary = resales.locator('div.rounded-lg').first();
      assert.equal(await summary.locator('p.text-2xl').innerText(), '3');
      assert.match(await summary.innerText(), /Wszystkie szybkie odsprzedaże ze wzrostem ceny:\s*3/);
      const firstResale = resales.locator('article').first();
      assert.match(await firstResale.innerText(), /12\.01\.2026/);
      assert.match(await firstResale.innerText(), /12\.05\.2026/);
      assert.match(await firstResale.innerText(), /200\s*000/); assert.match(await firstResale.innerText(), /260\s*000/);
      assert.match(await firstResale.innerText(), /3,9 mies\. \(120 dni\)/);
      assert.match(await resales.innerText(), /Dane źródłowe są ograniczone/);
      assert.match(await resales.innerText(), /nie jest zyskiem netto/);
      assert.equal(await resales.getByRole('link', { name: 'RCN Łódź · historia' }).getAttribute('href'), 'https://nowa.mapa.lodz.pl/dla-profesjonalistow/');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px horizontal overflow`);
      await page.screenshot({ path: path.join(proof, `rcn-${width}.png`), fullPage: true });
    }
    mode = 'hold'; await panel.getByRole('combobox').selectOption('primary');
    await panel.getByText('Pobieranie cen transakcyjnych…').waitFor();
    assert.equal(await panel.locator('article').count(), 0, 'old secondary rows hidden during primary load');
    assert.doesNotMatch(await panel.innerText(), /8\s*000|300\s*000/);
    await until(() => Boolean(release)); mode = 'low'; release();
    await panel.getByText('Za mało danych').waitFor();
    assert.equal(await panel.locator('article').count(), 2);
    assert.match(await panel.getByText('Mediana / m²', { exact: true }).locator('..').innerText(), /Za mało danych/);
    assert.doesNotMatch(await panel.innerText(), /Przedział dla metrażu oferty:/);
    mode = 'error'; await panel.getByRole('combobox').selectOption('secondary');
    await panel.getByText('Źródło chwilowo niedostępne').waitFor();
    assert.equal(await panel.locator('article').count(), 0);
    mode = 'ready'; const before = requests; await panel.getByRole('button', { name: 'Spróbuj ponownie' }).click();
    await panel.getByText('Przykładowe porównywalne transakcje').waitFor(); assert.ok(requests > before);
    mode = 'missing'; await panel.getByRole('combobox').selectOption('primary');
    await panel.getByText('Uzupełnij metraż oferty, aby porównać mieszkania o podobnej powierzchni.').waitFor();
    assert.equal(await panel.locator('article').count(), 0);
    resaleMode = 'hold'; await page.getByRole('button', { name: 'Zmień ofertę testową' }).click();
    await resaleState.getByText('Sprawdzanie kolejnych sprzedaży tych samych lokali…').waitFor();
    assert.equal(await resales.count(), 0, 'previous listing resale rows hidden during new listing load');
    assert.doesNotMatch(await resaleState.innerText(), /200\s*000|260\s*000|12\.01\.2026/);
    await until(() => Boolean(resaleRelease)); resaleMode = 'error'; resaleRelease();
    await resaleState.getByText('Historia odsprzedaży chwilowo niedostępna — test').waitFor();
    assert.equal(await resales.count(), 0);
    resaleMode = 'ready'; const resaleBefore = resaleRequests;
    await resaleState.getByRole('button', { name: 'Ponów historię odsprzedaży' }).click();
    await resales.getByText('Wszystkie szybkie odsprzedaże ze wzrostem ceny:', { exact: false }).waitFor();
    assert.equal(await resales.locator('article').count(), 3); assert.ok(resaleRequests > resaleBefore);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 960 }); await page.goto(`${base}/price-radar`);
      await page.getByRole('heading', { name: 'Radar transakcji · RCN', exact: true }).waitFor();
      const districts = page.getByRole('region', { name: 'Radar dzielnic', exact: true });
      await districts.getByRole('heading', {name:'Bałuty', exact:true}).waitFor();
      assert.equal(await districts.locator('article').count(),5);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:path.join(proof,`rcn-districts-${width}.png`),fullPage:true});
      await page.getByRole('button',{name:'Ulica',exact:true}).click();
      await resales.getByText('Wszystkie szybkie odsprzedaże ze wzrostem ceny:', { exact: false }).waitFor();
      assert.equal(await resales.locator('article').count(), 4);
      assert.equal(await resales.locator('div.rounded-lg').first().locator('p.text-2xl').innerText(), '3', 'main count is the 30% group, not all4 resales');
      assert.match(await resales.innerText(), /Wszystkie szybkie odsprzedaże ze wzrostem ceny:\s*4/);
      assert.equal(await page.getByLabel('Ulica w Łodzi', { exact: true }).inputValue(), 'Tatrzańska');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px RCN radar overflow`);
      await page.screenshot({ path: path.join(proof, `rcn-radar-${width}.png`), fullPage: true });
    }
    radarMode = 'hold'; await page.getByLabel('Ulica w Łodzi', { exact: true }).fill('Rokicińska');
    await page.getByRole('button', { name: 'Analizuj ulicę' }).click();
    await page.getByText('Pobieranie transakcji dla ulicy Rokicińska…', { exact: true }).waitFor();
    assert.equal(await resales.count(), 0, 'previous street rows hidden while a different street loads');
    await until(() => Boolean(radarRelease)); radarMode = 'error'; radarRelease();
    await page.getByRole('alert').filter({ hasText: 'Dane RCN chwilowo niedostępne — test' }).waitFor();
    assert.equal(await resales.count(), 0); radarMode = 'ready'; const radarBefore = radarRequests;
    await page.getByRole('button', { name: 'Spróbuj ponownie', exact: true }).click();
    await resales.getByText('Rokicińska · Wzrost ≥30% w ciągu roku', { exact: true }).waitFor();
    assert.ok(radarRequests > radarBefore); assert.equal(await resales.locator('article').count(), 4);
    assert.doesNotMatch(await resales.innerText(), /Tatrzańska/);
    const point = JSON.parse(fs.readFileSync(path.join(root,'features/transaction-prices/data/rcn-addresses.json'),'utf8')).addresses.find(row=>row.street==='Tatrzańska'&&row.building==='94');
    assert.ok(point);
    let nearbyRequests=0;
    page.on('request',request=>{if(request.url().includes('/api/price-radar/rcn/nearby?'))nearbyRequests++;});
    await page.context().grantPermissions(['geolocation'],{origin:base});
    await page.context().setGeolocation({latitude:point.latitude,longitude:point.longitude,accuracy:10});
    await page.getByRole('button',{name:'W pobliżu',exact:true}).click();
    assert.equal(nearbyRequests,0,'opening nearby tab never requests location or transactions automatically');
    const nearby=page.getByRole('region',{name:'Radar w pobliżu',exact:true});
    await nearby.getByRole('button',{name:'Lokalizuj mnie',exact:true}).click();
    const pairs=page.getByRole('region',{name:'Możliwe flipy w pobliżu',exact:true});
    await pairs.locator('article').first().waitFor();
    assert.match(await pairs.innerText(),/Odległość od środka wyszukiwania/);
    const radiusResponse=page.waitForResponse(response=>response.url().includes('/rcn/nearby?')&&new URL(response.url()).searchParams.get('radius')==='500');
    await nearby.getByLabel('Promień wyszukiwania',{exact:true}).selectOption('500');
    assert.equal((await radiusResponse).status(),200); await pairs.locator('article').first().waitFor();
    await nearby.getByRole('button',{name:'Podaj adres',exact:true}).click();
    await nearby.getByLabel('Ulica lub adres w Łodzi',{exact:true}).fill('Tatrzańska 94');
    await nearby.getByRole('button',{name:'Ustaw punkt',exact:true}).click();
    await pairs.locator('article').first().waitFor();
    assert.match(await nearby.innerText(),/Tatrzańska 94, Łódź/);
    assert.equal(await nearby.getByLabel('Promień wyszukiwania',{exact:true}).inputValue(),'500');
    await nearby.getByLabel('Ulica lub adres w Łodzi',{exact:true}).fill('Tatrzańska');
    await nearby.getByRole('button',{name:'Ustaw punkt',exact:true}).click();
    await nearby.getByText(/Promień liczony od wskazanego punktu ulicy/).waitFor();
    for(const width of [390,1440]){await page.setViewportSize({width,height:960});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(proof,`rcn-nearby-${width}.png`),fullPage:true});}
    await page.evaluate(()=>Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition:(_ok,no)=>no({code:1})}}));
    await nearby.getByRole('button',{name:'Moja lokalizacja',exact:true}).click();
    await nearby.getByRole('button',{name:'Lokalizuj mnie',exact:true}).click();
    await nearby.getByRole('alert').filter({hasText:'Brak zgody na lokalizację'}).waitFor();
    assert.equal(await pairs.count(),0,'denied GPS must not leave the previous address results visible');
    assert.deepEqual(legacyWrites, [], 'RCN entry must not start or continue legacy portal scans');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(proof, 'rcn-browser-proof.json'), JSON.stringify({ passed: true, widths: [390, 1440], requests, resaleRequests, radarRequests, legacyWrites, scenarios: ['source/data', 'market loading isolates old values', 'low sample', 'error retry', 'missing area', 'street resale count3/strong3/buy-sell-dates-prices-duration', 'resale listing change hides stale data', 'resale error retry', 'actual /price-radar RCN entry mobile/desktop', 'street loading isolates old rows', 'street error retry', 'no legacy portal POSTs', 'five real district summaries default', 'GPS explicit permission and radius change', 'typed address with preserved radius', 'street center precision notice'], pageErrors: errors }, null, 2));
  } finally {
    if (browser) await browser.close();
    if (app) app.kill();
    if (auth) await new Promise(r => auth.close(r));
    fs.rmSync(path.join(fixture, 'page.tsx'), { force: true });
    if (fs.existsSync(fixture)) fs.rmdirSync(fixture);
  }
});
