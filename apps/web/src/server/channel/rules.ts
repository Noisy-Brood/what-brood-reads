/**
 * Rules as the port speaks of them (DD16 §1: a Rule is Brood's, a provider's
 * filter or rule is its rendering): Brood's own, as recorded and as read back,
 * and the person's own, read without their rule text (D21).
 */

/**
 * Brood's rule, provider-neutral: one address or a domain and everything under
 * it, and the exact addresses and root domains carved out of it (DD1 §7.5).
 * How it is written at a provider is the adapter's: Gmail's search syntax,
 * Microsoft's predicates.
 */
export interface RuleScope {
  from: { kind: "address" | "domain"; value: string };
  /** Exact addresses, and domains with everything under them. */
  exclude: readonly string[];
  /**
   * Exact addresses that, copied on a message, keep it out (#663). How an
   * alert that shares its sender with mailings is told apart, such as
   * GitHub's `security_alert`.
   */
  excludeCc?: readonly string[];
}

/**
 * Which Brood made a rule, and which of its rules it is (#291): the database's
 * installation id, twelve hex characters, and the rule's id.
 */
export interface RuleIdentity {
  installation: string;
  ruleId: string;
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

/** What one of the person's rules does, in words a page can say (#1109). */
export type OwnRuleDoes =
  "out_of_inbox" | "trash" | "read" | "starred" | "important" | "forwards";

/** One of the person's rules, as their page shows it (#1109). */
export interface OwnRuleShown {
  /** The provider's id for it, for a press to take it over by (#1110). */
  id: string;
  names: OwnRule;
  /** The person's own homes it files under, by their names. */
  under: string[];
  does: OwnRuleDoes[];
  /**
   * Why it cannot be taken over, as far as its sender and action say, or null
   * where they allow it; the press reads it whole and asks again (#1110).
   */
  refusal: AdoptRefusal | null;
}

/**
 * One of the person's rules, taken over as Brood's (D21 §4, #1110): the one
 * sender it names and the one home of theirs it files under, out of the
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
