/**
 * What the chokepoint hands the rest of the app.
 *
 * DD16 §1 is the rule the names here follow: a provider's noun may not appear
 * in the core — not in the schema, not in a type, not in a function name. This
 * module is the one place Gmail's vocabulary is allowed, and this file is the
 * boundary, so the words `label`, `filter` and `thread` stop here.
 *
 * Nothing in an `ObservedEvent` is content. It is derived metadata — DD11 §6's
 * "the headers are discarded" made concrete, and the whole reason the index is
 * not a content store. The raw headers never leave this module.
 *
 * The fields are enumerated below rather than counted here. `docs-are-current.md`
 * refuses a count beside the list it counts, and this one had already drifted:
 * it said two identifiers where there are three, and omitted the display name.
 */

/** A header as the provider returns it. */
export type { RawHeader } from "./headers";

/**
 * One message as the provider returns it under `format=metadata`.
 *
 * Declared structurally rather than imported from the client library, so the
 * derivation below can be tested without a mailbox, a network or an auth
 * client — which is most of what makes it testable at all.
 */
export interface ProviderMessage {
  id?: string | null;
  /** Gmail's native conversation handle. DD16 §3 keeps it as the API handle. */
  threadId?: string | null;
  /** Epoch milliseconds, as a string. The source of `occurredAt`. */
  internalDate?: string | null;
  /**
   * The provider's system and user labels. `DRAFT` makes the message not an
   * event, and `SENT` is the source of `direction` (DD1 §2.3, §6.4). The rest
   * says where the message sits, which rescue reads (#442) and ingest stores
   * none of.
   */
  labelIds?: string[] | null;
  payload?: {
    headers?: Array<{ name?: string | null; value?: string | null }> | null;
  } | null;
}

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
   * RFC 5322 `Message-ID`, the identity that means the same thing at both
   * providers. Nullable on purpose: DD16 §3 records that it is conventionally
   * universal and not actually guaranteed — some senders omit it, some
   * duplicate it — so deduplication falls back to `providerEventId` where it is
   * absent, and a collision is two events that look alike rather than one event.
   */
  messageId: string | null;

  /** The provider's native conversation handle. */
  providerConversationId: string | null;

  /**
   * When the event arrived, from the response's `internalDate` and never from
   * the `Date` header. The distinction is load-bearing — see `deriveEvent`.
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
