// Localization: the engine's string tables (assets/strings.json, English text
// as the keys, the nine StarHermit locales; en-GB and fr-CA / es-ES fall back
// through the engine's chain) in the interface language the runtime reports
// (the player's choice in Options › Language, else the account's preferred
// language or the device's). Every string is drawn through T() each frame, so
// a change shows on the next frame and never restarts the match. The account
// lines are the engine's own `starhermit.*` strings.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";
import * as i18n from "../src/i18n.js";

export type Vars = Record<string, string | number>;
const I = i18n as unknown as { fmt(s: string, vars?: Vars): string; setTranslator(has: (k: string) => boolean, t: (k: string, v?: Vars) => string): void; pname(name: string): string };
strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));
I.setTranslator((k) => strings.has(k), (k, v) => strings.t(k, v));

export function currentLocale(): string { return strings.locale; }
/** An English source string in the player's language; unknown strings (player names) pass through; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string {
  return strings.has(key) ? strings.t(key, vars ?? undefined) : vars ? I.fmt(key, vars) : key;
}
/** Marks an English key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
/** A player's display name: built-in names (AI rivals, seats, the guest) are translated. */
export function pname(name: string): string { return I.pname(name); }
const ACCOUNT = {
  signIn: "signIn", invite: "invite", inviteCopied: "inviteCopied", inviteLink: "inviteLink", signedOut: "signedOut",
  lbPosting: "leaderboardPosting", lbRank: "leaderboardRank", lbPosted: "leaderboardPosted", lbFailed: "leaderboardNotPosted",
} as const;
/** An account line (the engine's) in the player's language. */
export function S(key: keyof typeof ACCOUNT, vars?: Vars): string { return strings.t(`starhermit.${ACCOUNT[key]}`, vars); }
