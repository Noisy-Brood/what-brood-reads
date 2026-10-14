import { describe, expect, it } from "vitest";
import { deriveEvent, MissingProviderEventIdError } from "./derive";
import { METADATA_HEADERS } from "./headers";
import type { ProviderMessage } from "./types";
import { DraftNotAnEventError, MissingArrivalTimeError } from "../channel";

/**
 * `conventions/testing.md`: test the logic that fails silently.
 *
 * Nothing here needs a mailbox. The derivation is a pure function precisely so
 * that the part with product consequences — a `recipientCount` that moves a
 * threshold, the recipients an outbound message points at, which decide whose
 * mail is left alone — can be exercised without one.
 */

const ME = ["tim@example.test"];

/** A message as the provider returns it under `format=metadata`. */
const message = (
  headers: Record<string, string>,
  overrides: Partial<ProviderMessage> = {},
): ProviderMessage => ({
  id: "prov-1",
  threadId: "conv-1",
  internalDate: "1789776000000",
  payload: {
    headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
  },
  ...overrides,
});

describe("the header allowlist", () => {
  it("does not include Subject", () => {
    // DD11 §6 declined to store subjects; DD1 §2.2 keeps the header out of the
    // request so it cannot be stored, logged or land in a stack trace. Reversing
    // this means changing both documents first.
    expect(METADATA_HEADERS).not.toContain("Subject");
  });

  it("is frozen, so it cannot be widened at runtime", () => {
    // The definition is what `verify_gmail_reads.mjs` checks, so a push would
    // have changed what every read asks for while the gate still reported the
    // allowlist intact.
    expect(Object.isFrozen(METADATA_HEADERS)).toBe(true);
    expect(() => METADATA_HEADERS.push("Subject")).toThrow(TypeError);
    expect(METADATA_HEADERS).not.toContain("Subject");
  });

  it("does not include Date", () => {
    // `occurredAt` comes from `internalDate`. A header we never ask for is one
    // nobody can accidentally prefer.
    expect(METADATA_HEADERS).not.toContain("Date");
  });
});

describe("the provider id", () => {
  it("is refused when absent rather than substituted with an empty one", () => {
    // `providerEventId` is the handle every later call passes back to the
    // provider, and two empty strings deduplicate against each other.
    expect(() =>
      deriveEvent(message({ From: "a@x.com" }, { id: null }), ME),
    ).toThrow(MissingProviderEventIdError);
  });
});

describe("occurredAt", () => {
  it("comes from internalDate, not the Date header", () => {
    // A sender controls `Date` and can backdate a message. That would file the
    // event in the wrong monthly partition, outside the window a threshold query
    // reads. DD11 §1 defines an event as a fact about arrival.
    const event = deriveEvent(
      message({ From: "a@x.com", Date: "Tue, 1 Jan 2019 00:00:00 +0000" }),
      ME,
    );
    expect(event.occurredAt.toISOString()).toBe("2026-09-19T00:00:00.000Z");
  });

  it("refuses a message with no internalDate rather than defaulting to now", () => {
    // Substituting the current time would look like success and quietly put the
    // event in a partition it does not belong to.
    expect(() =>
      deriveEvent(message({ From: "a@x.com" }, { internalDate: null }), ME),
    ).toThrow(MissingArrivalTimeError);
  });
});

describe("recipientCount", () => {
  it("does not split a quoted display name containing a comma", () => {
    // The bug a naive `split(",")` has: one address read as two, inflating the
    // count the personal-correspondence predicate tests.
    const event = deriveEvent(
      message({
        From: "a@x.com",
        To: '"Doe, Jane" <jane@example.com>, bob@example.com',
      }),
      ME,
    );
    expect(event.recipientCount).toBe(2);
  });

  it("does not split inside a parenthesised comment", () => {
    const event = deriveEvent(
      message({ From: "a@x.com", To: "jane@example.com (Jane, of Sales)" }),
      ME,
    );
    expect(event.recipientCount).toBe(1);
  });

  it("counts one person in both To and Cc once", () => {
    const event = deriveEvent(
      message({
        From: "a@x.com",
        To: "jane@example.com",
        Cc: "Jane <JANE@example.com>",
      }),
      ME,
    );
    expect(event.recipientCount).toBe(1);
  });

  it("counts nobody when the recipients are hidden", () => {
    // `undisclosed-recipients:;` is a group with no members. Counting the label
    // as an address would make a blind-copied message look addressed.
    const event = deriveEvent(
      message({ From: "a@x.com", To: "undisclosed-recipients:;" }),
      ME,
    );
    expect(event.recipientCount).toBe(0);
  });

  it("counts the members of a named group", () => {
    const event = deriveEvent(
      message({
        From: "a@x.com",
        To: "Managers: a@example.com, b@example.com;",
      }),
      ME,
    );
    expect(event.recipientCount).toBe(2);
  });
});

describe("the account's own addresses, left out of whom it wrote to", () => {
  const sent = { labelIds: ["SENT"] };
  const wroteTo = (to: string, own: readonly string[] = ME) =>
    deriveEvent(message({ From: ME[0]!, To: to }, sent), own)
      .recipientAddresses;

  it("leaves out the account's own address, whatever its case", () => {
    expect(wroteTo("Tim <TIM@example.test>, jane@example.com")).toEqual([
      "jane@example.com",
    ]);
  });

  it("leaves out a plus-tagged form of it", () => {
    // Deliberately the opposite of what §6.1 does for senders: the provider
    // delivers `me+tag@` to the same mailbox.
    expect(wroteTo("tim+receipts@example.test, jane@example.com")).toEqual([
      "jane@example.com",
    ]);
  });

  it("leaves out a configured alias", () => {
    expect(
      wroteTo("tim@example.net, jane@example.com", [...ME, "tim@example.net"]),
    ).toEqual(["jane@example.com"]);
  });
});

describe("where the person was on it (#654)", () => {
  const placed = (
    headers: Record<string, string>,
    own: readonly string[] = ME,
    over: Partial<ProviderMessage> = {},
  ) =>
    deriveEvent(message({ From: "a@example.com", ...headers }, over), own)
      .addressed;

  it("is to when the account is in To", () => {
    expect(placed({ To: "Tim <TIM@example.test>" })).toBe("to");
  });

  it("is cc when the account is only in Cc", () => {
    expect(placed({ To: "jane@example.com", Cc: "tim@example.test" })).toBe(
      "cc",
    );
  });

  it("is to when the account is in both", () => {
    expect(placed({ To: "tim@example.test", Cc: "tim@example.test" })).toBe(
      "to",
    );
  });

  it("is neither when the account is in neither line, as a Bcc arrives", () => {
    // Bcc is never delivered as a header: mail the person was Bcc'd on, or
    // that reached them through a group, has them in neither line.
    expect(placed({ To: "everyone@example.com", Cc: "jane@example.com" })).toBe(
      "neither",
    );
  });

  it("is neither when there is no To or Cc at all", () => {
    expect(placed({})).toBe("neither");
  });

  it("reads a plus-tagged form and a configured alias as the account", () => {
    expect(placed({ To: "tim+lists@example.test" })).toBe("to");
    expect(placed({ Cc: "tim@example.net" }, [...ME, "tim@example.net"])).toBe(
      "cc",
    );
  });

  it("reads a dotted form of a gmail.com address as the account (review of #660)", () => {
    // Google: dots do not matter in a gmail.com address, and do at work or
    // school, so a dot-variant there is somebody else.
    expect(
      placed({ To: "flastname@gmail.com" }, ["f.lastname@gmail.com"]),
    ).toBe("to");
    expect(
      placed({ To: "f.last.name@gmail.com" }, ["flastname@gmail.com"]),
    ).toBe("to");
    expect(
      placed({ To: "f.lastname@example.test" }, ["flastname@example.test"]),
    ).toBe("neither");
  });

  it("is null for mail the person sent", () => {
    expect(
      placed({ To: "tim@example.test" }, ME, { labelIds: ["SENT"] }),
    ).toBeNull();
  });
});

describe("the sender", () => {
  it("lowercases the address and keeps the plus tag", () => {
    // §6.1: `billing+eu@` and `billing+us@` may be two mailboxes run by two
    // teams, and a wrong merge is worse than no merge.
    const event = deriveEvent(
      message({ From: "Billing <Billing+EU@Vendor.com>" }),
      ME,
    );
    expect(event.senderAddress).toBe("billing+eu@vendor.com");
    expect(event.senderDisplayName).toBe("Billing");
  });

  it("reads a bare address with no display name", () => {
    const event = deriveEvent(message({ From: "alerts@vendor.com" }), ME);
    expect(event.senderAddress).toBe("alerts@vendor.com");
    expect(event.senderDisplayName).toBeNull();
  });

  it("keeps a quoted display name containing a comma intact", () => {
    const event = deriveEvent(
      message({ From: '"Vendor, Inc." <billing@vendor.com>' }),
      ME,
    );
    expect(event.senderAddress).toBe("billing@vendor.com");
    expect(event.senderDisplayName).toBe("Vendor, Inc.");
  });
});

describe("messageId", () => {
  it("strips the angle brackets so two spellings deduplicate", () => {
    const event = deriveEvent(
      message({ From: "a@x.com", "Message-ID": "<abc123@mail.vendor.com>" }),
      ME,
    );
    expect(event.messageId).toBe("abc123@mail.vendor.com");
  });

  it("finds the header whatever case the sender used", () => {
    // `Message-Id` is at least as common in the wild as the RFC's casing, and
    // missing it drops the only identity that correlates across providers.
    const event = deriveEvent(
      message({ From: "a@x.com", "Message-Id": "<abc123@mail.vendor.com>" }),
      ME,
    );
    expect(event.messageId).toBe("abc123@mail.vendor.com");
  });

  it("is null when the sender omitted it", () => {
    // DD16 §3: conventionally universal, not actually guaranteed. Absence falls
    // back to the provider id rather than being an error.
    const event = deriveEvent(message({ From: "a@x.com" }), ME);
    expect(event.messageId).toBeNull();
    expect(event.providerEventId).toBe("prov-1");
  });
});

describe("the flags", () => {
  it("reads a reply from References alone", () => {
    const event = deriveEvent(
      message({ From: "a@x.com", References: "<root@x.com>" }),
      ME,
    );
    expect(event.isReply).toBe(true);
  });

  it("reads bulk mail from List-Id alone", () => {
    const event = deriveEvent(
      message({ From: "a@x.com", "List-Id": "<eng.lists.example.com>" }),
      ME,
    );
    expect(event.hasListUnsubscribe).toBe(true);
  });

  it("leaves both false for ordinary mail", () => {
    const event = deriveEvent(
      message({ From: "a@x.com", To: "tim@example.test" }),
      ME,
    );
    expect(event.isReply).toBe(false);
    expect(event.hasListUnsubscribe).toBe(false);
  });
});

describe("whether it offers a one-click unsubscribe (#595)", () => {
  // The decision itself is `oneClickOf`'s, tested in unsubscribe.test.ts; here,
  // that ingest makes it from the headers the read now asks for, and keeps a
  // boolean and nothing else of them.
  const signed = {
    From: "Sender <hello@news.sender.test>",
    "List-Unsubscribe": "<https://unsubscribe.mail.test/u?t=opaque-token>",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    "DKIM-Signature":
      "v=1; d=news.sender.test; h=from:list-unsubscribe:list-unsubscribe-post; b=AAAAsender0123",
    "Authentication-Results":
      "mx.google.com; dkim=pass header.i=@news.sender.test header.b=AAAAsend",
  };

  it("is true for a mailing whose unsubscribe headers Gmail verified as the sender's", () => {
    const event = deriveEvent(message(signed), ME);
    expect(event.offersOneClick).toBe(true);
    expect(JSON.stringify(event)).not.toContain("opaque-token");
  });

  it("is false without the signature, and for ordinary mail", () => {
    const { "DKIM-Signature": _, ...unsigned } = signed;
    expect(deriveEvent(message(unsigned), ME).offersOneClick).toBe(false);
    expect(
      deriveEvent(message({ From: "a@x.com", To: "tim@example.test" }), ME)
        .offersOneClick,
    ).toBe(false);
  });

  it("asks for the headers the decision needs", () => {
    for (const h of [
      "List-Unsubscribe-Post",
      "DKIM-Signature",
      "Authentication-Results",
    ])
      expect(METADATA_HEADERS).toContain(h);
  });
});

describe("parenthesised comments", () => {
  it("does not leave the closing paren on the address", () => {
    // The stripper removed the comment's contents and then appended its closing
    // paren, so the address resolved to something nobody could write to.
    const event = deriveEvent(
      message({ From: "alerts@vendor.com (Automated Alerts)" }),
      ME,
    );
    expect(event.senderAddress).toBe("alerts@vendor.com");
  });

  it("ignores a comment beside an angle-bracketed address", () => {
    const event = deriveEvent(
      message({ From: "Alerts (do not reply) <alerts@vendor.com>" }),
      ME,
    );
    expect(event.senderAddress).toBe("alerts@vendor.com");
  });

  it("drops a comment that escapes its own parentheses", () => {
    // The escape branch appended unconditionally, so `\\(` inside a comment put
    // both characters into the token the comment was supposed to be absent
    // from: this address parsed as `jane@example.com \\(\\)`.
    const event = deriveEvent(
      message({ From: "jane@example.com (Jane \\(J\\) Doe)" }),
      ME,
    );
    expect(event.senderAddress).toBe("jane@example.com");
  });

  it("drops a comment containing a backslash", () => {
    const event = deriveEvent(
      message({ From: "alerts@vendor.com (note \\\\ here)" }),
      ME,
    );
    expect(event.senderAddress).toBe("alerts@vendor.com");
  });

  it("keeps an escaped character inside a quoted display name", () => {
    // The fix must not over-correct: a quoted string is not a comment, and its
    // escapes are part of the name.
    const event = deriveEvent(
      message({ From: '"Doe\\, Jane" <jane@example.com>' }),
      ME,
    );
    expect(event.senderAddress).toBe("jane@example.com");
  });

  it("still recognises the account behind a comment", () => {
    const event = deriveEvent(
      message(
        { From: "tim@example.test", To: "tim@example.test (Tim), a@x.com" },
        { labelIds: ["SENT"] },
      ),
      ME,
    );
    expect(event.recipientAddresses).toEqual(["a@x.com"]);
  });
});

describe("direction (DD1 §6.4)", () => {
  const sent = { labelIds: ["SENT"] };

  it("is outbound when the provider marked the message sent", () => {
    const event = deriveEvent(
      message({ From: "tim@example.test", To: "ada@vendor.com" }, sent),
      ME,
    );
    expect(event.direction).toBe("outbound");
  });

  it("is inbound when From is the account's own address but the provider did not mark it sent", () => {
    // A stranger can write the account's address in From. Read as outbound, it
    // would record the user writing to whoever the forger chose.
    const event = deriveEvent(
      message(
        { From: "Tim <tim@example.test>", To: "tim@example.test" },
        { labelIds: ["INBOX"] },
      ),
      ME,
    );
    expect(event.direction).toBe("inbound");
    expect(event.recipientAddresses).toEqual([]);
  });

  it("is inbound when the provider sent no labels at all", () => {
    const event = deriveEvent(message({ From: "ada@vendor.com" }), ME);
    expect(event.direction).toBe("inbound");
  });
});

describe("recipientAddresses", () => {
  const sent = { labelIds: ["SENT"] };

  it("lists every distinct To and Cc address of an outbound message, normalised", () => {
    const event = deriveEvent(
      message(
        {
          From: "tim@example.test",
          To: "Ada <Ada+Billing@Vendor.com>, bo@client.io",
          Cc: "bo@client.io",
        },
        sent,
      ),
      ME,
    );
    // Lowercased with the +tag intact, as a sender is (DD1 §6.1).
    expect(event.recipientAddresses).toEqual([
      "ada+billing@vendor.com",
      "bo@client.io",
    ]);
  });

  it("leaves out the account's own addresses, tagged or not", () => {
    const event = deriveEvent(
      message(
        {
          From: "tim@example.test",
          To: "ada@vendor.com",
          Cc: "tim+sent@example.test, tim@example.test",
        },
        sent,
      ),
      ME,
    );
    expect(event.recipientAddresses).toEqual(["ada@vendor.com"]);
  });

  it("is empty for a message sent only to the account itself", () => {
    const event = deriveEvent(
      message({ From: "tim@example.test", To: "tim@example.test" }, sent),
      ME,
    );
    expect(event.direction).toBe("outbound");
    expect(event.recipientAddresses).toEqual([]);
  });

  it("is empty for an inbound message, however many it was addressed to", () => {
    const event = deriveEvent(
      message({
        From: "ada@vendor.com",
        To: "tim@example.test, bo@client.io",
      }),
      ME,
    );
    expect(event.recipientCount).toBe(2);
    expect(event.recipientAddresses).toEqual([]);
  });
});

describe("a draft (#242)", () => {
  it("is refused before anything is derived: it reached nobody", () => {
    expect(() =>
      deriveEvent(
        message(
          { From: "tim@example.test", To: "ada@vendor.com" },
          { labelIds: ["DRAFT"] },
        ),
        ME,
      ),
    ).toThrow(DraftNotAnEventError);
  });

  it("is refused even alongside other labels", () => {
    expect(() =>
      deriveEvent(
        message({ From: "tim@example.test" }, { labelIds: ["INBOX", "DRAFT"] }),
        ME,
      ),
    ).toThrow(DraftNotAnEventError);
  });

  it("says which message, and nothing from its headers", () => {
    const error = (() => {
      try {
        deriveEvent(
          message(
            { From: "Secret Sender <s@x.com>", To: "ada@vendor.com" },
            { labelIds: ["DRAFT"] },
          ),
          ME,
        );
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toBe("message prov-1 is a draft");
  });

  it("leaves a sent message alone", () => {
    expect(
      deriveEvent(
        message(
          { From: "tim@example.test", To: "ada@vendor.com" },
          { labelIds: ["SENT"] },
        ),
        ME,
      ).direction,
    ).toBe("outbound");
  });
});

describe("where the message sits, which rescue decides by (#442)", () => {
  const placed = (labelIds: string[] | null) =>
    deriveEvent(message({ From: "a@x.com" }, { labelIds }), ME).placement;

  it("reads the inbox", () => {
    expect(placed(["INBOX", "UNREAD"])).toMatchObject({
      inView: true,
      setAside: false,
    });
  });

  it.each(["SPAM", "TRASH"])(
    "reads %s as set aside, which rescue never takes mail out of",
    (label) => {
      expect(placed([label, "Label_brood"])).toMatchObject({
        inView: false,
        setAside: true,
      });
    },
  );

  it("keeps every handle it is filed under, the person's and Brood's", () => {
    expect(placed(["Label_brood", "Label_theirs"])).toEqual({
      inView: false,
      setAside: false,
      filedUnder: ["Label_brood", "Label_theirs"],
    });
  });

  it("reads no labels as out of view and filed under nothing", () => {
    expect(placed(null)).toEqual({
      inView: false,
      setAside: false,
      filedUnder: [],
    });
  });
});

describe("what an inbound message copied (#663)", () => {
  it("carries the Cc's addresses, lowercased, for rescue", () => {
    const event = deriveEvent(
      message({
        From: "GitHub <notifications@github.com>",
        To: "tim@example.test",
        Cc: "Security alert <Security_Alert@noreply.github.com>, tim@example.test",
      }),
      ME,
    );
    expect(event.copied).toEqual([
      "security_alert@noreply.github.com",
      "tim@example.test",
    ]);
  });

  it("carries nothing for mail the person sent", () => {
    const event = deriveEvent(
      message(
        { From: "tim@example.test", To: "a@x.com", Cc: "b@x.com" },
        { labelIds: ["SENT"] },
      ),
      ME,
    );
    expect(event.copied).toEqual([]);
  });
});
