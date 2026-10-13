import { oneClickOf } from "./unsubscribe";
import {
  addressesIn,
  addressOf,
  displayNameOf,
  header,
  splitAddressList,
} from "./headers";
import type { ObservedEvent, Placement, ProviderMessage } from "./types";

/**
 * The response carried no id, so the event has no handle at the provider.
 *
 * DD16 §3 makes this the one identifier that is always present — the native id
 * is the handle for every later API call, where the RFC `Message-ID` is the
 * identity and is nullable. A message without one is a malformed response, not
 * an event with a blank id.
 */
export class MissingProviderEventIdError extends Error {
  constructor() {
    super("provider message has no id");
    this.name = "MissingProviderEventIdError";
  }
}

/** The response carried no `internalDate`, so the event cannot be placed in time. */
export class MissingArrivalTimeError extends Error {
  constructor(providerEventId: string) {
    super(`no internalDate on message ${providerEventId}`);
    this.name = "MissingArrivalTimeError";
  }
}

/**
 * The message is a draft, which reached nobody and so is not a reachability
 * event in either direction (DD11 §1). Not a malformed response: a message the
 * index has no place for, which the sync path skips rather than fails on.
 *
 * Why it has to be refused here: a draft carries neither `SENT` nor `INBOX`, so
 * it would be derived as inbound, from the account itself, and the account would
 * become one of its own senders, the thing DD1 §6.4 was written to prevent. And
 * each edit of a draft can surface again through history.
 */
export class DraftNotAnEventError extends Error {
  constructor(providerEventId: string) {
    super(`message ${providerEventId} is a draft`);
    this.name = "DraftNotAnEventError";
  }
}

/**
 * Reduce one provider message to the fields DD1 §2.3 keeps.
 *
 * Pure, and that is the point: no network, no auth, no mailbox. The derivation
 * is the part that fails silently — a wrong `recipientCount` moves a threshold
 * in DD1 §7.1 and nothing looks broken — so it is the part with tests.
 *
 * The account's own addresses arrive as an argument rather than an import. D10
 * §7 constrains this module to take what it needs from the rest of the app that
 * way: it will be published, and a chokepoint that grows dependencies inward
 * becomes either unreadable when mirrored or over-inclusive.
 */
export function deriveEvent(
  message: ProviderMessage,
  accountAddresses: readonly string[],
): ObservedEvent {
  // Checked first, and refused rather than defaulted. `?? ""` satisfied the
  // type and broke the promise the type makes: `providerEventId` is documented
  // as always present and is the handle every later call passes back to the
  // provider. Empty strings also collide with each other, so two malformed
  // responses would have deduplicated into one event — and the error below
  // would have named an empty id while doing it.
  if (!message.id) throw new MissingProviderEventIdError();
  const providerEventId = message.id;
  // Before anything else is derived: a draft is not an event at all. Gmail puts
  // its DRAFT system label on every draft, from its interface and its API alike,
  // and no one can apply it by hand.
  if (message.labelIds?.includes("DRAFT")) {
    throw new DraftNotAnEventError(providerEventId);
  }
  const headers = message.payload?.headers ?? [];

  // `occurredAt` is `internalDate` and never the `Date` header, which is not
  // pedantry. `Date` is written by the sending system, so a sender can backdate
  // a message — filing the event in the wrong monthly partition, outside the
  // window a threshold query reads, and out of step with the `after:` operator
  // that bounds backfill, which works on Google's internal time. DD11 §1 defines
  // an event as a fact about arrival. `internalDate` is when it arrived; `Date`
  // is a claim about when it was sent.
  const epochMs = Number(message.internalDate);
  if (!message.internalDate || !Number.isFinite(epochMs)) {
    // Refused rather than defaulted. Substituting the current time would place
    // the event in a partition it does not belong to and look like success —
    // and `conventions/security.md` says an uncertain operation takes no action.
    throw new MissingArrivalTimeError(providerEventId);
  }

  const from = header(headers, "From");
  const fromToken = from ? (splitAddressList(from)[0] ?? null) : null;

  const to = addressesIn(header(headers, "To"));
  const cc = addressesIn(header(headers, "Cc"));
  const recipients = [...to, ...cc];
  const unique = new Set(recipients);

  // The provider's own mark, and not a match on `From`: a stranger can put the
  // account's address there, and mail read as sent on that evidence would record
  // the user writing to whoever the forger named (DD1 §6.4).
  const direction = message.labelIds?.includes("SENT") ? "outbound" : "inbound";

  return {
    providerEventId,
    messageId: normaliseMessageId(header(headers, "Message-ID")),
    providerConversationId: message.threadId ?? null,
    occurredAt: new Date(epochMs),

    senderAddress: fromToken ? addressOf(fromToken) : null,
    senderDisplayName: fromToken ? displayNameOf(fromToken) : null,

    direction,
    // Copying yourself is not writing to a correspondent, so the account's own
    // addresses are not recipients, and a message sent only to yourself has none.
    recipientAddresses:
      direction === "outbound"
        ? [...unique].filter((a) => !isAccountAddress(a, accountAddresses))
        : [],

    // Who an inbound message copied, for rescue and nothing else (#663).
    copied: direction === "inbound" ? cc : [],

    // A reply is a message that points at another. Either header is enough:
    // `References` without `In-Reply-To` is common in list mail.
    isReply:
      header(headers, "In-Reply-To") !== null ||
      header(headers, "References") !== null,

    // The bulk-mail signal. `List-Id` catches mail from a list that omits the
    // unsubscribe header, which is most internal and many transactional lists.
    hasListUnsubscribe:
      header(headers, "List-Unsubscribe") !== null ||
      header(headers, "List-Id") !== null,

    // The same decision the press makes (`unsubscribe.ts`), kept as whether
    // and nothing else: the address is dropped with the headers.
    offersOneClick: oneClickOf(headers).offered,

    // Deduplicated: the same person in both `To` and `Cc` is one recipient, and
    // counting them twice inflates the number the personal-correspondence
    // predicate tests.
    recipientCount: unique.size,

    // Where the person was (#654). Bcc never arrives as a header, so mail they
    // were Bcc'd on, or reached them through a group, has them in neither line.
    // To wins over Cc: someone in both was written to. Outbound mail has no
    // place to record, since the person wrote it.
    addressed:
      direction === "outbound"
        ? null
        : to.some((a) => isAccountAddress(a, accountAddresses))
          ? "to"
          : cc.some((a) => isAccountAddress(a, accountAddresses))
            ? "cc"
            : "neither",

    placement: placementOf(message.labelIds ?? []),
  };
}

/**
 * Where the message sits (#442). Spam and the bin are set aside, and rescue
 * never takes mail out of either: a sender a pattern matches can be forged, and
 * what the provider judged spam stays there.
 */
function placementOf(labels: readonly string[]): Placement {
  return {
    inView: labels.includes("INBOX"),
    setAside: labels.includes("SPAM") || labels.includes("TRASH"),
    filedUnder: [...labels],
  };
}

/**
 * `Message-ID` as `<id@host>`; store the addr-spec inside.
 *
 * Normalised here rather than at the reader, because DD16 §3 deduplicates on
 * this value and two spellings of one id deduplicate against nothing.
 */
function normaliseMessageId(value: string | null): string | null {
  if (!value) return null;
  const m = /<([^>]+)>/.exec(value);
  const id = (m?.[1] ?? value).trim();
  return id || null;
}

/**
 * Does this recipient address belong to the connected account?
 *
 * `+tag` **is** collapsed here, and that is deliberately the opposite of what
 * DD1 §6.1 does for senders. The asymmetry is real rather than an oversight: a
 * sender's plus-tag may distinguish two mailboxes run by two teams, so merging
 * them is a wrong merge. The account's own plus-tag never does — the provider
 * delivers `me+receipts@` to the same mailbox as `me@`.
 *
 * And the two errors are not symmetric either. What this decides is who an
 * outbound message went to: a false negative counts the person's own address as
 * a correspondent, which only ever protects mail from quieting; a false positive
 * would drop a real correspondent, whom DD1 §7.1's "a sender the user has
 * written to" protects. The generous reading is the safe one.
 *
 * Gmail ignores dots in a `gmail.com` local part, so `f.lastname@gmail.com`
 * and `flastname@gmail.com` are one mailbox, and are matched as one here
 * (review of #660). Google says so for Gmail and says the opposite for work
 * and school addresses, where a dot is part of the address
 * (`google-2026-gmail-dots`), so only `gmail.com` is folded.
 * `googlemail.com` is not on that page, and is left as written. An alias is
 * passed in `accountAddresses`, which is why this is a list; where the list
 * comes from, and the aliases it cannot include, is DD1 §2.3.
 */
function isAccountAddress(
  address: string,
  accountAddresses: readonly string[],
): boolean {
  const candidate = mailbox(address);
  return accountAddresses.some(
    (own) => mailbox(own.trim().toLowerCase()) === candidate,
  );
}

/** The mailbox an address delivers to: no `+tag`, and no dots at gmail.com. */
function mailbox(address: string): string {
  const bare = withoutTag(address);
  const at = bare.lastIndexOf("@");
  if (at < 0 || bare.slice(at + 1) !== "gmail.com") return bare;
  return bare.slice(0, at).replaceAll(".", "") + bare.slice(at);
}

function withoutTag(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 0) return address;
  const local = address.slice(0, at);
  const plus = local.indexOf("+");
  return (plus < 0 ? local : local.slice(0, plus)) + address.slice(at);
}
