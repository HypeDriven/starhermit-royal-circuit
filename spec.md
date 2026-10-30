# Royal Circuit — Product and Game Specification

**Document status:** running specification of the shipped game on the StarHermit engine.  
**Game index:** 76  
**Genre:** Turn-based race board  
**Players:** 2–4 players depending on ruleset, plus practice AI  
**Targets:** the StarHermit client (native) and browsers through the engine's web runtime; desktop, phones and tablets, landscape and portrait  
**Implementation:** a StarHermit engine script game (engine 1.30.0, `engine.minor=32`): `native/*.ts` over the pure rules, AI, content, session and save modules in `src/`; the pavilion on `starhermit:scene`, every screen on `starhermit:ui`

## 1. Product vision

Royal Circuit is a game in which players race four tokens from home around a shared track using die rolls, captures, and safe spaces. Its signature setting is a festive circular board in a lantern-lit pavilion. The product should feel immediately understandable, responsive within one input, and polished enough that the board or playfield itself is the visual hero. Sessions should begin quickly, make the next useful action obvious without solving the game for the player, and end with a clear explanation of score and progress.

The experience must be original. Do not copy names, layouts, characters, iconography, writing, audio, progression maps, or level data from an existing title. Use an original visual language, original procedural assets, and internally authored content.

### Design pillars

1. **Readable before spectacular:** legal actions, hazards, selection, ownership, and goals remain legible with effects disabled.
2. **One-input confidence:** every press, tap, drag, key, or pointer action gives immediate visual and sonic acknowledgment.
3. **Short path to play:** a returning player reaches the primary playfield in at most two deliberate actions.
4. **Fair mastery:** randomness is seeded and inspectable; outcomes never depend on hidden purchases or invisible stat boosts.
5. **Scalable beauty:** the same art direction survives low-power mobile hardware and high-resolution desktop displays.

## 2. Core game design

### Objective and rules contract

Race four tokens from home around a shared track using die rolls, captures, and safe spaces.

The rules engine must represent legal actions independently from rendering. It must expose legal-action queries, deterministic resolution, serializable state, a monotonically increasing turn/tick number, and a terminal-state reason. Tutorials and hints call the same legal-action API used by play rather than duplicating rules.

### Core loop

The repeated loop is: **roll, choose a legal token, move, resolve captures or safe spaces, and pass**. Input is locked only during the shortest non-interruptible resolution phase. Cosmetic animation may continue after the logical state is ready, but skip/fast-forward must settle every object into the exact deterministic end state.

### Scoring and victory

Win by bringing every token home; expose rule variants before room creation. Results show a component breakdown rather than one unexplained total. Store integers for score and simulation units; format values only in presentation. Ties use, in order: primary objective completion, fewer invalid actions, lower authoritative elapsed time, then stable session identifier.

### Modes

- **Learn:** interactive lessons introduce one rule at a time and require the player to perform the action.
- **Journey:** authored progression with gradually combined mechanics and periodic mastery stages.
- **Daily:** one shared seed and ruleset per UTC day, from the platform's clock (`serverNow()`), the device's when it has not answered.
- **Practice:** selectable difficulty, restart, undo where rules permit, and no effect on competitive rating.
- **Challenge:** constrained goals such as move limits, speed targets, altered layouts, or restricted tools.
- **Hosted play:** not offered (the browser build never used the dev server's room relay either). Hosted play without a server referee would not be recorded; a future version would use StarHermit rooms with a room-bound session whose server script referees the result.

### Difficulty and content generation

- Represent content as versioned data: identifier, seed, initial state, goals, allowed mechanics, par values, tutorial flags, and presentation theme.
- Run offline validators to prove basic legality, reachable goals, bounded duration, and absence of soft locks. Logic puzzles additionally require a unique or explicitly accepted solution class.
- Difficulty is measured from solution depth, branching factor, time pressure, motor precision, hidden information, and recovery options—not merely larger numbers.
- Introduce one new concept in isolation, combine it with one known concept, then test mastery before adding another.
- Daily seeds are immutable after publication. If content is defective, mark the day excluded from ranking rather than silently replacing it.

### Game-state model

`boot → title → profile-ready → mode-select → preparing → tutorial/countdown → active ↔ paused/reconnecting → resolving → results → progression`.

Every transition has one owner and an explicit reason. Backgrounding pauses solo simulation. In hosted play, the authoritative clock continues where rules require it, while the returning client receives a fresh snapshot and a concise “while you were away” summary.

## 3. Interaction and user-interface design

### Information hierarchy

1. **Primary:** playfield, current objective, legal interaction target, and immediate danger or turn state.
2. **Secondary:** score/progress, remaining moves or time, opponent/party status where applicable.
3. **Tertiary:** settings, social controls, cosmetics, help, and history.

The 3D board fills the window but is never the only UI: menus, text, settings and assistive descriptions are `starhermit:ui` widgets over it, and the float picker's buttons are placed from the shared layout model (`src/boardlayout.js`) projected through the camera, so they sit over the floats they move.

### Responsive layouts

The old media queries are layouts `native/screens.ts` picks from the window's logical size (the window less its safe area, divided by the UI scale), every frame:

- **Wide (≥ 1024 logical px, not short):** the board fills the window; the top bar (mode and objective box at the start, the player chips in the middle, ☰ board state and pause at the end), the objective/progress/rules rail at the left and the turn rail (turn line and die) at the right, both centred vertically; the float picker's buttons float over their floats (docked over the tray when two would overlap or a float is off screen).
- **Compact (< 1024):** the rails become drawers behind **Objective** and **Turn** toggles under the top-end buttons (one open at a time, above the tray); the float picker is a docked row over the tray, above an open drawer.
- **Phone (≤ 700):** the objective line is hidden (the mode name stays), the player chips move to a row under the top bar beside the drawer toggles when the bar has no room, the tray spans the width with Roll growing, the banner and the lesson coach sit under the chips and toggles.
- **Short landscape (≤ 500 px tall):** compact top bar and tray, the title's head shrinks so Play and the mode cards share the first screen.
- Pages (title, setup, journey, learn, challenges) centre their column and scroll as a whole when taller than the window; overlays scroll inside their panel with the heading kept at the top when they open.
- Large windows need no extra scaling: the runtime's UI scale (Options) scales every widget.

### Screens and overlays

- **Title:** 🏮, the title and tagline, **▶ Play** (Practice setup), **↺ Resume saved game** for 30 s when an unfinished solo match is stored on this device, the mode cards (Daily Circuit with today's result, Journey with stages complete, Learn, Practice, Challenges), the chips (profile with the sync status when signed in, Achievements, Leaderboards, How to Play, Settings, Invite a friend when signed in) and **Sign in with StarHermit** for guests.
- **Setup:** per mode the title, Practice's players (2–4), AI difficulty (1–3), floats per player (2–4) and rule variants (exact finish, processions, lantern tiles); a summary card of rules, expected duration, ranked or not and assists; Back and Start (focused for keyboards and pads).
- **Journey map** (40 stage cells with stars, mastery stages framed, locked until the previous stage is done), **Learn** (six lessons, each unlocked by the one before), **Challenges** (six, with the best local score).
- **Match HUD** as in Responsive layouts; the action tray has Roll (with the last die face), Pass (only when no move exists), Undo (Practice, Learn) and Hint; the turn banner, the caption line for sound captions, the lesson coach (Learn) and toasts at the top end.
- **Pause:** Resume (first), Settings, How to Play, Restart (confirmed), Leave Game (confirmed; the solo match stays resumable).
- **Settings** (the game's own; the rest is the runtime's Options): Open Options and Key bindings buttons, sound captions, camera view (Auto / Top / Low), visual theme (five), the controls line (current key bindings), the left-handed tray, the colour palette (Standard / CVD-safe), timing assistance, Replay tutorial lessons.
- **Results:** the headline (Victory / Defeat / The lanterns dim… / Lesson Complete!), why it ended, the goal chip, the table (place, player with the score breakdown, crowned, captures, score), seed, turns and time, the leaderboard line when signed in, new achievements, the journey stars; Watch Replay (re-plays the recorded commands at 550 ms, Escape / Enter / Backspace returns), Retry, and the next recommended action (next stage, next lesson, back to title).
- **How to Play** (rule cards with the current key bindings), **Achievements**, **Leaderboards** (local Daily / All-time boards; the festival board's top 20 when signed in), **Profile** (display name — editable for guests, the account's when signed in; stats; Erase all local progress, confirmed), **Board State** (the board as text: who acts, the die, each float's place), **Confirm** dialogs.

### Input

- **Keys** (`control.*` in starhermit.txt, remappable in the runtime's Options › Controls): Space / Enter / Numpad Enter roll, move the picked float or pass; ←/↑ and →/↓ pick the previous / next legal float (the board lifts it and rings it); Backspace cancels the pick; U undo; H hint (picks the master AI's choice); C resets the camera; B opens the board state; Escape / P pause. With a HUD button focused (Tab), Enter is the button's and the arrows hand the keys back to the board.
- **Gamepads** (`engine.gamepad.*`): South confirm, East cancel, D-pad / left stick pick, West undo, North hint, Start pause, Right stick press camera, Select board state; the runtime's focus navigation works in every panel.
- **Pointer and touch:** the buttons; a tap on the die rolls, a tap on one of your floats moves it when the roll allows (an explanation otherwise), a tap on another float describes it; a drag (more than 9 px) orbits the camera (pitch clamped, distance fitted). Presses over a widget belong to the widget. Escape (or the gamepad's East) closes panels.

### Accessibility

- Every control is a widget with an accessible name; the float picker's buttons are the board's legal targets ("Float 2: kindle!"), the board state panel is the board as text, and turn, objective, hint, error and result lines go to the screen reader (one announcement a frame).
- Colour is reinforced by shape (round, square, triangle, hexagon floats and chip marks) and labels; the game's CVD-safe palette uses the Okabe–Ito colours and a blue accent.
- The runtime's Options carry reduced motion (no die tumble, hops, shake, bursts or ambient animation; event timing kept), high contrast (the old body.high-contrast tokens), larger text (the UI scale and text size), vibration (captures and errors buzz on phones) and the sound volumes; the game keeps captions, timing assistance (1.1 s AI pauses, longer banners) and the left-handed tray.

### Localization

Every player-facing string ships in en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT (`src/i18n.js` + `src/locales/*`, English source text as keys; the StarHermit chrome strings in `src/shstrings.js`). The language is the runtime's interface language (Options › Language, else the account's preferred language, else the device's), mapped to the nearest shipped locale (es-MX → es-419, en-AU → en-GB, pt-PT → pt-BR, fr-BE → fr-FR); every string is drawn through `T()` each frame, so a change shows on the next frame without restarting the match. Built-in names (AI rivals, seats, Guest Envoy) translate; players' own names do not.

## 4. Visual and audio design

### Visual contract

The subject is the active playfield at near-tabletop to room scale, framed so state changes occupy most of the screen. The scene is a festive circular board in a lantern-lit pavilion. Use an authored camera, original procedural geometry, restrained environmental storytelling, and a deterministic visual seed. The no-post-processing baseline must still communicate hierarchy, depth, selection, and state.

### Scene design (starhermit:scene)

- Use physically based lighting and color management with one dominant key, soft environment fill, and contact grounding. Gameplay colors are tested after tone mapping.
- Build reusable semantic meshes for active pieces, board cells, obstacles, targets, and environment modules. Geometry detail follows silhouette importance and camera distance.
- Use instancing for repeated pieces and props, pooled effects, texture atlases where appropriate, and explicit disposal on scene changes.
- Separate render layers for environment, gameplay, selection/ghosts, effects, and UI anchors. Cosmetic particles never intercept raycasts.
- Selection uses a combination of lift/pose, outline or rim, and grounded marker—not bloom alone. Legal targets preview before commit; invalid targets explain why.
- Event hierarchy: input acknowledgment < legal move < combo/goal < round completion. Reserve camera motion, strong emission, and dense particles for the highest tier.
- Audio uses original short transients tied to logical events, layered material impacts, quiet ambience, and adaptive music stems. Randomized pitch/variant is seeded for replay consistency where recording matters.

### Camera and motion

- Choose orthographic or low-distortion perspective according to depth requirements; expose framing constants rather than magic offsets.
- Camera transitions use authored duration/easing or critically damped springs and remain interruptible. Never animate by cumulative per-frame lerp.
- Decorative motion is paused or reduced when hidden. Gameplay animation derives from simulation state and interpolation alpha, not frame count.
- Camera shake is low-amplitude, event-tiered, disabled by reduced motion, and never changes raycast truth.

### Graphics-skill routing

During implementation, begin with `threejs-skill-router` and load only the following retained skills because they materially affect this visual target:

- `threejs-camera-direction` for deliberate framing and input-safe camera transitions
- `threejs-procedural-geometry` for authored, inspectable meshes instead of primitive-only placeholders
- `threejs-procedural-materials` for coherent PBR surfaces, perceptual parameters, and readable state masks
- `threejs-procedural-animation` for deterministic motion phases, springs, and interruption-safe transitions
- `threejs-procedural-vfx` for bounded particles, trails, impact accents, and event hierarchy
- `threejs-exposure-color-grading` for tone mapping, adaptation limits, and accessible color separation
- `threejs-image-pipeline` for explicit depth/color ownership and pass ordering
- `threejs-visual-validation` for fixed-view captures, seed sweeps, and performance evidence

Follow the skill pack's acceptance gate: deterministic seeds, debug views for controlling fields, perceptually grouped parameters, mechanism-backed quality tiers, and a readable no-post baseline. Do not add an effect merely because a skill exists.

### Performance budgets

- Target 60 fps at the default tier and a stable 30 fps fallback on constrained mobile hardware.
- Default active gameplay: ≤150 draw calls desktop, ≤90 mobile; ≤350k visible triangles desktop, ≤140k mobile; transient particles ≤20k desktop and ≤5k mobile.
- Cap device pixel ratio by quality tier; dynamically lower render scale before dropping simulation rate. UI text remains native resolution.
- Avoid runtime shader compilation during active play by prewarming required variants. Avoid per-frame allocations in simulation/render loops.
- Quality tiers independently control shadows, environment detail, particles, post effects, antialiasing, and render scale; they never alter rules or visibility of hazards.

### Graphics

The pavilion (`native/render.ts`) is the browser build's three.js r160 scene on `starhermit:scene`: one warm key light with soft shadows (render.js's fitted orthographic shadow box, bias and normalBias), a hemisphere fill and the flickering pavilion point light (r160 intensities as written), ACES filmic tone mapping at exposure 1.12; the circuit's lacquered tiles framed by gold rims, gold inlay rings under the safe tiles' lanterns, the dais, pillars and roof, twelve perimeter lanterns with festoon bulbs on wires, per-seat workshop pads, start rings and coloured approach steps, the floats (gold base, the seat's shape, a lamp top, a selection ring), the pip-faced die, pulsing hint rings, burst particles and drifting embers under the starry WGSL sky dome; the theme recolours board, lanterns, sky and fog. Reflections are `new RoomEnvironment(renderer)` (as the r160 page called it) as each lit material's own environment map at its old intensity.

**Quality.** The runtime's Options choose the graphics level (Auto from the device, render scale, frame-rate limit, adaptive resolution, the FPS readout); `native/quality.ts` maps its tier to the browser build's preset table and budgets:

| | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Shadows | off | 1024 | 2048 | 4096 |
| Ambient occlusion | off | off | on (8 samples) | high (16) |
| Bloom (0.42 / 0.4 / 0.92) | off | on | on | on |
| Display grade + vignette | off | on | on | on |
| Anti-aliasing | MSAA | FXAA | SMAA | MSAA |
| Reflections, textures, sky dome, festoon | off | on | on | on |
| Shading | Lambert | Standard | Physical (clear-coat) | Physical |
| Wood / flagstone texture (tile ½) | 128 px | 256 px | 256 px | 512 px |
| Curve detail | ½ | ¾ | full | 1½× |
| Burst pool / embers (scaled ≤ 1.5× by the level within the tier) | 20 / – | 120 / 50 | 160 / 70 | 240 / 100 |

The circuit, floats, die, hit areas and rules are identical on every tier. The old panel's per-effect overrides are not offered (the runtime's Options choose a level).

**Sound** (`native/audio.ts`): the authored one-shots (`sfx/*.opus`) per event on the effects bus; the adaptive music (pad, seeded pentatonic pluck, kick and shaker, bell accents at 76 BPM in the moods title, calm and tense — themes with a tense mood play tense in matches) rendered once into clips a slice a frame and crossfaded over 1.4 s; the pavilion ambience (a low-passed noise wash breathing at 0.09 Hz with seeded wind-chime plinks) rendered into a 30 s loop on the music bus at the old ambience-to-music ratio. The runtime's Options own the volumes, mute and voice limit; pausing and a hidden window silence the loops.

## 5. Technical architecture

### Client modules

- `src/rules.js`: pure deterministic state transitions, legality, scoring, seeded random stream (unchanged; also the dev server's referee).
- `src/ai.js`, `src/content.js`, `src/boardlayout.js`, `src/rng.js`: the AI levels and hint scorer, themes / lessons / Journey / challenges / Daily / achievements, the shared board layout, the streams (unchanged).
- `src/session.js`: one match: validated commands, undo, replay envelope, snapshots; an injected clock and `aiStep()` (one AI decision) so the client paces AI turns on fixed steps.
- `src/save.js`: the progression document, `mergeSaves`, the browser build's wrapped cloud document (`readForeign`), the device snapshot.
- `src/options.js`: the game's own options and the browser build's settings KV mapping.
- `src/i18n.js`, `src/locales/*`, `src/shstrings.js`: the nine locales.
- `native/main.ts`: the controller (screen flow, turn flow, AI pacing, lessons, progression, replay, input, lifecycle); `native/screens.ts`: every screen and overlay on `starhermit:ui`; `native/render.ts`: the pavilion; `native/audio.ts`, `native/platform.ts`, `native/quality.ts`, `native/style.ts`, `native/i18n.ts`, `native/game.ts` (typed facade over `src/`).

No module mutates rules state except through a validated command. Rendering reconciles from the rules snapshot; UI state and simulation state are separate so closing a drawer cannot affect a match.

### Determinism, replay, and security

- The client runs on the runtime's fixed 60 Hz steps: AI pacing (650 ms, 1100 with timing assistance), event playback tweens, banners, captions, toasts, the lesson's closing card and the replay all count steps, so slow frames never change a match and play scripts replay exactly.
- Use separate seeded random streams for rules, content decoration, and audiovisual variants. Cosmetic randomness never changes rules.
- Replay envelope: schema version, build/content version, seed, initial hash, timestamp offset, ordered commands, periodic state hashes, terminal result.
- Validate all network input for identity, session membership, turn/tick, bounds, rate, payload size, and legal action. Reject duplicates idempotently by command ID.
- Treat client clocks, scores, inventories, roles, physics outcomes, and completion claims as untrusted in competitive contexts.

### Loading and resilience

- The engine package is the game (`starhermit-files.json` pins every file); the runtime shows its own start screen while shaders compile.
- The in-progress solo match is snapshotted on this device after every command (`royal-circuit:snapshot:v1` in the device key/value storage) and offered as "Resume saved game".
- A hidden window pauses the match (the pause panel), silences the loops and flushes the save.

## 6. StarHermit integration

### Packaging and launch
- `starhermit.txt`: name, description, owner, `server=score-script.js`, cover, `launch=index.html`, `engine.api=1`, `engine.entry=native/main.ts`, `engine.version=1.30.0`, `engine.minor=32`, `engine.capabilities=platform,storage,clipboard`, the `control.*` keys and `engine.gamepad.*` buttons with their groups.
- `npm run package` (`starhermit package --web .`) writes the web loader `index.html` and `starhermit-files.json`; `.starhermitignore` leaves out tests, tools, docs, the dev server and documents.

### Identity, saves and settings
- Signed in, the title's profile chip and Profile show the account's display name; guests keep the local name (editable in Profile).
- Progress is the runtime's save (`saves`, schema 1: the device at once and the player's cloud slot): two devices' saves merge on a conflict (`mergeSaves`: best stars and fewest turns per stage, every lesson, the better daily per date, every achievement at its earliest unlock, the larger counters, both local boards, the higher rating). The browser build's cloud slot (`game:<slug>`, its versioned, checksummed document) shows as foreign: it is merged in and replaced once. Guests' old browser localStorage progress cannot migrate.
- The game's options are engine `settings` (synced with the account). The browser build's settings KV groups are read once (captions, palette, timing assistance, left-handed, camera, theme carry over unless set since) and removed; its volumes, graphics, accessibility toggles, bindings and language are the runtime's Options now.
- **Invite a friend** copies the platform's invite link (signed in). Sign-out shows a toast; progress stays on the device.

### Achievements and leaderboards
- The nine achievements (`content.js` ACHIEVEMENTS) unlock idempotently in the save and show in the results and the Achievements panel.
- Local boards (Daily and All-time, top 50, impossible scores rejected) stay in the save and sync with it; they are personal bests, never submitted.
- Signed in, every finished Journey, Daily or Challenge match posts the player's total (clamped at 0) through `score-script.js`: a practice session whose socket carries `{ type: 'result', scores: { 'high-score': n } }`; the script range-checks it (integer 0–20,000) and returns it in `scores` (the platform records it), then the results show "Leaderboard rank: #N" (or posted / not posted). Practice, lessons, replays and guests post nothing. Solo scores are client totals range-checked by the script (the user's decision for solo ports); there is no multiplayer to referee.

### Publishing and operations
- `server.js` stays the local dev server (static files, `/api/v1/time`, the unused room relay); it is not part of the package. The user publishes; pushing does not.

## 7. Content, economy, and retention

- Launch scope: tutorial sequence, at least 40 authored stages or equivalent procedural depth, daily challenge, practice, five visual themes, and a mastery track.
- Cosmetic rewards may alter materials, trails, board surrounds, ambience, or profile flourishes, but never hitboxes, timing windows, information, or power.
- Reward cadence: early feedback every session, meaningful unlock every 3–5 sessions, and long-term goals visible without manipulative countdowns.
- No real-money wagering, paid random rewards, forced advertising, energy pressure, punitive streak loss, or purchases that affect competitive outcomes.
- Notifications, if ever added by the host, are opt-in, frequency-capped, quiet-hour aware, and never use false urgency.

## 8. Analytics and privacy

Measure tutorial completion, first meaningful action time, session duration bands, level attempts, quit state, input modality, performance tier, reconnect success, and accessibility feature usage only in aggregate. Use random session identifiers, short retention, and explicit consent where required. Never collect message content, drawings, voice, private board notes, or exact pointer trails as analytics.

Success targets for the first public test: median first-play time under 20 seconds, tutorial completion above 80%, crash-free sessions above 99.5%, p95 input acknowledgment below 100 ms locally, and at least 95% of supported mobile sessions holding their selected frame-rate tier.

## 9. Testing and acceptance criteria

### Rules and content

- Unit-test every legal action, invalid-action reason, scoring component, terminal state, and serialization migration.
- Property-test deterministic replay: the same version, seed, and commands produce identical state hashes.
- Fuzz malformed commands and generated content; prove no hangs, NaN physics, impossible mandatory states, or unbounded loops.
- Golden-test representative easy, medium, hard, interrupted, resumed, and terminal sessions.

### Interface and accessibility

- Test pointer, coarse touch, keyboard-only, gamepad, screen reader, zoom to 200%, reduced motion, high contrast, safe areas, and both mobile orientations.
- Verify focus restoration after every modal, meaningful live announcements, no keyboard traps, and no hover-only instructions.
- Confirm all critical labels fit translated strings at 30% expansion and support right-to-left layout where localized.

### Graphics and performance

- Produce fixed-camera captures for every quality tier, deterministic seed sweeps, no-post baselines, debug-view mosaics, and 10-minute temporal stability runs.
- Profile CPU, GPU, memory, shader compilation, draw calls, triangles, texture memory, and garbage collection on representative desktop and mobile classes.
- Verify effects cannot obscure legal targets, alter picking, leak resources, or continue expensive updates while hidden.

### Platform and network

- Signed-in paths (cloud merge, the foreign save, the settings KV, score posting) are covered by unit tests of their pure parts (`tests/progress.test.mjs`, `tests/save.test.mjs`); they cannot be driven live here.

### Checks (`npm test`)

- `npm run test:unit`: `tests/rules.test.mjs` (249,806 assertions), `tests/content.test.mjs`, `tests/session-regression.mjs`, and node:test suites `save`, `progress` (save model, foreign slot, options, legacy KV, injected clock, AI turns, replay verification) and `i18n` (every key in `native/*.ts`, `src/`, the captions and content tables translated in all locales with the same placeholders, no stale rows).
- `npm run test:native` (`tests/native.mjs`): the web index is current, `tsc` (TypeScript 5.9, strict, no skipLibCheck), `starhermit check .` with zero warnings, and the play scripts from `tools/gen-plays.mjs` as signed-out render checks: Journey 1–2 by keys on a desktop, the six lessons by finger on a DPR-3 phone (generated from the rules), the menus and a paused Practice with undo, hint, board state, leave and resume, and today's Daily by keys in short landscape.
- `npm run test:browser` (`tools/browser-play.mjs`): the packaged game in Chrome on the GPU at desktop, phone (DPR 3) and landscape (DPR 3) — Journey 1 by mouse with an orbit drag and a pause, lessons 1–2 by finger, a Practice by keys with pause, settings and leave — failing on console errors or warnings.

## 10. Definition of done and non-goals

This specification is ready for implementation when rules examples, content schema, wireframes for all responsive breakpoints, visual target frames, accessibility annotations, authoritative message schema, achievement definitions, leaderboard definitions, and performance test devices are approved.

This document does **not** authorize implementation, asset production, monetization work, native wrappers, real-money systems, or copying any existing product. The initial build should favor one excellent core loop and a coherent original visual identity over feature breadth.

## Port differences and known limitations

- The old Settings tabs are split: volumes, mute, the concurrent-sound limit, graphics presets and render scale, frame-rate limit, key remapping, language, reduced motion, high contrast, larger text and vibration are the runtime's Options; the game keeps captions, camera, theme, palette, timing assistance and the left-handed tray. The old per-effect graphics overrides, the dead "hold to confirm" switch and the in-memory analytics consent (nothing was ever sent) are gone.
- The music renders two loops per mood (the melodies of loops 0 and 1) instead of a fresh melody every loop; a mood change restarts its loop under the crossfade.
- The title's gold gradient lettering is a flat gold (UI text takes one colour).
- Lesson steps now advance on the events of the batch that just settled; the browser build read the newest batch, so an AI turn queued during a long capture animation could stall "The Capture".
- Elapsed match time follows the fixed-step clock (pauses excluded).
- Guests' old browser localStorage progress and settings do not migrate (cloud saves do).
