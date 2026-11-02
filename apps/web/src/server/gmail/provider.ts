import type { Provider } from "../channel";
import { keepGrant, openMailbox, revokeMailbox } from "./mailbox";
import { authorizationUrl, redeemCode, type OAuthClient } from "./oauth";

/**
 * Gmail as the port's `Provider` (#1180): Google's OAuth client bound to the
 * adapter's own connect, open and revoke, so the core names no Gmail function
 * to reach them, and the Pub/Sub topic its mailboxes push to, read as each is
 * opened, or null for none. The registry (`server/providers.ts`) builds it.
 */
export function gmailProvider(
  client: OAuthClient,
  topic: () => string | null,
): Provider {
  return {
    id: "gmail",
    authorizationUrl: (state, challenge) =>
      authorizationUrl(client, state, challenge),
    redeem: (code, verifier) => redeemCode(client, code, verifier),
    open: (on, ref, reason) =>
      openMailbox(on, ref, client, { reason, topic: topic() }),
    keepGrant: (on, ref) => keepGrant(on, ref, client),
    revoke: (on, ref) => revokeMailbox(on, ref, client),
  };
}
