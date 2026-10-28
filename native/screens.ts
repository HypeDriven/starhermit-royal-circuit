// The browser build's DOM shell (src/ui.js + index.html + styles.css) as
// starhermit:ui, built every frame over the pavilion: the title (Play, the
// five mode cards, the profile / achievements / leaderboards / help /
// settings chips, invite and sign-in), the setup screen per mode (rules,
// duration, ranked, assists; Practice's players, AI, floats and rule
// variants), the Journey map, the lesson and challenge lists, the match HUD
// (mode and objective, the player chips, the board-state and pause buttons,
// the objective/progress/rules rail and the turn rail — drawers behind
// "Objective" / "Turn" toggles on compact windows — the turn banner, the
// caption line, the lesson coach, the action tray with Roll / Pass / Undo /
// Hint and the float picker: one button per legal move, floating by its
// float on wide windows, docked over the tray otherwise), the toasts, and
// every overlay (pause, settings, results, help, achievements, leaderboards,
// profile, board state, confirm). The old media queries are layouts picked
// by the window's logical size: wide (≥ 1024 px), compact (< 1024), phone
// (≤ 700) and short landscape (≤ 500 px tall).
import { frame, openMenu } from "starhermit:engine";
import { bindings, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { AI, Content, Rules } from "./game.ts";
import { N, S, T, pname } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import { token } from "./style.ts";
import {
  app, canAct, canUndo, confirmYes, describeFloat, describeMove, displayName, doHint, doMove, doPass, doRoll, doUndo,
  eraseProgress, flowText, fresh, hideOverlay, invite, later, lbLine, leaveGame, legalMoves, lessonUnlocked, modeName,
  moveAnchor, nextAction, objectiveText, openBoardState, pauseGame, previewPick, restartGame, resultSub, resumeAvailable,
  resumeGame, resumeSnapshot, retryCurrent, rulesList, setProfileName, setupBack, setupStart, sfxPlay, showBoards, showChallenges,
  showDaily, showJourney, showLearn, showOverlay, showSetup, signIn, stageUnlocked, topOverlay, watchReplay, type Overlay,
} from "./main.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; wide: boolean; compact: boolean; phone: boolean; land: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const land = lw > lh && lh <= 500;
  return { lw, lh, sc, wide: lw >= 1024 && !land, compact: lw < 1024 || land, phone: lw <= 700, land };
}
const lastSize = new Map<string, ui.Rect>();
const lastH = (k: string, fallback = 0): number => (lastSize.get(k)?.height ?? fallback * ui.preferences().scale) / ui.preferences().scale;
const lastW = (k: string, fallback = 0): number => (lastSize.get(k)?.width ?? fallback * ui.preferences().scale) / ui.preferences().scale;
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
interface Btn {
  id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string; selected?: boolean;
  content?: () => void; width?: number; height?: number; sound?: boolean;
}
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 2;
function button(b: Btn): boolean {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  if (b.content) opts.content = b.content;
  else if (b.width != null && buttonWidth(b.text, style) > b.width) {
    // a label wider than its button wraps (labels don't)
    const pad = style === "btn-play" ? 132 : 40;
    const inner = b.width - pad;
    const ink = style === "btn-primary" || style === "btn-play" || style === "btn-roll";
    opts.content = () => { ui.style(ink ? "wrap-ink" : "wrap").paragraph(b.text, Math.max(20, inner)); };
  } else if (b.name && b.name !== b.text) opts.content = () => { ui.label(b.text); };
  const s: ui.Style = {};
  if (b.width != null) s.width = b.width;
  if (b.height != null) s.height = b.height;
  const hit = ui.style(style, s).id(b.id).button(b.name ?? b.text, opts);
  if (hit && fresh()) later(() => { if (b.sound !== false) sfxPlay("ui"); b.act(); });
  return hit;
}
/** Buttons at their own widths in rows that wrap at `width` (flex-wrap). */
function flow(label: string, list: Btn[], width: number, gap = 10, justify: "start" | "center" | "end" = "start"): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? "btn"));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button({ ...b, width: bw(b) });
    }, { spacing: gap, width, justify, align: "center" }));
  }, { spacing: gap, width });
}
/** A check box row (a role "checkbox" widget: built-in check box labels don't wrap). */
function toggleRow(id: string, label: string, on: boolean, w: number, set: (v: boolean) => void): void {
  ui.row(`${id}-row`, () => {
    const res = ui.id(id).widget(label, {
      role: "checkbox", checked: on, size: { width: 44, height: 44 }, style: "check",
      draw: (r, st) => {
        const s = st.scale, box = 22 * s, bx = r.x + (r.width - box) / 2, by = r.y + (r.height - box) / 2;
        draw.roundRect(bx, by, box, box, 4, on ? token("accent") : "#2a2342");
        draw.strokeRoundRect(bx, by, box, box, 4, on ? token("accent") : "#8a80a0", 2);
        if (on) draw.text("✓", bx + box / 2, by + 1 * s, { size: 17 * s, color: token("ink"), align: "center", weight: "bold" });
      },
    });
    para(label, w - 56, "text", `${id}-label`);
    if (res.activated && fresh()) later(() => set(!on));
  }, { width: w, align: "center", spacing: 10 });
}
/** A segmented control (.seg): one button per option, the current one selected. */
function seg<T extends string | number>(id: string, label: string, options: readonly T[], current: T, w: number, set: (v: T) => void, nameOf: (v: T) => string = (v) => String(v)): void {
  ui.column(`${id}-f`, () => {
    para(label, w, "field-label", `${id}-label`);
    const list: Btn[] = options.map((o) => ({ id: `${id}-${o}`, text: nameOf(o), style: "seg", selected: o === current, act: () => set(o) }));
    flow(`${id}-seg`, list, w, 8);
  }, { spacing: 6, width: w });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  if (app.screen === "game") hud(L);
  else page(L);
  overlay(L);
  toasts(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ pages (title, setup, journey, learn, challenges)
function page(L: Layout): void {
  const key = `page-${app.screen}`;
  const pad = 16;
  const maxW = app.screen === "title" ? 760 : app.screen === "setup" ? 560 : 860;
  const w = Math.min(maxW, L.lw - 2 * pad);
  const contentH = lastH(key, L.lh);
  const scroll = contentH + 2 * pad > L.lh + 1;
  const opening = frame().frame - app.openedFrame <= 6;
  ui.place("page", { anchor: "top-start", x: 0, y: 0 }, () => {
    const body = (): void => {
      const top = scroll ? pad : Math.max(pad, (L.lh - contentH) / 2);
      ui.column("page-col", () => {
        lastSize.set(key, ui.column(`${key}-in`, () => {
          if (app.screen === "title") title(w, L);
          else if (app.screen === "setup") panel("setup", w, () => setup(w - 40, L));
          else if (app.screen === "journey") panel("journey", w, () => journey(w - 40));
          else if (app.screen === "learn") panel("learn", w, () => learnList(w - 40));
          else panel("challenge", w, () => challengeList(w - 40));
        }, { width: w, spacing: 0, align: "center" }));
      }, { width: L.lw - (scroll ? 14 : 0), align: "center", padding: { top, bottom: pad } });
    };
    if (scroll) ui.scrollArea("page-scroll", { width: L.lw, height: L.lh }, body, opening ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
}
function panel(id: string, w: number, build: () => void): void {
  ui.column(`${id}-panel`, build, { style: "panel", width: w, spacing: 12, padding: 20 });
}

// ----- title
function title(w: number, L: Layout): void {
  const save = platform.save();
  const compactHead = L.land;
  ui.column("title-wrap", () => {
    ui.column("title-head", () => {
      ui.style(compactHead ? "logo-sm" : "logo").label("🏮");
      ui.style(L.phone || compactHead ? "game-title-sm" : "game-title").id("title-h").label("Royal Circuit");
      para(T("Race your floats around the festival circuit. First to crown all four wins."), Math.min(w, 420), "tagline", "tagline");
    }, { spacing: compactHead ? 0 : 6, align: "center", width: w });
    const play = T("▶ Play");
    button({ id: "btn-play", text: play, style: "btn-play", width: Math.min(w, buttonWidth(play, "btn-play")), act: () => showSetup("practice") });
    if (resumeAvailable()) button({ id: "btn-resume-saved", text: T("↺ Resume saved game"), act: resumeSnapshot });
    // mode cards: three columns, two on compact windows (an odd last card spans both)
    const cols = L.wide ? 3 : 2;
    const gap = L.phone ? 8 : 12;
    const cw = (w - (cols - 1) * gap) / cols;
    const done = Object.keys(save.journey).length;
    const today = Content.dailyForDate(new Date(platform.nowMs()));
    const rec = save.dailies[today.date];
    const cards: [string, string, string, string, () => void][] = [
      ["daily", "🌇", T("Daily Circuit"), rec ? T(rec.won ? "Today: won · score {score}" : "Today: played · score {score}", { score: rec.score }) : T("One shared race each day"), showDaily],
      ["journey", "🗺️", T("Journey"), done ? T("{n}/40 stages complete", { n: done }) : T("40 festival stages"), showJourney],
      ["learn", "📜", T("Learn"), T("Interactive lessons"), showLearn],
      ["practice", "🎋", T("Practice"), T("Unranked, undo allowed"), () => showSetup("practice")],
      ["challenge", "⚡", T("Challenges"), T("Constrained goals"), showChallenges],
    ];
    ui.column("title-grid", () => {
      for (let r = 0; r * cols < cards.length; r++) {
        const row = cards.slice(r * cols, (r + 1) * cols);
        ui.row(`title-grid-r${r}`, () => {
          row.forEach(([id, icon, name, sub, act], i) => {
            const span = row.length === 1 && cols === 2 && i === 0 && cards.length % 2 === 1 ? 2 : 1;
            const cardW = span === 2 ? w : cw;
            const iw = cardW - 32;
            button({
              id: `card-${id}`, text: name, name, style: "mode-card", width: cardW, height: L.phone ? 84 : 96, act,
              content: () => ui.column(`card-${id}-face`, () => {
                if (!L.phone || !L.land) ui.style("mode-icon").label(icon);
                para(name, iw, "mode-name");
                para(sub, iw, "mode-sub", `card-${id}-sub`);
              }, { spacing: 2, width: iw }),
            });
          });
        }, { spacing: gap, width: w });
      }
    }, { spacing: gap, width: w });
    const sync = platform.signedIn() ? syncLabel() : "";
    const chips: Btn[] = [
      { id: "chip-profile", text: `🏮 ${displayName()}${sync ? `  ${sync}` : ""}`, name: T("Profile"), style: "chip", act: () => showOverlay("profile", "btn-profile-close") },
      { id: "chip-achievements", text: T("Achievements"), style: "chip", act: () => showOverlay("achievements", "btn-ach-close") },
      { id: "chip-leaderboards", text: T("Leaderboards"), style: "chip", act: () => showBoards("daily") },
      { id: "chip-help", text: T("How to Play"), style: "chip", act: () => showOverlay("help", "btn-help-close") },
      { id: "chip-settings", text: T("Settings"), style: "chip", act: () => showOverlay("settings", "btn-settings-close") },
    ];
    if (platform.signedIn() && platform.inviteLink()) chips.push({ id: "chip-invite", text: S("invite"), style: "chip", act: invite });
    flow("title-foot", chips, w, 10, "center");
    if (!platform.signedIn()) button({ id: "btn-signin", text: S("signIn"), act: signIn, width: Math.min(w, buttonWidth(S("signIn"), "btn")) });
  }, { spacing: L.land ? 10 : 18, align: "center", width: w });
}
function syncLabel(): string {
  switch (platform.syncState()) {
    case "synced": return T("☁ synced");
    case "saving": case "connecting": return T("☁ saving…");
    case "error": return T("☁ offline");
    default: return "";
  }
}

// ----- setup (ui.js showSetup)
function setup(w: number, L: Layout): void {
  const mode = app.mode!, cfg = app.setupCfg!, content = app.content, lesson = app.lesson;
  const titles: Record<string, string> = {
    practice: N("Practice Match"), daily: N("Daily Circuit"), journey: N("Journey"), challenge: N("Challenge"), learn: N("Lesson"), local: N("Local Table"),
  };
  para(T(content?.name || lesson?.title || titles[mode] || "Set up"), w, "h2", "setup-h");
  if (lesson) para(T(lesson.intro), w, "muted", "setup-intro");
  if (mode === "practice") {
    seg("set-players", T("Players"), [2, 3, 4], cfg.players, w, (v) => { cfg.players = v; });
    seg("set-ai", T("AI difficulty"), AI.AI_LEVELS.map((l) => l.level), cfg.aiLevel, w, (v) => { cfg.aiLevel = v; });
    seg("set-floats", T("Floats per player"), [2, 3, 4], cfg.floats, w, (v) => { cfg.floats = v; });
    ui.column("set-variants", () => {
      para(T("Rule variants"), w, "field-label", "variants-h");
      toggleRow("set-exact", T("Exact finish (overshoot is wasted)"), cfg.exactFinish, w, (v) => { cfg.exactFinish = v; });
      toggleRow("set-blockades", T("Processions (blockades)"), cfg.blockades, w, (v) => { cfg.blockades = v; });
      toggleRow("set-safe", T("Lantern safe tiles"), cfg.safeTrack, w, (v) => { cfg.safeTrack = v; });
    }, { spacing: 4, width: w });
  }
  if (mode === "local") {
    seg("set-players", T("Players at this table"), [2, 3, 4], cfg.players, w, (v) => { cfg.players = v; });
    para(T("Pass-and-play: everyone shares this device. Undo is allowed between turns."), w, "hint-line");
  }
  // summary card: rules, expected duration, ranked, assists
  const dur = mode === "learn" ? T("~{n} min", { n: 2 }) : cfg.players === 2 && !content ? T("~{n} min", { n: "6–10" })
    : content && content.ruleset.players === 2 ? T("~{n} min", { n: "6–10" }) : T("~{n} min", { n: "10–15" });
  const ranked = mode === "daily" || mode === "journey" || mode === "challenge";
  const rules: string[] = [];
  if (mode === "practice") {
    rules.push(T("{n} players", { n: cfg.players }), T("{level} AI", { level: T(AI.AI_LEVELS.find((l) => l.level === cfg.aiLevel)!.name) }),
      T("{n} floats each", { n: cfg.floats }), T(cfg.exactFinish ? "exact finish" : "bounce finish"),
      T(cfg.blockades ? "processions on" : "no processions"), T(cfg.safeTrack ? "lantern tiles" : "dark circuit"));
  } else if (content) {
    const r = content.ruleset;
    rules.push(T("{n} players", { n: r.players }), T("{n} floats each", { n: r.floats ?? 4 }),
      T(r.exactFinish === false ? "bounce finish" : "exact finish"),
      T(r.safeTrack === false ? "no safe tiles" : "lantern tiles"),
      r.maxTurns ? T("limit {n} rounds", { n: r.maxTurns }) : T("no turn limit"));
  } else if (mode === "local") rules.push(T("{n} players", { n: cfg.players }), T("standard rules"));
  else rules.push(T("scripted lesson dice"));
  const undo = mode === "practice" || mode === "local" || mode === "learn";
  const iw = w - 28;
  ui.column("summary", () => {
    sumLine("sum-rules", T("Rules:"), rules.join(" · "), iw);
    sumLine("sum-dur", T("Expected duration:"), dur, iw);
    sumLine("sum-ranked", T("Ranked:"), T(ranked ? "yes — counts for records" : "no — practice does not affect rating"), iw);
    sumLine("sum-assists", T("Assists:"), T(undo ? "hints available, undo allowed" : "hints available"), iw);
  }, { style: "summary", width: w, spacing: 4 });
  void L;
  flow("setup-actions", [
    { id: "setup-back", text: T("Back"), style: "btn-ghost", act: setupBack },
    { id: "setup-start", text: T("Start"), style: "btn-primary", act: setupStart },
  ], w, 10, "end");
}
function sumLine(id: string, k: string, v: string, w: number): void {
  const kw = textWidth(k, "sum-k");
  if (kw + 8 + textWidth(v, "sum-v") <= w) ui.row(id, () => { ui.style("sum-k").label(k); ui.style("sum-v").label(v); }, { spacing: 6 });
  else ui.column(id, () => { ui.style("sum-k").label(k); ui.style("sum-v").paragraph(v, w); }, { spacing: 2, width: w });
}
function headRow(id: string, heading: string, w: number, back: () => void): void {
  const bw = buttonWidth(T("Back"), "btn-ghost");
  ui.row(`${id}-head`, () => {
    para(heading, w - bw - 12, "h2", `${id}-h`);
    ui.spacer();
    button({ id: `${id}-back`, text: T("Back"), style: "btn-ghost", act: back });
  }, { width: w, align: "center" });
}

// ----- journey map
function journey(w: number): void {
  const save = platform.save();
  const done = save.journey;
  headRow("journey", T("Journey"), w, () => { app.screen = "title"; app.openedFrame = frame().frame; });
  para(T("{done} of 40 stages complete · {stars} stars", {
    done: Object.keys(done).length, stars: Object.values(done).reduce((s, r) => s + (r.stars || 0), 0),
  }), w, "muted", "journey-progress");
  const gap = 10, min = 92;
  const cols = Math.max(1, Math.floor((w + gap) / (min + gap)));
  const cw = (w - (cols - 1) * gap) / cols;
  const J = Content.JOURNEY;
  ui.column("stage-grid", () => {
    for (let r = 0; r * cols < J.length; r++) {
      ui.row(`stage-grid-r${r}`, () => {
        for (let i = r * cols; i < Math.min(J.length, (r + 1) * cols); i++) {
          const stage = J[i]!;
          const rec = done[stage.id];
          const unlocked = stageUnlocked(stage.index);
          const name = T(stage.name);
          const label = rec ? T("Stage {n}: {name}, {stars} stars", { n: stage.index, name, stars: rec.stars })
            : unlocked ? T("Stage {n}: {name}", { n: stage.index, name }) : T("Stage {n}: {name}, locked", { n: stage.index, name });
          const stars = rec ? "★".repeat(rec.stars) + "☆".repeat(3 - rec.stars) : unlocked ? "···" : "🔒";
          button({
            id: `stage-${stage.index}`, text: label, name: label, style: stage.mastery ? "stage-cell-mastery" : "stage-cell", width: cw,
            disabled: !unlocked, act: () => showSetup("journey", stage),
            content: () => ui.column(`stage-${stage.index}-face`, () => {
              ui.style("stage-num").label(String(stage.index));
              ui.style("stage-stars").label(stars);
              para(name, cw - 14, "stage-name");
            }, { spacing: 2, width: cw - 14, align: "center" }),
          });
        }
      }, { spacing: gap, width: w });
    }
  }, { spacing: gap, width: w });
}

// ----- learn and challenges
function cardItem(id: string, icon: string, titleText: string, sub: string, meta: string, w: number, opts: { done?: boolean; disabled?: boolean; act?: () => void; role?: "button" | "none" }): void {
  const metaW = meta ? textWidth(meta, "ci-meta") : 0;
  const iw = w - 32 - 40 - (metaW ? metaW + 14 : 0) - 14;
  const face = (): void => {
    ui.row(`${id}-face`, () => {
      ui.style("ci-icon").label(icon);
      ui.column(`${id}-body`, () => {
        para(titleText, iw, "ci-title");
        para(sub, iw, "ci-sub");
      }, { spacing: 2, width: iw });
      if (meta) ui.style("ci-meta").label(meta);
    }, { spacing: 14, align: "center", width: w - 32 });
  };
  if (opts.role === "none") ui.column(id, face, { style: opts.done ? "card-item-done" : "card-item", width: w });
  else button({ id, text: titleText, name: `${titleText}. ${sub}${meta ? ` ${meta}` : ""}`, style: opts.done ? "card-item-done" : "card-item", width: w,
    disabled: opts.disabled, act: opts.act ?? (() => undefined), content: face });
}
function learnList(w: number): void {
  const save = platform.save();
  headRow("learn", T("Learn the Circuit"), w, () => { app.screen = "title"; app.openedFrame = frame().frame; });
  ui.column("lesson-list", () => {
    for (const lesson of Content.LESSONS) {
      const doneIt = !!save.lessons[lesson.id];
      const open = lessonUnlocked(lesson.order) || doneIt;
      cardItem(`lesson-${lesson.order}`, doneIt ? "✅" : "📜", T(lesson.title), T(lesson.intro), open ? T("Lesson {n}", { n: lesson.order }) : "🔒", w,
        { done: doneIt, disabled: !open, act: () => showSetup("learn", null, lesson) });
    }
  }, { spacing: 10, width: w });
}
function challengeList(w: number): void {
  const save = platform.save();
  headRow("ch", T("Challenges"), w, () => { app.screen = "title"; app.openedFrame = frame().frame; });
  ui.column("challenge-list", () => {
    for (const ch of Content.CHALLENGES) {
      const best = save.leaderboards.best.find((b) => b.contentId === ch.id);
      cardItem(`ch-${ch.id}`, "⚡", T(ch.name), T(ch.blurb), best ? T("best {score}", { score: best.score }) : "", w, { act: () => showSetup("challenge", ch) });
    }
  }, { spacing: 10, width: w });
}

// ------------------------------------------------------------------ the match HUD
const DIE_GLYPHS = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
function hud(L: Layout): void {
  const s = app.session;
  if (!s) return;
  const st = s.state;
  const m = L.phone ? 10 : 16;
  const top = L.land ? 6 : m;
  // the top bar: mode + objective, the player chips, board state + pause
  const iconsW = 44 * 2 + 8;
  const objW = L.phone ? Math.min(L.lw - 2 * m - iconsW - 12, 340) : Math.min(340, lastW("hud-obj", 220));
  ui.place("hud-left", { anchor: "top-start", x: m, y: top }, () => {
    lastSize.set("hud-obj", ui.column("hud-obj", () => {
      const iw = (L.phone ? objW : 340) - 28;
      para(modeName(), iw, "hud-mode", "hud-mode-name");
      if (!L.phone && !L.land) para(objectiveText(), iw, "hud-obj", "hud-objective");
    }, { style: "hud-box", spacing: 2, padding: L.phone || L.land ? { top: 6, bottom: 6, start: 10, end: 10 } : { top: 8, bottom: 8, start: 14, end: 14 } }));
  });
  ui.place("hud-right", { anchor: "top-end", x: m, y: top }, () => {
    ui.row("hud-actions", () => {
      button({ id: "btn-board-state", text: T("Board state (accessible text)"), name: T("Board state (accessible text)"), style: "icon-btn", width: 44, height: 44,
        act: openBoardState, content: () => ui.label("☰") });
      button({ id: "btn-pause", text: T("Pause"), name: T("Pause"), style: "icon-btn", width: 44, height: 44, act: pauseGame, content: () => pauseGlyph() });
    }, { spacing: 8 });
  });
  const objActual = Math.min(objW, lastW("hud-obj", objW));
  // the chips sit between the objective box and the buttons; when that leaves too little room (phones), in a
  // row under the top bar beside the drawer toggles
  const between = L.lw - 2 * m - objActual - iconsW - 24;
  const under = between < 220;
  const chipsW = under ? L.lw - 2 * m - (L.wide ? 0 : 96 + 12) : between;
  const chipsY = under ? top + 54 : top;
  ui.place("hud-chips", { anchor: "top-start", x: under ? m : m + objActual + 12, y: chipsY }, () => {
    playerChips(chipsW, L);
  });
  // the banner, the lesson coach, the caption
  if (app.banner) {
    const bw = Math.min(0.92 * L.lw, 560);
    const y = Math.max(L.land ? 56 : 76, chipsY + lastH("hud-chips-col", 40) + 12, L.wide || L.land ? 0 : 70 + 2 * 40 + 6 + 12);
    ui.place("turn-banner", { anchor: "top", y }, () => {
      ui.column("banner", () => para(app.banner!.text, bw - 44, "banner-text", "turn-banner-text"), { style: "banner" });
    });
  }
  if (app.mode === "learn" && app.coach) {
    const cw = Math.min(0.92 * L.lw, 520);
    // on compact windows the coach sits under the drawer toggles
    const below = Math.max((L.land ? 56 : 70) + 2 * 40 + 6, chipsY + lastH("hud-chips-col", 40)) + 60;
    ui.place("lesson-coach", { anchor: "top", y: L.wide ? 120 : L.land ? 96 : Math.max(120, below) }, () => {
      ui.column("coach", () => para(T(app.coach), cw - 40, "coach-text", "lesson-coach"), { style: "coach" });
    });
  }
  if (app.caption) {
    ui.place("caption-line", { anchor: "bottom", y: L.land ? 70 : 96 }, () => {
      ui.column("caption", () => ui.style("caption-text").label(app.caption!.text), { style: "caption" });
    });
  }
  // rails
  if (L.wide) {
    railBox("rail-left", "start", 218, L, () => leftRail(186));
    railBox("rail-right", "end", 218, L, () => rightRail(186));
  } else {
    const ty = L.land ? 56 : 70;
    ui.place("rail-toggles", { anchor: "top-end", x: m, y: ty }, () => {
      ui.column("rail-toggle-col", () => {
        button({ id: "toggle-left", text: T("Objective"), style: "btn-rail", width: 96, selected: app.railOpen === "left",
          act: () => { app.railOpen = app.railOpen === "left" ? null : "left"; } });
        button({ id: "toggle-right", text: T("Turn"), style: "btn-rail", width: 96, selected: app.railOpen === "right",
          act: () => { app.railOpen = app.railOpen === "right" ? null : "right"; } });
      }, { spacing: 6 });
    });
    if (app.railOpen) {
      const dw = Math.min(300, 0.78 * L.lw);
      const maxH = (L.land ? 0.56 : 0.44) * L.lh;
      const bottom = L.land ? 64 : 86;
      const side = app.railOpen === "left" ? "bottom-start" : "bottom-end";
      ui.place("rail-drawer", { anchor: side, x: m, y: bottom }, () => {
        const inner = dw - 32;
        const key = "drawer-in";
        const scroll = lastH(key, 100) + 28 > maxH;
        const body = (): void => { lastSize.set(key, ui.column(key, () => (app.railOpen === "left" ? leftRail(inner - (scroll ? 14 : 0)) : rightRail(inner - (scroll ? 14 : 0))), { spacing: 4, width: inner - (scroll ? 14 : 0) })); };
        ui.column("drawer", () => {
          if (scroll) ui.scrollArea("drawer-scroll", { width: inner, height: maxH - 28 }, body);
          else body();
        }, { style: "rail", width: dw, padding: 14 });
      });
    }
  }
  // the float picker and the tray
  picker(L);
  tray(L);
  void st;
}
function pauseGlyph(): void {
  ui.widget("", {
    role: "none", size: { width: 16, height: 16 },
    draw: (r) => {
      const s = frame().scale;
      void s;
      const bw = r.width * 0.28, h = r.height * 0.9, y = r.y + (r.height - h) / 2;
      draw.roundRect(r.x + r.width * 0.12, y, bw, h, 1, token("text"));
      draw.roundRect(r.x + r.width * 0.6, y, bw, h, 1, token("text"));
    },
  });
}
function shapeMark(id: string, seat: number): void {
  const def = Rules.PLAYER_DEFS[seat]!;
  const color = "#" + render.playerColorOf(seat).toString(16).padStart(6, "0");
  ui.id(id).widget("", {
    role: "none", size: { width: 14, height: 14 },
    draw: (r) => {
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2, rad = r.width / 2;
      const edge = "#ffffff80";
      if (def.shape === "square") { draw.roundRect(r.x, r.y, r.width, r.height, 3, color); draw.strokeRoundRect(r.x, r.y, r.width, r.height, 3, edge, 2); }
      else if (def.shape === "tri") {
        draw.polygon([[cx, r.y], [r.x + r.width, r.y + r.height], [r.x, r.y + r.height]], color);
      } else if (def.shape === "hex") {
        const pts: [number, number][] = [];
        for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + Math.PI / 6; pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]); }
        draw.polygon(pts, color);
      } else { draw.circle(cx, cy, rad, color); draw.strokeCircle(cx, cy, rad - 1, edge, 2); }
    },
  });
}
function playerChips(w: number, L: Layout): void {
  const s = app.session!;
  const st = s.state;
  const chips = st.players.map((p) => ({ p, text: pname(p.name), crowns: `♛${p.crowned}` }));
  const maxName = Math.max(30, w - 86);
  const chipW = (c: (typeof chips)[number]): number => 24 + 14 + 7 + Math.min(maxName, textWidth(c.text, "chip-name")) + 7 + textWidth(c.crowns, "chip-crowns") + 4;
  // flex-wrap, centred
  const rows: (typeof chips)[] = [[]];
  let used = 0;
  for (const c of chips) {
    const cw = Math.min(w, chipW(c));
    if (rows[rows.length - 1]!.length && used + 8 + cw > w) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? 8 : 0) + cw;
    rows[rows.length - 1]!.push(c);
  }
  lastSize.set("hud-chips-col", ui.column("hud-chips-col", () => {
    rows.forEach((row, ri) => ui.row(`chips-r${ri}`, () => {
      for (const c of row) {
        const on = c.p.seat === st.turnIndex && st.phase !== "over";
        ui.row(`chip-p${c.p.seat}`, () => {
          shapeMark(`dot-p${c.p.seat}`, c.p.seat);
          if (textWidth(c.text, "chip-name") <= maxName) ui.style("chip-name").label(c.text);
          else ui.style("chip-name").paragraph(c.text, maxName);
          ui.style("chip-crowns").label(c.crowns);
        }, { style: on ? "hud-chip-on" : "hud-chip", spacing: 7, align: "center" });
      }
    }, { spacing: 8, width: w, justify: "center", align: "center" }));
  }, { spacing: 6, width: w }));
  void L;
}
function railBox(id: string, side: "start" | "end", w: number, L: Layout, build: () => void): void {
  const h = lastH(`${id}-in`, 200) + 28;
  const y = Math.max(70, (L.lh - h) / 2);
  ui.place(id, { anchor: side === "start" ? "top-start" : "top-end", x: 12, y }, () => {
    ui.column(`${id}-box`, () => {
      lastSize.set(`${id}-in`, ui.column(`${id}-in`, build, { spacing: 4, width: w - 32 }));
    }, { style: "rail", width: w, padding: { top: 14, bottom: 14, start: 16, end: 16 } });
  });
}
/** #rail-left: the objective, every player's progress, the rules. */
function leftRail(w: number): void {
  const s = app.session!;
  const st = s.state;
  para(T("Objective"), w, "rail-h", "rail-obj-h");
  para(objectiveText(), w, "rail-text", "rail-objective");
  ui.spacer(0.0001);
  para(T("Progress"), w, "rail-h", "rail-prog-h");
  for (const p of st.players) {
    const v = `♛ ${p.crowned}/${st.ruleset.floats} · ⚔ ${p.captures}`;
    const vw = textWidth(v, "rail-text");
    ui.row(`rail-prog-${p.seat}`, () => {
      para(pname(p.name), w - vw - 8, "rail-text");
      ui.spacer();
      ui.style("rail-text").label(v);
    }, { width: w, align: "center" });
  }
  para(T("Rules"), w, "rail-h", "rail-rules-h");
  rulesList().forEach((r, i) => para(r, w, "rail-muted", `rail-rule-${i}`));
}
/** #rail-right: the turn line and the die. */
function rightRail(w: number): void {
  const s = app.session!;
  para(T("Turn"), w, "rail-h", "rail-turn-h");
  ui.column("rail-turn-c", () => para(flowText(), w, "rail-turn", "rail-turn"), { width: w, align: "center" });
  ui.column("rail-die-c", () => ui.style("rail-die").label(DIE_GLYPHS[(s.state.die ?? 5) - 1]!), { width: w, align: "center" });
}

/** The float picker: on wide windows each button sits over its float; overlaps or off-screen floats dock the row over the tray. */
function picker(L: Layout): void {
  const moves = legalMoves();
  if (!moves.length) return;
  const sc = L.sc, sa = frame().safeArea;
  const items = moves.map((mv, i) => ({ mv, i, text: describeMove(mv) }));
  let placed: { x: number; y: number; w: number; h: number; it: (typeof items)[number] }[] = [];
  if (L.wide) {
    for (const it of items) {
      const a = moveAnchor(it.mv);
      const x0 = (a.x - sa.left) / sc, y0 = (a.y - sa.top) / sc;
      const inView = a.visible && x0 > 8 && x0 < L.lw - 8 && y0 > 60 && y0 < L.lh - 120;
      if (!inView) { placed = []; break; }
      const w = buttonWidth(it.text, "btn-pick"), h = 48;
      const x = Math.min(L.lw - w - 8, Math.max(8, x0 - w / 2));
      const y = Math.min(L.lh - 100, Math.max(60, y0 - 52));
      placed.push({ x, y, w, h, it });
    }
    const overlaps = placed.some((a, i) => placed.some((o, j) => j > i && a.x < o.x + o.w && o.x < a.x + a.w && a.y < o.y + o.h && o.y < a.y + a.h));
    if (overlaps) placed = [];
  }
  const pickBtn = (it: (typeof items)[number], width?: number): void => {
    button({ id: `pick-${it.mv.floatId}`, text: it.text, style: "btn-pick", selected: it.i === app.pickIdx, width, act: () => doMove(it.mv.floatId) });
  };
  if (placed.length) {
    for (const p of placed) ui.place(`pick-at-${p.it.mv.floatId}`, { anchor: "top-start", x: p.x, y: p.y }, () => pickBtn(p.it));
  } else {
    const w = Math.min(0.92 * L.lw, 900);
    let bottom = (L.land ? 64 : 92) + (L.phone ? 18 : 0);
    // an open rail drawer sits over the tray: the docked picker goes above it
    if (!L.wide && app.railOpen) bottom = (L.land ? 64 : 86) + Math.min(lastH("drawer-in", 100) + 28, (L.land ? 0.56 : 0.44) * L.lh) + 8;
    const anchor = platform.options.leftHanded && !L.phone ? "bottom-end" : "bottom";
    ui.place("float-picker", { anchor, x: anchor === "bottom-end" ? 14 : 0, y: bottom }, () => {
      flow("float-picker-row", items.map((it) => ({ id: `pick-${it.mv.floatId}`, text: it.text, style: "btn-pick", selected: it.i === app.pickIdx, act: () => doMove(it.mv.floatId) })), w, 8, "center");
    });
  }
  // hover previews the move (mouseenter / focus): the focused picker button selects its float
  const f = ui.focused();
  if (f) { const i = items.findIndex((it) => it.text === f); if (i >= 0) previewPick(i); }
}
/** #action-tray: Roll, Pass, Undo, Hint (bottom centre; at the end for the left-handed tray). */
function tray(L: Layout): void {
  const s = app.session!;
  const acts = s.actions;
  const ok = canAct();
  const rollDie = DIE_GLYPHS[(s.state.die ?? 6) - 1]!;
  const btns: Btn[] = [];
  const rollText = T("Roll");
  btns.push({
    id: "btn-roll", text: rollText, name: T("Roll the festival die"), style: "btn-roll", disabled: !(ok && acts.type === "roll"), act: doRoll, sound: false,
    content: () => ui.row("roll-face", () => { ui.style("roll-die").label(rollDie); ui.style("roll-label").label(rollText); }, { spacing: 10, align: "center" }),
  });
  if (acts.type === "pass") btns.push({ id: "btn-pass", text: T("Pass"), disabled: !ok, act: doPass, sound: false });
  if (canUndo()) btns.push({ id: "btn-undo", text: T("Undo"), style: "btn-ghost", act: doUndo });
  btns.push({ id: "btn-hint", text: T("Hint"), style: "btn-ghost", disabled: !(ok && acts.type === "moves"), act: doHint, sound: false });
  const rollW = textWidth(rollText, "roll-label") + textWidth(rollDie, "roll-die") + 10 + 54;
  const widths = btns.map((b) => (b.id === "btn-roll" ? rollW : buttonWidth(b.text, b.style ?? "btn")));
  const total = widths.reduce((a, b) => a + b, 0) + 10 * (btns.length - 1);
  const full = L.phone && !L.land;
  const trayW = full ? L.lw - 20 : total + 30;
  if (full) widths[0] = Math.max(rollW, trayW - 30 - (total - widths[0]!));
  const anchor = platform.options.leftHanded && !full ? "bottom-end" : "bottom";
  ui.place("action-tray", { anchor, x: anchor === "bottom-end" ? 14 : 0, y: L.land ? 8 : 14 }, () => {
    ui.row("tray-row", () => {
      btns.forEach((b, i) => button({ ...b, width: widths[i], height: b.id === "btn-roll" ? (L.land ? 40 : 48) : undefined }));
    }, { style: full ? "tray-sq" : "tray", spacing: 10, align: "center", justify: "center", width: trayW,
      padding: L.land ? { top: 6, bottom: 6, start: 10, end: 10 } : { top: 10, bottom: 10, start: 14, end: 14 } });
  });
}

// ------------------------------------------------------------------ toasts
function toasts(L: Layout): void {
  if (!app.toasts.length) return;
  const w = Math.min(L.lw - 28, 320);
  ui.place("toast-stack", { anchor: "top-end", x: 14, y: app.screen === "game" ? (L.land ? 56 : 120) : 14 }, () => {
    ui.column("toast-col", () => {
      app.toasts.forEach((t, i) => ui.column(`toast-${i}`, () => para(t.text, w - 34, "toast-text", `toast-${i}-text`), { style: t.kind === "error" ? "toast-error" : "toast" }));
    }, { spacing: 8, align: "end" });
  });
}

// ------------------------------------------------------------------ overlay panels (.overlay > .panel)
function overlay(L: Layout): void {
  const o = topOverlay();
  if (!o) return;
  const wideP = o === "settings" || o === "results" || o === "help" || o === "achievements" || o === "boards" || o === "boardstate";
  const w = Math.min(wideP ? 860 : 560, L.lw - 28);
  const pad = L.phone ? 16 : 20;
  const inner = w - 2 * pad;
  const maxH = L.lh - 28;
  const key = `panel-${o}`;
  const prev = lastSize.get(key);
  const scroll = !!prev && prev.height / L.sc + 2 * pad > maxH;
  const opening = frame().frame - app.openedFrame <= 6;
  const isOpen = ui.dialog(panelLabel(o), "", true, () => {
    ui.column("panel", () => {
      const iw = inner - (scroll ? 14 : 0);
      const body = (): void => { lastSize.set(key, ui.column(`${key}-in`, () => buildPanel(o, iw, L), { spacing: 12, width: iw })); };
      if (scroll) ui.scrollArea(`${key}-scroll`, { width: inner + 6, height: maxH - 2 * pad }, body, opening ? { scrollTo: { top: 0 } } : undefined);
      else body();
    }, { style: "panel", width: w, spacing: 0, padding: pad });
  });
  if (!isOpen && fresh()) later(() => closeOverlay(o));
}
function closeOverlay(o: Overlay): void {
  if (o === "results") return; // the results stay until a choice
  hideOverlay(o);
}
function panelLabel(o: Overlay): string {
  switch (o) {
    case "pause": return T("Paused");
    case "settings": return T("Settings");
    case "results": return T("Results");
    case "help": return T("How to Play");
    case "achievements": return T("Achievements");
    case "boards": return T("Leaderboards");
    case "profile": return T("Profile");
    case "boardstate": return T("Board State");
    case "confirm": return T("Are you sure?");
  }
}
function buildPanel(o: Overlay, w: number, L: Layout): void {
  switch (o) {
    case "pause": pausePanel(w); break;
    case "settings": settingsPanel(w); break;
    case "results": resultsPanel(w, L); break;
    case "help": helpPanel(w); break;
    case "achievements": achievementsPanel(w); break;
    case "boards": boardsPanel(w); break;
    case "profile": profilePanel(w); break;
    case "boardstate": boardStatePanel(w); break;
    case "confirm": confirmPanel(w); break;
  }
}
function closeRow(id: string, heading: string, w: number, closeText: string, close: () => void): void {
  const bw = buttonWidth(closeText, "btn-ghost");
  ui.row(`${id}-head`, () => {
    para(heading, w - bw - 12, "h2", `${id}-h`);
    ui.spacer();
    button({ id: `btn-${id}-close`, text: closeText, style: "btn-ghost", act: close });
  }, { width: w, align: "center" });
}

function pausePanel(w: number): void {
  para(T("Paused"), w, "h2", "pause-h");
  ui.column("pause-col", () => {
    button({ id: "btn-resume", text: T("Resume"), style: "btn-primary", width: w, act: resumeGame });
    button({ id: "btn-pause-settings", text: T("Settings"), width: w, act: () => showOverlay("settings", "btn-settings-close") });
    button({ id: "btn-pause-help", text: T("How to Play"), width: w, act: () => showOverlay("help", "btn-help-close") });
    button({ id: "btn-restart", text: T("Restart"), width: w, act: restartGame });
    button({ id: "btn-leave", text: T("Leave Game"), style: "btn-danger", width: w, act: leaveGame });
  }, { spacing: 10, width: w });
}

/** The game's own settings (what the runtime's Options do not cover). */
function settingsPanel(w: number): void {
  const o = platform.options;
  closeRow("settings", T("Settings"), w, T("Done"), () => hideOverlay("settings"));
  para(T("Volumes, mute, graphics quality, frame rate, key bindings, language, larger text, high contrast, reduced motion and vibration are in the StarHermit Options."), w, "muted", "options-note");
  flow("set-runtime", [
    { id: "btn-options", text: T("Open Options"), act: () => openMenu() },
    { id: "btn-rebind", text: T("Key bindings"), act: () => requestRebind() },
  ], w, 10);
  section("set-audio", T("Audio"), w, (iw) => {
    toggleRow("set-captions", T("Captions for meaningful audio"), o.captions, iw, (v) => platform.setOption("captions", v));
  });
  section("set-graphics", T("Graphics"), w, (iw) => {
    const cams = { auto: N("Auto"), top: N("Top"), low: N("Low") } as Record<string, string>;
    seg("set-camera", T("Camera"), ["auto", "top", "low"] as const, o.camera, iw, (v) => platform.setOption("camera", v), (v) => T(cams[v]!));
    seg("set-theme", T("Theme"), Content.THEMES.map((t) => t.id), o.theme, iw, (v) => platform.setOption("theme", v), (id) => T(Content.themeById(id).name));
    para(T("Visual theme. Cosmetics never alter rules or hazards."), iw, "hint-line", "theme-hint");
  });
  section("set-controls", T("Controls"), w, (iw) => {
    para(keysLine(), iw, "muted", "controls-note");
    toggleRow("set-left", T("Left-handed controls"), o.leftHanded, iw, (v) => platform.setOption("leftHanded", v));
  });
  section("set-access", T("Accessibility"), w, (iw) => {
    seg("set-palette", T("Color palette"), ["standard", "cvd"] as const, o.palette, iw, (v) => platform.setOption("palette", v), (v) => T(v === "cvd" ? "CVD-safe" : "Standard"));
    para(T("The CVD palette uses blue/gold separation; player identity also uses shapes and labels."), iw, "hint-line", "palette-hint");
    toggleRow("set-timing", T("Timing assistance (longer AI pauses, slower banners)"), o.timingAssist, iw, (v) => platform.setOption("timingAssist", v));
    button({ id: "btn-replay-tutorial", text: T("Replay tutorial lessons"), act: () => { app.overlays = []; app.paused = false; showLearn(); } });
  });
}
function section(id: string, titleText: string, w: number, build: (iw: number) => void): void {
  ui.column(id, () => { para(titleText, w, "h3", `${id}-h`); build(w); }, { style: "field-line", width: w, spacing: 10 });
}
const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc", "Numpad Enter": "Num Enter" };
function keyOf(action: string): string {
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return list[0] ?? "—";
}
function keysLine(): string {
  return T("{confirm} roll/confirm · arrows switch float · {undo} undo · {hint} hint · {camera} camera · {board} board text · {pause} pause. Gamepad: ✕/A confirm, ○/B cancel, ☰ pause.", {
    confirm: keyOf("confirm"), undo: keyOf("undo"), hint: keyOf("hint"), camera: keyOf("camera"), board: keyOf("board"), pause: keyOf("pause"),
  });
}

const SCORE_PARTS: Record<string, string> = {
  crowned: N("crowned"), progress: N("progress"), captures: N("captures"), victory: N("victory"), invalidPenalty: N("invalid penalty"),
};
function resultsPanel(w: number, L: Layout): void {
  const rv = app.resultsView;
  const s = app.session;
  if (!rv || !s) return;
  const { lessonOnly, results, newAch } = rv;
  const won = results.winner === 0;
  const goal = s.goalStatus();
  para(T("Results"), w, "h2", "results-h");
  ui.column("result-head", () => {
    para(lessonOnly ? T("Lesson Complete!") : app.mode === "learn" ? T("Lesson over")
      : won ? T("🏮 Victory!") : results.reason === "turn-limit" ? T("The lanterns dim…") : T("Defeat"), w, "big", "result-big");
    const sub = resultSub();
    if (sub && !lessonOnly) para(sub, w, "muted", "result-sub");
    if (goal.label) {
      ui.column("goal-chip", () => ui.style(goal.met ? "goal-met-text" : "goal-missed-text").label(`${goal.met ? "✓" : "✗"} ${goal.label}`),
        { style: goal.met ? "goal-met" : "goal-missed" });
    }
  }, { spacing: 6, width: w, align: "center" });
  if (!lessonOnly) {
    // the result table: Place, Player (with the score breakdown), Crowned, Captures, Score
    const small = L.phone;
    const heads = [T("Place"), T("Player"), T("Crowned"), T("Captures"), T("Score")];
    const colW = (h: string, min: number): number => Math.max(min, textWidth(h, "th") + (small ? 8 : 20));
    const wPlace = colW(heads[0]!, 40), wCr = colW(heads[2]!, 50), wCap = colW(heads[3]!, 50), wSc = colW(heads[4]!, 56);
    const wName = Math.max(80, w - wPlace - wCr - wCap - wSc);
    const rowFn = (id: string, cells: { text: string; w: number; cls: string; end?: boolean; extra?: string }[]): void => {
      ui.row(id, () => {
        cells.forEach((c, i) => ui.column(`${id}-${i}`, () => {
          para(c.text, c.w - 8, c.cls, `${id}-${i}-t`);
          if (c.extra) para(c.extra, c.w - 8, "breakdown", `${id}-${i}-b`);
        }, { width: c.w, align: c.end ? "end" : "start", spacing: 2, padding: { end: c.end ? 4 : 0 } }));
      }, { style: "row-line", width: w, align: "start" });
    };
    rowFn("rt-head", [
      { text: heads[0]!, w: wPlace, cls: "th" }, { text: heads[1]!, w: wName, cls: "th" }, { text: heads[2]!, w: wCr, cls: "th", end: true },
      { text: heads[3]!, w: wCap, cls: "th", end: true }, { text: heads[4]!, w: wSc, cls: "th", end: true },
    ]);
    for (const row of results.rows) {
      const cls = row.seat === results.winner ? "td-win" : "td";
      const bd = Object.entries(row.breakdown.parts).filter(([, v]) => v !== 0).map(([k, v]) => `${T(SCORE_PARTS[k] || k)} ${v > 0 ? "+" : ""}${v}`).join("  ");
      rowFn(`rt-${row.seat}`, [
        { text: `#${row.place}`, w: wPlace, cls }, { text: pname(row.name), w: wName, cls, extra: bd }, { text: String(row.crowned), w: wCr, cls, end: true },
        { text: String(row.captures), w: wCap, cls, end: true }, { text: String(row.breakdown.total), w: wSc, cls, end: true },
      ]);
    }
    para(T("Seed {seed} · {turns} turns · {secs}s · ties break on objective, then invalid actions, then time.", {
      seed: results.seed, turns: results.turns, secs: Math.round(results.elapsedMs / 1000),
    }), w, "hint-line", "results-seed");
    const lb = lbLine();
    if (lb) para(lb, w, "muted", "results-lb");
  }
  if (newAch.length) {
    ui.column("results-ach", () => {
      sumLine("results-ach-line", T("Achievements unlocked:"), newAch.map((k) => T(Content.ACHIEVEMENTS.find((a) => a.key === k)?.name || k)).join(", "), w - 28);
    }, { style: "summary", width: w });
  }
  if (app.mode === "journey" && app.content) {
    const rec = platform.save().journey[app.content.id];
    if (rec) para(T("Stage {n}: {stars} earned.", { n: app.content.index, stars: "★".repeat(rec.stars) + "☆".repeat(3 - rec.stars) }), w, "muted", "results-stars");
  }
  const next = nextAction();
  const btns: Btn[] = [];
  if (!lessonOnly) btns.push({ id: "results-replay", text: T("Watch Replay"), style: "btn-ghost", act: watchReplay });
  btns.push({ id: "results-retry", text: T("Retry"), act: () => { app.overlays = []; retryCurrent(); } });
  btns.push({ id: "results-next", text: next.text, style: "btn-primary", act: () => { app.overlays = []; next.act(); } });
  flow("results-actions", btns, w, 10, "end");
}

function helpPanel(w: number): void {
  closeRow("help", T("How to Play"), w, T("Close"), () => hideOverlay("help"));
  para(T("Race four floats from your workshop around the Grand Circuit. A full lap earns the right to climb your Grand Approach — crown all four floats in the pavilion to win."), w, "text", "help-intro");
  const data: [string, string, string][] = [
    ["🎲", T("Kindling"), T("Roll a 6 to move a float from the workshop onto your start tile. A 6 also grants an encore roll — but three 6s in a row are overkindled and end your turn.")],
    ["🏮", T("Lantern tiles"), T("Lit tiles (every 5th) are safe: floats of any color share them and no captures happen there.")],
    ["⚔️", T("Captures"), T("Land exactly on a rival float on an ordinary tile to send it back to its workshop.")],
    ["🧱", T("Processions"), T("Two of your floats on one ordinary tile form a wall: rivals can neither land on it nor pass it.")],
    ["👑", T("The Approach"), T("After a full lap, floats climb their colored approach. The final crown needs an exact roll (unless bounce-back is on).")],
    ["⌨️", T("Controls"), keysLine()],
  ];
  const gap = 12;
  const cols = Math.max(1, Math.floor((w + gap) / (220 + gap)));
  const cw = (w - (cols - 1) * gap) / cols;
  ui.column("help-cards", () => {
    for (let r = 0; r * cols < data.length; r++) {
      ui.row(`help-r${r}`, () => {
        data.slice(r * cols, (r + 1) * cols).forEach(([icon, h, text], i) => {
          const id = `help-${r * cols + i}`;
          ui.column(id, () => {
            ui.style("hc-icon").label(icon);
            para(h, cw - 28, "h3", `${id}-h`);
            para(text, cw - 28, "text", `${id}-p`);
          }, { style: "help-card", width: cw, spacing: 4 });
        });
      }, { spacing: gap, width: w, align: "stretch" });
    }
  }, { spacing: gap, width: w });
}

function achievementsPanel(w: number): void {
  closeRow("ach", T("Achievements"), w, T("Close"), () => hideOverlay("achievements"));
  const save = platform.save();
  ui.column("ach-list", () => {
    for (const a of Content.ACHIEVEMENTS) {
      const got = save.achievements[a.key];
      cardItem(`ach-${a.key}`, got ? a.icon : "🔒", T(a.name), T(a.desc), got ? String(got).slice(0, 10) : "", w, { done: !!got, role: "none" });
    }
  }, { spacing: 10, width: w });
}

function boardsPanel(w: number): void {
  closeRow("boards", T("Leaderboards"), w, T("Close"), () => hideOverlay("boards"));
  ui.row("boards-tabs", () => {
    button({ id: "tab-daily", text: T("Daily"), style: "tab", selected: app.boardsTab === "daily", act: () => showBoards("daily") });
    button({ id: "tab-best", text: T("All-time"), style: "tab", selected: app.boardsTab === "best", act: () => showBoards("best") });
  }, { style: "tab-line", width: w, spacing: 6 });
  const save = platform.save();
  const rows = save.leaderboards[app.boardsTab];
  if (!rows.length) {
    para(app.boardsTab === "daily" ? T("No daily results yet — play today’s Daily Circuit.") : T("No records yet — finish a journey stage, challenge or daily."), w, "muted", "boards-empty");
  } else {
    const heads = ["#", T("Where"), T("Result"), T("Score"), T("Turns"), T("Seed")];
    const ws = [30, 0, 70, 64, 56, 84].map((m, i) => Math.max(m, i === 1 ? 0 : textWidth(heads[i]!, "th") + 12));
    ws[1] = Math.max(80, w - ws.reduce((a, b) => a + b, 0));
    const line = (id: string, texts: string[], cls: string): void => {
      ui.row(id, () => {
        texts.forEach((t, i) => ui.column(`${id}-${i}`, () => para(t, ws[i]! - 6, cls), { width: ws[i]!, align: i >= 3 ? "end" : "start", padding: { end: i >= 3 ? 4 : 0 } }));
      }, { style: "row-line", width: w });
    };
    line("bd-head", heads, "th");
    rows.slice(0, 20).forEach((r, i) => line(`bd-${i}`, [String(i + 1), r.contentId || "—", T(r.won ? "Won" : "Lost"), String(r.score), String(r.turns), String(r.seed).slice(0, 8)], "td"));
    para(platform.signedIn()
      ? T("Personal bests — these records live on this device and sync with your account; they are never submitted as ranked scores. Each row keeps its ruleset, content version, seed and duration; impossible scores are rejected before they are recorded.")
      : T("Casual board — these records are stored on this device only and are not submitted or compared against other players. Each row keeps its ruleset, content version, seed and duration; impossible scores are rejected before they are recorded."), w, "hint-line", "boards-note");
  }
  if (platform.signedIn()) {
    if (app.board === "loading") para(T("Loading the festival leaderboard…"), w, "muted", "fb-loading");
    else if (!app.board || !app.board.length) para(T("No platform leaderboard for this board yet — personal bests above are the record."), w, "muted", "fb-none");
    else {
      para(T("Festival leaderboard"), w, "h3", "fb-h");
      for (const [i, e] of app.board.entries()) para(`${e.rank}. ${e.name} — ${e.score}`, w, "td", `fb-${i}`);
    }
  }
}

let nameDraft: string | null = null;
function profilePanel(w: number): void {
  closeRow("profile", T("Profile"), w, T("Close"), () => { if (nameDraft !== null) setProfileName(nameDraft); nameDraft = null; hideOverlay("profile"); });
  const save = platform.save();
  const st = save.stats;
  para(T("Display name"), w, "field-label", "prof-name-label");
  if (platform.signedIn()) para(displayName(), w, "text", "prof-name");
  else {
    if (nameDraft === null) nameDraft = pname(save.profile.name);
    nameDraft = ui.id("prof-name").textField(T("Display name"), nameDraft, { maxChars: 20, width: Math.min(w, 320) });
    if (ui.submitted(T("Display name"))) { setProfileName(nameDraft); }
  }
  const iw = w - 28;
  ui.column("prof-stats", () => {
    sumLine("ps-games", T("Games:"), `${st.gamesPlayed} · ${T("Won:")} ${st.gamesWon}`, iw);
    sumLine("ps-caps", T("Captures:"), `${st.captures} · ${T("Floats crowned:")} ${st.crowned}`, iw);
    sumLine("ps-streak", T("Daily streak:"), T("{n} day(s)", { n: st.streakDays }), iw);
    sumLine("ps-account", T("Account:"), platform.signedIn()
      ? T("Signed in via the platform — progress syncs to your account ({status}). This device keeps an offline copy.", { status: syncLabel() || T("☁ synced") })
      : T("Guest — progress is stored on this device. Sign in with StarHermit to sync it with your account."), iw);
  }, { style: "summary", width: w, spacing: 4 });
  button({ id: "btn-erase", text: T("Erase all local progress"), style: "btn-danger", act: () => { nameDraft = null; eraseProgress(); } });
}

function boardStatePanel(w: number): void {
  closeRow("bs", T("Board State"), w, T("Close"), () => hideOverlay("boardstate"));
  const st = app.session?.state;
  if (!st) return;
  const END: Record<string, string> = { "crown-sweep": N("crown sweep"), "crown-first": N("crown target"), "turn-limit": N("turn limit"), resign: N("resignation"), abandon: N("abandoned") };
  const actor = pname(st.players[st.turnIndex]?.name ?? "");
  para(st.phase === "over"
    ? T("Game over — {name} wins ({reason}).", { name: pname(st.players[st.winner ?? 0]?.name ?? ""), reason: T(END[st.reason ?? ""] || st.reason || "") })
    : st.die ? T("{name} to act, die shows {die}. Round {round}.", { name: actor, die: st.die, round: st.round })
      : T("{name} to act, awaiting roll. Round {round}.", { name: actor, round: st.round }), w, "text", "bs-line");
  for (const p of st.players) {
    const vars = { name: pname(p.name), crowned: p.crowned, floats: st.ruleset.floats, captures: p.captures };
    para(p.resigned ? T("{name} — {crowned}/{floats} crowned, {captures} captures (resigned)", vars) : T("{name} — {crowned}/{floats} crowned, {captures} captures", vars), w, "bs-h", `bs-p${p.seat}`);
    p.floats.forEach((fp, i) => para(`• ${describeFloat(st, p.seat, fp, i)}`, w - 20, "text", `bs-p${p.seat}-f${i}`));
  }
}

function confirmPanel(w: number): void {
  para(T("Are you sure?"), w, "h2", "confirm-h");
  para(T(app.confirm?.text ?? ""), w, "text", "confirm-text");
  flow("confirm-actions", [
    { id: "confirm-no", text: T("Cancel"), style: "btn-ghost", act: () => hideOverlay("confirm") },
    { id: "confirm-yes", text: T("Confirm"), style: "btn-danger", act: confirmYes },
  ], w, 10, "end");
}
