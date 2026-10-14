import {
  addressOf,
  header,
  UNSUBSCRIBE_HEADERS,
  type RawHeader,
} from "./headers";
import type { ProviderClient } from "./client";
import type { OneClick } from "../channel";

/**
 * Whether one message offers a one-click unsubscribe Brood may use on the
 * person's behalf (#595, RFC 8058), and where to send it.
 *
 * The second of the chokepoint's two message reads, beside `readEvent`, and as
 * narrow: `format: "metadata"` and `UNSUBSCRIBE_HEADERS`, for one message, at
 * the person's press. The raw headers do not leave this file. What leaves is
 * whether one-click is offered, why not where it is not, and the address to
 * post to as an `UnsubscribeUrl`, which cannot print itself: it usually
 * carries a token that would unsubscribe the person, so it is used once and
 * never stored, logged or shown.
 *
 * RFC 8058 §4: the unsubscribe headers "MUST be covered by" a valid DKIM
 * signature, and without one the receiver "SHOULD NOT offer a one-click
 * unsubscribe". So it is offered only when all of these hold:
 *
 *   - `List-Unsubscribe-Post` is exactly `List-Unsubscribe=One-Click`, and
 *     `List-Unsubscribe` has an `https:` address.
 *   - Gmail's own `Authentication-Results` says `dkim=pass` for a signature.
 *     Only the first is read, which Gmail adds as it receives the message: a
 *     sender can carry one of its own further down, and Google does not
 *     document that Gmail removes it.
 *   - That signature's `h=` names both unsubscribe headers.
 *   - Its signing domain aligns with the `From` address's domain, so the
 *     sending service's own signature (a `d=sendgrid.info` beside the
 *     sender's) never qualifies a message alone.
 *
 * Anything it cannot read is not offered: fail closed (security).
 */

const REDACTED = "[redacted]";

/** The address a one-click unsubscribe is posted to, as a value that cannot print itself. */
export class UnsubscribeUrl {
  readonly #href: string;

  private constructor(href: string) {
    this.#href = href;
  }

  /** Only from a parsed `https:` address. */
  static of(url: URL): UnsubscribeUrl {
    if (url.protocol !== "https:") throw new Error("not an https address");
    return new UnsubscribeUrl(url.href);
  }

  /** The address itself, for the one request that posts to it. */
  href(): string {
    return this.#href;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

/** Read one message's unsubscribe headers and say whether one-click is offered. */
export async function readUnsubscribe(
  client: ProviderClient,
  id: string,
): Promise<OneClick> {
  const { data } = await client.users.messages.get({
    format: "metadata",
    metadataHeaders: UNSUBSCRIBE_HEADERS,
    // Its headers alone, and nothing else of the message (gmail/index.ts).
    fields: "payload/headers",
    userId: "me",
    id,
  });
  return oneClickOf(data.payload?.headers ?? []);
}

/** The decision, from the headers alone. Exported for its tests. */
export function oneClickOf(headers: RawHeader[]): OneClick {
  const post = header(headers, "List-Unsubscribe-Post");
  if (post?.replace(/\s+/g, "") !== "List-Unsubscribe=One-Click")
    return { offered: false, reason: "not_one_click" };

  const url = httpsAddress(header(headers, "List-Unsubscribe"));
  if (!url) return { offered: false, reason: "no_https" };

  const passed = gmailDkimPasses(headers);
  const covering = all(headers, "DKIM-Signature")
    .map(signatureOf)
    .filter(
      (s): s is Signature =>
        s !== null &&
        s.signed.has("list-unsubscribe") &&
        s.signed.has("list-unsubscribe-post") &&
        passed.some((p) => passes(p, s)),
    );
  if (covering.length === 0) return { offered: false, reason: "not_signed" };

  const from = domainOf(addressOf(header(headers, "From") ?? ""));
  if (!from || !covering.some((s) => aligned(s.domain, from)))
    return { offered: false, reason: "not_aligned" };

  return { offered: true, url: UnsubscribeUrl.of(url) };
}

/** Every value of a header, in the order the message holds them. */
const all = (headers: RawHeader[], name: string): string[] =>
  headers
    .filter((h) => h.name?.toLowerCase() === name.toLowerCase())
    .map((h) => h.value ?? "");

/** The first `https:` address in a `List-Unsubscribe` value: `<https://…>, <mailto:…>`. */
function httpsAddress(value: string | null): URL | null {
  if (!value) return null;
  for (const m of value.matchAll(/<([^>]*)>/g)) {
    const raw = m[1]!.replace(/\s+/g, "");
    if (!URL.canParse(raw)) continue;
    const url = new URL(raw);
    if (url.protocol === "https:") return url;
  }
  return null;
}

/** A `dkim=pass` result in Gmail's `Authentication-Results`, as it names the signature. */
interface Pass {
  /** `header.d`, or the domain of `header.i`. */
  domain: string | null;
  /** `header.b`: the first characters of the signature's `b=`, where given. */
  b: string | null;
}

/**
 * The `dkim=pass` results in the first `Authentication-Results`, and only if
 * Gmail wrote it (`mx.google.com`, the authserv-id RFC 8601 puts first).
 */
function gmailDkimPasses(headers: RawHeader[]): Pass[] {
  const first = all(headers, "Authentication-Results")[0];
  if (!first) return [];
  const [authserv, ...results] = first.split(";");
  if (authserv?.trim().toLowerCase() !== "mx.google.com") return [];
  return results
    .map((r) => r.trim())
    .filter((r) => /^dkim=pass\b/i.test(r))
    .map((r) => {
      const d = /\bheader\.d=([^\s;]+)/i.exec(r)?.[1];
      const i = /\bheader\.i=([^\s;]+)/i.exec(r)?.[1];
      const b = /\bheader\.b=([^\s;]+)/i.exec(r)?.[1];
      const domain = d ?? (i ? i.slice(i.lastIndexOf("@") + 1) : null);
      return { domain: domain?.toLowerCase() || null, b: b ?? null };
    });
}

/** A `DKIM-Signature`, as far as this needs it. */
interface Signature {
  domain: string;
  /** The `h=` tag's header names, lower-cased. */
  signed: Set<string>;
  /** The `b=` tag, folding whitespace removed. */
  b: string;
}

/** Its tags, `d=`, `h=` and `b=`, or null where one is missing. */
function signatureOf(value: string): Signature | null {
  const tags = new Map<string, string>();
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    tags.set(
      part.slice(0, eq).trim().toLowerCase(),
      part.slice(eq + 1).replace(/\s+/g, ""),
    );
  }
  const domain = tags.get("d")?.toLowerCase();
  const h = tags.get("h");
  const b = tags.get("b");
  if (!domain || !h || !b) return null;
  return {
    domain,
    signed: new Set(h.split(":").map((n) => n.trim().toLowerCase())),
    b,
  };
}

/**
 * Whether a pass names this signature: by its domain always, and by
 * `header.b` as well where Gmail gave it. Never by `header.b` alone: it is
 * only the first characters of `b=`, which a sender can read off the
 * signature Gmail did verify and copy into a forged one for another domain
 * (review of #1020).
 */
function passes(p: Pass, s: Signature): boolean {
  if (p.b && !s.b.startsWith(p.b)) return false;
  return (
    p.domain !== null &&
    (p.domain === s.domain || p.domain.endsWith(`.${s.domain}`))
  );
}

const domainOf = (address: string | null): string | null =>
  address ? address.slice(address.lastIndexOf("@") + 1) || null : null;

/**
 * DMARC's relaxed alignment, by the domains' own labels: one is the other or
 * under it. Without the public suffix list, which DMARC uses to find the
 * organizational domain, a signing domain of a single label is refused, so a
 * `d=com` never aligns with everything under it. A signature at a public
 * suffix of two labels (`co.uk`) would still align; no one but its registry
 * can sign there, and a pass from Gmail is required besides.
 */
function aligned(signer: string, from: string): boolean {
  if (!signer.includes(".")) return false;
  return (
    signer === from ||
    from.endsWith(`.${signer}`) ||
    signer.endsWith(`.${from}`)
  );
}
