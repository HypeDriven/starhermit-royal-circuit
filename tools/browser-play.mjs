// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes, at a desktop viewport, a phone
// (DPR 3) and a phone held sideways (DPR 3): on the desktop Journey stage 1
// is played to its results by mouse (Roll, the float picker's buttons over
// the floats, Pass), with a camera drag on the board and a pause by Escape;
// on the phone the Learn lessons 1-2 are played by finger (the Turn drawer,
// Roll, the docked picker); sideways a Practice match is started, played a
// few turns by keys, paused, its settings opened and left. Widgets are found
// through the page's accessibility mirror of the engine's UI. Screenshots of
// each step go to --shots. Fails on console errors or warnings, the runtime's
// error screen, or a view that does not finish.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const views = [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const cdp = v.hasTouch ? await ctx.newCDPSession(page) : null;
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(4000);
  const shot = async (name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${name}.png`) }); } };
  const find = (name) => page.getByRole('button', { name, exact: true }).or(page.getByText(name, { exact: true })).first();
  const tapAt = async (x, y) => {
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  /** A press on a widget: the mouse on the desktop, a finger on the phones. */
  const pressEl = async (el) => {
    const b = await el.boundingBox();
    if (!b) throw new Error('no box');
    await tapAt(b.x + b.width / 2, b.y + b.height / 2);
  };
  const press = async (name) => { const el = find(name); await el.waitFor({ timeout: 15000 }); await pressEl(el); };
  const visible = async (loc) => (await loc.count()) > 0 && (await loc.first().isVisible().catch(() => false));
  /** Plays the human's turns by presses until `done` text shows: a picker button, else Pass, else Roll. */
  const playTurns = async (done, limitMs) => {
    const end = Date.now() + limitMs;
    while (Date.now() < end) {
      if (await visible(page.getByRole('button', { name: done, exact: true })) || await visible(page.getByText(done, { exact: false }))) return;
      const pick = page.getByRole('button', { name: /^Float \d: / });
      if (await visible(pick)) { await pressEl(pick.first()); await page.waitForTimeout(500); continue; }
      const pass = page.getByRole('button', { name: 'Pass', exact: true });
      if (await visible(pass) && await pass.first().isEnabled({ timeout: 1000 }).catch(() => false)) { await pressEl(pass.first()); await page.waitForTimeout(500); continue; }
      const roll = page.getByRole('button', { name: 'Roll the festival die', exact: true });
      if (await visible(roll) && await roll.first().isEnabled({ timeout: 1000 }).catch(() => false)) { await pressEl(roll.first()); await page.waitForTimeout(500); continue; }
      await page.waitForTimeout(300);
    }
    throw new Error(`"${done}" not reached`);
  };
  let reached = false;
  try {
    await shot('title');
    if (v.name === 'desktop') {
      await press('Journey');
      await page.getByRole('button', { name: /^Stage 1: / }).first().click();
      await press('Start');
      await page.waitForTimeout(3000);
      await shot('journey-1');
      // a camera drag on the board, then the camera reset key
      await page.mouse.move(640, 300); await page.mouse.down(); await page.mouse.move(760, 330, { steps: 8 }); await page.mouse.up();
      await page.waitForTimeout(600);
      await shot('orbit');
      await page.keyboard.press('KeyC');
      await page.keyboard.press('Escape');
      await find('Resume').waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);
      await shot('pause');
      await press('Resume');
      await page.waitForTimeout(500);
      await playTurns('Watch Replay', 600000);
      await page.waitForTimeout(1500);
      await shot('journey-1-results');
    } else if (v.name === 'phone') {
      await press('Learn');
      await page.getByRole('button', { name: /^Kindling a Float\./ }).first().click().catch(async () => { await press('Kindling a Float'); });
      for (let i = 0; i < 2; i++) {
        await press('Start');
        await page.waitForTimeout(2500);
        await press('Turn');
        await shot(`lesson-${i + 1}`);
        await playTurns('Retry', 180000);
        await page.waitForTimeout(800);
        await shot(`lesson-${i + 1}-results`);
        if (i === 0) await press('Next: Around the Circuit');
      }
    } else {
      await press('▶ Play');
      await page.waitForTimeout(800);
      await shot('setup');
      // the setup panel scrolls on a short screen: Start is below the fold
      await page.mouse.move(400, 200); await page.mouse.wheel(0, 3000); await page.waitForTimeout(800);
      await press('Start');
      await page.waitForTimeout(3000);
      for (let i = 0; i < 12; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(900); }
      await shot('practice');
      await press('Pause');
      await find('Resume').waitFor({ timeout: 15000 });
      await press('Settings');
      await page.waitForTimeout(800);
      await shot('settings');
      await press('Done');
      await press('Leave Game');
      await press('Confirm');
      await find('Daily Circuit').waitFor({ timeout: 15000 });
      await shot('title-again');
    }
    reached = true;
  } catch (e) { problems.push(`play: ${String(e.message || e).split('\n')[0]}`); await shot('failed'); }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0 && reached;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'} played=${reached}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
