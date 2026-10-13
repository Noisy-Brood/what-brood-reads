import { auth } from "@googleapis/gmail";

/**
 * A push from Gmail, through Pub/Sub, verified before anything is done with it
 * (DD1 §4.5).
 *
 * The endpoint is public and causes work, so an unverified one lets anyone make
 * us spend quota on history calls for any mailbox they can name. Pub/Sub signs
 * each push with an OIDC token for a service account we choose, addressed to an
 * audience we choose. Both are checked, and the signature against Google's
 * published keys, before the body is read.
 *
 * What a push says is small, and this passes on less: Gmail's notice carries
 * `emailAddress` and `historyId` and nothing else, no content and not even
 * message ids (DD1 §4.3). Only the address is returned. The sync reads changes
 * from the cursor it stored, never from one a request supplied.
 */

export interface PushConfig {
  /** The audience the subscription's tokens are addressed to. */
  audience: string;
  /** The service account the subscription signs as. */
  serviceAccount: string;
}

/** Google's public keys for its OIDC tokens, by key id, as PEM. */
export type SigningKeys = Record<string, string>;

export type PushRefusal =
  /** No bearer token. */
  | "no_token"
  /** A token that is not Google's, not for us, expired, or not the subscription's. */
  | "invalid_token"
  /** Verified, and not a notice this can read. */
  | "malformed";

/** A refused push. It carries the reason and nothing from the request. */
export class PushRejectedError extends Error {
  constructor(readonly reason: PushRefusal) {
    super(`push refused: ${reason}`);
    this.name = "PushRejectedError";
  }

  /** The refusal as a code, for a log and a span (#445). */
  get code(): string {
    return `push_${this.reason}`;
  }
}

export interface PushDeps {
  /** Google's current signing keys. Fetched from Google unless given. */
  keys?: () => Promise<SigningKeys>;
}

const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/**
 * One client for the process, so Google's signing certificates are fetched
 * once and kept until the expiry Google gives them: google-auth-library 11.1.0
 * caches them on the instance (`oauth2client.js`, `certificateCache`), and a
 * new instance per push fetched them on every push (#452). It holds no
 * credential; it only verifies.
 */
const verifier = new auth.OAuth2();

const googleKeys = async (): Promise<SigningKeys> => {
  const { certs } = await verifier.getFederatedSignonCertsAsync();
  return certs as SigningKeys;
};

/**
 * Verify a push and return the address it is about. Throws `PushRejectedError`.
 * The body is a function, and it is called only once the token has passed: an
 * unverified request is not parsed, whatever it sends.
 */
export async function verifyPush(
  authorization: string | null,
  readBody: () => Promise<unknown>,
  config: PushConfig,
  deps: PushDeps = {},
): Promise<{ address: string }> {
  const match = /^Bearer (\S+)$/.exec(authorization ?? "");
  if (!match) throw new PushRejectedError("no_token");

  let email: unknown;
  let verified: unknown;
  try {
    const ticket = await verifier.verifySignedJwtWithCertsAsync(
      match[1]!,
      await (deps.keys ?? googleKeys)(),
      config.audience,
      ISSUERS,
    );
    const payload = ticket.getPayload();
    email = payload?.email;
    verified = payload?.email_verified;
  } catch {
    // The library's messages can quote the token's payload back, so none of
    // them is kept.
    throw new PushRejectedError("invalid_token");
  }
  if (email !== config.serviceAccount || verified !== true) {
    throw new PushRejectedError("invalid_token");
  }

  let body: unknown;
  try {
    body = await readBody();
  } catch {
    throw new PushRejectedError("malformed");
  }
  const data = (body as { message?: { data?: unknown } } | null)?.message?.data;
  if (typeof data !== "string") throw new PushRejectedError("malformed");
  let notice: unknown;
  try {
    notice = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  } catch {
    throw new PushRejectedError("malformed");
  }
  const address = (notice as { emailAddress?: unknown } | null)?.emailAddress;
  if (typeof address !== "string" || !address.includes("@")) {
    throw new PushRejectedError("malformed");
  }
  return { address: address.trim().toLowerCase() };
}
