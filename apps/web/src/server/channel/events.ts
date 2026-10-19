/**
 * What the port hands the core about events: one event as read, and the pages
 * and options that list and follow them (D14 §4, #456).
 *
 * Nothing in an `ObservedEvent` is content. It is derived metadata, DD11 §6's
 * "the headers are discarded" made concrete, and the whole reason the index is
 * not a content store. The raw headers never leave the adapter.
 */

/**
 * One reachability event, in Brood's nouns.
 *
 * DD11 §1: an event is a fact about **arrival**.
 */
export interface ObservedEvent {
  /**
   * The provider's own id. Always present, and the handle for every subsequent
   * API call — but never the identity, because it does not survive a move and
   * cannot recognise the same message reaching two connected accounts.
   */
  providerEventId: string;

  /**
   * RFC 5322 `Message-ID`, the identity that means the same thing at every
   * provider. Nullable on purpose: DD16 §3 records that it is conventionally
   * universal and not actually guaranteed — some senders omit it, some
   * duplicate it — so deduplication falls back to `providerEventId` where it is
   * absent, and a collision is two events that look alike rather than one event.
   */
  messageId: string | null;

  /** The provider's native conversation handle. */
  providerConversationId: string | null;

  /**
   * When the event arrived, by the provider's own clock and never from the
   * `Date` header, which the sender writes, so a sender cannot backdate an
   * event out of the window a threshold reads. Gmail's reading of it is in its
   * `deriveEvent`.
   */
  occurredAt: Date;

  /** Normalised per DD1 §6.1: lowercased, `+tag` intact. For sender resolution. */
  senderAddress: string | null;

  /**
   * Whatever the sender typed. Adversary-written text — DD8 §3 — and anything
   * that renders it is rendering untrusted input.
   */
  senderDisplayName: string | null;

  /**
   * `outbound` when the provider marked the message as sent by this account,
   * and never inferred from `From`, which a stranger can forge — DD1 §6.4.
   */
  direction: "inbound" | "outbound";

  /**
   * For an outbound event, every distinct address in `To` and `Cc` other than
   * the account's own, normalised as `senderAddress` is. An outbound event
   * points at each of them (DD1 §6.4). Always empty for inbound: nothing reads
   * who else an inbound message went to, beyond the count.
   */
  recipientAddresses: string[];

  /**
   * For an inbound event, the addresses in its `Cc`, normalised as
   * `senderAddress` is. Read by rescue alone, to keep an alert told apart by
   * its Cc out of Brood's homes (#663), and never stored: the index keeps who
   * else a message went to only as a count. Always empty for outbound.
   */
  copied: string[];

  isReply: boolean;
  hasListUnsubscribe: boolean;
  /**
   * Whether the message offered a one-click unsubscribe Brood may use (#595):
   * `oneClickOf`'s decision from its headers, kept as a boolean and nothing
   * more. The address is never kept; the press reads the message again.
   */
  offersOneClick: boolean;
  recipientCount: number;

  /**
   * Where the person was on an inbound message: in `To`, only in `Cc`, or in
   * neither, which is how a Bcc, a group or a list arrives (DD1 §2.3, #654).
   * Null for outbound, which the person wrote.
   */
  addressed: Addressed | null;

  /**
   * Where the provider has the event as it is read (#442). What rescue decides
   * by, and not stored: where mail sits changes after it arrives, and an event
   * is a fact about arrival.
   */
  placement: Placement;
}

/** The person's place on an inbound message (DD1 §2.3). */
export type Addressed = "to" | "cc" | "neither";

/** Where an event sits at the provider, in Brood's nouns. */
export interface Placement {
  /** In the inbox. */
  inView: boolean;
  /** In spam or the bin, where the provider or the person put it aside. */
  setAside: boolean;
  /**
   * The provider's handles for everything the event is filed under: opaque,
   * compared only with the handles of Brood's own homes.
   */
  filedUnder: string[];
}

export interface ListPage {
  /** Provider ids, for `Mailbox.read`. */
  providerEventIds: string[];
  nextPageToken: string | null;
  /**
   * The provider's estimate of how many results the whole query has, where it
   * gives one: for Gmail, its `resultSizeEstimate`, which Google calls an
   * "estimated total number of results" and says no more about. A count,
   * never an id.
   */
  estimate?: number;
}

export interface ChangePage {
  /** Provider ids of events added in this page of changes, for `Mailbox.read`. */
  providerEventIds: string[];
  /**
   * How events moved in this page (#420): whether each was put in the inbox,
   * and the handles it was taken out from. Where an arrival was filed, in its
   * own record or before, is not a move; a record after it is.
   */
  moved: MovedEvent[];
  /**
   * The last change this page covers. Resuming from it, if the step stops
   * before the next page, repeats nothing already ingested and misses nothing.
   */
  through: string | null;
  nextPageToken: string | null;
  /** The mailbox's cursor as of this call: where the next sync starts once every page is read. */
  cursor: string | null;
}

/** One event's movement, in Brood's nouns. */
export interface MovedEvent {
  providerEventId: string;
  /** Put in the inbox. */
  intoView: boolean;
  /** The handles it was taken out from: opaque, compared with Brood's homes. */
  outOf: string[];
}

export interface ChangeOptions {
  /** The cursor to read changes after. */
  since: string;
  pageToken?: string;
  pageSize?: number;
}

export interface ReadOptions {
  /**
   * The mailbox's own addresses: the primary and every alias known (DD1 §2.3).
   * An argument rather than an import, per D10 §7, and a list rather than a
   * string because the account's own address has to be recognised in any form,
   * so it is never counted among the people an outbound message went to.
   */
  accountAddresses: readonly string[];
}

export interface PageOptions {
  pageToken?: string | null;
  pageSize?: number;
}

export interface WindowOptions {
  since: Date;
  /**
   * Where the window ends, for the older half of a first read (#602). Open to
   * now when absent.
   */
  before?: Date;
  /**
   * Sent mail only (#602): the first read lists the whole retention window
   * of it, so the guard for people the person has written to is whole.
   */
  sent?: boolean;
  pageToken?: string | null;
  pageSize?: number;
}
