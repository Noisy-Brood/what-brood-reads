/**
 * The channel port (D14 §4, DD16 §2, #456): the one module the core imports to
 * speak to a mailbox, and the one an adapter implements. Types, errors and the
 * capabilities declaration, and how every adapter names a home, and nothing
 * else: no client, no credential and no read, which stay in each adapter
 * (`server/gmail/`).
 */
export type { Capabilities } from "./capabilities";
export {
  DraftNotAnEventError,
  MissingArrivalTimeError,
  ProviderRequestError,
  RuleNotFoundError,
  UnrenderableRuleError,
} from "./errors";
export {
  HOME_PARENT,
  homeAtProvider,
  QUIETED_AT_PROVIDER,
  quietedHomeAtProvider,
} from "./homes";
export type { ProviderFailure } from "./errors";
export {
  AuthorizationError,
  GrantNotRevokedError,
  PartialGrantError,
  RevocationError,
} from "./grant";
export type {
  Addressed,
  ChangeOptions,
  ChangePage,
  ListPage,
  MovedEvent,
  ObservedEvent,
  PageOptions,
  Placement,
  ReadOptions,
  WindowOptions,
} from "./events";
export type {
  HomeColour,
  HomeParent,
  Mailbox,
  MailboxOpener,
  MailboxSize,
  Watch,
  WatchNotice,
} from "./mailbox";
export type {
  AdoptedRule,
  AdoptRefusal,
  BroodRule,
  OwnRule,
  OwnRuleDoes,
  OwnRuleShown,
  RecordedRule,
  RuleIdentity,
  RuleScope,
} from "./rules";
export type {
  Provider,
  Providers,
  Redeemed,
  Revocation,
  Sealer,
} from "./provider";
export type { NoOneClick, OneClick, UnsubscribeAddress } from "./unsubscribe";
