// Localization: the browser build's tables (src/i18n.js with src/locales/*,
// English text as the keys, the nine StarHermit locales; the account strings
// in src/shstrings.js) in the interface language the runtime reports
// (preferences().language: the player's choice in Options › Language, else
// the account's preferred language or the device's). The runtime's Options
// replace the game's own Language setting (sh-language.js) and the DOM
// re-labelling: every string is drawn through T() each frame, so a change
// shows on the next frame and never restarts the match.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import * as i18n from "../src/i18n.js";
import * as sh from "../src/shstrings.js";

export type Vars = Record<string, string | number>;
const I = i18n as unknown as {
  T(key: string, vars?: Vars): string; pname(name: string): string; setLocale(tag: string): void; getLang(): string; LOCALES: string[];
};
const SH = sh as unknown as { shText(key: string, vars?: Vars): string };

/** The nearest shipped locale for a BCP 47 tag (es-MX → es-419, en-AU → en-GB, pt-PT → pt-BR, fr-BE → fr-FR). */
export function matchLocale(tag: string): string {
  const t = String(tag || "en-US");
  const L = I.LOCALES;
  const exact = L.find((l) => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const lang = t.split("-")[0]!.toLowerCase();
  const region = (t.split("-")[1] || "").toUpperCase();
  if (lang === "en") return ["US", "PR", "UM", "AS", "GU", "MP", "VI", ""].includes(region) ? "en-US" : "en-GB";
  if (lang === "es") return region === "ES" ? "es-ES" : "es-419";
  if (lang === "fr") return region === "CA" ? "fr-CA" : "fr-FR";
  if (lang === "pt") return "pt-BR";
  if (lang === "de") return "de-DE";
  if (lang === "it") return "it-IT";
  return "en-US";
}

let locale = "";
function apply(tag: string): void {
  const next = matchLocale(tag);
  if (next === locale) return;
  locale = next;
  I.setLocale(next);
  ui.setLanguage(next);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));

export function currentLocale(): string { return locale; }
/** An English source string in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return I.T(key, vars ?? undefined); }
/** Marks an English key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
/** A player's display name: built-in names (AI rivals, seats, the guest) are translated. */
export function pname(name: string): string { return I.pname(name); }
/** The account strings (signIn, invite, inviteCopied, inviteLink, signedOut, lbPosting, lbRank, lbPosted, lbFailed). */
export function S(key: string, vars?: Vars): string { return SH.shText(key, vars); }
