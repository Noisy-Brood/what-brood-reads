/**
 * THE chokepoint. `apps/web/src/server/gmail/` is the only path to Google.
 *
 * D2 traded "we cannot read your content" for "we never do." That trade is only
 * worth something if the second half is enforced, so it is enforced here and
 * checked by `scripts/verify_gmail_reads.mjs`, which was written before the
 * first Gmail call and sat vacuous until this module landed:
 *
 *   1. No Gmail API call exists outside this directory.
 *   2. Every body-bearing read sets `format: "metadata"` explicitly.
 *   3. `metadataHeaders` is only ever `METADATA_HEADERS`, and that constant
 *      holds exactly DD1 §2.2's allowlist — which omits `Subject`.
 *   4. Every metadata read names the fields it takes (`fields`), so nothing
 *      else of a message comes back: Gmail's `snippet`, the opening of the
 *      body, is not among them. Google's reference for `messages.get` does not
 *      say whether the `metadata` format omits it, so the request does.
 *
 * Two boundaries hold this module in shape, and both are cheapest to keep while
 * it is being written:
 *
 * **Nothing else in the app is imported.** D10 §7: it imports types, its own
 * configuration, and the encryption helpers (`../tokens`), which it names and
 * does not contain. Everything else it needs arrives as arguments — the auth
 * client, the account's own addresses. It will be published, and a chokepoint
 * that grows dependencies inward is either unreadable when mirrored or
 * over-inclusive about what gets mirrored. `boundary.test.ts` holds the line.
 *
 * **Gmail's vocabulary stops here.** DD16 §1: no provider noun in the core.
 * `thread`, `label` and `filter` are allowed in this directory and nowhere else,
 * and `scripts/verify_provider_nouns.mjs` is what makes that a mechanism rather
 * than a discipline.
 */
// The code exchange and the profile read are not exported: they hold tokens.
// `redeemCode` returns a sealer, never a token (DD1 §11).
export {
  AuthorizationError,
  authorizationUrl,
  GrantNotRevokedError,
  PartialGrantError,
  redeemCode,
  SCOPES,
} from "./oauth";
export type { OAuthClient, Redeemed, Sealer } from "./oauth";
// Not exported: the raw client (`./client`) and the read functions that take one
// (`listEventIds`, `readEvent`, `readUnsubscribe`). Outside this directory Gmail is reached through a
// `Mailbox` and nothing else, and `scripts/verify_gmail_reads.mjs` holds it there.
export {
  keepGrant,
  openMailbox,
  ProviderRequestError,
  RevocationError,
  revokeMailbox,
  RuleNotFoundError,
} from "./mailbox";
export type {
  Mailbox,
  MailboxDeps,
  MailboxOpener,
  MailboxSize,
  PageOptions,
  Revocation,
  WindowOptions,
} from "./mailbox";
export type { HomeColour } from "./colours";
export { PushRejectedError, verifyPush } from "./push";
export type { PushConfig, PushDeps, PushRefusal, SigningKeys } from "./push";
export type {
  ChangeOptions,
  ChangePage,
  MovedEvent,
  ListOptions,
  ListPage,
  ReadOptions,
} from "./observe";

export {
  deriveEvent,
  DraftNotAnEventError,
  MissingArrivalTimeError,
} from "./derive";
export { METADATA_HEADERS } from "./headers";
// A type only: an address is made by the read, never outside it.
export type {
  NoOneClick,
  OneClick,
  UnsubscribeAddress,
  UnsubscribeUrl,
} from "./unsubscribe";
export {
  HOME_PARENT,
  homeAtProvider,
  quietedHomeAtProvider,
  QUIETED_AT_PROVIDER,
  renderable,
  renderableValue,
  UnrenderableRuleError,
} from "./rules";
export type {
  AdoptRefusal,
  AdoptedRule,
  BroodRule,
  OwnRule,
  OwnRuleDoes,
  OwnRuleShown,
  RecordedRule,
  RuleIdentity,
  RuleScope,
} from "./rules";
export { rulesFile, type RuleToWrite } from "./filter-file";

export type { ObservedEvent, Placement, ProviderMessage } from "./types";
export { READS_PER_MINUTE } from "./pace";
