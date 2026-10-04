// src/platform.js over the shipped StarHermit SDK with a stubbed fetch and launch fragment:
// token read, profile nickname, cloud save round trip on `game:<slug>`, settings KV, control
// bindings (load + remap + reset), read-only board, and no network traffic standalone.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Platform } from '../src/platform.js';

const SDK = (() => {
  const m = { exports: {} };
  new Function('module', 'exports', readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(m, m.exports);
  return m.exports;
})();

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64u({ alg: 'none' })}.${b64u({ sub: 'u-1234567890', game_scope: 'royal-circuit', exp: 9999999999 })}.sig`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timers = { setTimeout: (fn, ms) => (ms > 5000 ? 0 : setTimeout(fn, ms)), clearTimeout: (t) => t && clearTimeout(t) };

let net, local;
function stubNet() {
  const calls = [];
  const store = { save: null, patches: [], controls: [] };
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, auth: init.headers && init.headers.Authorization });
    const json = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
    const g = '/api/v1/games/royal-circuit';
    if (url === '/api/v1/users/u-1234567890/profile') return json(200, { nickname: 'Lantern Lu' });
    if (url === '/api/v1/me/cloud-saves/game%3Aroyal-circuit') {
      if (method === 'GET') return store.save ? new Response(store.save, { status: 200 }) : json(404, {});
      if (method === 'PUT') { store.save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return json(200, {}); }
    }
    if (url === `${g}/settings`) {
      if (method === 'GET') return json(200, { settings: { audio: { music: 0.1 }, theme: 'moon-garden' } });
      if (method === 'PATCH') { store.patches.push(JSON.parse(init.body).settings); return json(200, {}); }
    }
    if (url === `${g}/controls`) {
      if (method === 'GET') return json(200, { actions: [{ action: 'hint', codes: ['KeyJ'] }] });
      store.controls.push({ method, body: init.body && JSON.parse(init.body) });
      return json(200, {});
    }
    if (url === g) return json(200, { leaderboardId: 'lb-1' });
    if (url.startsWith('/api/v1/leaderboards/lb-1/entries')) return json(200, { items: [{ userId: 'u-1234567890', score: 42, rank: 1 }] });
    return json(404, {});
  };
  return { calls, store, fetch };
}
function launch(hash, hostname) {
  const loc = { hash, pathname: '/', search: '', hostname, href: `https://${hostname}/${hash}`, origin: `https://${hostname}` };
  const win = { location: loc, history: { state: null, replaceState(_s, _t, url) { loc.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; } } };
  const sh = SDK.create({ window: win, fetch: net.fetch, ...timers });
  globalThis.window = { StarHermit: sh, addEventListener() {} };
  globalThis.document = { addEventListener() {}, visibilityState: 'visible' };
  return { loc, sh };
}
beforeEach(() => {
  net = stubNet();
  local = [];
  globalThis.fetch = async (u) => { local.push(String(u)); return { ok: false, status: 404, json: async () => ({}) }; };
});

test('hosted: token, nickname, cloud save, settings KV, controls, board', async () => {
  const { loc } = launch(`#game_token=${TOKEN}`, 'localhost');
  const p = await new Platform().init();
  assert.equal(p.hosted, true);
  assert.equal(loc.hash, '');
  assert.equal(p.slug, 'royal-circuit');
  assert.equal(p.sub, 'u-1234567890');
  assert.equal(await p.fetchNickname(), 'Lantern Lu');
  assert.deepEqual(local, [], 'no dev-server probe while hosted');

  assert.equal(await p.cloudLoad(), null);
  const statuses = [];
  p.onSyncChange = (s) => statuses.push(s);
  p.queueCloudSave({ version: 1, payload: { stats: { gamesWon: 2 } } });
  await p.flushCloudSave();
  assert.ok(net.calls.some((c) => c.method === 'PUT' && c.url === '/api/v1/me/cloud-saves/game%3Aroyal-circuit'));
  assert.deepEqual(await p.cloudLoad(), { version: 1, payload: { stats: { gamesWon: 2 } } });
  assert.deepEqual(statuses, ['saving', 'synced']);

  const settings = { audio: { music: 0.7, effects: 0.9 }, theme: 'lantern-pavilion', input: { bindings: null }, accessibility: { leftHanded: false } };
  assert.equal(await p.applyPlatformSettings(settings), true);
  assert.deepEqual(settings.audio, { music: 0.1, effects: 0.9 });
  assert.equal(settings.theme, 'moon-garden');
  settings.accessibility.leftHanded = true;
  p.mirrorSettings(settings);
  await sleep(700);
  assert.deepEqual(net.store.patches.at(-1), { accessibility: { leftHanded: true } });

  const b = await p.loadBindings({ hint: ['KeyH'], undo: ['KeyU'] });
  assert.deepEqual(b, { hint: ['KeyJ'], undo: ['KeyU'] });
  p.setControl('undo', ['KeyZ']);
  p.resetControls();
  await sleep(10);
  assert.deepEqual(net.store.controls.map((c) => c.method), ['PUT', 'DELETE']);
  assert.deepEqual(net.store.controls[0].body, { bindings: { undo: ['KeyZ'] } });

  assert.deepEqual(await p.fetchGlobalBoard(), [{ rank: 1, name: 'Lantern Lu', score: 42 }]);
  assert.ok(net.calls.every((c) => c.auth === `Bearer ${TOKEN}`));
  assert.ok(p.inviteLink().endsWith('/game-invite/u-1234567890/royal-circuit'));
});

test('standalone on the platform host: no network; sign-in offered', async () => {
  launch('', 'royal-circuit.starhermit.com');
  const p = await new Platform().init();
  assert.equal(p.hosted, false);
  assert.equal(p.canSignIn(), true);
  assert.equal(await p.fetchNickname(), null);
  assert.equal(await p.cloudLoad(), null);
  p.queueCloudSave({ a: 1 });
  await p.flushCloudSave();
  assert.equal(await p.applyPlatformSettings({ audio: {} }), false);
  p.mirrorSettings({ audio: { music: 1 } });
  assert.deepEqual(await p.loadBindings({ hint: ['KeyH'] }), { hint: ['KeyH'] });
  p.setControl('hint', ['KeyJ']);
  p.resetControls();
  assert.equal(await p.fetchGlobalBoard(), null);
  assert.equal(p.inviteLink(), null);
  await sleep(700);
  assert.deepEqual(net.calls, []);
  assert.deepEqual(local, [], 'no dev-server probe on a StarHermit host');
});

test('standalone locally: no network request at all', async () => {
  launch('', 'localhost');
  const p = await new Platform().init();
  assert.equal(p.canSignIn(), false);
  assert.ok(Math.abs(p.now() - Date.now()) < 50, 'device clock');
  p.setConsent(true);
  p.track('start', { mode: 'practice' });
  assert.equal(p.funnel.length, 1, 'telemetry stays in memory');
  assert.deepEqual(local, [], 'no own-server probe or telemetry');
  assert.deepEqual(net.calls, []);
});
