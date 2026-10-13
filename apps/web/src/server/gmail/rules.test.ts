import { describe, expect, it, vi } from "vitest";
import type { ProviderClient } from "./client";
import {
  FILE_BATCH,
  mailboxOver,
  ProviderRequestError,
  RuleNotFoundError,
} from "./mailbox";
import {
  adoptableOf,
  broodRuleOf,
  describeOwnRules,
  ownRuleOf,
  homeAtProvider,
  quietedHomeAtProvider,
  heldAsSent,
  renderRule,
  ruleTag,
  searchFor,
  UnrenderableRuleError,
} from "./rules";
import { stubProviderClient } from "./stub-client.test-support";

/**
 * A rule's scope in Gmail's syntax, and the writes that install and file by it.
 *
 * How Gmail reads the syntax was established on the dev mailbox, read-only, by
 * `messages.list` through this module (#194): `from:google.com` matches mail from
 * `accounts.google.com`, so a domain includes its subdomains; `from:gle.com` and
 * `from:oogle.com` match nothing from `google.com`, so a domain is not a
 * substring; `reply@accounts.google.com` does not match `no-reply@…`, so an
 * address is exact; and `-{a b}` excludes both. It also showed `from:` matching a
 * word of the sender's display name, which no rendering here can prevent, and
 * which DD1 §7.5 takes up.
 */

const domain = (value: string, exclude: string[] = []) => ({
  from: { kind: "domain" as const, value },
  exclude,
});
/** An installation and rule id, and the tag they make. */
const ME = {
  installation: "a1b2c3d4e5f6",
  ruleId: "3f9c2a7b-1d4e-4c8a-9b0f-1e2d3c4b5a69",
};
const TAG = "nb-a1b2c3d4e5f63f9c2a7b1d4e4c8a9b0f1e2d3c4b5a69.invalid";

const address = (value: string) => ({
  from: { kind: "address" as const, value },
  exclude: [],
});

describe("rendering a scope", () => {
  it("renders a domain, with no carve-out", () => {
    expect(renderRule(domain("vendor.com"))).toEqual({
      query: "from:vendor.com",
      negatedQuery: null,
    });
  });

  it("carves out each exclusion, sorted and once", () => {
    expect(
      renderRule(
        domain("vendor.com", [
          "security@vendor.com",
          "alerts@vendor.com",
          "alerts@vendor.com",
        ]),
      ),
    ).toEqual({
      query: "from:vendor.com",
      negatedQuery: "from:alerts@vendor.com OR from:security@vendor.com",
    });
  });

  it("carves out a domain, and everything under it, as a domain (#288)", () => {
    expect(
      renderRule(domain("vendor.com", ["bank.com", "alerts@other.com"])),
    ).toEqual({
      query: "from:vendor.com",
      negatedQuery: "from:alerts@other.com OR from:bank.com",
    });
  });

  it("renders an address exactly", () => {
    expect(renderRule(address("receipts+eu@vendor.co.uk")).query).toBe(
      "from:receipts+eu@vendor.co.uk",
    );
  });

  it("searches for the same set, less its carve-outs and drafts", () => {
    expect(
      searchFor(domain("vendor.com", ["a@vendor.com", "b@vendor.com"])),
    ).toBe("from:vendor.com -{from:a@vendor.com from:b@vendor.com} -in:drafts");
    expect(searchFor(domain("vendor.com"))).toBe("from:vendor.com -in:drafts");
  });

  it("carves out a copied address as a cc: term, after the sender terms (#663)", () => {
    const scope = {
      ...domain("github.com", ["alerts@bank.com"]),
      excludeCc: ["security_alert@noreply.github.com"],
    };
    expect(renderRule(scope)).toEqual({
      query: "from:github.com",
      negatedQuery:
        "from:alerts@bank.com OR cc:security_alert@noreply.github.com",
    });
    expect(searchFor(scope)).toBe(
      "from:github.com -{from:alerts@bank.com cc:security_alert@noreply.github.com} -in:drafts",
    );
    // A rule Brood wrote is read back as it was written.
    expect(
      broodRuleOf({
        criteria: renderRule(scope, ME),
        action: { addLabelIds: ["L1"], removeLabelIds: ["INBOX"] },
      }),
    ).toMatchObject({
      exclude: ["alerts@bank.com"],
      excludeCc: ["security_alert@noreply.github.com"],
    });
  });

  it("refuses a copied carve-out that is not an exact address (#663)", () => {
    expect(() =>
      renderRule({ ...domain("github.com"), excludeCc: ["github.com"] }),
    ).toThrow(UnrenderableRuleError);
  });

  // Each of these would be syntax, not a value: a carve-out that excludes nothing,
  // or a rule that files more than it says.
  it.each([
    ["a space", domain("vendor.com OR bank.com")],
    ["a brace", domain("vendor.com}")],
    ["a quote", address('"a"@vendor.com')],
    ["no dot", domain("vendor")],
    ["upper case, which the index never holds", domain("Vendor.com")],
    [
      "an exclusion with syntax in it",
      domain("vendor.com", ["a@vendor.com -in:spam"]),
    ],
    ["an address with no local part", address("@vendor.com")],
  ])("refuses a value with %s", (_, scope) => {
    expect(() => renderRule(scope)).toThrow(UnrenderableRuleError);
  });
});

/** A provider that answers the rule side, recording what it was asked. */
const provider = (over: {
  labels?: Array<{ id: string; name: string; type?: string }>;
  created?: string[];
  patched?: Array<{ id: string; name: string }>;
  filterGet?: Filters["get"];
  filterCreate?: Filters["create"];
  filterDelete?: Filters["delete"];
  filterList?: Filters["list"];
  batchModify?: Users["messages"]["batchModify"];
  list?: Users["messages"]["list"];
}) => {
  let n = 0;
  return stubProviderClient({
    labels: {
      list: async () => ({
        data: {
          labels: (over.labels ?? []).map((l) => ({ type: "user", ...l })),
        },
      }),
      create: vi.fn<Users["labels"]["create"]>(async (p) => {
        over.created?.push(p.requestBody?.name ?? "");
        return { data: { id: `L${++n}` } };
      }),
      patch: vi.fn<Users["labels"]["patch"]>(async (p) => {
        over.patched?.push({ id: p.id ?? "", name: p.requestBody?.name ?? "" });
        return { data: {} };
      }),
    },
    filters: {
      get: over.filterGet ?? (async () => ({ data: {} })),
      create: over.filterCreate ?? (async (p) => made(`F${++n}`)(p)),
      delete: over.filterDelete ?? (async () => ({ data: undefined })),
      list: over.filterList ?? (async () => ({ data: {} })),
    },
    messages: {
      list: over.list ?? (async () => ({ data: {} })),
      batchModify: over.batchModify ?? (async () => ({ data: undefined })),
    },
  });
};

type Users = ProviderClient["users"];
type Filters = Users["settings"]["filters"];

/**
 * Gmail's answer to filters.create: the filter it made, its criteria with it,
 * as the reference says. `heldAsSent` reads them back (#659).
 */
const made =
  (id: string): Filters["create"] =>
  async (p) => ({ data: { id, criteria: p?.requestBody?.criteria } });

describe("a rule's tag (#291)", () => {
  it("names the installation and the rule, under .invalid", () => {
    expect(ruleTag(ME)).toBe(TAG);
  });

  // A rule exactly as Brood writes it: what the sweep may call its own.
  const brood = {
    criteria: {
      query: "from:vendor.com",
      negatedQuery: `from:alerts@bank.com OR from:${TAG} OR from:x.com`,
    },
    action: { addLabelIds: ["L1"], removeLabelIds: ["INBOX"] },
  };

  it("is read back from a rule of exactly Brood's shape, among other carve-outs", () => {
    expect(broodRuleOf(brood)).toEqual({
      identity: ME,
      from: { kind: "domain", value: "vendor.com" },
      home: "L1",
      exclude: ["alerts@bank.com", "x.com"],
      excludeCc: [],
    });
  });

  it("reads copied carve-outs after the sender terms, and none before them (#663)", () => {
    const withCc = (negatedQuery: string) =>
      broodRuleOf({
        ...brood,
        criteria: { query: "from:vendor.com", negatedQuery },
      });
    expect(
      withCc(`from:${TAG} OR cc:security_alert@noreply.github.com`)?.excludeCc,
    ).toEqual(["security_alert@noreply.github.com"]);
    // Not the order Brood writes, so not Brood's.
    expect(
      withCc(`cc:security_alert@noreply.github.com OR from:${TAG}`),
    ).toBeNull();
    expect(withCc(`from:${TAG} OR to:someone@example.com`)).toBeNull();
  });

  it("reads each carve-out once, however often the filter repeats it (review of #476)", () => {
    expect(
      broodRuleOf({
        ...brood,
        criteria: {
          query: "from:vendor.com",
          negatedQuery: `from:x.com OR from:x.com OR from:${TAG}`,
        },
      })?.exclude,
    ).toEqual(["x.com"]);
  });

  it("reads back what it carves out, the tag aside, so a sweep can compare it with the record (#441)", () => {
    expect(
      broodRuleOf({
        ...brood,
        criteria: { query: "from:vendor.com", negatedQuery: `from:${TAG}` },
      })?.exclude,
    ).toEqual([]);
  });

  it("is absent from a rule with no tag", () => {
    expect(
      broodRuleOf({
        ...brood,
        criteria: {
          query: "from:vendor.com",
          negatedQuery: "from:alerts@bank.com",
        },
      }),
    ).toBeNull();
    expect(broodRuleOf({})).toBeNull();
  });

  // Each of these carries the tag and is not plainly Brood's: a user copied one
  // of its rules and changed it, or pasted the tag into their own. A sweep that
  // removed any of them would remove a rule the user wrote (review of #296).
  it.each([
    [
      "a tag inside a larger term",
      {
        criteria: { ...brood.criteria, negatedQuery: `from:(${TAG} bank.com)` },
      },
    ],
    [
      "the tag twice",
      {
        criteria: {
          ...brood.criteria,
          negatedQuery: `from:${TAG} OR from:${TAG}`,
        },
      },
    ],
    [
      "a carve-out that is not a from: term",
      {
        criteria: {
          ...brood.criteria,
          negatedQuery: `from:${TAG} OR subject:invoice`,
        },
      },
    ],
    [
      "a query of more than one term",
      {
        criteria: {
          ...brood.criteria,
          query: "from:vendor.com has:attachment",
        },
      },
    ],
    [
      "a subject criterion",
      { criteria: { ...brood.criteria, subject: "invoice" } },
    ],
    [
      "a from criterion beside the query",
      { criteria: { ...brood.criteria, from: "x@y.com" } },
    ],
    [
      "attachments only",
      { criteria: { ...brood.criteria, hasAttachment: true } },
    ],
    ["a forward", { action: { ...brood.action, forward: "me@elsewhere.com" } }],
    ["two homes", { action: { ...brood.action, addLabelIds: ["L1", "L2"] } }],
    ["the inbox kept", { action: { addLabelIds: ["L1"], removeLabelIds: [] } }],
    [
      "something else removed",
      { action: { addLabelIds: ["L1"], removeLabelIds: ["UNREAD"] } },
    ],
    // A field Brood never writes is not Brood's, even set false or zero, and
    // nor is one the library does not model (Copilot on #296).
    [
      "hasAttachment set false",
      { criteria: { ...brood.criteria, hasAttachment: false } },
    ],
    [
      "excludeChats set false",
      { criteria: { ...brood.criteria, excludeChats: false } },
    ],
    ["a size of zero", { criteria: { ...brood.criteria, size: 0 } }],
    [
      "a key the library does not model",
      { criteria: { ...brood.criteria, sentAfter: "x" } },
    ],
    [
      "an action key the library does not model",
      { action: { ...brood.action, markImportant: true } },
    ],
  ])("is refused for a rule with %s", (_, over) => {
    expect(broodRuleOf({ ...brood, ...over })).toBeNull();
  });

  it("is absent for a malformed tag", () => {
    expect(
      broodRuleOf({
        ...brood,
        criteria: {
          query: "from:vendor.com",
          negatedQuery: "from:nb-short.invalid",
        },
      }),
    ).toBeNull();
  });

  it("refuses an installation or rule id that is not what it says", () => {
    expect(() => ruleTag({ ...ME, installation: "not-hex" })).toThrow(
      UnrenderableRuleError,
    );
    expect(() => ruleTag({ ...ME, ruleId: "x" })).toThrow(
      UnrenderableRuleError,
    );
  });
});

describe("listing rules", () => {
  /** A Brood filter of this installation, as `filters.get` answers it whole. */
  const brood = (home: string) => ({
    criteria: { query: "from:x.com", negatedQuery: `from:${TAG}` },
    action: { addLabelIds: [home], removeLabelIds: ["INBOX"] },
  });
  /** The person's own: a filter Brood never reads whole. */
  const theirs = {
    criteria: { from: "billing@shop.test", subject: "invoice overdue" },
    action: { addLabelIds: ["Lmine"], removeLabelIds: ["INBOX"] },
  };

  it("lists each filter's id, action and named sender, and nothing else it matches (D21 §2, #1106, #1107)", async () => {
    const asked: Parameters<Filters["list"]>[0][] = [];
    await mailboxOver(
      provider({
        filterList: async (p) => {
          asked.push(p);
          return { data: { filter: [] } };
        },
      }),
    ).listRules([]);
    expect(asked).toEqual([
      { userId: "me", fields: "filter(id,criteria/from,action)" },
    ]);
  });

  it("reads whole only a recorded filter and one filing into a Brood home, never the person's own (#1106)", async () => {
    const read: string[] = [];
    const whole: Record<string, object> = {
      F1: brood("Lr"),
      F2: theirs,
      F3: brood("Le"),
    };
    const rules = await mailboxOver(
      provider({
        labels: [
          { id: "Le", name: "brood/ext" },
          { id: "Lr", name: "Stripe, renamed" },
          { id: "Lmine", name: "Receipts" },
        ],
        filterList: async () => ({
          data: {
            filter: [
              {
                id: "F1",
                action: { addLabelIds: ["Lr"], removeLabelIds: ["INBOX"] },
              },
              {
                id: "F2",
                action: { addLabelIds: ["Lmine"], removeLabelIds: ["INBOX"] },
              },
              {
                id: "F3",
                action: { addLabelIds: ["Le"], removeLabelIds: ["INBOX"] },
              },
            ],
          },
        }),
        filterGet: async (p) => {
          read.push(p.id ?? "");
          return { data: whole[p.id ?? ""] ?? {} };
        },
      }),
    ).listRules([{ providerRuleId: "F1", homeId: null }]);
    expect(read.sort()).toEqual(["F1", "F3"]);
    expect(rules).toEqual([
      {
        providerRuleId: "F1",
        rule: {
          identity: ME,
          from: { kind: "domain", value: "x.com" },
          home: "Lr",
          exclude: [],
          excludeCc: [],
        },
      },
      {
        providerRuleId: "F3",
        rule: {
          identity: ME,
          from: { kind: "domain", value: "x.com" },
          home: "Le",
          exclude: [],
          excludeCc: [],
        },
      },
    ]);
  });

  it("finds a filter filing into a recorded home the person renamed (#1106)", async () => {
    const read: string[] = [];
    await mailboxOver(
      provider({
        labels: [{ id: "Lr", name: "Stripe, renamed" }],
        filterList: async () => ({
          data: {
            filter: [
              {
                id: "F9",
                action: { addLabelIds: ["Lr"], removeLabelIds: ["INBOX"] },
              },
            ],
          },
        }),
        filterGet: async (p) => {
          read.push(p.id ?? "");
          return { data: brood("Lr") };
        },
      }),
    ).listRules([{ providerRuleId: "F1", homeId: "Lr" }]);
    expect(read).toEqual(["F9"]);
  });

  it("leaves out a filter gone between the list and its read", async () => {
    const rules = await mailboxOver(
      provider({
        filterList: async () => ({
          data: { filter: [{ id: "F1", action: { addLabelIds: ["Lr"] } }] },
        }),
        filterGet: async () => {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        },
      }),
    ).listRules([{ providerRuleId: "F1", homeId: "Lr" }]);
    expect(rules).toEqual([]);
  });
});

describe("the person's own filters, as what they name (D21 §1, #1107)", () => {
  const files = { removeLabelIds: ["INBOX"] };

  it.each([
    ["billing@shop.test", { kind: "address", value: "billing@shop.test" }],
    ["  Billing@Shop.TEST ", { kind: "address", value: "billing@shop.test" }],
    ["shop.test", { kind: "domain", value: "shop.test" }],
    ["@mail.shop.test", { kind: "domain", value: "mail.shop.test" }],
  ])("reads %j as what it names", (from, named) => {
    expect(ownRuleOf({ criteria: { from }, action: files }, new Set())).toEqual(
      named,
    );
  });

  it.each([
    "Shop Billing",
    "billing@shop.test OR news@shop.test",
    "{billing@shop.test news@shop.test}",
    "billing",
    "-billing@shop.test",
    "*@shop.test",
    "",
  ])("reads %j as naming nothing certain", (from) => {
    expect(
      ownRuleOf({ criteria: { from }, action: files }, new Set()),
    ).toBeNull();
  });

  it("counts a filter that adds one of the person's labels, or sends to the trash", () => {
    const from = "billing@shop.test";
    expect(
      ownRuleOf(
        { criteria: { from }, action: { addLabelIds: ["Lmine"] } },
        new Set(["Lmine"]),
      ),
    ).not.toBeNull();
    expect(
      ownRuleOf(
        { criteria: { from }, action: { addLabelIds: ["TRASH"] } },
        new Set(),
      ),
    ).not.toBeNull();
  });

  it("does not count a filter that only stars, marks read or forwards", () => {
    const from = "billing@shop.test";
    for (const action of [
      { addLabelIds: ["STARRED"] },
      { removeLabelIds: ["UNREAD"] },
      { forward: "me@elsewhere.test" },
    ])
      expect(ownRuleOf({ criteria: { from }, action }, new Set())).toBeNull();
  });

  it("lists through the one mask, and returns only what each filter names", async () => {
    const asked: Parameters<Filters["list"]>[0][] = [];
    const own = await mailboxOver(
      provider({
        labels: [{ id: "Lmine", name: "Receipts" }],
        filterList: async (p) => {
          asked.push(p);
          return {
            data: {
              filter: [
                {
                  id: "F1",
                  criteria: { from: "billing@shop.test" },
                  action: { addLabelIds: ["Lmine"] },
                },
                {
                  id: "F2",
                  criteria: { from: "Shop Billing" },
                  action: { removeLabelIds: ["INBOX"] },
                },
                {
                  id: "F3",
                  action: { addLabelIds: ["Lb"], removeLabelIds: ["INBOX"] },
                },
              ],
            },
          };
        },
      }),
    ).ownRules();
    expect(asked).toEqual([
      { userId: "me", fields: "filter(id,criteria/from,action)" },
    ]);
    expect(own).toEqual([{ kind: "address", value: "billing@shop.test" }]);
  });
});

describe("the person's own filters, shown to them (D21 §4, #1109)", () => {
  const names = new Map([
    ["Lr", "Receipts"],
    ["Lb", "brood/ext/shop"],
  ]);

  it("says what each does, its labels by name, and never a forwarding address", () => {
    const { shown, unreadable } = describeOwnRules(
      [
        {
          criteria: { from: "billing@shop.test" },
          action: {
            addLabelIds: ["Lr", "STARRED"],
            removeLabelIds: ["INBOX", "UNREAD"],
          },
        },
        {
          criteria: { from: "news.example" },
          action: { addLabelIds: ["TRASH", "IMPORTANT"] },
        },
        {
          criteria: { from: "boss@work.test" },
          action: { forward: "me@elsewhere.test" },
        },
      ],
      names,
      new Set(["Lb"]),
    );
    expect(unreadable).toBe(0);
    expect(shown).toMatchObject([
      {
        names: { kind: "address", value: "billing@shop.test" },
        under: ["Receipts"],
        does: ["out_of_inbox", "read", "starred"],
      },
      {
        names: { kind: "domain", value: "news.example" },
        under: [],
        does: ["trash", "important"],
      },
      {
        names: { kind: "address", value: "boss@work.test" },
        under: [],
        does: ["forwards"],
      },
    ]);
    expect(JSON.stringify(shown)).not.toContain("elsewhere.test");
  });

  it("counts the filters naming no sender for certain, and leaves Brood's own out", () => {
    const { shown, unreadable } = describeOwnRules(
      [
        {
          criteria: { from: "Shop Billing" },
          action: { removeLabelIds: ["INBOX"] },
        },
        { action: { removeLabelIds: ["INBOX"] } },
        { action: { addLabelIds: ["Lb"], removeLabelIds: ["INBOX"] } },
      ],
      names,
      new Set(["Lb"]),
    );
    expect(shown).toEqual([]);
    expect(unreadable).toBe(2);
  });

  it("reads them through the one mask, and labels by name", async () => {
    const asked: Parameters<Filters["list"]>[0][] = [];
    const result = await mailboxOver(
      provider({
        labels: [
          { id: "Lr", name: "Receipts" },
          { id: "Le", name: "brood/ext" },
        ],
        filterList: async (p) => {
          asked.push(p);
          return {
            data: {
              filter: [
                {
                  id: "F1",
                  criteria: { from: "billing@shop.test" },
                  action: { addLabelIds: ["Lr"] },
                },
                {
                  id: "F2",
                  action: { addLabelIds: ["Le"], removeLabelIds: ["INBOX"] },
                },
              ],
            },
          };
        },
      }),
    ).ownRulesShown([]);
    expect(asked).toEqual([
      { userId: "me", fields: "filter(id,criteria/from,action)" },
    ]);
    expect(result).toMatchObject({
      shown: [
        {
          names: { kind: "address", value: "billing@shop.test" },
          under: ["Receipts"],
          does: [],
        },
      ],
      unreadable: 0,
    });
  });
});

describe("taking a person's filter over (D21 §4, #1110)", () => {
  const theirs = new Set(["Lr", "Ls"]);
  const plain = {
    criteria: { from: "billing@shop.test" },
    action: { addLabelIds: ["Lr"], removeLabelIds: ["INBOX"] },
  };

  it("takes over one that names one sender, files under one of their labels and skips the inbox", () => {
    expect(adoptableOf(plain, theirs)).toEqual({
      names: { kind: "address", value: "billing@shop.test" },
      homeId: "Lr",
    });
  });

  it.each([
    [
      "matches_more",
      { criteria: { from: "billing@shop.test", subject: "invoice" } },
    ],
    [
      "matches_more",
      { criteria: { from: "billing@shop.test", query: "has:attachment" } },
    ],
    [
      "matches_more",
      { criteria: { from: "billing@shop.test", hasAttachment: true } },
    ],
    [
      "matches_more",
      { criteria: { from: "billing@shop.test", to: "me@me.test" } },
    ],
    ["not_one_sender", { criteria: { from: "Shop Billing" } }],
    ["keeps_in_inbox", { action: { addLabelIds: ["Lr"] } }],
    [
      "forwards",
      {
        action: {
          addLabelIds: ["Lr"],
          removeLabelIds: ["INBOX"],
          forward: "x@y.test",
        },
      },
    ],
    [
      "does_more",
      { action: { addLabelIds: ["Lr", "STARRED"], removeLabelIds: ["INBOX"] } },
    ],
    [
      "does_more",
      { action: { addLabelIds: ["Lr"], removeLabelIds: ["INBOX", "UNREAD"] } },
    ],
    ["no_home", { action: { removeLabelIds: ["INBOX"] } }],
    [
      "several_homes",
      { action: { addLabelIds: ["Lr", "Ls"], removeLabelIds: ["INBOX"] } },
    ],
  ])("refuses, as %s, one Brood cannot carry exactly", (why, over) => {
    expect(adoptableOf({ ...plain, ...over }, theirs)).toBe(why);
  });

  it("reads one filter whole, by its id, and judges it", async () => {
    const read: string[] = [];
    const verdict = await mailboxOver(
      provider({
        labels: [{ id: "Lr", name: "Receipts" }],
        filterGet: async (p) => {
          read.push(p.id ?? "");
          return {
            data: { ...plain, criteria: { ...plain.criteria, subject: "x" } },
          };
        },
      }),
    ).ownRuleWhole("F1");
    expect(read).toEqual(["F1"]);
    expect(verdict).toBe("matches_more");
  });

  it("puts a person's filter back exactly as it was", async () => {
    const made: unknown[] = [];
    const id = await mailboxOver(
      provider({
        filterCreate: async (p) => {
          made.push(p.requestBody);
          return { data: { id: "F9" } };
        },
      }),
    ).restoreOwnRule({
      names: { kind: "domain", value: "shop.test" },
      homeId: "Lr",
    });
    expect(id).toBe("F9");
    expect(made).toEqual([
      {
        criteria: { from: "shop.test" },
        action: { addLabelIds: ["Lr"], removeLabelIds: ["INBOX"] },
      },
    ]);
  });
});

describe("a home's name at the provider (#304)", () => {
  it("sits under brood, with external shortened to ext", () => {
    expect(homeAtProvider("external/stripe")).toBe("brood/ext/stripe");
    expect(homeAtProvider("external/stripe/receipts")).toBe(
      "brood/ext/stripe/receipts",
    );
    expect(homeAtProvider("external/digest@news.example")).toBe(
      "brood/ext/digest@news.example",
    );
  });

  it("shortens only the first part, and only what it has a short form for", () => {
    expect(homeAtProvider("customers/acme")).toBe("brood/customers/acme");
    expect(homeAtProvider("external/external")).toBe("brood/ext/external");
  });

  it("reads only its own short forms, not an inherited property (Copilot on #305)", () => {
    expect(homeAtProvider("constructor/x")).toBe("brood/constructor/x");
    expect(homeAtProvider("toString")).toBe("brood/toString");
  });

  it("refuses a path that already begins with a short form, which would share a label (Copilot on #305)", () => {
    expect(() => homeAtProvider("ext/stripe")).toThrow(UnrenderableRuleError);
  });
});

describe("homes", () => {
  it("makes each missing part under brood, parents first", async () => {
    const created: string[] = [];
    const id = await mailboxOver(provider({ created })).ensureHome(
      "external/stripe",
    );
    expect(created).toEqual(["brood", "brood/ext", "brood/ext/stripe"]);
    expect(id).toBe("L3");
  });

  it("uses what already exists, and makes only what does not", async () => {
    const created: string[] = [];
    const id = await mailboxOver(
      provider({
        created,
        labels: [
          { id: "Lb", name: "brood" },
          { id: "Le", name: "brood/ext" },
        ],
      }),
    ).ensureHome("external/stripe");
    expect(created).toEqual(["brood/ext/stripe"]);
    expect(id).toBe("L1");
  });

  it("makes nothing when the whole path exists", async () => {
    const created: string[] = [];
    expect(
      await mailboxOver(
        provider({
          created,
          labels: [
            { id: "Lb", name: "brood" },
            { id: "Le", name: "brood/ext" },
            { id: "Ls", name: "brood/ext/stripe" },
          ],
        }),
      ).ensureHome("external/stripe"),
    ).toBe("Ls");
    expect(created).toEqual([]);
  });

  it("does not land in a user's label that shares the core's name (#304)", async () => {
    // The user's own `external/stripe` is theirs; Brood's home is under brood.
    const created: string[] = [];
    const id = await mailboxOver(
      provider({
        created,
        labels: [
          { id: "Lu1", name: "external" },
          { id: "Lu2", name: "external/stripe" },
        ],
      }),
    ).ensureHome("external/stripe");
    expect(created).toEqual(["brood", "brood/ext", "brood/ext/stripe"]);
    expect(id).not.toBe("Lu2");
  });

  it("does not take a system label's name for a home", async () => {
    const created: string[] = [];
    await mailboxOver(
      provider({
        created,
        labels: [{ id: "SPAM", name: "brood", type: "system" }],
      }),
    ).ensureHome("external/stripe");
    expect(created[0]).toBe("brood");
  });
});

describe("a quieted home (#393)", () => {
  it("is named under brood/quieted, keeping its own name", () => {
    expect(quietedHomeAtProvider("external/stripe")).toBe(
      "brood/quieted/ext/stripe",
    );
  });

  it("cannot be named by a core path, which would share its label", () => {
    expect(() => homeAtProvider("quieted/stripe")).toThrow(
      UnrenderableRuleError,
    );
  });

  const holding = (labels: Array<{ id: string; name: string }>) => {
    const created: string[] = [];
    const patched: Array<{ id: string; name: string }> = [];
    const m = mailboxOver(provider({ labels, created, patched }));
    return { m, created, patched };
  };
  const ACTIVE = [
    { id: "Lb", name: "brood" },
    { id: "Le", name: "brood/ext" },
    { id: "Ls", name: "brood/ext/stripe" },
  ];

  it("is moved there by a rename, its parents made first", async () => {
    const { m, created, patched } = holding(ACTIVE);
    expect(await m.showHome("Ls", "external/stripe", "quieted")).toBe("shown");
    expect(created).toEqual(["brood/quieted", "brood/quieted/ext"]);
    expect(patched).toEqual([{ id: "Ls", name: "brood/quieted/ext/stripe" }]);
  });

  it("is moved back by the same rename, making nothing", async () => {
    const { m, created, patched } = holding([
      { id: "Lb", name: "brood" },
      { id: "Le", name: "brood/ext" },
      { id: "Lq", name: "brood/quieted" },
      { id: "Lqe", name: "brood/quieted/ext" },
      { id: "Ls", name: "brood/quieted/ext/stripe" },
    ]);
    expect(await m.showHome("Ls", "external/stripe", "active")).toBe("shown");
    expect(created).toEqual([]);
    expect(patched).toEqual([{ id: "Ls", name: "brood/ext/stripe" }]);
  });

  it("is shown without a call when it is already there", async () => {
    const { m, patched } = holding(ACTIVE);
    expect(await m.showHome("Ls", "external/stripe", "active")).toBe("shown");
    expect(patched).toEqual([]);
  });

  it.each([
    ["it was renamed by the person", [{ id: "Ls", name: "Stripe receipts" }]],
    ["it was removed by the person", [{ id: "Lb", name: "brood" }]],
    [
      "its new name is taken",
      [...ACTIVE, { id: "Lx", name: "brood/quieted/ext/stripe" }],
    ],
    [
      "it has homes under it",
      [...ACTIVE, { id: "Lr", name: "brood/ext/stripe/receipts" }],
    ],
  ])("is left as it is when %s", async (_, labels) => {
    const { m, created, patched } = holding(labels);
    expect(await m.showHome("Ls", "external/stripe", "quieted")).toBe("left");
    expect(created).toEqual([]);
    expect(patched).toEqual([]);
  });
});

describe("what Gmail holds of a filter it made (#659)", () => {
  const sent = {
    scope: domain("vendor.com", ["a.com", "b@c.com"]),
    identity: ME,
  };
  const held = (negatedQuery: string, query = "from:vendor.com") => ({
    query,
    negatedQuery,
  });

  it("is as sent when every carve-out is held, in any order", () => {
    expect(
      heldAsSent(sent, held(`from:b@c.com OR from:${TAG} OR from:a.com`)),
    ).toBe(true);
  });

  it("is not as sent when a carve-out is missing, as a shortened query would be", () => {
    expect(heldAsSent(sent, held(`from:a.com OR from:${TAG}`))).toBe(false);
  });

  it("is not as sent when the sender is not the one sent", () => {
    expect(
      heldAsSent(
        sent,
        held(`from:a.com OR from:b@c.com OR from:${TAG}`, "from:other.com"),
      ),
    ).toBe(false);
  });

  it("is not as sent when the tag names another rule", () => {
    expect(
      heldAsSent(
        {
          ...sent,
          identity: { ...ME, ruleId: "11111111-1111-1111-1111-111111111111" },
        },
        held(`from:a.com OR from:b@c.com OR from:${TAG}`),
      ),
    ).toBe(false);
  });

  it("is not as sent in a form the sweep could not read, extra spacing included (review of #1150)", () => {
    expect(
      heldAsSent(sent, held(`from:a.com  OR from:b@c.com OR from:${TAG}`)),
    ).toBe(false);
  });

  it("is not as sent when Gmail answers with no criteria at all", () => {
    expect(heldAsSent(sent, undefined)).toBe(false);
  });
});

describe("installing a rule", () => {
  it("takes the filter back out and fails when Gmail holds less than was sent (#659)", async () => {
    const deleted: string[] = [];
    await expect(
      mailboxOver(
        provider({
          filterCreate: async () => ({
            data: {
              id: "Fshort",
              criteria: {
                query: "from:vendor.com",
                negatedQuery: `from:${TAG}`,
              },
            },
          }),
          filterDelete: async ({ id }) => {
            deleted.push(id ?? "");
            return { data: undefined };
          },
        }),
      ).installRule(domain("vendor.com", ["security@vendor.com"]), "L1", ME),
    ).rejects.toBeInstanceOf(ProviderRequestError);
    expect(deleted).toEqual(["Fshort"]);
  });

  it("tries the cleanup again once, then says the filter was left for the sweep (review of #1150)", async () => {
    const short = async () => ({
      data: {
        id: "Fshort",
        criteria: { query: "from:vendor.com", negatedQuery: `from:${TAG}` },
      },
    });
    const install = (fails: number) => {
      const tries: string[] = [];
      const done = mailboxOver(
        provider({
          filterCreate: short,
          filterDelete: async ({ id }) => {
            tries.push(id ?? "");
            if (tries.length <= fails)
              throw Object.assign(new Error("x"), { status: 500 });
            return { data: undefined };
          },
        }),
      ).installRule(domain("vendor.com", ["security@vendor.com"]), "L1", ME);
      return { done, tries };
    };
    // The code reaches the log through failureCode, so which happened is read.
    const once = install(1);
    await expect(once.done).rejects.toMatchObject({ reason: "notHeldAsSent" });
    expect(once.tries).toEqual(["Fshort", "Fshort"]);
    const twice = install(2);
    await expect(twice.done).rejects.toMatchObject({
      reason: "shortFilterLeft",
    });
    expect(twice.tries).toEqual(["Fshort", "Fshort"]);
  });

  it("files into the home and out of the inbox, with the carve-out", async () => {
    const filterCreate = vi.fn(made("F9"));
    const id = await mailboxOver(provider({ filterCreate })).installRule(
      domain("vendor.com", ["security@vendor.com"]),
      "L1",
      ME,
    );
    expect(id).toBe("F9");
    expect(filterCreate).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        criteria: {
          query: "from:vendor.com",
          negatedQuery: `from:${TAG} OR from:security@vendor.com`,
        },
        action: { addLabelIds: ["L1"], removeLabelIds: ["INBOX"] },
      },
    });
  });

  it("carries its tag even with nothing else carved out (#291)", async () => {
    const filterCreate = vi.fn(made("F9"));
    await mailboxOver(provider({ filterCreate })).installRule(
      domain("vendor.com"),
      "L1",
      ME,
    );
    expect(filterCreate.mock.calls[0]![0]).toMatchObject({
      requestBody: {
        criteria: { query: "from:vendor.com", negatedQuery: `from:${TAG}` },
      },
    });
  });

  it("refuses to install a scope it cannot render, and asks the provider nothing", async () => {
    const filterCreate = vi.fn();
    await expect(
      mailboxOver(provider({ filterCreate })).installRule(
        domain("a b.com"),
        "L1",
        ME,
      ),
    ).rejects.toBeInstanceOf(ProviderRequestError);
    expect(filterCreate).not.toHaveBeenCalled();
  });
});

describe("replacing a rule", () => {
  const old = async () => ({
    data: { action: { addLabelIds: ["L1"], removeLabelIds: ["INBOX"] } },
  });

  it("makes the new one into the same home, then removes the old", async () => {
    const steps: string[] = [];
    const id = await mailboxOver(
      provider({
        filterGet: old,
        filterCreate: async (p) => {
          steps.push(`create ${JSON.stringify(p?.requestBody?.action)}`);
          return made("Fnew")(p);
        },
        filterDelete: async ({ id }) => {
          steps.push(`delete ${id}`);
          return { data: undefined };
        },
      }),
    ).replaceRule("Fold", domain("vendor.com", ["security@vendor.com"]), ME);
    expect(id).toBe("Fnew");
    expect(steps).toEqual([
      'create {"addLabelIds":["L1"],"removeLabelIds":["INBOX"]}',
      "delete Fold",
    ]);
  });

  it("removes the new one again when the old will not go, and fails", async () => {
    const deleted: string[] = [];
    await expect(
      mailboxOver(
        provider({
          filterGet: old,
          filterCreate: made("Fnew"),
          filterDelete: async ({ id }) => {
            deleted.push(id ?? "");
            if (id === "Fold")
              throw Object.assign(new Error("x"), { status: 500 });
            return { data: undefined };
          },
        }),
      ).replaceRule("Fold", domain("vendor.com"), ME),
    ).rejects.toMatchObject({ operation: "rule", status: 500 });
    expect(deleted).toEqual(["Fold", "Fnew"]);
  });

  it("says the rule is not found when the provider has no filter by its id, and makes nothing (#454)", async () => {
    const filterCreate = vi.fn();
    await expect(
      mailboxOver(
        provider({
          filterGet: async () => {
            throw Object.assign(new Error("x"), { status: 404 });
          },
          filterCreate,
        }),
      ).replaceRule("Fold", domain("vendor.com"), ME),
    ).rejects.toBeInstanceOf(RuleNotFoundError);
    expect(filterCreate).not.toHaveBeenCalled();
  });

  it("does not say not found for a 404 from making the new filter: that is a failure (review of #760)", async () => {
    const thrown = await mailboxOver(
      provider({
        filterGet: old,
        filterCreate: async () => {
          throw Object.assign(new Error("x"), { status: 404 });
        },
      }),
    )
      .replaceRule("Fold", domain("vendor.com"), ME)
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ProviderRequestError);
    expect(thrown).not.toBeInstanceOf(RuleNotFoundError);
    expect(thrown).toMatchObject({ operation: "rule", status: 404 });
  });

  it("refuses a rule with no home to file into", async () => {
    const filterCreate = vi.fn();
    await expect(
      mailboxOver(
        provider({
          filterGet: async () => ({
            data: { action: { removeLabelIds: ["INBOX"] } },
          }),
          filterCreate,
        }),
      ).replaceRule("Fold", domain("vendor.com"), ME),
    ).rejects.toBeInstanceOf(ProviderRequestError);
    expect(filterCreate).not.toHaveBeenCalled();
  });
});

describe("a rule's home", () => {
  it("is what the rule adds, less the inbox, so a renamed home is still found", async () => {
    expect(
      await mailboxOver(
        provider({
          filterGet: async () => ({
            data: {
              action: {
                addLabelIds: ["INBOX", "L7"],
                removeLabelIds: ["INBOX"],
              },
            },
          }),
        }),
      ).ruleHome("F1"),
    ).toBe("L7");
  });

  it("fails for a rule that files into nothing", async () => {
    await expect(
      mailboxOver(
        provider({ filterGet: async () => ({ data: { action: {} } }) }),
      ).ruleHome("F1"),
    ).rejects.toMatchObject({ operation: "rule" });
  });
});

describe("removing a rule", () => {
  it("counts one already gone as removed", async () => {
    await expect(
      mailboxOver(
        provider({
          filterDelete: async () => {
            throw Object.assign(new Error("gone"), { status: 404 });
          },
        }),
      ).removeRule("F1"),
    ).resolves.toBeUndefined();
  });

  it("fails on any other refusal", async () => {
    await expect(
      mailboxOver(
        provider({
          filterDelete: async () => {
            throw Object.assign(new Error("no"), { status: 403 });
          },
        }),
      ).removeRule("F1"),
    ).rejects.toMatchObject({ operation: "rule", status: 403 });
  });
});

describe("rescue's half of the mailbox (#442)", () => {
  it("names Brood's homes by handle: everything under brood, and nothing of the person's", async () => {
    const homes = await mailboxOver(
      provider({
        labels: [
          { id: "Lb", name: "brood" },
          { id: "Le", name: "brood/ext" },
          { id: "Ls", name: "brood/ext/stripe renamed by the person" },
          { id: "Lq", name: "brood/quieted/ext/news" },
          { id: "Lp", name: "Receipts" },
          { id: "Lx", name: "broodish" },
          { id: "INBOX", name: "INBOX", type: "system" },
        ],
      }),
    ).homeHandles([]);
    expect([...homes].sort()).toEqual(["Le", "Lq", "Ls"]);
  });

  it("counts a recorded home, though the person renamed it out of brood, and lists no filter (review of #494, #1106)", async () => {
    const homes = await mailboxOver(
      provider({
        labels: [{ id: "Lr", name: "Stripe, renamed" }],
        filterList: async () => {
          throw new Error("homeHandles lists no filter");
        },
      }),
    ).homeHandles([{ providerRuleId: "F1", homeId: "Lr" }]);
    expect([...homes]).toEqual(["Lr"]);
  });

  it("asks a recorded rule with no home yet for its home, by id (#1106)", async () => {
    const read: string[] = [];
    const homes = await mailboxOver(
      provider({
        labels: [],
        filterGet: async (p) => {
          read.push(p.id ?? "");
          return {
            data: {
              action: { addLabelIds: ["Lr"], removeLabelIds: ["INBOX"] },
            },
          };
        },
      }),
    ).homeHandles([{ providerRuleId: "F1", homeId: null }]);
    expect(read).toEqual(["F1"]);
    expect([...homes]).toEqual(["Lr"]);
  });

  it("puts events back in the inbox a thousand a request, and takes nothing away", async () => {
    const batchModify = vi.fn<Users["messages"]["batchModify"]>(async () => ({
      data: undefined,
    }));
    const ids = Array.from({ length: FILE_BATCH + 1 }, (_, i) => `m${i}`);
    await mailboxOver(provider({ batchModify })).bringIntoView(ids);
    expect(batchModify).toHaveBeenCalledTimes(2);
    expect(batchModify.mock.calls[0]![0]).toEqual({
      userId: "me",
      requestBody: { ids: ids.slice(0, FILE_BATCH), addLabelIds: ["INBOX"] },
    });
  });

  it("names the operation when the provider refuses", async () => {
    const batchModify = async () => {
      throw Object.assign(new Error("x"), { code: 503 });
    };
    await expect(
      mailboxOver(provider({ batchModify })).bringIntoView(["m1"]),
    ).rejects.toMatchObject({ operation: "view" });
  });
});

describe("bringing filed mail back (#663)", () => {
  it("puts events back in the inbox and takes the one home off them, a thousand a request", async () => {
    const batchModify = vi.fn<Users["messages"]["batchModify"]>(async () => ({
      data: undefined,
    }));
    const ids = Array.from({ length: FILE_BATCH + 1 }, (_, i) => `m${i}`);
    await mailboxOver(provider({ batchModify })).returnFromHome(ids, ["L1"]);
    expect(batchModify).toHaveBeenCalledTimes(2);
    expect(batchModify.mock.calls[0]![0]).toEqual({
      userId: "me",
      requestBody: {
        ids: ids.slice(0, FILE_BATCH),
        addLabelIds: ["INBOX"],
        removeLabelIds: ["L1"],
      },
    });
  });

  it("names the operation when the provider refuses", async () => {
    const batchModify = async () => {
      throw Object.assign(new Error("x"), { code: 503 });
    };
    await expect(
      mailboxOver(provider({ batchModify })).returnFromHome(["m1"], ["L1"]),
    ).rejects.toMatchObject({ operation: "return" });
  });

  it("takes every home it is given off, once each, and refuses none or the inbox (#610)", async () => {
    const batchModify = vi.fn<Users["messages"]["batchModify"]>(async () => ({
      data: undefined,
    }));
    const box = mailboxOver(provider({ batchModify }));
    await box.returnFromHome(["m1"], ["L-sub", "L-root", "L-sub"]);
    expect(batchModify.mock.calls[0]![0]).toMatchObject({
      requestBody: { removeLabelIds: ["L-sub", "L-root"] },
    });
    await expect(box.returnFromHome(["m1"], [])).rejects.toThrow();
    await expect(box.returnFromHome(["m1"], ["INBOX"])).rejects.toThrow();
    expect(batchModify).toHaveBeenCalledTimes(1);
  });
});

describe("filing what already arrived", () => {
  it("files a thousand ids a request, into the home and out of the inbox", async () => {
    const batchModify = vi.fn<Users["messages"]["batchModify"]>(async () => ({
      data: undefined,
    }));
    const ids = Array.from({ length: FILE_BATCH * 2 + 1 }, (_, i) => `m${i}`);
    await mailboxOver(provider({ batchModify })).fileExisting(ids, "L1");
    expect(batchModify).toHaveBeenCalledTimes(3);
    const sizes = batchModify.mock.calls.map(
      (c) =>
        (c[0] as { requestBody: { ids: string[] } }).requestBody.ids.length,
    );
    expect(sizes).toEqual([1000, 1000, 1]);
    expect(batchModify.mock.calls[0]![0]).toMatchObject({
      userId: "me",
      requestBody: { addLabelIds: ["L1"], removeLabelIds: ["INBOX"] },
    });
  });

  it("finds them by the rule's own search, ids only", async () => {
    const list = vi.fn(async () => ({
      data: { messages: [{ id: "m1" }], nextPageToken: null },
    }));
    const page = await mailboxOver(provider({ list })).matching(
      domain("vendor.com", ["a@vendor.com"]),
      { pageSize: 500 },
    );
    expect(list).toHaveBeenCalledWith({
      userId: "me",
      q: "from:vendor.com -{from:a@vendor.com} -in:drafts",
      pageToken: undefined,
      maxResults: 500,
    });
    expect(page.providerEventIds).toEqual(["m1"]);
  });
});
