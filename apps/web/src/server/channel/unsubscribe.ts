/**
 * One-click unsubscribe, as the port reports it (#595, RFC 8058): offered, with
 * an address to post to once, or not, and why.
 */

/** Why a message offers no one-click unsubscribe Brood may use. */
export type NoOneClick =
  /** No `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. */
  | "not_one_click"
  /** No `https:` address in `List-Unsubscribe`. */
  | "no_https"
  /** No signature the provider passed that covers both unsubscribe headers. */
  | "not_signed"
  /** A covering signature passed, but not the sender's own domain's. */
  | "not_aligned";

/**
 * What a caller may do with the address: post to it. An adapter hands out a
 * value that prints `[redacted]`, since the address usually carries a token
 * that would unsubscribe the person (for Gmail, `UnsubscribeUrl`); a caller is
 * promised only `href()`, so a test can stand one in, typed.
 */
export interface UnsubscribeAddress {
  href(): string;
}

/** Whether one message offers a one-click unsubscribe Brood may use (#595, RFC 8058). */
export type OneClick =
  | { offered: true; url: UnsubscribeAddress }
  | { offered: false; reason: NoOneClick };
