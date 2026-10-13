/**
 * One request to Google's OAuth endpoints, and the one shape its failure takes.
 *
 * Shared by the code exchange (`oauth.ts`) and the access-token refresh
 * (`mailbox.ts`), which are the two places a request body carries a credential.
 * **A failure is an `AuthorizationError` with the step, the HTTP status and
 * Google's error code, and nothing from the request or the response body beyond
 * that code.** It returns a response body, which may hold a token, so it is
 * exported to this directory's modules and not from the index.
 */

export const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";

export type Fetch = typeof fetch;

export class AuthorizationError extends Error {
  constructor(
    /** What failed: the exchange, the profile read, or refreshing an access token. */
    readonly step: "exchange" | "profile" | "refresh",
    /** The HTTP status, or 0 when the request never completed. */
    readonly status: number,
    /** Google's own error code, such as `invalid_grant`, when it gave one. */
    readonly providerCode: string | null,
  ) {
    super(
      `authorization failed at ${step}: ${status}${providerCode ? ` ${providerCode}` : ""}`,
    );
    this.name = "AuthorizationError";
  }

  /**
   * The failure as a code: the step, the status and Google's code (#445).
   * Recorded as the class name alone before, so a rotated client secret or an
   * outage at Google's token endpoint stalled every mailbox with no cause to
   * read.
   */
  get code(): string {
    return `auth_${this.step}_${this.status}${this.providerCode ? `_${this.providerCode}` : ""}`;
  }
}

/** Google's error code from a failed response, if it sent one. Never the body. */
async function providerCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown } | null;
    return typeof body?.error === "string" && /^[a-z_]{1,64}$/.test(body.error)
      ? body.error
      : null;
  } catch {
    return null;
  }
}

/**
 * Make one request and return its JSON object, or throw an
 * `AuthorizationError`. The whole contract is here: a network failure, a
 * refusal, and a success that is not a JSON object all end the same way, with
 * the step and the status and nothing from the request or the body.
 */
export async function sendJson(
  step: AuthorizationError["step"],
  run: () => Promise<Response>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await run();
  } catch {
    // A network failure's message can carry the URL, and the URL here can carry
    // nothing we want kept, so none of it is.
    throw new AuthorizationError(step, 0, null);
  }
  if (!response.ok) {
    throw new AuthorizationError(
      step,
      response.status,
      await providerCode(response),
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AuthorizationError(step, response.status, "malformed_response");
  }
  return body as Record<string, unknown>;
}

/**
 * Revoke a token at Google, and say what Google answered: its HTTP status, or 0
 * when the request never completed. Google's documented answer is 200 for a
 * revocation it processed and 400, with an error code, for anything else, and
 * revoking an access token revokes its refresh token too
 * (`google-2026-oauth-revoke`). Nothing of the request or the body is kept.
 */
export async function revokeToken(
  token: string,
  fetchFn: Fetch,
): Promise<number> {
  try {
    const response = await fetchFn(REVOKE, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return response.status;
  } catch {
    return 0;
  }
}
