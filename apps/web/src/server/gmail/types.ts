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
