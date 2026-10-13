/**
 * Authorization at Google: the consent request, the code exchange, and the one
 * profile read that says which mailbox was connected (DD1 §3.1).
 *
 * In the chokepoint because it is a path to Google, and written with `fetch`
 * rather than an OAuth library: the requests are small, and what matters is what
 * a failure carries. `gaxios`'s error redactor is marked experimental in its own
 * source and does not name `refresh_token`, `code` or `code_verifier` (#189's
 * design note), so nothing here goes through it. **A failure is an
 * `AuthorizationError` with the HTTP status and Google's error code, and nothing
 * from the request or the response body beyond that code.**
 *
 * Nothing is imported inward (D10 §7): the client's id and secret, the redirect
 * address and `fetch` itself arrive as arguments.
 */

import {
  AuthorizationError,
  revokeToken,
  sendJson,
  TOKEN,
  type Fetch,
} from "./request";

/** Revoke, best effort: a caller revoking because something else failed reports that failure, not this one. */
const revoke = async (refreshToken: string, fetchFn: Fetch) =>
  (await revokeToken(refreshToken, fetchFn)) === 200;

export { AuthorizationError };

/**
 * Google granted some of `SCOPES` and not all (#598). Its granular consent
 * screen lets a person untick a scope when more than one is asked for, and an
 * app "must verify which scopes were actually granted" (Google's
 * web-server OAuth guide). Brood cannot work with part of D2's grant, so the
 * grant is revoked before this is thrown. `missing` is the scopes not granted,
 * which are public strings and no secret. `revoked` is whether Google
 * confirmed the revocation: only its 200 does (`google-2026-oauth-revoke`),
 * and a grant it did not confirm is one the person is told to remove (review
 * of #614).
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
 * The profile read failed after Google minted a grant, and Google did not
 * confirm taking the grant back (#615): only its 200 does
 * (`google-2026-oauth-revoke`). The grant is live at Google and nothing holds
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
 * The scopes of `SCOPES` a token response did not grant: its `scope` is
 * "a list of space-delimited, case-sensitive strings" (Google's web-server
 * OAuth guide). A response with no `scope` granted nothing that can be shown,
 * so every scope is missing, and the connect fails loudly rather than
 * connecting on a guess.
 */
export function missingScopes(granted: unknown): string[] {
  const have = new Set(
    typeof granted === "string" ? granted.split(/\s+/).filter(Boolean) : [],
  );
  return SCOPES.filter((s) => !have.has(s));
}

/** The scopes, exactly D2's and nothing else. No `openid` or `email`: the mailbox is named by Gmail. */
export const SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.settings.basic",
]);

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const PROFILE = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Where to send the person to consent. `access_type=offline` is what yields a
 * refresh token, and `prompt=consent` makes Google issue one again on a
 * reconnect; without it a reconnect gets no refresh token and a mailbox that
 * stops syncing within the hour (DD1 §3.1).
 */
export function authorizationUrl(
  client: Pick<OAuthClient, "clientId" | "redirectUri">,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

// The exchange and the profile read hold tokens, so neither is exported, from
// here or from the index: the only way to them is `redeemCode`, which returns a
// sealer (DD1 §11). A module-private function cannot be deep-imported.

/** Redeem the code, with the PKCE verifier that proves this is who started the flow. */
async function exchange(
  client: OAuthClient,
  code: string,
  codeVerifier: string,
  fetchFn: Fetch,
): Promise<{ refreshToken: string; accessToken: string; scope: unknown }> {
  const body = await sendJson("exchange", () =>
    fetchFn(TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: client.redirectUri,
      }).toString(),
    }),
  );
  if (
    typeof body.refresh_token !== "string" ||
    typeof body.access_token !== "string"
  ) {
    // Without a refresh token the mailbox would stop syncing within the hour;
    // refusing now is better than connecting something that will lapse.
    throw new AuthorizationError("exchange", 200, "no_refresh_token");
  }
  return {
    refreshToken: body.refresh_token,
    accessToken: body.access_token,
    scope: body.scope,
  };
}

/** The connected mailbox's address, which names the account (DD1 §3.1). */
async function readAddress(
  accessToken: string,
  fetchFn: Fetch,
): Promise<string> {
  const body = await sendJson("profile", () =>
    fetchFn(PROFILE, { headers: { authorization: `Bearer ${accessToken}` } }),
  );
  if (
    typeof body.emailAddress !== "string" ||
    !body.emailAddress.includes("@")
  ) {
    throw new AuthorizationError("profile", 200, "no_address");
  }
  return body.emailAddress.trim().toLowerCase();
}

/** Where a refresh token is sealed. Described here rather than imported (D10 §7). */
export interface Sealer<Tx> {
  seal(
    sql: Tx,
    ref: { userId: string; accountId: string },
    refreshToken: string,
  ): Promise<void>;
}

/**
 * A redeemed authorization, as the rest of the app may hold it: the mailbox's
 * address, and the only two things it can do with the refresh token, which is
 * seal it or give it up.
 */
export interface Redeemed {
  address: string;
  sealInto<Tx>(
    vault: Sealer<Tx>,
    sql: Tx,
    ref: { userId: string; accountId: string },
  ): Promise<void>;
  /**
   * Revoke the refresh token at Google, for a caller that could not seal it.
   * Google has already minted it, so a token that is dropped instead is a live
   * grant to the mailbox that nobody holds and nobody will revoke.
   */
  discard(): Promise<boolean>;
}

/**
 * Redeem the code, name the mailbox, and hand back a way to seal the refresh
 * token, **never the token itself** (DD1 §11: nothing outside this module
 * receives a plaintext token). The refresh token lives in this closure until it
 * is sealed or discarded, and the access token is used for the profile read and
 * dropped. **If the grant is short of `SCOPES`, or the profile read fails, the
 * token just minted is revoked before the failure is reported**, since nothing
 * else will ever hold it.
 */
export async function redeemCode(
  client: OAuthClient,
  code: string,
  codeVerifier: string,
  fetchFn: Fetch = fetch,
): Promise<Redeemed> {
  const { refreshToken, accessToken, scope } = await exchange(
    client,
    code,
    codeVerifier,
    fetchFn,
  );
  // Before anything is read with it: a partial grant connects nothing (#598).
  const missing = missingScopes(scope);
  if (missing.length > 0) {
    throw new PartialGrantError(missing, await revoke(refreshToken, fetchFn));
  }
  let address: string;
  try {
    address = await readAddress(accessToken, fetchFn);
  } catch (e) {
    // Given back; and if Google does not confirm it, that is the failure the
    // person must hear, since the grant is still theirs to remove (#615).
    if (!(await revoke(refreshToken, fetchFn)))
      throw new GrantNotRevokedError(e instanceof Error ? e.name : "unknown");
    throw e;
  }
  return {
    address,
    sealInto: (vault, sql, ref) => vault.seal(sql, ref, refreshToken),
    discard: () => revoke(refreshToken, fetchFn),
  };
}
