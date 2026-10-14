/**
 * What a provider's failure means to Brood, decided by the adapter that knows
 * the provider (D14 §4, #456). Gmail answers 404 for a cursor too old to
 * resume from and for a message that is gone, and Microsoft Graph answers
 * neither with 404 (D22 §4). So the core reads `kind` and never a status: a
 * status means what its provider says it means, and only the adapter has read
 * that provider's documentation.
 *
 * - `gone`: what was asked about is not at the provider: a message, a rule or
 *   a home the person removed, or one an earlier pass did.
 * - `cursor_expired`: the change cursor is older than the provider keeps
 *   history for, a documented state with a defined recovery (DD1 §4.4).
 * - `page_refused`: a page token the provider no longer takes, on a listing
 *   that sent one (`Mailbox.list`, `Mailbox.matching`), so the listing can
 *   start again from the top.
 * - `rate_limited`: a limit to wait out rather than a failure.
 * - `failed`: anything else.
 */
export type ProviderFailure =
  "gone" | "cursor_expired" | "page_refused" | "rate_limited" | "failed";

/**
 * The rule a record names is not at the provider (#454): asked for by its own
 * id, the provider said it is not there. Thrown only for that lookup, before
 * anything is made, so a missing rule met while making or removing one stays a
 * `ProviderRequestError` and a failure (review of #760).
 */
export class RuleNotFoundError extends Error {
  constructor() {
    super("rule not found at the provider");
    this.name = "RuleNotFoundError";
  }
}

/**
 * A request to the mailbox failed. It carries which request, what the failure
 * means (`kind`), the HTTP status and the provider's reason code, and nothing
 * else: a client library's own error holds the request it made, and that
 * request's headers hold the access token.
 */
export class ProviderRequestError extends Error {
  constructor(
    readonly operation:
      | "cursor"
      | "list"
      | "read"
      | "changes"
      | "watch"
      | "addresses"
      | "matching"
      | "home"
      | "rule"
      | "file"
      | "view"
      | "return"
      | "size",
    /** The HTTP status, or 0 when there was none. For the code, never to branch on. */
    readonly status: number,
    /**
     * The provider's own code for the failure (#375): for Gmail,
     * `error.errors[].reason` in its body, since a 403 is a rate limit, a
     * quota, a domain policy or a permission and only this says which. A code,
     * never text: the adapter keeps it only when it is a short run of letters,
     * so nothing else of the body is carried.
     */
    readonly reason: string | null = null,
    /** What the failure means, as the adapter judged it from its provider's documentation. */
    readonly kind: ProviderFailure = "failed",
  ) {
    super(
      `provider request failed at ${operation}: ${status}${reason ? ` ${reason}` : ""}`,
    );
    this.name = "ProviderRequestError";
  }

  /**
   * The failure as a code: the operation, the status and the provider's
   * reason, and nothing else. What a sync records and a span carries (#445).
   */
  get code(): string {
    return `provider_${this.operation}_${this.status}${this.reason ? `_${this.reason}` : ""}`;
  }

  /** A limit to wait out rather than a failure. */
  get rateLimited(): boolean {
    return this.kind === "rate_limited";
  }
}

/**
 * The response carried no arrival time, so the event cannot be placed in
 * time. Not a malformed response the sync fails on: one it skips.
 */
export class MissingArrivalTimeError extends Error {
  constructor(providerEventId: string) {
    super(`no arrival time on message ${providerEventId}`);
    this.name = "MissingArrivalTimeError";
  }
}

/**
 * The message is a draft, which reached nobody and so is not a reachability
 * event in either direction (DD11 §1). Not a malformed response: a message the
 * index has no place for, which the sync path skips rather than fails on.
 * Why the adapter has to refuse one is the adapter's to say: Gmail's is beside
 * the check in its `deriveEvent` (`gmail/derive.ts`).
 */
export class DraftNotAnEventError extends Error {
  constructor(providerEventId: string) {
    super(`message ${providerEventId} is a draft`);
    this.name = "DraftNotAnEventError";
  }
}
