/**
 * The channel port (D14 §4, DD16 §2, #456): the one module the core imports to
 * speak to a mailbox, and the one an adapter implements. Types, errors and the
 * capabilities declaration, and nothing else: no client, no credential and no
 * read, which stay in each adapter (`server/gmail/`).
 */
export type { Capabilities } from "./capabilities";
export {
  DraftNotAnEventError,
  MissingArrivalTimeError,
  ProviderRequestError,
  RuleNotFoundError,
} from "./errors";
export type { ProviderFailure } from "./errors";
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
export type { NoOneClick, OneClick, UnsubscribeAddress } from "./unsubscribe";
