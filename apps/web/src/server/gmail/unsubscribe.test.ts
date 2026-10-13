import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import type { RawHeader } from "./headers";
import { oneClickOf } from "./unsubscribe";

/**
 * When a message offers a one-click unsubscribe Brood may use (#595, RFC 8058
 * §4). Shaped on a real mailing's headers, read in Tim's own mailbox on
 * 2026-10-10, with every value invented: Gmail's `Authentication-Results`
 * first, the sender's and the sending service's signatures, both covering
 * the unsubscribe headers.
 */

const URL = "https://unsubscribe.mail.test/u?t=opaque-token";
const SENDER_B = "AAAAsender0123456789";
const SERVICE_B = "BBBBservice012345678";

const signature = (
  d: string,
  b: string,
  h = "from:to:subject:list-unsubscribe:list-unsubscribe-post",
) =>
  `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${d}; h=${h}; s=s1; t=1791387992; bh=x=; b=${b.slice(0, 10)} ${b.slice(10)}`;

const results = (...dkim: string[]) =>
  ["mx.google.com", ...dkim, "spf=pass smtp.mailfrom=news.sender.test"].join(
    ";\n       ",
  );

const headers = (
  over: Partial<Record<string, string | string[] | null>> = {},
): RawHeader[] => {
  const base: Record<string, string | string[] | null> = {
    "Authentication-Results": results(
      `dkim=pass header.i=@news.sender.test header.s=s1 header.b=${SENDER_B.slice(0, 8)}`,
      `dkim=pass header.i=@mailer.test header.s=api header.b=${SERVICE_B.slice(0, 8)}`,
    ),
    "DKIM-Signature": [
      signature("news.sender.test", SENDER_B),
      signature("mailer.test", SERVICE_B),
    ],
    From: "Sender <hello@news.sender.test>",
    "List-Unsubscribe": `<${URL}>, <mailto:unsub@sender.test?subject=x>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    ...over,
  };
  return Object.entries(base).flatMap(([name, value]) =>
    value === null
      ? []
      : (Array.isArray(value) ? value : [value]).map((v) => ({
          name,
          value: v,
        })),
  );
};

describe("a one-click unsubscribe Brood may use (#595)", () => {
  it("is offered when Gmail passed the sender's own signature over both headers", () => {
    const got = oneClickOf(headers());
    expect(got.offered).toBe(true);
    if (got.offered) expect(got.url.href()).toBe(URL);
  });

  it("never prints the address, which carries the person's token", () => {
    const got = oneClickOf(headers());
    if (!got.offered) throw new Error("not offered");
    expect(`${got.url}`).toBe("[redacted]");
    expect(JSON.stringify(got)).not.toContain("opaque-token");
    expect(inspect(got)).not.toContain("opaque-token");
  });

  it("reads header.d as well as header.i, with no header.b", () => {
    const got = oneClickOf(
      headers({
        "Authentication-Results": results(
          "dkim=pass header.d=news.sender.test",
        ),
      }),
    );
    expect(got.offered).toBe(true);
  });

  it("aligns a sender under the signing domain", () => {
    const got = oneClickOf(headers({ From: "<hello@mail.news.sender.test>" }));
    expect(got.offered).toBe(true);
  });
});

describe("not offered (#595)", () => {
  it("without List-Unsubscribe-Post: List-Unsubscribe=One-Click", () => {
    expect(oneClickOf(headers({ "List-Unsubscribe-Post": null }))).toEqual({
      offered: false,
      reason: "not_one_click",
    });
  });

  it("with only a mailto address, or one over plain http", () => {
    for (const value of [
      "<mailto:unsub@sender.test>",
      "<http://unsubscribe.mail.test/u>",
    ])
      expect(oneClickOf(headers({ "List-Unsubscribe": value }))).toEqual({
        offered: false,
        reason: "no_https",
      });
  });

  it("when Gmail's result is not a pass, even beside a forged pass further down", () => {
    // A sender can carry an Authentication-Results of its own, naming
    // mx.google.com; only the first, which Gmail prepends, is read.
    const got = oneClickOf(
      headers({
        "Authentication-Results": [
          results(
            `dkim=fail header.i=@news.sender.test header.b=${SENDER_B.slice(0, 8)}`,
          ),
          results(
            `dkim=pass header.i=@news.sender.test header.b=${SENDER_B.slice(0, 8)}`,
          ),
        ],
      }),
    );
    expect(got).toEqual({ offered: false, reason: "not_signed" });
  });

  it("when the first result is not Gmail's", () => {
    const got = oneClickOf(
      headers({
        "Authentication-Results": `mx.sender.test; dkim=pass header.i=@news.sender.test header.b=${SENDER_B.slice(0, 8)}`,
      }),
    );
    expect(got).toEqual({ offered: false, reason: "not_signed" });
  });

  it("when no passing signature covers List-Unsubscribe-Post", () => {
    const got = oneClickOf(
      headers({
        "DKIM-Signature": [
          signature("news.sender.test", SENDER_B, "from:to:list-unsubscribe"),
          signature("mailer.test", SERVICE_B, "from:to:list-unsubscribe"),
        ],
      }),
    );
    expect(got).toEqual({ offered: false, reason: "not_signed" });
  });

  it("when Gmail's pass names another signature than the one covering the headers", () => {
    const got = oneClickOf(
      headers({
        "Authentication-Results": results(
          "dkim=pass header.i=@news.sender.test header.b=ZZZZZZZZ",
        ),
      }),
    );
    expect(got).toEqual({ offered: false, reason: "not_signed" });
  });

  it("when a forged signature for the sender copies the start of the service's passing one (review of #1020)", () => {
    // Gmail verified only the service's signature. The forged one claims the
    // sender's domain and borrows the service's b= prefix, which the sender
    // can read off its own mail; a pass names a signature by domain and b=.
    const got = oneClickOf(
      headers({
        "Authentication-Results": results(
          `dkim=pass header.d=mailer.test header.b=${SERVICE_B.slice(0, 8)}`,
        ),
        "DKIM-Signature": [
          signature("mailer.test", SERVICE_B, "from:to"),
          signature("news.sender.test", SERVICE_B),
        ],
      }),
    );
    expect(got.offered).toBe(false);
  });

  it("when only the sending service's signature passes, not the sender's", () => {
    const got = oneClickOf(
      headers({
        "Authentication-Results": results(
          `dkim=fail header.i=@news.sender.test header.b=${SENDER_B.slice(0, 8)}`,
          `dkim=pass header.i=@mailer.test header.b=${SERVICE_B.slice(0, 8)}`,
        ),
      }),
    );
    expect(got).toEqual({ offered: false, reason: "not_aligned" });
  });

  it("when the signing domain is a single label, which would align with everything under it", () => {
    const got = oneClickOf(
      headers({
        "Authentication-Results": results("dkim=pass header.d=test"),
        "DKIM-Signature": signature("test", SENDER_B),
      }),
    );
    expect(got).toEqual({ offered: false, reason: "not_aligned" });
  });

  it("when there is no From address to align with", () => {
    expect(oneClickOf(headers({ From: null }))).toEqual({
      offered: false,
      reason: "not_aligned",
    });
  });
});
