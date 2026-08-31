# Known Issues — Royal Circuit

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on spark105 (OBLITERATED Q5_K_M),
alongside the game's own test suite, a headless-Chrome crawl, and live WebSocket probes against a
running `server.js`.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | 249806 + 68 assertions pass, 0 failed (`rules.test.mjs`, `content.test.mjs`) |
| `node --check` on all modules | clean (12 modules + `server.js`) |
| `tests/e2e.mjs` (headless Chrome) | not present — replaced by an ad-hoc CDP boot/mode/crawl sweep (see below) |

The unit suites are extensive but import only from `src/rules.js` and `src/content.js`
(`tests/rules.test.mjs:5-9`, `tests/content.test.mjs:7-12`). `src/ui.js`, `src/session.js`,
`src/ai.js`, `src/save.js`, `src/platform.js` and `server.js` have no automated coverage at all —
and `src/ui.js` is where the most serious defect below lives.

Ad-hoc headless-Chrome coverage: boot, every title mode card, a Daily Circuit round started and
driven through hint/pause/resume, a 70-click random UI crawl, and a corrupt-`localStorage` reload
matrix (`{"broken":`, `null`, `[]`, `{}`, non-JSON — all booted cleanly).

## Confirmed defects

Defects below were each verified by reading the source, not just reported by the model.

### 1. The main "▶ Play" button is broken — `segField` crashes on numeric options

- **File:** `src/ui.js:308` (`segField`), reached from `src/ui.js:390`, `391`, `392`, `403` and
  `1634`
- **Trigger:** Click "▶ Play" on the title screen (or the Practice mode card, or Local Table
  setup, or Hosted Play → Create a room).
- **Behaviour:** `segField` assumes every option is a string:

  ```js
  const b = el('button', { text: opt === 'cvd' ? 'CVD-safe' : opt[0].toUpperCase() + opt.slice(1), … });
  ```

  Five call sites pass numbers — `[2, 3, 4]` for Players / Floats / Seats and
  `AI_LEVELS.map((l) => l.level)` (which is `[1, 2, 3]`, `src/ai.js:20-24`). For a number,
  `opt[0]` is `undefined` and `.toUpperCase()` throws. The exception propagates out of
  `showSetup`, so the rest of the setup screen — including `cfg.floats`, the rule-variant
  checkboxes, the summary card and the Start button wiring — never runs. The player is left on an
  **empty setup screen** whose Start button does nothing.
- **Expected:** The Practice/Local setup renders its option groups; `#btn-play` at `src/ui.js:1816`
  (`showSetup('practice')`) is the primary entry point into the game.
- **Evidence:** Headless Chrome, clicking `#btn-play` on a clean load:

  ```
  STEP clickPlay: "ok"
  STEP setupBody: 0            <- #setup-body has no children
  STEP setupHeading: "Practice Match"
  STEP clickStart: "clicked"
  STEP screenVisible: ["screen-setup"]   <- still on setup; nothing started
  --- console errors (1) ---
  EXCEPTION: TypeError: Cannot read properties of undefined (reading 'toUpperCase')
      at segField (…/src/ui.js:308:72)
      at showSetup (…/src/ui.js:390:17)
      at HTMLButtonElement.<anonymous> (…/src/ui.js:1816:76)
  ```

  The random UI crawl independently reproduced it from both `btn-play` and `card-practice`, and
  `renderHostedHome` (`src/ui.js:1634`) throws the same way.

### 2. Hosted play broadcasts the RNG state — any client can predict every die roll

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

### 3. There are no leaderboards at all, but the UI claims submissions are validated

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

- WebGL: `canvas.getContext('webgl2')` succeeds under headless SwiftShader, `#gl-fallback`
  stays hidden and `body.no-gl` is never set, so the 3-D board is the path actually exercised.
  (The fallback markup is present in `index.html` and therefore shows up in `textContent`
  dumps even while hidden — that is not evidence of a fallback.)
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

- Any Practice, Local Table or Hosted-create flow past the setup screen — blocked by defect 1.
- `src/render.js` visual output; see the suspected item above.
- Hosted play with 3-4 seats, reconnect via `seatToken`, and the abandon/auto-resign timers.
- Touch and gamepad input.
