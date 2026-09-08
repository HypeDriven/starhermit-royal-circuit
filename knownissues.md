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
and `src/ui.js` is where the most serious defect below lived.

Ad-hoc headless-Chrome coverage: boot, every title mode card, a Daily Circuit round started and
driven through hint/pause/resume, a 70-click random UI crawl, and a corrupt-`localStorage` reload
matrix (`{"broken":`, `null`, `[]`, `{}`, non-JSON — all booted cleanly).

### Review pass 2026-09-07

| Check | Result |
| --- | --- |
| `npm test` | 249806 + 68 assertions pass, 0 failed (re-run after the fixes) |
| `node --check` on all modules + tests | clean |
| `tests/e2e.mjs` (headless Chrome, desktop + mobile) | **E2E PASS**, no page errors |
| Hosted WebSocket probe (2 clients, real protocol) | no `rng` / `ruleset.seed` in any client snapshot; roll still applies and broadcasts |
| Two-browser hosted round against `server.js` | create → join → start → roll visible on both clients, zero console errors |
| Browser smoke (practice: pause → Escape → play on, 6 turns, reload → resume) | pass, zero console errors, zero failed requests |

Still without automated coverage: `src/ui.js`, `src/session.js`, `src/ai.js`, `src/save.js`,
`src/platform.js`, `server.js` (all exercised only through the e2e/smoke runs above).

**Not implemented:** UI text is English only. `agents/localization.md` asks for US/UK English,
es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT; no string table or locale switch exists yet,
and adding one touches every screen in `src/ui.js`.

## Confirmed defects

None outstanding. The two defects recorded by the 2026-08-20 pass were fixed on 2026-09-07;
see Resolved #5 and #6.

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

### 5. Hosted play broadcast the RNG state — any client could predict every die roll

- **RESOLVED 2026-09-07.** `server.js` now builds every client-visible snapshot through
  `publicState()`, which strips `state.rng` and `ruleset.seed` before `begin`, `applied`,
  `rejected` (stale-tick resync), reconnect `room` replies and spectator joins. The client
  never applies commands in hosted play, and nothing it renders or evaluates (legal actions,
  hints, ranking, score breakdown) reads the stream, so the redaction is behaviour-neutral.
  Verified with two live WebSocket clients against a running server: `has rng: false`,
  `has ruleset.seed: false` on both `begin` and `applied`, and a roll still applied and
  broadcast normally; and with a two-browser hosted round (create → join → start → roll
  visible on both clients, zero console errors).

### 6. The Leaderboards overlay claimed submissions were validated

- **RESOLVED 2026-09-07.** `src/ui.js` `showBoards` now states the truth: the records are stored
  on this device only, are not submitted or compared against other players, and the board is
  labelled casual — matching spec.md §Achievements and leaderboards ("If validation is
  unavailable, label the board casual"). The impossible-score rejection it does perform
  (`pushBoard`) is still described. spec.md records the same constraint.

### 7. Escape on the pause panel froze the match

- **RESOLVED 2026-09-07.** `hideOverlay('pause')` dismissed the panel but left `AppState.PAUSED`
  and `session.paused === true`, with no visible way back. `hideOverlay` now resumes when the
  pause panel is closed while paused, and `resumeGame` hides the panel directly to avoid
  recursion; Restart/Leave hide it without resuming so their confirm prompts still run paused.

### 8. Resuming a saved game lost the stage/lesson it belonged to

- **RESOLVED 2026-09-07.** `Session.restore` accepts `{content, lesson}` and `resumeSnapshot`
  resolves the saved `contentId` into `app.lesson` for lessons and `app.content` otherwise.
  Previously a resumed lesson crashed `enterGameScreen` (`app.lesson.title` on a stale null) and
  a resumed stage scored as an anonymous match (`results.contentId === null`, no goal chip).

### 9. Watching a replay double-counted progression

- **RESOLVED 2026-09-07.** `watchReplay` clears `app.replayMode` before calling `showResults`
  again with the real session, so `updateProgression` ran a second time — inflating games played,
  captures, crowned, achievements and pushing a duplicate board row. Progression is now applied
  at most once per session (`session.progressionApplied`).

### 10. Hosted results used seat 0 instead of the player's own seat

- **RESOLVED 2026-09-07.** `updateProgression`, `pushBoard` and the win/lose sting in
  `onSessionEvent` now derive `mySeat` from `app.hosted.seat` in hosted play, so a player in
  seat 1-3 no longer records another seat's win/captures (and no longer hears a victory sting
  for seat 0's win).

### 11. `favicon.svg` and `icon.png` 404ed when served by `server.js`

- **RESOLVED 2026-09-07.** The static allowlist in `serveStatic` covered only `index.html`,
  `styles.css`, `favicon.ico` and the asset directories, so the icon `index.html` references
  failed under the game's own host. Both root icons are now allowed. `index.html` also carried a
  leftover placeholder data-URI `<link rel="icon">` after the real artwork landed; it is removed
  and an `apple-touch-icon` points at `icon.png`.

### 12. Pausing did not stop the AI turn already scheduled

- **RESOLVED 2026-09-07.** `Session.driveAI` only checked `paused` at the top of the loop, so a
  pace timer that had already fired played one more AI move after the pause panel opened.
  `pauseGame` now calls `cancelPending()`, and `driveAI` re-checks `paused`/`cancelled` after the
  pace tick. `cancelPending` resolves the waiter (instead of leaving it hanging) so resuming can
  re-drive the AI.

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
