/**
 * The channel port: what the core may ask of a connected mailbox, whatever
 * provider is behind it (D14 §4, DD16 §2, #456).
 *
 * The core imports this module and never an adapter, and an adapter imports
 * this module and nothing else of the core. It is published beside each
 * adapter in the public mirror (D10 §7), so it holds types, errors and the
 * capabilities declaration, and no logic that reaches the index.
 */
import type postgres from "postgres";
import type { AccountRef } from "../tokens";
import type { Capabilities } from "./capabilities";
import type {
  ChangeOptions,
  ChangePage,
  ListPage,
  ObservedEvent,
  PageOptions,
  ReadOptions,
  WindowOptions,
} from "./events";
import type {
  AdoptedRule,
  AdoptRefusal,
  BroodRule,
  OwnRule,
  OwnRuleShown,
  RecordedRule,
  RuleIdentity,
  RuleScope,
} from "./rules";
import type { OneClick } from "./unsubscribe";

/**
 * The colours a home can be drawn in: a colour of its own, each a hue word any
 * adapter can map, or the pale tint homes with little mail share. A port type,
 * like `Mailbox`.
 */
export type HomeColour = "blue" | "green" | "lavender" | "gold" | "muted";

/**
 * The parents Brood makes to hold homes, which are not homes themselves
 * (#1124): `root`, the one every home sits under, and `external`, the one the
 * homes on the `external/` path sit under. Each takes the shared tint and
 * never a colour of a home's own (DD1 §8.4). How each is named is the
 * adapter's, as a home's name is.
 */
export type HomeParent = "root" | "external";

/** How big a mailbox is (#558). Null where the provider gives no count. */
export interface MailboxSize {
  messages: number | null;
  conversations: number | null;
  /** Messages in the inbox. */
  inbox: number | null;
  /** Messages under Brood's homes. */
  filed: number | null;
  /**
   * The day the oldest mail still in it arrived, to the day: how far back it
   * goes. A lower bound on the account's age, since deleted mail leaves no
   * trace and a provider need not say when an account was made. Null for a
   * mailbox with no mail.
   */
  oldest: Date | null;
}

/**
 * A connected mailbox, as the rest of the app may hold it: what it can ask of
 * the mailbox, and no credential and no client (DD1 §3.2, §11).
 *
 * Each adapter implements it, and nothing outside an adapter knows which
 * provider is behind one (D14 §4, DD16 §2). What the adapter can do is said by
 * `capabilities`, which is how the core is to choose each verb's path (D14 §4)
 * rather than finding a verb missing in front of the person (DD16 §4).
 */
export interface Mailbox {
  /** What this provider can do, declared once by its adapter. */
  readonly capabilities: Capabilities;
  /**
   * The provider's change cursor as of now, opaque to the core. Captured
   * before a backfill lists anything, so that mail arriving during it is seen
   * twice rather than never (DD1 §4.1).
   */
  historyCursor(): Promise<string>;
  /**
   * One page of the events that arrived since `since`, drafts left out. The
   * provider's search syntax stays in the adapter: the caller names a time.
   */
  list(options: WindowOptions): Promise<ListPage>;
  read(providerEventId: string, options: ReadOptions): Promise<ObservedEvent>;
  /**
   * Whether this message offers a one-click unsubscribe Brood may post on the
   * person's behalf, and where (#595, RFC 8058). For the one message a person
   * pressed for: it reads what that message says of unsubscribing and of its
   * signature, and nothing else.
   */
  oneClick(providerEventId: string): Promise<OneClick>;
  /**
   * One page of the events added since a cursor. A cursor older than the
   * provider keeps history for fails as `cursor_expired`, which is a
   * documented state with a defined recovery, not an error to alarm on (DD1
   * §4.4).
   */
  changes(options: ChangeOptions): Promise<ChangePage>;
  /**
   * Ask the provider to push a notice of each change to `topic`, or renew the
   * request. It lasts until `expiresAt`, and a watch that lapses looks exactly
   * like a quiet mailbox (DD1 §4.2).
   */
  watch(topic: string): Promise<{ expiresAt: Date }>;
  /**
   * The mailbox's own addresses, as far as the provider will say: the primary,
   * and every alias it has verified as the person's. An unverified one is left
   * out, since ownership is not proven. What a provider leaves out is its
   * adapter's to say (Gmail's, in `gmail/mailbox.ts`, DD1 §2.3).
   */
  addresses(): Promise<string[]>;
  /**
   * How big the mailbox is, as far as the provider will say (#558): its
   * messages and conversations, what sits in the inbox, and what is filed
   * under Brood's homes. Only totals are asked for, so unread counts, which
   * interface-prohibitions refuses to show, are never fetched. A count the
   * provider does not give is null.
   */
  size(): Promise<MailboxSize>;
  /**
   * One page of the events a rule with this scope would file, carve-outs left
   * out: ids only, for the retroactive pass (DD1 §8). The provider's search
   * syntax stays in the adapter, as `list`'s does.
   */
  matching(scope: RuleScope, options?: PageOptions): Promise<ListPage>;
  /**
   * The provider's id for the home at `path`, made if it is absent (DD1 §8:
   * reconcile before creating). The adapter names it at the provider, under a
   * `brood` parent (#304; Gmail's `homeAtProvider`). Each parent is found or
   * made before its child, so `brood/ext/stripe` never depends on how the
   * provider treats a missing `brood` or `brood/ext`.
   */
  ensureHome(path: string): Promise<string>;
  /**
   * Show the home `homeId`, made for `path`, as `as`: under its own name, or
   * moved under `brood/quieted/` (#393). A rename, so the home keeps its id,
   * its mail and every rule filing into it. `left` where the home is not under
   * the name Brood gave it, which is the person's doing and not undone (DD1
   * §8), where the name it would take is in use, or where it has homes under
   * it. `shown` where it is shown so now, whether or not this call renamed it.
   */
  showHome(
    homeId: string,
    path: string,
    as: "active" | "quieted",
  ): Promise<"shown" | "left">;
  /**
   * The colour the home `homeId` has now (#796): one of Brood's, null for
   * none, or `other` for a colour that is none of Brood's. Whether a colour
   * Brood can draw was given by Brood is the core's to know, from its record.
   */
  homeColour(homeId: string): Promise<HomeColour | null | "other">;
  /** Give the home `homeId` the colour `to` (#796). */
  colourHome(homeId: string, to: HomeColour): Promise<void>;
  /**
   * The provider's id for each parent Brood makes that is there now, by the
   * name Brood gives it (#1124). One that is absent is left out and never
   * made here: `ensureHome` makes a parent with the home it holds. Its colour
   * is read and set by id with `homeColour` and `colourHome`, as a home's is.
   */
  parentHomes(): Promise<Map<HomeParent, string>>;
  /**
   * Install a rule that files what `scope` matches into `homeId`, out of view:
   * the home added and the inbox removed, before delivery. Returns the
   * provider's id for it.
   */
  installRule(
    scope: RuleScope,
    homeId: string,
    identity: RuleIdentity,
  ): Promise<string>;
  /**
   * Put a rule with `scope` in place of `providerRuleId`, filing into the same
   * home, and return the new rule's id. The provider cannot edit a rule, so the
   * new one is made first and the old one then removed; if that removal fails,
   * the new one is removed too and the call fails, so the provider never holds
   * two rules for one record. A rule no longer at the provider throws
   * `RuleNotFoundError`, before anything is made.
   */
  replaceRule(
    providerRuleId: string,
    scope: RuleScope,
    identity: RuleIdentity,
  ): Promise<string>;
  /**
   * The rules at the provider that may be Brood's, read as Brood's where they
   * plainly are (their identity, sender and home), or null where not (#291):
   * each one `recorded`, and each filing into a home of Brood's. The person's
   * own rules are listed by id and action only, and never read whole, so
   * nothing they wrote to match mail reaches Brood (D21 §2, #1106).
   */
  listRules(
    recorded: readonly RecordedRule[],
  ): Promise<{ providerRuleId: string; rule: BroodRule | null }[]>;
  /**
   * What the person's own rules name, with certainty, where they take that
   * mail somewhere (D21 §1, #1107): an exact address or a domain, and never a
   * rule's own text. Listed through the one mask, so nothing else a rule
   * matches arrives.
   */
  ownRules(): Promise<OwnRule[]>;
  /**
   * The person's own rules, for them to see beside Brood's, on their press
   * (D21 §4, #1109): each naming one sender for certain, with the person's
   * own homes it files under, by name, and what else it does, and how many
   * name none for certain.
   * Brood's own, told apart by `recorded` as `listRules` does, are left out.
   * Through the same one mask: nothing else a rule matches arrives.
   */
  ownRulesShown(recorded: readonly RecordedRule[]): Promise<{
    shown: OwnRuleShown[];
    unreadable: number;
    /**
     * The names of the person's own homes, none of Brood's, for the core to
     * recognise what another product left (#1111). Read for the press and
     * kept nowhere.
     */
    theirHomeNames: string[];
  }>;
  /**
   * One of the person's rules read whole, by its id, at their press to take it
   * over (D21 §4, #1110): the one read of a rule's full criteria, for that
   * rule alone, judged and not returned. What can be taken over exactly, why
   * it cannot, or null where it is gone.
   */
  ownRuleWhole(
    providerRuleId: string,
  ): Promise<AdoptedRule | AdoptRefusal | null>;
  /**
   * Put one of the person's rules back exactly as it was taken over (#1110):
   * its sender, into their home, out of the inbox. Returns its new id.
   */
  restoreOwnRule(rule: AdoptedRule): Promise<string>;
  /**
   * The home a rule files into now, asked of the rule itself. A home renamed by
   * the user keeps its id, and this is how Brood keeps filing into it (DD1 §8).
   */
  ruleHome(providerRuleId: string): Promise<string>;
  /** Remove a rule. One already gone is not an error. */
  removeRule(providerRuleId: string): Promise<void>;
  /**
   * File events already delivered into `homeId`, out of the inbox, as the
   * rule would have: the retroactive pass (DD1 §8), a thousand ids a request.
   */
  fileExisting(
    providerEventIds: readonly string[],
    homeId: string,
  ): Promise<void>;
  /**
   * The handles of Brood's homes at the provider (#442): the home each
   * `recorded` rule files into, which a home the person renamed out of
   * Brood's parent still is, and every home under that parent. How rescue
   * tells mail Brood filed from mail the person's own rules moved. No rule is
   * listed: a recorded rule with no home yet is asked by its id (#1106).
   */
  homeHandles(recorded: readonly RecordedRule[]): Promise<Set<string>>;
  /**
   * Put events back in the inbox (#442, and surfacing, #418). Adds the inbox
   * and removes nothing, so an event keeps the home it was filed under.
   */
  bringIntoView(providerEventIds: readonly string[]): Promise<void>;
  /**
   * Undo filing (#663, D17): put events back in the inbox and take `homeIds`,
   * the homes they were filed under, off them, so they are as they were before
   * Brood. Takes off those homes and nothing else, a thousand ids a request.
   * More than one where nested homes both filed them (#610).
   */
  returnFromHome(
    providerEventIds: readonly string[],
    homeIds: readonly string[],
  ): Promise<void>;
}

/**
 * Open one account's mailbox, reading its token through `on`: the transaction
 * a caller holds, when it holds one. Read through the pool instead, an open
 * inside a transaction waits for a second connection, and on a pool of one it
 * waits for ever: `make reconcile` hung that way on its first mailbox (#444).
 * disconnect opened this way from the start.
 *
 * The handle comes first, as it does in `openMailbox`, and on purpose: an
 * opener written as `(ref) => …` would type-check against a signature with
 * the handle second, silently ignoring it. With the handle first it is handed
 * a handle where it expects an account, and fails to compile.
 */
export type MailboxOpener = (
  on: postgres.Sql | postgres.TransactionSql,
  ref: AccountRef,
) => Promise<Mailbox>;
