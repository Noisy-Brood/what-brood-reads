import type { Provider } from "../channel";
import { keepGrant, openMailbox, revokeMailbox } from "./mailbox";
import { authorizationUrl, redeemCode, type OAuthClient } from "./oauth";

/**
 * Gmail as the port's `Provider` (#1180): Google's OAuth client bound to the
 * adapter's own connect, open and revoke, so the core names no Gmail function
 * to reach them. The registry (`server/providers.ts`) builds it.
 */
export function gmailProvider(client: OAuthClient): Provider {
  return {
    id: "gmail",
    authorizationUrl: (state, challenge) =>
      authorizationUrl(client, state, challenge),
    redeem: (code, verifier) => redeemCode(client, code, verifier),
    open: (on, ref, reason) => openMailbox(on, ref, client, { reason }),
    keepGrant: (on, ref) => keepGrant(on, ref, client),
    revoke: (on, ref) => revokeMailbox(on, ref, client),
  };
}
