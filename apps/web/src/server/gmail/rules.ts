/**
 * A rule's scope, rendered into Gmail's search syntax (DD1 §7.5, §8).
 *
 * Brood's rule is provider-neutral: one address or a domain and everything under
 * it, and the exact addresses and root domains carved out of it. Gmail's filter takes a `query` and
 * a `negatedQuery`, each in "the same query format as the Gmail search box"
 * (`google-2026-gmail-filters`), and the retroactive pass searches with the same
 * two joined. So the rendering is written once, here, and both use it.
 *
 * The scope arrives as a structural type rather than an import from the core,
 * which D10 §7 asks of this module: it will be published, and a chokepoint that
 * reaches inward for its types is either unreadable when mirrored or mirrors too
 * much.
 *
 * **Every value is refused unless it is plainly an address or a domain.** These
 * strings become search syntax, and a value holding a space, a brace, a quote or
 * `OR` would be syntax rather than a value: a carve-out that silently stopped
 * excluding anything, or a rule that filed far more than it said. The values come
 * from the index, already normalised, so a refusal here is a defect upstream, and
 * it fails rather than being escaped into something that might mean anything.
 */

export interface RuleScope {
  from: { kind: "address" | "domain"; value: string };
  /** Exact addresses, and domains with everything under them. */
  exclude: readonly string[];
  /**
   * Exact addresses that, copied on a message, keep it out (#663): `cc:`
   * terms, which Gmail's search matches in the Cc or Bcc fields
   * (`google-2026-gmail-search-operators`). How an alert that shares its
   * sender with mailings is told apart, such as GitHub's `security_alert`.
   */
  excludeCc?: readonly string[];
}

/**
 * A value in a scope is not plainly an address or a domain. It carries nothing
 * of the value: that is a sender's address, and D8 §7 keeps sender addresses
 * out of every error report.
 */
export class UnrenderableRuleError extends Error {
  constructor() {
    super("a rule value is not a plain address or domain");
    this.name = "UnrenderableRuleError";
  }
}

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const DOMAIN = new RegExp(`^(?:${LABEL}\\.)+[a-z]{2,63}$`);
const LOCAL = /^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9_+-])?$/;

function plainDomain(value: string): string {
  if (!DOMAIN.test(value)) throw new UnrenderableRuleError();
  return value;
}

function plainAddress(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0 || !LOCAL.test(value.slice(0, at))) {
    throw new UnrenderableRuleError();
  }
  plainDomain(value.slice(at + 1));
  return value;
}

/** One sender term. */
const term = (kind: "address" | "domain", value: string): string =>
  kind === "address"
    ? `from:${plainAddress(value)}`
    : `from:${plainDomain(value)}`;

/** One copied-address term: an exact address and nothing looser. */
const ccTerm = (value: string): string => `cc:${plainAddress(value)}`;

/**
 * Can this one value be rendered, as an address if it has an `@` and as a
 * domain if not? What the never-quiet list asks of an entry before it takes it:
 * every rule carries every entry (#288), so one it could not render would stop
 * every rule from being installed or rewritten.
 */
export function renderableValue(value: string): boolean {
  return renderable({
    from: { kind: "domain", value: "example.com" },
    exclude: [value],
  });
}

/**
 * Can this scope be rendered? Asked before anything is installed, so a sender
 * the index accepts and the renderer does not, an address with RFC punctuation
 * in its local part say, is refused as unrenderable rather than failing at the
 * provider. Gmail's documentation does not say how its search reads those
 * characters, so none of them is rendered.
 */
export function renderable(scope: RuleScope): boolean {
  try {
    renderRule(scope);
    return true;
  } catch (e) {
    if (e instanceof UnrenderableRuleError) return false;
    throw e;
  }
}

/** The parent every home Brood makes sits under in Gmail (#304). */
export const HOME_PARENT = "brood";

/** A path's first part, as its label shortens it: `external` reads `ext` (#304). */
const SHORT: Readonly<Record<string, string>> = { external: "ext" };

/**
 * The name a home has at the provider: the core's path under the `brood`
 * parent, with its first part shortened where the label is (#304). So the
 * engine's `external/stripe` is the label `brood/ext/stripe`.
 *
 * A rendering, and only that. The core's paths keep the full word, as the engine
 * names them and the proposals page shows them; a label is Gmail's rendering of
 * a classification (DD16 §1). One parent keeps Brood's work in one group, apart
 * from the labels the user made, and stops a home Brood makes from landing
 * inside one of theirs that happens to share its name.
 */
export function homeAtProvider(path: string): string {
  const [first, ...rest] = path.split("/");
  // A path that already begins with a short form would share its label with
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
 * typed (#451).
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
 * Which Brood made a rule, and which of its rules it is (#291): the database's
 * installation id, twelve hex characters, and the rule's id.
 */
export interface RuleIdentity {
  installation: string;
  ruleId: string;
}

const TAG = /^nb-([0-9a-f]{12})([0-9a-f]{32})\.invalid$/;

/**
 * The tag a rule carries at the provider, as one more carve-out: a domain under
 * `.invalid`, which RFC 2606 reserves for names "sure to be invalid"
 * (`rfc-2606`), so no sender has it and the carve-out excludes nothing. Searched
 * read-only on the dev mailbox, the term alone matched nothing and a rule with it
 * matched exactly what it matched without (#291).
 */
export function ruleTag(identity: RuleIdentity): string {
  const hex = identity.ruleId.replaceAll("-", "").toLowerCase();
  if (
    !/^[0-9a-f]{12}$/.test(identity.installation) ||
    !/^[0-9a-f]{32}$/.test(hex)
  ) {
    throw new UnrenderableRuleError();
  }
  return `nb-${identity.installation}${hex}.invalid`;
}

/**
 * A rule as Brood recorded it: its id at the provider, and the home it files
 * into where that is recorded. What tells Brood's rules apart from the
 * person's without reading the person's whole (D21 §2, #1106).
 */
export interface RecordedRule {
  providerRuleId: string;
  homeId: string | null;
}

/**
 * What one of the person's own rules names, read with certainty: one exact
 * address, or one domain (D21 §1, #1107). Never the rule's own text: only this
 * leaves the chokepoint.
 */
export type OwnRule = { kind: "address" | "domain"; value: string };

/**
 * One of the person's rules, as what its `from` names for certain, where its
 * action takes that mail somewhere: out of the inbox, to the trash, or under
 * one of the person's own labels (`theirLabels`). Null for anything less
 * certain, a display name, several names or Gmail's operators, and for a rule
 * that only stars, marks read or forwards: an unclear rule takes no action
 * (interface-prohibitions, principle 3), so Brood proposes as it would.
 */
export function ownRuleOf(
  rule: ProviderRule,
  theirLabels: ReadonlySet<string>,
): OwnRule | null {
  const adds = rule.action?.addLabelIds ?? [];
  const takes =
    (rule.action?.removeLabelIds ?? []).includes("INBOX") ||
    adds.includes("TRASH") ||
    adds.some((l) => theirLabels.has(l));
  return takes ? namedBy(rule) : null;
}

/** The one sender a rule's `from` names for certain, or null. */
function namedBy(rule: ProviderRule): OwnRule | null {
  const from = (rule.criteria?.from ?? "").trim().toLowerCase();
  // Plain as Brood's own rules are plain: the same patterns `term` renders by.
  const at = from.lastIndexOf("@");
  if (
    at > 0 &&
    LOCAL.test(from.slice(0, at)) &&
    DOMAIN.test(from.slice(at + 1))
  )
    return { kind: "address", value: from };
  const domain = from.startsWith("@") ? from.slice(1) : from;
  return DOMAIN.test(domain) ? { kind: "domain", value: domain } : null;
}

/** What one of the person's rules does, in words a page can say (#1109). */
export type OwnRuleDoes =
  "out_of_inbox" | "trash" | "read" | "starred" | "important" | "forwards";

/** One of the person's rules, as their page shows it (#1109). */
export interface OwnRuleShown {
  /** The provider's id for it, for a press to take it over by (#1110). */
  id: string;
  names: OwnRule;
  /** The person's own labels it files under, by their names. */
  under: string[];
  does: OwnRuleDoes[];
  /**
   * Why it cannot be taken over, as far as its sender and action say, or null
   * where they allow it; the press reads it whole and asks again (#1110).
   */
  refusal: AdoptRefusal | null;
}

/**
 * The person's own rules, for them to see beside Brood's (D21 §4, #1109):
 * each one that names one sender for certain, with the labels it adds by
 * their names and what else it does, and how many it names no sender for
 * certain, which Brood does not read. Brood's own, filing into one of
 * `broodHomes`, are left out. A forwarding address is never carried, only
 * that a rule forwards.
 */
export function describeOwnRules(
  rules: readonly (ProviderRule & { id?: string | null })[],
  labelNames: ReadonlyMap<string, string>,
  broodHomes: ReadonlySet<string>,
  theirLabels: ReadonlySet<string> = new Set(),
): { shown: OwnRuleShown[]; unreadable: number } {
  const shown: OwnRuleShown[] = [];
  let unreadable = 0;
  for (const rule of rules) {
    const adds = rule.action?.addLabelIds ?? [];
    if (adds.some((l) => broodHomes.has(l))) continue;
    const names = namedBy(rule);
    if (!names) {
      unreadable++;
      continue;
    }
    const removes = rule.action?.removeLabelIds ?? [];
    const does: OwnRuleDoes[] = [];
    if (removes.includes("INBOX")) does.push("out_of_inbox");
    if (adds.includes("TRASH")) does.push("trash");
    if (removes.includes("UNREAD")) does.push("read");
    if (adds.includes("STARRED")) does.push("starred");
    if (adds.includes("IMPORTANT")) does.push("important");
    if (rule.action?.forward) does.push("forwards");
    const adoptable = adoptableOf(rule, theirLabels);
    shown.push({
      id: rule.id ?? "",
      names,
      under: adds.flatMap((l) => {
        const name = labelNames.get(l);
        return name === undefined ? [] : [name];
      }),
      does,
      refusal: typeof adoptable === "string" ? adoptable : null,
    });
  }
  return { shown, unreadable };
}

/**
 * One of the person's rules, taken over as Brood's (D21 §4, #1110): the one
 * sender it names and the one label of theirs it files under, out of the
 * inbox. All it takes to put theirs back exactly, and no text of theirs, since
 * a rule that held any is never taken over.
 */
export type AdoptedRule = { names: OwnRule; homeId: string };

/** Why one of the person's rules cannot be taken over exactly (#1110). */
export type AdoptRefusal =
  /** It also matches a subject, a search, an attachment, a size or a recipient. */
  | "matches_more"
  /** Its `from` names no one sender for certain. */
  | "not_one_sender"
  /** It leaves mail in the inbox, which Brood's rules never do. */
  | "keeps_in_inbox"
  | "forwards"
  /** It also stars, marks read, sends to the trash or marks important. */
  | "does_more"
  | "no_home"
  | "several_homes";

/**
 * Whether one of the person's rules can be carried exactly as one of Brood's
 * (#1110): one sender named for certain, no other criterion, and an action of
 * one of their own labels (`theirLabels`) and out of the inbox, nothing more.
 * Judged on the list, where only `from` and the action are read, and again on
 * the rule read whole at the person's press.
 */
export function adoptableOf(
  rule: ProviderRule,
  theirLabels: ReadonlySet<string>,
): AdoptedRule | AdoptRefusal {
  const c = rule.criteria ?? {};
  if (
    c.to ||
    c.subject ||
    c.query ||
    c.negatedQuery ||
    c.hasAttachment ||
    c.excludeChats ||
    c.size
  )
    return "matches_more";
  const names = namedBy(rule);
  if (!names) return "not_one_sender";
  const a = rule.action ?? {};
  if (a.forward) return "forwards";
  const removes = a.removeLabelIds ?? [];
  if (!removes.includes("INBOX")) return "keeps_in_inbox";
  const adds = a.addLabelIds ?? [];
  if (removes.length > 1 || adds.some((l) => !theirLabels.has(l)))
    return "does_more";
  if (adds.length === 0) return "no_home";
  if (adds.length > 1) return "several_homes";
  return { names, homeId: adds[0]! };
}

/** A rule as the provider lists it: the fields a filter can carry. */
export interface ProviderRule {
  criteria?: {
    from?: string | null;
    to?: string | null;
    subject?: string | null;
    query?: string | null;
    negatedQuery?: string | null;
    hasAttachment?: boolean | null;
    excludeChats?: boolean | null;
    size?: number | null;
    sizeComparison?: string | null;
  } | null;
  action?: {
    addLabelIds?: string[] | null;
    removeLabelIds?: string[] | null;
    forward?: string | null;
  } | null;
}

const TERM = /^from:\S+$/;
const CC_TERM = /^cc:\S+$/;

/** A rule at the provider that is plainly Brood's: who made it, what it files, where. */
export interface BroodRule {
  identity: RuleIdentity;
  /** The sender term of its query, read back into Brood's terms. */
  from: RuleScope["from"];
  /** The one home it files into. */
  home: string;
  /**
   * What it carves out, besides its tag, as the provider holds it: the values
   * of its other `from:` terms, sorted. What the sweep compares with the record,
   * since a copy edited at the provider can carve out less than the record says
   * (#441).
   */
  exclude: string[];
  /** Its `cc:` carve-outs' addresses, sorted: the same, for copied addresses. */
  excludeCc: string[];
}

/** Keys a present value of which is anything but null makes a rule not Brood's. */
const onlyKeys = (o: object, allowed: readonly string[]) =>
  Object.entries(o).every(
    ([k, v]) => allowed.includes(k) || v === null || v === undefined,
  );

/**
 * The rule, read as Brood's, **only if the whole of it is exactly the shape
 * Brood writes**: criteria of a `query` and a `negatedQuery` and nothing else,
 * not even a field set false; a query of one `from:` term; carve-outs of `from:`
 * terms joined by `OR`, exactly one of them a tag, then any `cc:` terms; an action that adds one home
 * and removes the inbox, and nothing else. Anything else is null, and a sweep
 * leaves it alone.
 *
 * The tag is text in a filter, and a user can write text into a filter: copy one
 * of Brood's and change it, or paste a tag into a rule of their own. The shape
 * is one guard; the sweep's other is that it removes only what a record vouches
 * for, comparing the sender and home read here against it (review of #296).
 *
 * Whether Gmail hands `negatedQuery` back exactly as it was written is not
 * documented and has not been tried, since trying needs a filter created on a
 * real mailbox. If it rewrites the text, nothing matches this shape and a sweep
 * removes nothing, which is the safe way for that to be wrong.
 */
export function broodRuleOf(rule: ProviderRule): BroodRule | null {
  const c = rule.criteria ?? {};
  const a = rule.action ?? {};
  if (!onlyKeys(c, ["query", "negatedQuery"])) return null;
  if (!onlyKeys(a, ["addLabelIds", "removeLabelIds"])) return null;
  const query = c.query ?? "";
  if (!TERM.test(query)) return null;
  const all = (c.negatedQuery ?? "").split(" OR ");
  // The sender terms, then the copied ones: the order `renderRule` writes.
  const split = all.findIndex((t) => !TERM.test(t));
  const terms = split === -1 ? all : all.slice(0, split);
  const copied = split === -1 ? [] : all.slice(split);
  if (!copied.every((t) => CC_TERM.test(t))) return null;
  const tags = terms
    .map((t) => TAG.exec(t.slice("from:".length)))
    .filter((m): m is RegExpExecArray => m !== null);
  if (tags.length !== 1) return null;
  const adds = a.addLabelIds ?? [];
  const removes = a.removeLabelIds ?? [];
  if (adds.length !== 1 || adds[0] === "INBOX") return null;
  if (removes.length !== 1 || removes[0] !== "INBOX") return null;
  const value = query.slice("from:".length);
  // Once each: a filter that repeats a term carves out nothing more, and a
  // repeat would read as a difference from the record on every sweep.
  const exclude = [
    ...new Set(
      terms.map((t) => t.slice("from:".length)).filter((v) => !TAG.test(v)),
    ),
  ].sort();
  const [, installation, h] = tags[0]!;
  return {
    identity: {
      installation: installation!,
      ruleId: `${h!.slice(0, 8)}-${h!.slice(8, 12)}-${h!.slice(12, 16)}-${h!.slice(16, 20)}-${h!.slice(20)}`,
    },
    from: { kind: value.includes("@") ? "address" : "domain", value },
    home: adds[0]!,
    exclude,
    excludeCc: [...new Set(copied.map((t) => t.slice("cc:".length)))].sort(),
  };
}

/**
 * The filter's two halves. `negatedQuery` is null when nothing is carved out.
 * A rule being installed carries its tag among the carve-outs; a search does not
 * need one.
 */
export function renderRule(
  scope: RuleScope,
  identity?: RuleIdentity,
): {
  query: string;
  negatedQuery: string | null;
} {
  const exclude = [
    ...new Set([...scope.exclude, ...(identity ? [ruleTag(identity)] : [])]),
  ].sort();
  // After the sender terms, so a rule with no copied carve-out renders as it
  // always has, and is not rewritten for nothing.
  const terms = [
    ...exclude.map((v) => term(v.includes("@") ? "address" : "domain", v)),
    ...[...new Set(scope.excludeCc ?? [])].sort().map(ccTerm),
  ];
  return {
    query: term(scope.from.kind, scope.from.value),
    negatedQuery: terms.length ? terms.join(" OR ") : null,
  };
}

/**
 * The search that finds what the rule would have filed, for the retroactive pass:
 * the query, less the carve-outs. Drafts are left out, as the window's listing
 * leaves them out, because a draft reached nobody.
 */
export function searchFor(scope: RuleScope): string {
  const { query, negatedQuery } = renderRule(scope);
  return [
    query,
    negatedQuery && `-{${negatedQuery.replaceAll(" OR ", " ")}}`,
    "-in:drafts",
  ]
    .filter(Boolean)
    .join(" ");
}
