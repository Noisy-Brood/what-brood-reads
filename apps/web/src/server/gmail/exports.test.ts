import { describe, expect, it } from "vitest";
import * as gmail from "./index";

/**
 * The chokepoint's public surface, pinned.
 *
 * `scripts/verify_token_access.mjs` stops anything but this module and the vault
 * importing the module that opens a token, and stops either handing it onward by
 * re-export. What a lexical check cannot see is a function that calls the opener
 * and returns what it read. That is code, and whether a function's result is a
 * token needs a type system and not a regex.
 *
 * What covers it is that this list is short and is asserted, so an added export is
 * a diff to this file that a reviewer cannot miss, and a token-returning one has
 * to be added on purpose. If you are here because this failed: is the new export
 * something the rest of the app should hold, and does it return, or accept and
 * return, anything a caller could use as a credential? Then update the list.
 */
describe("the chokepoint's exports", () => {
  it("are exactly these, and none of them hands a credential to the caller", () => {
    // `redeemCode` returns the mailbox's address and a sealer, never a token:
    // the refresh token stays in its closure until the vault seals it. The code
    // exchange and the profile read, which do hold tokens, are not exported.
    // `openMailbox` returns functions over a client it keeps; the refresh
    // token is used once and dropped, and the access token stays in the client.
    // `revokeMailbox` returns how the grant ended, as a word, and nothing else.
    // `keepGrant` returns nothing: the access token it is given is dropped
    // (#801).
    // `UnrenderableRuleError` carries nothing of the value it refused, and
    // `RuleNotFoundError` nothing at all (#454).
    // `homeAtProvider` and `quietedHomeAtProvider` turn a path into a name, and
    // `QUIETED_AT_PROVIDER` is the name quieted homes sit under (#451).
    // `rulesFile` writes Brood's own rules from its record, with no read and
    // without the tag that marks them Brood's (#1108).
    // `PartialGrantError` carries the scopes not granted, which are public, and
    // `GrantNotRevokedError` carries nothing but its code (#615).
    // No raw client and no read function: outside, Gmail is a `Mailbox`, and
    // `scripts/verify_gmail_reads.mjs` refuses an index that exports either.
    expect(Object.keys(gmail).sort()).toEqual([
      "AuthorizationError",
      "DraftNotAnEventError",
      "GrantNotRevokedError",
      "HOME_PARENT",
      "METADATA_HEADERS",
      "MissingArrivalTimeError",
      "PartialGrantError",
      "ProviderRequestError",
      "PushRejectedError",
      "QUIETED_AT_PROVIDER",
      "READS_PER_MINUTE",
      "RevocationError",
      "RuleNotFoundError",
      "SCOPES",
      "UnrenderableRuleError",
      "authorizationUrl",
      "deriveEvent",
      "homeAtProvider",
      "keepGrant",
      "openMailbox",
      "quietedHomeAtProvider",
      "redeemCode",
      "renderable",
      "renderableValue",
      "revokeMailbox",
      "rulesFile",
      "verifyPush",
    ]);
  });
});
