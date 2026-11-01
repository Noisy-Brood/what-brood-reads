/**
 * A provider as the core reaches it to connect, open and end a grant (D14 §4,
 * #1180). The shape is generalised from Gmail's ahead of a second adapter,
 * which will confirm or change it: not every provider offers a revocation
 * Brood can make (D22 §7). Each adapter implements it; the registry
 * (`server/providers.ts`) is the one place that holds them all.
 */
import type postgres from "postgres";
import type { AccountRef, ReadReason } from "../tokens";
import type { Mailbox } from "./mailbox";

/** The providers Brood connects, as `accounts.provider` names them. */
export type ProviderId = "gmail";

/** How the grant ended: revoked now, or found already dead, by the provider's own answer. */
export type Revocation = "revoked" | "already_revoked";

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
   * Revoke the refresh token at the provider, for a caller that could not
   * seal it. The provider has already minted it, so a token that is dropped
   * instead is a live grant to the mailbox that nobody holds and nobody will
   * revoke.
   */
  discard(): Promise<boolean>;
}

type Handle = postgres.Sql | postgres.TransactionSql;

/** One provider, configured: its client's id, secret and redirect address held inside. */
export interface Provider {
  readonly id: ProviderId;
  /** Where to send the person to consent, for the state and PKCE challenge given. */
  authorizationUrl(state: string, codeChallenge: string): string;
  /** Redeem a code: a sealer for its refresh token, never the token (DD1 §11). */
  redeem(code: string, codeVerifier: string): Promise<Redeemed>;
  /** Open the account's mailbox, its token read on `on` for `reason` (#451). */
  open(on: Handle, ref: AccountRef, reason: ReadReason): Promise<Mailbox>;
  /** Use a stopped mailbox's token and nothing else, so the grant stays alive (#801). */
  keepGrant(on: postgres.Sql, ref: AccountRef): Promise<void>;
  /** End Brood's grant at the provider (DD14 §4). */
  revoke(on: Handle, ref: AccountRef): Promise<Revocation>;
}

/** Every configured provider, as the core holds them. */
export interface Providers {
  /** The provider of the account `ref`, read on the handle given. */
  of(on: Handle, ref: AccountRef): Promise<Provider>;
  /** By name, for connect, before the account exists. */
  named(id: ProviderId): Provider;
}
