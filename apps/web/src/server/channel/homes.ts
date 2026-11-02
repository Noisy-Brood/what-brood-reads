import { UnrenderableRuleError } from "./errors";

/**
 * The name a home has at a provider, as every adapter renders it (#304,
 * #1180): one rule, so a person's homes are named alike whichever mailbox
 * they are in. A rendering, and only that: the core's paths keep the full
 * word, as the engine names them and the proposals page shows them, and a
 * provider's own noun for a home stays in its adapter (DD16 §1).
 */

/** The parent every home Brood makes sits under (#304). */
export const HOME_PARENT = "brood";

/** A path's first part, as its home's name shortens it: `external` reads `ext` (#304). */
const SHORT: Readonly<Record<string, string>> = { external: "ext" };

/**
 * The name a home has at the provider: the core's path under the `brood`
 * parent, with its first part shortened (#304). So the engine's
 * `external/stripe` is `brood/ext/stripe`.
 *
 * One parent keeps Brood's work in one group, apart from the homes the person
 * made, and stops a home Brood makes from landing inside one of theirs that
 * happens to share its name.
 */
export function homeAtProvider(path: string): string {
  const [first, ...rest] = path.split("/");
  // A path that already begins with a short form would share its name with
  // the path that shortens to it: `ext/x` and `external/x` both `brood/ext/x`,
  // two classifications in one home. The engine never names one; refused, so
  // a caller that did fails rather than filing into another's home. The same
  // for `quieted`, whose homes sit where a quieted home is moved (#393).
  if (Object.values(SHORT).includes(first!) || first === QUIETED) {
    throw new UnrenderableRuleError();
  }
  // Own keys only: `constructor` must not read Object.prototype's.
  const short = Object.hasOwn(SHORT, first!) ? SHORT[first!] : first;
  return [HOME_PARENT, short, ...rest].join("/");
}

/** Where a quieted home is moved, under the `brood` parent (#393). */
const QUIETED = "quieted";

/**
 * Where quieted homes sit in the mailbox, as a person sees it: what the pages
 * name when they say where quieted mail went, read from here rather than
 * typed (#451). Only where a provider can move a home there.
 */
export const QUIETED_AT_PROVIDER = `${HOME_PARENT}/${QUIETED}`;

/**
 * The name a quieted home has at the provider: its own name, moved under
 * `brood/quieted/`. So a quieted `external/stripe` is `brood/quieted/ext/stripe`,
 * out of the way and still found by its own name (#393).
 */
export function quietedHomeAtProvider(path: string): string {
  const home = homeAtProvider(path);
  return `${QUIETED_AT_PROVIDER}/${home.slice(HOME_PARENT.length + 1)}`;
}

/**
 * The name a home has in a mailbox as it is shown there now: moved under
 * `brood/quieted/` while quieted where the provider renames homes in place
 * (`renamesHomes`), and its own name otherwise, since a home a provider
 * cannot rename keeps its name when quieted (#1180).
 */
export function homeShownAt(
  path: string,
  shown: "active" | "quieted",
  renamesHomes: boolean,
): string {
  return shown === "quieted" && renamesHomes
    ? quietedHomeAtProvider(path)
    : homeAtProvider(path);
}
