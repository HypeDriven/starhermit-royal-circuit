// The look of the HUD, rails, tray, panels and screens: the browser build's
// styles.css, rewritten class-based in tools/ui-style.css and converted once
// with `starhermit css` into assets/ui-style.json (`npm run css`), registered
// at start with the theme the runtime's own widgets (scroll bars, focus
// rings, sliders) take. The runtime's high contrast option is the old
// body.high-contrast token set; the game's colour-vision palette is
// body.palette-cvd's blue accent.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
const BASE: Tokens = {
  accent: "#e8b04b", "accent-hi": "#ffd98a", ink: "#241703", bg: "#141026",
  panel: "#18122ceb", hud: "#140e28c7", text: "#f2ecdf", muted: "#b8aecb",
  danger: "#e05a4e", "danger-text": "#ffb4ac", ok: "#5ecf8a", ring: "#ffd98a",
  edge: "#ffffff2e", glass: "#ffffff14", "glass-hi": "#ffffff24",
};
/** body.high-contrast. */
const CONTRAST: Tokens = { panel: "#000000f2", hud: "#000000f2", text: "#ffffff", muted: "#e8e8e8", accent: "#ffd34d", ring: "#ffffff", edge: "#ffffff" };
/** body.palette-cvd. */
const CVD: Tokens = { accent: "#4dc3ff", ring: "#9fe0ff", "accent-hi": "#9fe0ff" };

let current: Tokens = { ...BASE };
export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13, headingSize: 24, padding: 8, spacing: 10, radius: 12,
    text: BASE.text!, muted: BASE.muted!, panel: "#1c1533", control: "#2a2342", hovered: "#3a3258",
    pressed: "#4a4068", field: "#2a2342", accent: BASE.accent!, focus: BASE.ring!, outline: "#5a5070",
  });
  ui.setTokens(css.tokens);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    heading: { text: { color: "$text" } },
    widget: { focusRing: { color: "$ring", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "#ffffff40", radius: 4 } } },
    tooltip: { background: "#1c1533", text: { color: "$text" }, radius: 6, padding: 6 },
    // .overlay: rgba(8, 5, 18, 0.62) behind the panels.
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#0805129e" } } },
  });
  key = "";
  applyTokens(false, false);
}

let key = "";
/** The base, high-contrast and colour-vision tokens (cheap when unchanged). */
export function applyTokens(highContrast: boolean, cvd: boolean): void {
  const k = `${highContrast}:${cvd}`;
  if (k === key) return;
  key = k;
  current = { ...BASE, ...(highContrast ? CONTRAST : {}), ...(cvd ? CVD : {}) };
  ui.setTokens(current);
  ui.setTheme({ text: current.text!, muted: current.muted!, accent: current.accent!, focus: current.ring! });
}
/** A token's current colour (for draw calls, which take real colours). */
export function token(name: string): string { return current[name] ?? "#000000"; }
