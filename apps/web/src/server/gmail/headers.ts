/**
 * The header allowlist, and the address parsing that reads it.
 *
 * DD1 §2.2 decided the allowlist and D2 §8's open question with it: fetching
 * every header and using eight of them means the other forty are in the process,
 * in memory, and one careless log line from being a leak. So the request names
 * what it wants.
 *
 * `Subject` is deliberately absent. DD11 §6 declined to store subjects because
 * nothing reads them; an allowlist makes that structural rather than
 * aspirational — a header that is never fetched cannot be stored by accident,
 * logged by accident, or end up in a stack trace.
 *
 * `Date` is absent too, and for a different reason. `occurred_at` comes from the
 * response's `internalDate`, not from a header — see `observe.ts`.
 *
 * `scripts/verify_gmail_reads.mjs` asserts that this list is defined exactly
 * once in the repository, that it holds exactly these headers, and that no call
 * site passes anything else. Changing it means changing DD1 §2.2 and DD11 §6
 * first, which is the point: it should be a visible, reviewable act.
 */
const METADATA_HEADERS: string[] = [
  "From",
  "To",
  "Cc",
  "Message-ID",
  "In-Reply-To",
  "References",
  "List-Unsubscribe",
  "List-Id",
  "List-Unsubscribe-Post",
  "DKIM-Signature",
  "Authentication-Results",
];

// Frozen, so `METADATA_HEADERS.push("Subject")` throws rather than quietly
// changing what every read asks for. `verify_gmail_reads.mjs` checks the
// definition above, not the value at call time, so mutation would have passed
// the gate while breaking the guarantee — a check reading as coverage, in the
// one module whose whole job is the privacy claim.
//
// The annotation stays `string[]` rather than `readonly string[]` on purpose.
// The client's `metadataHeaders` parameter takes `string[]`, so a readonly type
// would need a spread or a cast at the call site — and the gate requires the
// argument to be this constant, by name, so either would make the allowlist
// check vacuous. The freeze carries the guarantee; this paragraph carries the
// reason the type does not.
Object.freeze(METADATA_HEADERS);

/**
 * The headers the one-click unsubscribe read asks for (#595), for one message,
 * when the person presses, and for nothing else. What they prove is RFC 8058's
 * condition for offering it: the unsubscribe headers are covered by a DKIM
 * signature that Gmail checked (`Authentication-Results`) and that aligns with
 * the sender (`From`). `Subject` is absent here too.
 *
 * Its values never leave `unsubscribe.ts`: the read returns whether one-click
 * is offered, and the address to post to as a value that cannot print itself.
 * `verify_gmail_reads.mjs` holds this list to exactly these headers, and to the
 * one read in `unsubscribe.ts`, as it holds `METADATA_HEADERS` to `observe.ts`.
 */
const UNSUBSCRIBE_HEADERS: string[] = [
  "From",
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
  "DKIM-Signature",
  "Authentication-Results",
];

Object.freeze(UNSUBSCRIBE_HEADERS);

export { METADATA_HEADERS, UNSUBSCRIBE_HEADERS };

/** A header as the provider returns it. Structural, so nothing is imported. */
export interface RawHeader {
  name?: string | null;
  value?: string | null;
}

/**
 * Look a header up case-insensitively.
 *
 * Not a nicety: the header is `Message-ID` in RFC 5322 and `Message-Id` in a
 * great deal of mail that exists, and matching the RFC's casing alone would
 * silently drop the identity DD16 §3 deduplicates on — leaving every affected
 * event to fall back to the provider's own id and never correlate.
 */
export function header(headers: RawHeader[], name: string): string | null {
  const wanted = name.toLowerCase();
  for (const h of headers) {
    if (h.name?.toLowerCase() === wanted) return h.value?.trim() || null;
  }
  return null;
}

/**
 * Split an RFC 5322 address list into its addresses.
 *
 * Splitting on `,` is wrong and wrong invisibly: a quoted display name may
 * contain one — `"Doe, Jane" <jane@example.com>` is a single address that a
 * naive split reads as two. `recipient_count` feeds the personal-correspondence
 * predicate in DD1 §7.1, so over-counting there files mail that the rule exists
 * to leave alone. That is the shape of bug `conventions/testing.md` means by
 * logic that fails silently.
 *
 * So the separator is a comma at depth zero — outside quotes, outside angle
 * brackets, outside parenthesised comments.
 */
export function splitAddressList(value: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quoted = false;
  let escaped = false;
  let angle = 0;
  let comment = 0;

  for (const ch of value) {
    // Both escape branches have to respect comment state. They appended
    // unconditionally, so a comment escaping its own parentheses leaked into
    // the token it was supposed to be absent from: `a@x.com (Jane \\(J\\) Doe)`
    // parsed as `a@x.com \\(\\)`, which `addressOf` then accepted because it
    // still contains an `@`. The same corrupted-sender failure as the closing
    // paren below, arriving by a different route.
    //
    // A quoted string is not a comment, and its escapes are part of the name,
    // so this is keyed on `comment` rather than on escaping in general.
    if (escaped) {
      if (!comment) buf += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (!comment) buf += ch;
      escaped = true;
      continue;
    }
    if (quoted) {
      buf += ch;
      if (ch === '"') quoted = false;
      continue;
    }
    switch (ch) {
      case '"':
        quoted = true;
        break;
      case "(":
        comment++;
        break;
      case ")":
        // `continue`, not `break`. Falling through to the append below put the
        // closing paren back on the token the comment had just been stripped
        // from — `a@x.com (Jane)` became `a@x.com )`, which is not an address
        // and would have resolved to a sender nobody can write to twice.
        if (comment > 0) {
          comment--;
          continue;
        }
        break;
      case "<":
        if (!comment) angle++;
        break;
      case ">":
        if (!comment && angle > 0) angle--;
        break;
      case ",":
        if (!comment && !angle) {
          out.push(buf);
          buf = "";
          continue;
        }
        break;
    }
    if (!comment) buf += ch;
  }
  out.push(buf);
  return out.map((t) => t.trim()).filter(Boolean);
}

/**
 * The addr-spec inside one address token, lowercased.
 *
 * Lowercase only. DD1 §6.1 is explicit that `+tag` is not stripped: plus
 * addressing is valid on any domain and its meaning belongs to the sending
 * system, so `billing+eu@vendor.com` and `billing+us@vendor.com` may be two
 * mailboxes run by two teams. Collapsing them merges their stats and their
 * classifications below the tier that is supposed to do the aggregating, and a
 * wrong merge is worse than no merge.
 *
 * Returns null for anything that is not an address — which includes the group
 * syntax a mail system emits when it hides the recipients, `undisclosed-
 * recipients:;`. That is genuinely not an address, and counting it as one would
 * make a blind-copied message look like it was addressed to somebody.
 */
export function addressOf(token: string): string | null {
  let s = token.trim();

  // A group: `Managers: a@example.com;`. The label is not an address; the
  // members already arrived as their own comma-separated tokens.
  //
  // Only before the first `@`, which rules out the one place a colon appears
  // inside an address rather than in front of a list of them: an IPv6 domain
  // literal, `user@[IPv6:2001:db8::1]`. Slicing at that colon would leave a
  // fragment that still contains an `@` and so would be stored as a sender.
  const at = s.indexOf("@");
  const colon = topLevelColon(at < 0 ? s : s.slice(0, at));
  if (colon >= 0) s = s.slice(colon + 1);
  s = s.replace(/;\s*$/, "").trim();

  const open = s.lastIndexOf("<");
  const close = s.lastIndexOf(">");
  if (open >= 0 && close > open) s = s.slice(open + 1, close).trim();

  if (!s || !s.includes("@")) return null;
  return s.toLowerCase();
}

/**
 * The display name in one address token, or null.
 *
 * Untrusted input, and worth naming as such where it is produced rather than
 * where it is read: DD8 §3's whole argument is that a display name is whatever
 * the sender typed, so anything downstream that renders one is rendering
 * adversary-written text.
 *
 * Only the `Name <addr>` form is read. RFC 5322's older comment form —
 * `addr (Name)` — is dropped along with every other comment, because a comment
 * can appear anywhere in an address and treating one position as a display name
 * would mean guessing at the rest. A missing display name costs an entry in
 * `display_names[]`; a wrong one is a wrong label on a sender.
 */
export function displayNameOf(token: string): string | null {
  const s = token.trim();
  const open = s.lastIndexOf("<");
  if (open <= 0) return null;
  const name = s.slice(0, open).trim().replace(/^"|"$/g, "").trim();
  return name || null;
}

/** The index of a `:` at depth zero, or -1. */
function topLevelColon(s: string): number {
  let quoted = false;
  let escaped = false;
  let angle = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quoted) {
      if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "<") angle++;
    else if (ch === ">" && angle > 0) angle--;
    else if (ch === ":" && !angle) return i;
  }
  return -1;
}

/** Every address in a header value, lowercased, in order, deduplicated. */
export function addressesIn(value: string | null): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const token of splitAddressList(value)) {
    const addr = addressOf(token);
    if (addr) seen.add(addr);
  }
  return [...seen];
}
