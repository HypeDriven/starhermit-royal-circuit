# Known Issues — Royal Circuit

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on spark105 (OBLITERATED Q5_K_M),
alongside the game's own test suite, a headless-Chrome crawl, and live WebSocket probes against a
running `server.js`.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | 249806 + 68 assertions pass, 0 failed (`rules.test.mjs`, `content.test.mjs`) |
| `node --check` on all modules | clean (12 modules + `server.js`) |
| `tests/e2e.mjs` (headless Chrome, desktop + mobile) | **E2E PASS** — real pointer tap on the Journey card, round finishes (crown-first, Victory), results shown, progress persisted, results Continue → next stage; no page errors |

The unit suites are extensive but import only from `src/rules.js` and `src/content.js`
(`tests/rules.test.mjs:5-9`, `tests/content.test.mjs:7-12`). `src/ui.js`, `src/session.js`,
`src/ai.js`, `src/save.js`, `src/platform.js` and `server.js` have no automated coverage at all —
and `src/ui.js` is where the most serious defect below lives.

Ad-hoc headless-Chrome coverage: boot, every title mode card, a Daily Circuit round started and
driven through hint/pause/resume, a 70-click random UI crawl, and a corrupt-`localStorage` reload
matrix (`{"broken":`, `null`, `[]`, `{}`, non-JSON — all booted cleanly).

## Confirmed defects

Defects below were each verified by reading the source, not just reported by the model.

### 1. Hosted play broadcasts the RNG state — any client can predict every die roll

- **File:** `server.js:710` (`handleStart`) and `server.js:403` (`commitResult`); state shape at
  `src/rules.js:103-110`; stream format at `src/rng.js:22-25`
- **Trigger:** Join any hosted room and read the `begin` / `applied` snapshot.
- **Behaviour:** The server comments at `server.js:702` that "TRUST: the seed is generated here;
  clients never see it before the fact", then broadcasts the entire authoritative state verbatim:

  ```js
  broadcast(room, { t: 'begin', snapshot: room.state });          // server.js:710
  broadcast(room, { t: 'applied', snapshot: res.state, events: res.events }); // server.js:403
  ```

  `room.state` contains `ruleset` (with `seed`) and `rng`, and `createStream` returns a plain
  `{ s: uint32 }` object that survives `JSON.stringify` (`src/rng.js:22-25`). mulberry32 is
  trivially forward-computable, so a client knows every future roll before deciding its move.
- **Expected:** Snapshots must redact `rng` and `ruleset.seed` (the sibling game `river-stakes`
  attempts exactly this in its `getSnapshot`), or the dice must be committed server-side.
  Note this is a protocol-level defect independent of defect 1: the leak is in what the server
  sends, so fixing the broken "Create a room" form would expose it to real players immediately.
- **Evidence:** Two live WebSocket clients against the running server (port 39508), speaking the
  documented protocol directly:

  ```
  snapshot keys: version,ruleset,rng,forcedRollIdx,tick,turnIndex,round,turnsPlayed,
                 phase,die,sixes,players,winner,reason,lastCommandId
  ruleset.seed leaked to clients: 3660380090
  rng stream state leaked to clients: {"s":3660380090}
  predicted next die: 4
  actual die after roll: 4
  events: [{"t":"roll","seat":0,"value":4}]
  ```

### 2. There are no leaderboards at all, but the UI claims submissions are validated

- **File:** `src/ui.js:601-607` (`showBoards`), `src/save.js:24`, route table at
  `server.js:97-117`
- **Trigger:** Open the Leaderboards overlay.
- **Behaviour:** The overlay reads `app.save.leaderboards[…]` — a purely local array
  (`src/save.js:24`, commented "local boards; hosted boards come from the server") — and then
  prints:

  ```js
  'Submissions include ruleset, content version, seed and duration; impossible or stale-version scores are rejected.'
  ```

  Nothing is ever submitted anywhere: `server.js` serves only `GET /api/v1/time` and
  `POST /api/v1/telemetry` before 404ing every other `/api/` path, and `src/platform.js` contains
  no board or achievement call. The claim in the UI is false.
- **Expected:** spec.md §Achievements and leaderboards — "Provide global and friends-filtered
  boards for the primary metric plus a fair daily/weekly board… For globally competitive boards,
  validate score claims through a lightweight authoritative script… If validation is unavailable,
  label the board casual."
- **Evidence:** The quoted string, `grep -n "leaderboard\|/api" server.js` (only `/time` and
  `/telemetry`), and `grep -n "leaderboard\|board\|friends" src/platform.js src/save.js` returning
  only the local-array declaration.

## Resolved

The defects below were confirmed in the current source and have been fixed (with the real
pointer/touch + keyboard playability verified by `tests/e2e.mjs`).

### 1. The main "▶ Play" button was broken — `segField` crashes on numeric options

- **RESOLVED 2026-09-04.** `src/ui.js:303-319` `segField` now formats a non-string option with
  `String(opt)` (numeric option labels like `[2, 3, 4]` and `AI_LEVELS.map(l=>l.level)` no longer
  index a `Number` with `opt[0].toUpperCase()`). The Practice / Local / Hosted setup groups render
  and Start buttons wire up. Verified: all challenges + journey stages create a game via
  `createGame`, and the e2e drives a full round.
  (This also covered the e2e-reported crash on numeric option arrays.)

### 2. `#gl-fallback` overlay always covered the viewport and blocked every pointer/touch

- **RESOLVED 2026-09-04.** `styles.css:30` added `#gl-fallback[hidden] { display: none; }`, so the
  overlay honours its HTML `hidden` attribute and only shows when WebGL is genuinely unavailable.
  A real pointer tap on the Journey card now reaches the UI (`tests/e2e.mjs` desktop pass), and the
  game is playable by pointer AND keyboard.

### 3. Challenge setup crashed on Start (players mismatch)

- **RESOLVED 2026-09-04.** `src/content.js:244-252` `stageRuleset` now falls back to
  `stage.ruleset.players` when a content definition has no top-level `players` (challenges only
  carry `ruleset.players`), so `createGame` receives a player count matching the 2/3/4-player
  array built from `def.ai` instead of defaulting to 4. Verified: all six challenges create a game.

### 4. Journey "crown-first" objective was UI-only — round only ended on a full crown-sweep

- **RESOLVED 2026-09-04.** `src/rules.js` (`normalizeRuleset` + `checkTerminal`) now recognises a
  `{ type: 'crown-first', count }` ruleset goal and ends the round as soon as a player crowns the
  goal count (reason `crown-first`), instead of only terminating on a full crown-sweep or turn
  limit. `src/content.js` `stageRuleset` threads the stage `goal` into the ruleset. Verified: the
  e2e Journey stage 1 round now finishes (Victory in 44 turns) instead of never terminating.

## Suspected — not confirmed

### 1. The WebGL first-frame deadline is a fixed 4 s

- **File:** `src/bootstrap.js:54` (`setTimeout(() => reject(new Error('first frame timeout')), 4000)`)
- **Concern:** Boot falls back to 2-D if the first rendered frame has not arrived within four
  seconds, regardless of device class. On a slow phone or during a cold shader compile this could
  demote a perfectly capable device to the 2-D board permanently for that session.
- **Why unconfirmed:** On this machine (headless Chrome + SwiftShader, i.e. software rendering) the
  deadline is met comfortably and the 3-D path is used, so no premature fallback could be observed.

## Investigated and rejected

### "Missing Score-chase mode"

An earlier draft of this pass flagged the title mode map (`src/ui.js:1817-1823`:
`daily, journey, learn, practice, challenge, hosted`) for lacking a Score-chase mode.
**That is wrong for this game.** Royal Circuit's own `spec.md` §Modes lists "**Hosted play:**
private invitations and appropriate public matching, with reconnect and authoritative results" as
the sixth mode, not Score chase (that wording belongs to other games' specs in this repo). The
implemented mode set matches the spec. The missing *global boards* of defect 3 remain a genuine
gap, since spec.md §Achievements and leaderboards asks for them independently of the mode list.

## Checked, no defects found

- WebGL: `canvas.getContext('webgl2')` succeeds under headless SwiftShader and `body.no-gl` is
  never set, so the 3-D board is the path actually exercised. **NB:** the earlier claim that
  `#gl-fallback` "stays hidden" was WRONG — its `display: grid` overrode the `hidden` attribute
  and the overlay always covered the viewport. That is fixed (see Resolved #2).
- Suspend/resume: entered a round, performed an action, reloaded the page, and confirmed the
  game re-boots with its snapshot intact and no console errors or failed requests.
- `src/rules.js` + `src/session.js` + `src/ai.js`: roll/move/pass/resign legality, exact-finish,
  blockades, captures, safe tiles, turn rotation, terminal detection, serializable state,
  deterministic AI — ~250k assertions pass, including a golden-hash regression.
- `src/content.js`: themes, six lessons, journey stages and six challenge definitions — 68
  assertions pass.
- `server.js` WebSocket layer: room codes, seat binding (`cmd.seat` is taken from the bound seat,
  never the payload — `server.js:718`), turn and tick validation, idempotent duplicate commands,
  rejected commands never committed, per-connection token bucket with strike-based disconnect,
  64 KiB message cap, abandon timers, and results computed from authoritative state only. Read in
  full; no gap found beyond defect 2.
- Persistence: `royal-circuit:save:v1`, `:settings:v1` and `:snapshot:v1` survive five kinds of
  corrupt payload without a boot failure.
- UI paths other than setup: Daily Circuit runs, pause/resume, help, achievements, settings tabs
  and the boards overlay all open without console errors (70-click crawl produced exactly the two
  `segField` exceptions of defect 1 and nothing else). A separate Daily Circuit session driven
  through 440 Roll/Pass/Move clicks produced zero console errors and zero failed requests.

## Not tested

- `src/render.js` visual output; see the suspected item above.
- Hosted play with 3-4 seats, reconnect via `seatToken`, and the abandon/auto-resign timers.
- Gamepad input.
