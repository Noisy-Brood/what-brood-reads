/**
 * How a provider's grant fails, the same for every adapter (#1180), so the
 * core reads one set of errors whichever provider connected the mailbox. Each
 * carries a step, a status and a provider's code, and never anything of a
 * request or a response body, which may hold a token.
 */

export class AuthorizationError extends Error {
  constructor(
    /** What failed: the exchange, the profile read, or refreshing an access token. */
    readonly step: "exchange" | "profile" | "refresh",
    /** The HTTP status, or 0 when the request never completed. */
    readonly status: number,
    /** The provider's own error code, such as `invalid_grant`, when it gave one. */
    readonly providerCode: string | null,
  ) {
    super(
      `authorization failed at ${step}: ${status}${providerCode ? ` ${providerCode}` : ""}`,
    );
    this.name = "AuthorizationError";
  }

  /**
   * The failure as a code: the step, the status and the provider's code
   * (#445). Recorded as the class name alone before, so a rotated client
   * secret or an outage at a token endpoint stalled every mailbox with no
   * cause to read.
   */
  get code(): string {
    return `auth_${this.step}_${this.status}${this.providerCode ? `_${this.providerCode}` : ""}`;
  }
}

/**
 * The provider granted some of what Brood asked for and not all (#598). Brood
 * cannot work with part of a grant, so the adapter revokes it, where the
 * provider allows, before this is thrown. `missing` is the scopes not
 * granted, which are public strings and no secret. `revoked` is whether the
 * provider confirmed taking the grant back; a grant it did not confirm is one
 * the person is told to remove (review of #614).
 */
export class PartialGrantError extends Error {
  constructor(
    readonly missing: readonly string[],
    readonly revoked: boolean,
  ) {
    super("partial grant");
    this.name = "PartialGrantError";
  }
}

/**
 * Something failed after the provider minted a grant, and the provider did
 * not confirm taking it back (#615). The grant is live there and nothing holds
 * its token, so the person is told to remove it. It carries nothing of the
 * failure or the grant: a code for the log, and that is all.
 */
export class GrantNotRevokedError extends Error {
  constructor(
    /**
     * The class of the failure that started it, for the operator's line,
     * never its message (review of #681): a profile read that failed and a
     * network that did are different incidents.
     */
    readonly first: string,
  ) {
    super("grant not revoked");
    this.name = "GrantNotRevokedError";
  }

  get code(): string {
    return "connect_grant_not_revoked";
  }
}

/**
 * The provider did not confirm a revocation: its HTTP status, or 0 when the
 * request never completed. Nothing else, since the request held the refresh
 * token.
 */
export class RevocationError extends Error {
  constructor(readonly status: number) {
    super(`revocation not confirmed: ${status}`);
    this.name = "RevocationError";
  }
}
