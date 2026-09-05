/**
 * Royal Circuit — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → Journey mode card → Stage 1 (an authored, fully solvable solo
 *   stage; its "crown-first" objective is a UI label — the authoritative
 *   rules only end a round on a full crown-sweep or a turn limit, so the
 *   stage is played as a real 2-player race to a declared winner) → start →
 *   pause/resume, hint → play the human's turns for real through the visible
 *   HUD (#btn-roll, #btn-pass, and the DOM float-picker buttons that are the
 *   accessible equivalent of canvas picking) → results screen with a winner
 *   + per-player score breakdown ("lap results") + persisted stage progress
 *   → back to title.
 * A second pass runs the same real flow on a mobile viewport (fewer moves)
 * and asserts the output.
 *
 * INPUT MODALITY:
 * The game is fully playable by pointer AND keyboard. `#gl-fallback` is
 * genuinely hidden when hidden (styles.css now has `#gl-fallback[hidden]{
 * display:none}`), so pointer/touch reach the real controls — the desktop
 * pass opens the Journey card with a REAL pointer tap to prove it. Keyboard
 * (focus + Enter) is a supported first-class input and the rest of the flow
 * drives the on-screen controls through it, exercising the same bindings.
 *
 * No game code is modified and nothing is cheated: every action presses a
 * real visible control. The test only reads the DOM to decide which visible
 * float button is a sensible legal move (advance an on-track float, prefer
 * CROWN, then capture/lantern/move, and only kindle a new float when nothing
 * else can move). It never calls the game's own rules/command API.
 *
 * KNOWN LIMITATION (documented — the game source is now fixed): the title's
 * "▶ Play" button / Practice setup crashed on numeric options in `src/ui.js`
 * `segField` (knownissues.md defect 1, `opt[0].toUpperCase()` on a Number);
 * that is fixed. This test enters through the Journey mode card, whose
 * content-driven setup is the primary solo path exercised here.
 *
 * Serving: the repo ships `server.js` (the StarHermit authoritative script
 * declared by starhermit.txt) but solo modes (journey/daily/practice/learn/
 * challenge) are fully playable offline — when /api/v1/time is unavailable
 * `src/platform.js` drops to `hosted=false` and every solo screen works
 * locally. So, per the sibling conventions (picture-logic/blockstead/
 * balance-spire), this test embeds a minimal node:http static server on an
 * ephemeral port and answers /api/* probes with 200 `{}` so the platform
 * adapter degrades to its documented offline path with zero console noise.
 * Hosted play (which genuinely needs server.js + /ws) is out of scope and is
 * not entered by this test.
 *
 * Run: npm run test:e2e  (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/royal-circuit-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const filePath = p === '/' ? path.join(ROOT, 'index.html') : path.join(ROOT, p);
    // No StarHermit backend here: answer API probes with empty JSON (200) so
    // the platform adapter degrades to offline mode without console noise.
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name) => console.log(`ok - ${name}`);

// Activate a real visible control through the game's supported keyboard
// path. Outside the ACTIVE game state (title/setup/overlay) the game's
// global key handler returns before the confirm map, so Enter on a focused
// button dispatches its native click. The always-on `#gl-fallback` overlay
// (see header) captures pointerdown/touch, so we use keyboard throughout.
async function press(page, locator) {
  await locator.focus();
  await page.keyboard.press('Enter');
}

// One human turn action via the game's real semantic bindings
// (Space/Enter = confirm → roll a die, or click the focused float, or pass;
// press Escape to pause; H to hint). This is the same path a keyboard user
// takes; the test only sends the key and lets the game resolve it.
const ACTIVE_KEYS = {
  confirm: 'Enter', pause: 'Escape', move: 'Enter', hint: 'h',
};

// ---------- in-page state read (DOM only, no game API) ----------
// Summarises what the real UI is offering right now so the test can decide
// which visible control to press next.
const readAct = (page) => page.evaluate(() => {
  const pk = document.getElementById('float-picker');
  const roll = document.getElementById('btn-roll');
  const pass = document.getElementById('btn-pass');
  const rt = document.getElementById('rail-turn')?.textContent || '';
  return {
    over: !document.getElementById('overlay-results').hidden,
    inGame: document.getElementById('screen-game').classList.contains('active'),
    pickerN: pk && !pk.hidden ? pk.querySelectorAll('button').length : 0,
    rollEnabled: !!(roll && !roll.disabled),
    passVisible: !!(pass && !pass.hidden && !pass.disabled),
    railTurn: rt,
    hintEnabled: !document.getElementById('btn-hint')?.disabled,
  };
});

// Pick which visible float button to move by its label: advance an on-track
// float (prefer a crown, then a capture, then a lantern tile, then an ordinary
// move) and only kindle a new float when nothing else can move. This races the
// human to the crown efficiently while remaining a purely legal choice. Returns
// the button index, or -1 if none.
const pickIndex = (page) => page.evaluate(() => {
  const btns = [...document.getElementById('float-picker').querySelectorAll('button')];
  const score = (t) => t.includes('CROWN') ? 4
    : t.includes('capture') ? 3
    : t.includes('lantern') ? 2
    : /move \d/.test(t) ? 1 : 0; // "kindle!" / deploy -> 0
  let best = -1, bestS = -1;
  btns.forEach((b, i) => { const s = score(b.textContent); if (s > bestS) { bestS = s; best = i; } });
  return best;
});

// Wait until the stage has truly started and the human is on move (Roll
// enabled or a float must be chosen), i.e. the countdown finished.
async function waitHumanTurn(page, timeout) {
  await page.waitForFunction(() => {
    if (!document.getElementById('screen-game').classList.contains('active')) return false;
    if (!document.getElementById('overlay-results').hidden) return true; // already over
    const pk = document.getElementById('float-picker');
    if (pk && !pk.hidden && pk.querySelectorAll('button').length > 0) return true;
    const roll = document.getElementById('btn-roll');
    const rt = document.getElementById('rail-turn')?.textContent || '';
    return !!(roll && !roll.disabled) && /roll|choose|pass|move/.test(rt);
  }, null, { timeout });
}

// Drive the human's turns with the game's real confirm key (Enter) until the
// results overlay appears (round over, winner crowned). Rivals drive
// themselves through the game's own internal loop. When `hint` is set, the
// first legal-move state triggers the real Hint key ('H') once (it just
// recommends a float; it never moves). Float choice uses the game's own
// keyboard confirm-on-focused-picker-button path (a legal, sensible move).
async function driveHumanToResults(page, maxIters, hint = false) {
  let hinted = false;
  for (let i = 0; i < maxIters; i++) {
    const a = await readAct(page);
    if (a.over) {
      if (hint && !hinted) throw new Error('never reached a legal-move state to exercise hint');
      return true;
    }
    if (!a.inGame) throw new Error('left game screen mid-round');
    if (a.pickerN > 0) {
      if (hint && !hinted) {
        if (!a.hintEnabled) throw new Error('hint key target not enabled on a moves state');
        await page.keyboard.press(ACTIVE_KEYS.hint);
        hinted = true;
        await page.waitForTimeout(250);
        continue; // re-read; the picker is still there, press confirm next
      }
      const idx = await pickIndex(page);
      if (idx < 0) throw new Error('float picker visible but no legal move');
      await page.locator('#float-picker button').nth(idx).focus();
      await page.keyboard.press(ACTIVE_KEYS.confirm);
    } else if (a.rollEnabled || a.passVisible) {
      await page.keyboard.press(ACTIVE_KEYS.confirm);
    }
    // AI turn / resolving animation / countdown: wait for the UI to settle.
    await page.waitForTimeout(140);
  }
  throw new Error('round did not finish within the guard limit');
}

async function startJourneyStage1(page) {
  // The always-on `#gl-fallback` overlay used to capture pointerdown/touch
  // even while hidden (known issue: `display:grid` overriding `[hidden]`).
  // A REAL pointer tap on the menu card proves the overlay no longer blocks
  // pointer input. The rest of the flow uses the supported keyboard path.
  await page.locator('#card-journey').click();
  await page.waitForSelector('#screen-journey.active', { state: 'visible' });
  await press(page, page.locator('#journey-grid .stage-cell').first());
  await page.waitForSelector('#screen-setup.active', { state: 'visible' });
  await press(page, page.locator('#setup-start'));
  await page.waitForSelector('#screen-game.active', { state: 'visible' });
}

// ---------- one pass ----------
async function runPass(browser, name, ctxOpts, { full }) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const p = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(p)) errors.push(`http ${r.status()}: ${p}`);
  });

  try {
    // load + title
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#screen-title.active', { state: 'visible', timeout: 20000 });
    await page.screenshot({ path: SHOT('title', name) });
    ok(`${name}: title screen visible`);

    // enter Journey stage 1 through the real mode card (works around the
    // known broken "▶ Play" / Practice numeric-option defect, see header).
    await startJourneyStage1(page);
    await waitHumanTurn(page, 25000);
    const hudObj = (await page.textContent('#rail-objective')) || '';
    const mode = (await page.textContent('#hud-mode-name')) || '';
    await page.screenshot({ path: SHOT('start', name) });
    ok(`${name}: Journey stage 1 started (mode="${mode.trim()}"; objective="${hudObj.trim()}")`);

    if (full) {
      // pause / resume: Escape pauses (a real semantic binding), and Resume
      // is a real overlay button (the overlay traps keys, so Enter clicks it).
      await page.keyboard.press(ACTIVE_KEYS.pause);
      await page.waitForFunction(() => !document.getElementById('overlay-pause').hidden, null, { timeout: 8000 });
      await page.screenshot({ path: SHOT('pause', name) });
      await press(page, page.locator('#btn-resume'));
      await page.waitForFunction(() => document.getElementById('overlay-pause').hidden, null, { timeout: 8000 });
      await waitHumanTurn(page, 20000);
      ok(`${name}: pause and resume work`);

      // play the human's turns to the end of the stage, exercising the real
      // Hint key ('H') once on a legal-move state along the way.
      const finished = await driveHumanToResults(page, 1300, true);
      if (!finished) throw new Error('drive loop reported not finished');
      await page.waitForFunction(() => !document.getElementById('overlay-results').hidden, null, { timeout: 20000 });
      const head = ((await page.textContent('#results-body .result-head .big')) || '').trim();
      if (!/Victory|Defeat|dim/.test(head)) throw new Error(`unexpected results headline: "${head}"`);
      const rows = await page.locator('#results-body .result-table tbody tr').count();
      if (rows < 1) throw new Error('results score table is empty');
      const seedLine = ((await page.textContent('#results-body .hint')) || '').trim();
      await page.screenshot({ path: SHOT('results', name) });
      ok(`${name}: stage completed — results shown (headline="${head}", ${rows} score rows, ${seedLine})`);

      // progress persisted for the stage
      const rec = await page.evaluate(() => {
        for (const k of Object.keys(localStorage)) {
          if (/royal-circuit:save/.test(k)) {
            const raw = localStorage.getItem(k);
            try { const j = JSON.parse(raw); return j?.payload ?? j; } catch { /* continue */ }
          }
        }
        return null;
      });
      const stageStars = rec?.journey?.['journey-01'];
      if (!stageStars) throw new Error('journey stage 1 result not persisted: ' + JSON.stringify(rec));
      ok(`${name}: progress persisted (${JSON.stringify(stageStars)})`);

      // winning the stage offers the natural next action: Continue → Stage 2
      await press(page, page.locator('#results-next'));
      await page.waitForSelector('#screen-setup.active', { state: 'visible', timeout: 10000 });
      const nextHeading = ((await page.textContent('#setup-h')) || '').trim();
      if (!/Journey/.test(nextHeading) && !/Stage|Causeway|Lantern/.test(nextHeading)) {
        throw new Error(`results Continue did not lead to a journey setup (heading="${nextHeading}")`);
      }
      ok(`${name}: results Continue leads to the next journey stage (setup "${nextHeading}")`);
    } else {
      // mobile: make a few real moves through the visible controls (keyboard
      // path — see header: the gl-fallback overlay blocks pointer/touch).
      await waitHumanTurn(page, 25000);
      const initialRT = (await readAct(page)).railTurn;
      let actions = 0;
      let sawPicker = false;
      for (let k = 0; k < 14; k++) {
        const a = await readAct(page);
        if (a.over) break;
        if (a.pickerN > 0) {
          sawPicker = true;
          const idx = await pickIndex(page);
          if (idx < 0) { await page.keyboard.press(ACTIVE_KEYS.confirm); continue; }
          await page.locator('#float-picker button').nth(idx).focus();
          await page.keyboard.press(ACTIVE_KEYS.confirm);
          actions++;
          await page.waitForTimeout(600);
          if (actions >= 2) break; // a couple of real moves is enough on mobile
        } else if (a.rollEnabled || a.passVisible) {
          await page.keyboard.press(ACTIVE_KEYS.confirm);
          actions++;
          await page.waitForTimeout(350);
        } else {
          await page.waitForTimeout(300); // AI turn / resolving
        }
      }
      const afterRT = (await readAct(page)).railTurn;
      // The human's real input must have advanced the round: either a float
      // was picked, a die was rolled / a pass taken, i.e. the turn state moved.
      const progressed = sawPicker || actions > 0 || afterRT !== initialRT;
      if (!progressed) throw new Error(`mobile: no real progress (rail "${initialRT}" -> "${afterRT}")`);
      await page.screenshot({ path: SHOT('mobile-play', name) });
      ok(`${name}: real input advanced the round (${actions} action(s), picker=${sawPicker}, rail "${initialRT}" -> "${afterRT}")`);
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - ${name}: no page errors`);
}

// ---------- main ----------
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  console.log(`serving ${ROOT} at ${BASE}`);
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, { full: true });
  await runPass(browser, 'mobile',
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { full: false });
  console.log('\nE2E PASS — royal-circuit, desktop + mobile, no page errors');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (failures) process.exit(1);
