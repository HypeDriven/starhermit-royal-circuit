# Royal Circuit — module contracts

These contracts are binding. Every module is an ES module under `src/`. Read the
real sources for exact shapes before coding against them.

## src/rng.js (done)
`hashSeed(str)->u32`, `createStream(seed)->{s}`, `nextInt(st,n)`, `nextRange(st,min,max)`,
`nextFloat(st)`, `pick(st,arr)`, `hashString(str)`, `canonicalJSON(v)`, `hashState(v)`.

## src/rules.js (done)
Constants: `TRACK_LEN=40`, `APPROACH_LEN=4`, `DONE=44`, `SAFE_CELLS`, `START_CELLS`,
`PLAYER_DEFS` (`{key,name,color,shape}` × 4: vermilion/jade/azure/gilded), `REASON_TEXT`.
State: plain JSON; `players[i].floats[]` holds progress ints: `-1` workshop,
`0..39` circuit tile `(startCell(seat)+p)%40`, `40..43` approach lane, `44` crowned.
`createGame(rulesetOpts, players)`, `legalActions(state)`, `applyCommand(state, cmd)`,
`moveBlockReason`, `circuitCell`, `isSafeCell`, `blockadeAt`, `floatsOnCell`,
`rankPlayers`, `scoreBreakdown`, `stateHash`, `cloneState`.
Events emitted by applyCommand: `{t:'roll'|'move'|'deploy'|'capture'|'crown'|'encore'|
'overkindled'|'pass'|'turn'|'resign'|'gameover', ...}`.

## src/boardlayout.js (done)
Pure world-space math shared by render + DOM overlay: `circuitPos(cell)`,
`approachPos(ruleset,seat,step)`, `workshopPos(ruleset,seat,index)`,
`floatPos(ruleset,seat,progress,stackIndex,stackSize)`, `crownPos(seat)`,
`diePos(ruleset,seat)`, `cellAngle(c)`, constants `RING_RADIUS=10` etc.

## src/content.js (done)
`THEMES` (5, with numeric hex palettes + `accentCss/bgCss`), `LESSONS` (6),
`JOURNEY` (40 stages), `CHALLENGES` (6), `ACHIEVEMENTS`, `dailyForDate(date)`,
`CONTENT_VERSION`, `BUILD_VERSION`, `validateContent(def)`.

## src/ai.js (done)
`chooseMove(state, moves, seat, level)`, `AI_LEVELS`, `aiName(level, idx)`, `hintMove`.

## src/render.js (to write — Three.js)
`createRenderer(canvas, opts) -> renderer` with:
- `opts`: `{ theme, reducedMotion, quality, palette, onReady }`
- `setTheme(themeDef)`, `setQuality('low'|'medium'|'high')`, `setReducedMotion(b)`, `setPalette(name)`
- `syncState(state)` — reconcile all entity views from an immutable rules snapshot (idempotent)
- `animateEvents(events, state) -> Promise` — cosmetic playback; resolves when settled;
  `skip()` settles everything instantly into the exact deterministic end state
- highlights: `setMoveHints({moves, die, canRoll, canPass})`, `clearHints()`,
  `setSelection(sel|null)` where sel=`{seat,floatId}`
- `pick(clientX, clientY) -> {kind:'float',seat,floatId}|{kind:'cell',cell}|{kind:'die'}|null`
- `projectToScreen(pos) -> {x,y,visible}` (CSS px) for DOM label alignment
- camera: `setCameraMode('auto'|'top'|'low')`, `resetCamera()`
- `resize()`, `dispose()`, `stats() -> {drawCalls, triangles, fps}`
- render loop must pause when `document.hidden`; never raycast cosmetic particles

## src/audio.js (to write — WebAudio synth, no assets)
`createAudio() -> audio` with:
- `unlock()` (first gesture), `suspend()`, `resume()`, `dispose()`
- `setVolume(bus, v)` / `getVolume(bus)` for `'music'|'effects'|'ambience'|'voice'`; `setMuted(b)`
- `event(name, opts?)` — names: `ui, select, error, roll, move, deploy, capture, crown,
  encore, overkindled, pass, turn, win, lose, hint, undo`
- `EVENT_CAPTIONS` export: map name → caption string (for captions setting)
- `setMusic(mood)` — `'off'|'title'|'calm'|'tense'|'bright'|'results'`; `setAmbience(on)`

## server.js (to write — Node, zero deps, ESM; package.json has type:module)
Static file server + `GET /api/v1/time` + WebSocket `/ws` rooms with authoritative
rules via `src/rules.js`. Messages JSON: c→s `create|join|start|command|leave|list|ping`;
s→c `room|begin|applied|rejected|presence|result|error|pong` (+ `replyTo` for RPC).
