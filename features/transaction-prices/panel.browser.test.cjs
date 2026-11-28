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
async function listen(server) { await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); }); return server.address().port; }
async function until(fn, timeout = 60000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Timed out waiting for local browser fixture'); }
test('real RCN panel: mobile/desktop, market isolation, retry and missing area', { timeout: 600000 }, async () => {
  fs.mkdirSync(proof, { recursive: true });
  const fixture = path.join(root, 'app/(app)/rcn-browser-fixture');
  assert.equal(fs.existsSync(fixture), false, 'never overwrite an existing app route');
  let app, browser, auth;
  try {
    fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(fixture, 'page.tsx'), `import { TransactionPricesPanel } from '@/features/transaction-prices/transaction-prices-panel';\nexport default function Page() { return <main className="mx-auto w-full max-w-5xl p-3"><TransactionPricesPanel listingId="${listing}" /></main>; }\n`);
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
    const panel = page.getByRole('region', { name: 'Porównanie z cenami transakcyjnymi' });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(`${base}/rcn-browser-fixture`);
      await panel.getByText('Przykładowe porównywalne transakcje').waitFor();
      assert.equal(await panel.locator('article').count(), 6);
      assert.match(await panel.innerText(), /8\s*000/);
      assert.equal(await panel.getByRole('link', { name: 'RCN Łódź · dane publiczne' }).getAttribute('href'), 'https://nowa.mapa.lodz.pl/dla-profesjonalistow/');
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
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(proof, 'rcn-browser-proof.json'), JSON.stringify({ passed: true, widths: [390, 1440], requests, scenarios: ['source/data', 'market loading isolates old values', 'low sample', 'error retry', 'missing area'], pageErrors: errors }, null, 2));
  } finally {
    if (browser) await browser.close();
    if (app) app.kill();
    if (auth) await new Promise(r => auth.close(r));
    fs.rmSync(path.join(fixture, 'page.tsx'), { force: true });
    if (fs.existsSync(fixture)) fs.rmdirSync(fixture);
  }
});
