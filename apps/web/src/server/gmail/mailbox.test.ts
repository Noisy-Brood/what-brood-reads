import { describe, expect, it, vi } from "vitest";
import { RefreshToken } from "../tokens/secret";
import { TokenRevokedError } from "../tokens";
import type { TokenOpener } from "../tokens/open";
import type { ProviderClient } from "./client";
import { DraftNotAnEventError } from "./derive";
import { METADATA_HEADERS, UNSUBSCRIBE_HEADERS } from "./headers";
import {
  MAX_HOMES_COUNTED,
  mailboxOver,
  oldestMail,
  openMailbox,
  ProviderRequestError,
  RevocationError,
  revokeMailbox,
  windowQuery,
} from "./mailbox";
import { AuthorizationError } from "./request";
import { stubProviderClient } from "./stub-client.test-support";
import { unconnectedSql } from "../testing/unconnected-sql";

/** The database handle passed in: never queried, since the token opener is a stand-in. */
const SQL = unconnectedSql();

/**
 * Opening a stored account's mailbox, and what it lets out. The refresh token
 * goes to Google's token endpoint and nowhere else, and a failed request to the
 * mailbox comes back as a status, because the client library's own error holds
 * the request it made, access token included.
 */

const SENTINEL = "SENTINEL-must-not-appear";
const REFRESH = `1//${SENTINEL}`;
const ACCESS = `ya29.${SENTINEL}`;
const ref = { userId: "u", accountId: "a" };
const client = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "http://localhost:3000/api/connect/callback",
};

const opener = (): TokenOpener & { open: ReturnType<typeof vi.fn> } => ({
  open: vi.fn(async () => RefreshToken.of(REFRESH)),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const tokenEndpoint = (answer: () => Response) => {
  const calls: RequestInit[] = [];
  const fn = (async (_url: string | URL, init?: RequestInit) => {
    calls.push(init!);
    return answer();
  }) as typeof fetch;
  return { fn, calls };
};

/** Everything an error could carry out of the process. */
const everything = (e: unknown) =>
  e instanceof Error
    ? `${e.message} ${e.name} ${e.stack ?? ""} ${JSON.stringify(e)} ${JSON.stringify(Object.entries(e))}`
    : String(e);

const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

describe("opening a mailbox", () => {
  it("paces its message reads by the account, before any request is made (#381)", async () => {
    const keys: string[] = [];
    const mailbox = await openMailbox(SQL, ref, client, {
      reason: "sync",
      opener: opener(),
      fetchFn: tokenEndpoint(() => json({ access_token: ACCESS })).fn,
      pacer: {
        async wait(key) {
          keys.push(key);
          throw new Error("paced");
        },
      },
    });
    await expect(mailbox.read("m1", { accountAddresses: [] })).rejects.toThrow(
      "paced",
    );
    expect(keys).toEqual([ref.accountId]);
  });

  it("reads the token for sync, and sends it only to the token endpoint, as a refresh", async () => {
    const o = opener();
    const google = tokenEndpoint(() => json({ access_token: ACCESS }));
    await openMailbox(SQL, ref, client, {
      reason: "sync",
      opener: o,
      fetchFn: google.fn,
    });
    expect(o.open).toHaveBeenCalledWith(SQL, ref, "sync");
    const body = new URLSearchParams(String(google.calls[0]!.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe(REFRESH);
    expect(body.get("client_id")).toBe("client-id");
  });

  it("gives back functions over the mailbox, and no token", async () => {
    const mailbox = await openMailbox(SQL, ref, client, {
      reason: "sync",
      opener: opener(),
      fetchFn: tokenEndpoint(() => json({ access_token: ACCESS })).fn,
    });
    // The rule side (#194) files and installs by id and scope: each takes and
    // returns provider ids, never a credential.
    expect(Object.keys(mailbox).sort()).toEqual([
      "addresses",
      "bringIntoView",
      "changes",
      "colourHome",
      "ensureHome",
      "fileExisting",
      "historyCursor",
      "homeColour",
      "homeHandles",
      "installRule",
      "list",
      "listRules",
      "matching",
      "oneClick",
      "ownRuleWhole",
      "ownRules",
      "ownRulesShown",
      "read",
      "removeRule",
      "replaceRule",
      "restoreOwnRule",
      "returnFromHome",
      "ruleHome",
      "showHome",
      "size",
      "watch",
    ]);
    expect(JSON.stringify(mailbox)).not.toContain(SENTINEL);
  });

  it("names a revoked grant as one, and carries nothing from the request", async () => {
    const error = await failure(
      openMailbox(SQL, ref, client, {
        reason: "sync",
        opener: opener(),
        fetchFn: tokenEndpoint(() =>
          json(
            { error: "invalid_grant", error_description: `bad ${SENTINEL}` },
            400,
          ),
        ).fn,
      }),
    );
    expect(error).toBeInstanceOf(TokenRevokedError);
    expect(error).toMatchObject({ status: 400, reason: "invalid_grant" });
    expect(everything(error)).not.toContain(SENTINEL);
  });

  it("reports any other refusal as a failed refresh, not a revoked grant", async () => {
    const error = await failure(
      openMailbox(SQL, ref, client, {
        reason: "sync",
        opener: opener(),
        fetchFn: tokenEndpoint(() => json({ error: "invalid_client" }, 401)).fn,
      }),
    );
    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error).toMatchObject({
      step: "refresh",
      status: 401,
      providerCode: "invalid_client",
    });
  });

  it("refuses a success with no access token in it", async () => {
    const error = await failure(
      openMailbox(SQL, ref, client, {
        reason: "sync",
        opener: opener(),
        fetchFn: tokenEndpoint(() => json({ token_type: "Bearer" })).fn,
      }),
    );
    expect(error).toMatchObject({
      step: "refresh",
      providerCode: "no_access_token",
    });
  });

  it("asks Google nothing when the vault will not open the token", async () => {
    const google = tokenEndpoint(() => json({ access_token: ACCESS }));
    const refusing: TokenOpener = {
      open: async () => {
        throw new Error("vault refused");
      },
    };
    await expect(
      openMailbox(SQL, ref, client, {
        reason: "sync",
        opener: refusing,
        fetchFn: google.fn,
      }),
    ).rejects.toThrow("vault refused");
    expect(google.calls).toHaveLength(0);
  });
});

/** A library error as gaxios builds one: the request it made, headers and all. */
const libraryError = (status: number) =>
  Object.assign(new Error(`Request failed ${SENTINEL}`), {
    status,
    config: { headers: { Authorization: `Bearer ${ACCESS}` } },
    response: { status, data: { error: { message: SENTINEL } } },
  });

/** A provider client that answers only what these tests ask of it. */
const provider = (over: {
  getProfile?: Users["getProfile"];
  labelsList?: Users["labels"]["list"];
  labelsGet?: Users["labels"]["get"];
  list?: Users["messages"]["list"];
  get?: Users["messages"]["get"];
  history?: Users["history"]["list"];
  watch?: Users["watch"];
  sendAs?: Users["settings"]["sendAs"]["list"];
}) =>
  stubProviderClient({
    getProfile: over.getProfile ?? (async () => ({ data: {} })),
    messages: {
      list: over.list ?? (async () => ({ data: {} })),
      get: over.get ?? (async () => ({ data: {} })),
    },
    history: { list: over.history ?? (async () => ({ data: {} })) },
    labels: {
      list: over.labelsList ?? (async () => ({ data: {} })),
      get: over.labelsGet ?? (async () => ({ data: {} })),
    },
    watch: over.watch ?? (async () => ({ data: {} })),
    sendAs: { list: over.sendAs ?? (async () => ({ data: {} })) },
  });

type Users = ProviderClient["users"];

describe("what the mailbox asks, and what its failures carry", () => {
  it("lists a window by arrival, leaving drafts out", async () => {
    const list = vi.fn(async () => ({
      data: { messages: [{ id: "m1" }], nextPageToken: "p2" },
    }));
    const since = new Date("2026-06-01T00:00:00Z");
    const page = await mailboxOver(provider({ list })).list({
      since,
      pageToken: "p1",
      pageSize: 50,
    });
    expect(list).toHaveBeenCalledWith({
      userId: "me",
      q: `after:${since.getTime() / 1000} -in:drafts`,
      pageToken: "p1",
      maxResults: 50,
    });
    expect(page).toEqual({ providerEventIds: ["m1"], nextPageToken: "p2" });
    expect(windowQuery(since)).toBe("after:1780272000 -in:drafts");
    // The older half of a first read is bounded at both ends (#602).
    expect(windowQuery(since, new Date(1781000000 * 1000))).toBe(
      "after:1780272000 before:1781000000 -in:drafts",
    );
    // And the first read's sent listing is sent mail only.
    expect(windowQuery(since, undefined, true)).toBe(
      "in:sent after:1780272000 -in:drafts",
    );
  });

  it("carries the provider's estimate of the whole window, where it gives one", async () => {
    const list = vi.fn(async () => ({
      data: {
        messages: [{ id: "m1" }],
        nextPageToken: null,
        resultSizeEstimate: 11_600,
      },
    }));
    const page = await mailboxOver(provider({ list })).list({
      since: new Date(),
    });
    expect(page).toEqual({
      providerEventIds: ["m1"],
      nextPageToken: null,
      estimate: 11_600,
    });
  });

  it("waits for the pacer before it reads (#381)", async () => {
    const order: string[] = [];
    const get = vi.fn(async () => {
      order.push("get");
      return {
        data: {
          id: "m1",
          internalDate: "1789776000000",
          payload: { headers: [{ name: "From", value: "a@vendor.test" }] },
        },
      };
    });
    await mailboxOver(provider({ get }), async () => {
      order.push("pace");
    }).read("m1", { accountAddresses: ["tim@example.test"] });
    expect(order).toEqual(["pace", "get"]);
  });

  it("reads metadata with the allowlist and the fields it takes, and nothing else", async () => {
    const get = vi.fn(async () => ({
      data: {
        id: "m1",
        internalDate: "1789776000000",
        payload: { headers: [{ name: "From", value: "a@vendor.test" }] },
      },
    }));
    await mailboxOver(provider({ get })).read("m1", {
      accountAddresses: ["tim@example.test"],
    });
    expect(get).toHaveBeenCalledWith({
      format: "metadata",
      metadataHeaders: METADATA_HEADERS,
      fields: "id,threadId,labelIds,internalDate,payload/headers",
      userId: "me",
      id: "m1",
    });
  });

  it("reads a message's unsubscribe headers and nothing else of it", async () => {
    const get = vi.fn(async () => ({ data: { payload: { headers: [] } } }));
    await mailboxOver(provider({ get })).oneClick("m1");
    expect(get).toHaveBeenCalledWith({
      format: "metadata",
      metadataHeaders: UNSUBSCRIBE_HEADERS,
      fields: "payload/headers",
      userId: "me",
      id: "m1",
    });
  });

  it("asks for the additions since a cursor, and names each added event once", async () => {
    const history = vi.fn(async () => ({
      data: {
        history: [
          { id: "9", messagesAdded: [{ message: { id: "m1" } }] },
          {
            id: "10",
            messagesAdded: [
              { message: { id: "m2" } },
              { message: { id: "m1" } },
            ],
          },
        ],
        nextPageToken: "h2",
        historyId: "12",
      },
    }));
    const page = await mailboxOver(provider({ history })).changes({
      since: "8",
      pageToken: "h1",
      pageSize: 50,
    });
    expect(history).toHaveBeenCalledWith({
      userId: "me",
      startHistoryId: "8",
      historyTypes: ["messageAdded", "labelAdded", "labelRemoved"],
      pageToken: "h1",
      maxResults: 50,
    });
    // "10" is past "9": the ids are numbers, and compared as strings they are not.
    expect(page).toEqual({
      providerEventIds: ["m1", "m2"],
      moved: [],
      through: "10",
      nextPageToken: "h2",
      cursor: "12",
    });
  });

  it("names how events already there moved, and not how an arrival was filed nor a star (#420)", async () => {
    const history = async () => ({
      data: {
        history: [
          {
            id: "20",
            labelsAdded: [{ message: { id: "old1" }, labelIds: ["INBOX"] }],
          },
          {
            id: "21",
            labelsRemoved: [
              { message: { id: "old1" }, labelIds: ["Label_home"] },
            ],
          },
          {
            id: "22",
            labelsRemoved: [
              { message: { id: "old2" }, labelIds: ["Label_home", "UNREAD"] },
            ],
          },
          {
            id: "23",
            labelsAdded: [{ message: { id: "old3" }, labelIds: ["STARRED"] }],
          },
          {
            id: "24",
            messagesAdded: [{ message: { id: "new1" } }],
            labelsAdded: [{ message: { id: "new1" }, labelIds: ["INBOX"] }],
          },
        ],
        historyId: "30",
      },
    });
    const page = await mailboxOver(provider({ history })).changes({
      since: "19",
    });
    expect(page.providerEventIds).toEqual(["new1"]);
    expect(page.moved).toEqual([
      { providerEventId: "old1", intoView: true, outOf: ["Label_home"] },
      {
        providerEventId: "old2",
        intoView: false,
        outOf: ["Label_home", "UNREAD"],
      },
    ]);
    expect(page.through).toBe("24");
  });

  it("keeps a move after an arrival on the same page, and not the arrival's own filing (review of #498)", async () => {
    const history = async () => ({
      data: {
        history: [
          {
            id: "20",
            messagesAdded: [{ message: { id: "m1" } }],
            labelsAdded: [{ message: { id: "m1" }, labelIds: ["Label_home"] }],
          },
          {
            id: "21",
            labelsRemoved: [
              { message: { id: "m1" }, labelIds: ["Label_home"] },
            ],
          },
        ],
        historyId: "22",
      },
    });
    const page = await mailboxOver(provider({ history })).changes({
      since: "19",
    });
    expect(page.providerEventIds).toEqual(["m1"]);
    expect(page.moved).toEqual([
      { providerEventId: "m1", intoView: false, outOf: ["Label_home"] },
    ]);
  });

  it("reports a page with no changes as reaching nowhere, with the mailbox's cursor", async () => {
    const page = await mailboxOver(
      provider({ history: async () => ({ data: { historyId: "40" } }) }),
    ).changes({ since: "39" });
    expect(page).toEqual({
      providerEventIds: [],
      moved: [],
      through: null,
      nextPageToken: null,
      cursor: "40",
    });
  });

  it("asks for every change to be pushed to the topic, and says when that stops", async () => {
    const watch = vi.fn(async () => ({
      data: { historyId: "5", expiration: "1790000000000" },
    }));
    const result = await mailboxOver(provider({ watch })).watch(
      "projects/p/topics/t",
    );
    expect(watch).toHaveBeenCalledWith({
      userId: "me",
      requestBody: { topicName: "projects/p/topics/t" },
    });
    expect(result).toEqual({ expiresAt: new Date(1790000000000) });
  });

  it("refuses a watch with no expiry rather than assume one", async () => {
    const error = await failure(
      mailboxOver(provider({ watch: async () => ({ data: {} }) })).watch("t"),
    );
    expect(error).toMatchObject({ operation: "watch" });
  });

  it("names the mailbox's own addresses: the primary and verified aliases, and no unverified one", async () => {
    const sendAs = vi.fn(async () => ({
      data: {
        sendAs: [
          { sendAsEmail: "Tim@Example.test", isPrimary: true },
          {
            sendAsEmail: "personal@example.org",
            verificationStatus: "accepted",
          },
          { sendAsEmail: "someone@else.test", verificationStatus: "pending" },
          {
            sendAsEmail: "PERSONAL@example.org",
            verificationStatus: "accepted",
          },
          { verificationStatus: "accepted" },
        ],
      },
    }));
    expect(await mailboxOver(provider({ sendAs })).addresses()).toEqual([
      "tim@example.test",
      "personal@example.org",
    ]);
    expect(sendAs).toHaveBeenCalledWith({ userId: "me" });
  });

  it("returns the provider's history cursor", async () => {
    const mailbox = mailboxOver(
      provider({ getProfile: async () => ({ data: { historyId: "12345" } }) }),
    );
    expect(await mailbox.historyCursor()).toBe("12345");
  });

  it("refuses a profile with no cursor rather than start from nothing", async () => {
    const error = await failure(mailboxOver(provider({})).historyCursor());
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error).toMatchObject({ operation: "cursor" });
  });

  it.each([
    [
      "list",
      (m: ReturnType<typeof mailboxOver>) => m.list({ since: new Date() }),
    ],
    [
      "read",
      (m: ReturnType<typeof mailboxOver>) =>
        m.read("m1", { accountAddresses: [] }),
    ],
    ["cursor", (m: ReturnType<typeof mailboxOver>) => m.historyCursor()],
    [
      "changes",
      (m: ReturnType<typeof mailboxOver>) => m.changes({ since: "1" }),
    ],
    ["watch", (m: ReturnType<typeof mailboxOver>) => m.watch("topic")],
    ["addresses", (m: ReturnType<typeof mailboxOver>) => m.addresses()],
  ])(
    "a failed %s carries its status and not the request it made",
    async (operation, call) => {
      const fail = async () => {
        throw libraryError(404);
      };
      const error = await failure(
        call(
          mailboxOver(
            provider({
              list: fail,
              get: fail,
              getProfile: fail,
              history: fail,
              watch: fail,
              sendAs: fail,
            }),
          ),
        ),
      );
      expect(error).toBeInstanceOf(ProviderRequestError);
      expect(error).toMatchObject({ operation, status: 404 });
      expect(everything(error)).not.toContain(SENTINEL);
    },
  );

  /** A Gmail error body as its guide shows one (#375), with a sentinel in its message. */
  const googleError = (status: number, reason: unknown) =>
    Object.assign(new Error(`Request failed ${SENTINEL}`), {
      status,
      config: { headers: { Authorization: `Bearer ${ACCESS}` } },
      response: {
        status,
        data: {
          error: {
            code: status,
            message: SENTINEL,
            errors: [{ domain: "usageLimits", message: SENTINEL, reason }],
          },
        },
      },
    });
  const readFailing = (status: number, reason: unknown) =>
    failure(
      mailboxOver(
        provider({
          get: async () => {
            throw googleError(status, reason);
          },
        }),
      ).read("m1", { accountAddresses: [] }),
    );

  it("keeps Google's reason on a failure, and nothing else of the body (#375)", async () => {
    const error = await readFailing(403, "userRateLimitExceeded");
    expect(error).toMatchObject({
      operation: "read",
      status: 403,
      reason: "userRateLimitExceeded",
    });
    expect(everything(error)).not.toContain(SENTINEL);
  });

  it.each([
    ["text with spaces", `quota ${SENTINEL}`],
    ["a very long word", "x".repeat(41)],
    ["not a string", { nested: SENTINEL }],
  ])(
    "drops a reason that is %s rather than a plain code",
    async (_, reason) => {
      const error = await readFailing(403, reason);
      expect(error).toMatchObject({ status: 403, reason: null });
      expect(everything(error)).not.toContain(SENTINEL);
    },
  );

  it.each([
    [429, null, true],
    [403, "rateLimitExceeded", true],
    [403, "userRateLimitExceeded", true],
    [403, "dailyLimitExceeded", false],
    [403, "domainPolicy", false],
    [403, null, false],
    [500, "rateLimitExceeded", false],
  ] as const)(
    "a %i with reason %s is rate limited: %s",
    (status, reason, limited) => {
      expect(new ProviderRequestError("read", status, reason).rateLimited).toBe(
        limited,
      );
    },
  );

  it("lets the derivation's refusal of a draft through as itself", async () => {
    const get = async () => ({
      data: {
        id: "d1",
        labelIds: ["DRAFT"],
        internalDate: "1789776000000",
        payload: { headers: [{ name: "From", value: "tim@example.test" }] },
      },
    });
    const error = await failure(
      mailboxOver(provider({ get })).read("d1", {
        accountAddresses: ["tim@example.test"],
      }),
    );
    expect(error).toBeInstanceOf(DraftNotAnEventError);
  });
});

/** Google, for a revocation: the token endpoint, Gmail's stop, and the revoke endpoint. */
const google = (answers: {
  token?: () => Response;
  stop?: () => Response;
  revoke?: () => Response;
}) => {
  const calls: Array<{ to: string; body: string; auth: string | null }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const to = u.includes("/token")
      ? "token"
      : u.includes("/revoke")
        ? "revoke"
        : u.includes("/users/me/stop")
          ? "stop"
          : u;
    calls.push({
      to,
      body: String(init?.body ?? ""),
      auth: new Headers(init?.headers).get("authorization"),
    });
    if (to === "token")
      return (answers.token ?? (() => json({ access_token: ACCESS })))();
    if (to === "stop") return (answers.stop ?? (() => json({})))();
    if (to === "revoke")
      return (answers.revoke ?? (() => new Response("", { status: 200 })))();
    throw new Error(`unexpected ${u}`);
  }) as typeof fetch;
  return { fn, calls, order: () => calls.map((c) => c.to) };
};

describe("revoking the grant (#223)", () => {
  it("reads the token for revoke, stops the watch, then revokes the refresh token", async () => {
    const o = opener();
    const g = google({});
    const result = await revokeMailbox(SQL, ref, client, {
      opener: o,
      fetchFn: g.fn,
    });
    expect(result).toBe("revoked");
    expect(o.open).toHaveBeenCalledWith(SQL, ref, "revoke");
    expect(g.order()).toEqual(["token", "stop", "revoke"]);
    expect(g.calls[1]!.auth).toBe(`Bearer ${ACCESS}`);
    expect(new URLSearchParams(g.calls[2]!.body).get("token")).toBe(REFRESH);
  });

  it("says the grant was already dead when Google refuses the refresh token, and asks nothing more", async () => {
    const g = google({ token: () => json({ error: "invalid_grant" }, 400) });
    const result = await revokeMailbox(SQL, ref, client, {
      opener: opener(),
      fetchFn: g.fn,
    });
    expect(result).toBe("already_revoked");
    expect(g.order()).toEqual(["token"]);
  });

  it("revokes even when the watch will not stop", async () => {
    const g = google({
      stop: () => json({ error: { message: SENTINEL } }, 500),
    });
    expect(
      await revokeMailbox(SQL, ref, client, {
        opener: opener(),
        fetchFn: g.fn,
      }),
    ).toBe("revoked");
    expect(g.order()).toEqual(["token", "stop", "revoke"]);
  });

  it.each([
    ["Google's refusal", () => json({ error: "invalid_token" }, 400), 400],
    ["an outage", () => new Response("", { status: 503 }), 503],
  ])("does not claim a revocation on %s", async (_name, revoke, status) => {
    const error = await failure(
      revokeMailbox(SQL, ref, client, {
        opener: opener(),
        fetchFn: google({ revoke }).fn,
      }),
    );
    expect(error).toBeInstanceOf(RevocationError);
    expect(error).toMatchObject({ status });
    expect(everything(error)).not.toContain(SENTINEL);
  });

  it("does not claim one when the request never completed", async () => {
    const g = google({
      revoke: () => {
        throw new TypeError(`fetch failed for token=${SENTINEL}`);
      },
    });
    const error = await failure(
      revokeMailbox(SQL, ref, client, {
        opener: opener(),
        fetchFn: g.fn,
      }),
    );
    expect(error).toMatchObject({ status: 0 });
    expect(everything(error)).not.toContain(SENTINEL);
  });

  it("passes on a failure to refresh that is not a dead grant, rather than call it revoked", async () => {
    const error = await failure(
      revokeMailbox(SQL, ref, client, {
        opener: opener(),
        fetchFn: google({ token: () => json({ error: "invalid_client" }, 401) })
          .fn,
      }),
    );
    expect(error).toMatchObject({ step: "refresh", status: 401 });
  });
});

describe("a mailbox's size (#558)", () => {
  const labels = [
    { id: "L1", name: "brood", type: "user" },
    { id: "L2", name: "brood/ext/stripe", type: "user" },
    { id: "L3", name: "brood/quieted/ext/old", type: "user" },
    { id: "L4", name: "Receipts", type: "user" },
  ];
  const totals: Record<string, number> = {
    INBOX: 120,
    L1: 0,
    L2: 30,
    L3: 5,
    L4: 999,
  };

  it("asks only for totals, never unread counts, and sums Brood's homes alone", async () => {
    const asked: { fields?: string }[] = [];
    const size = await mailboxOver(
      provider({
        getProfile: async (p) => {
          asked.push(p);
          return { data: { messagesTotal: 4000, threadsTotal: 2500 } };
        },
        labelsList: async () => ({ data: { labels } }),
        labelsGet: async (p) => {
          asked.push(p);
          return { data: { messagesTotal: totals[p.id ?? ""] } };
        },
        list: async () => ({ data: {} }),
      }),
    ).size();
    expect(size).toMatchObject({
      messages: 4000,
      conversations: 2500,
      inbox: 120,
      filed: 35,
    });
    for (const p of asked) expect(String(p.fields)).not.toMatch(/Unread/i);
    expect(asked.map((p) => p.fields)).toEqual([
      "messagesTotal,threadsTotal",
      "messagesTotal",
      "messagesTotal",
      "messagesTotal",
    ]);
  });

  it("does not count more homes than it may, so a read stays inside its time (review of #596)", async () => {
    let asked = 0;
    const many = Array.from({ length: MAX_HOMES_COUNTED + 1 }, (_, i) => ({
      id: `H${i}`,
      name: `brood/ext/h${i}`,
      type: "user",
    }));
    const size = await mailboxOver(
      provider({
        getProfile: async () => ({ data: {} }),
        labelsList: async () => ({ data: { labels: many } }),
        labelsGet: async () => {
          asked += 1;
          return { data: { messagesTotal: 1 } };
        },
      }),
    ).size();
    expect(size.filed).toBeNull();
    // The inbox only: no home is asked about.
    expect(asked).toBe(1);
  });

  it("says null for a count Gmail does not give", async () => {
    const size = await mailboxOver(
      provider({
        getProfile: async () => ({ data: {} }),
        labelsList: async () => ({ data: { labels: labels.slice(1, 2) } }),
        labelsGet: async () => ({ data: {} }),
      }),
    ).size();
    expect(size).toEqual({
      messages: null,
      conversations: null,
      inbox: null,
      filed: null,
      oldest: null,
    });
  });
});

describe("how far back a mailbox goes (#558)", () => {
  const DAY = 86_400_000;
  const NOW = Date.UTC(2026, 9, 1);

  it("finds the day of the oldest mail by halving, in few questions", async () => {
    const first = Date.UTC(2009, 2, 14, 8);
    let asked = 0;
    const oldest = await oldestMail(async (before) => {
      asked += 1;
      return first < before;
    }, NOW);
    expect(oldest!.getTime()).toBeLessThanOrEqual(first);
    expect(first - oldest!.getTime()).toBeLessThan(DAY);
    expect(asked).toBeLessThan(20);
  });

  it("counts mail that arrived today, which a search before today leaves out (review of #596)", async () => {
    // As Gmail answers `before:YYYY/MM/DD`: mail before the start of that
    // day, so a search before today leaves today's mail out.
    const today = NOW + 9 * 3_600_000;
    const startOf = (ms: number) => Math.floor(ms / DAY) * DAY;
    const oldest = await oldestMail(
      async (before) => today < startOf(before),
      NOW + 12 * 3_600_000,
    );
    expect(oldest).not.toBeNull();
    expect(today - oldest!.getTime()).toBeLessThan(DAY);
  });

  it("ends whatever time of day it is asked at", async () => {
    // A now that is not midnight leaves the bounds less than two days apart
    // at the end, where halving rounds to nothing unless each step moves.
    // Mail from today, as a new mailbox has, is where it stalled.
    for (const hour of [1, 7, 13, 23]) {
      const now = NOW + hour * 3_600_000 + 17 * 60_000;
      const first = now - 30 * 60_000;
      const oldest = await oldestMail(async (before) => first < before, now);
      expect(oldest!.getTime()).toBeLessThanOrEqual(first);
      expect(first - oldest!.getTime()).toBeLessThan(DAY);
    }
  });

  it("is nothing for a mailbox with no mail, and the floor for mail before it", async () => {
    expect(await oldestMail(async () => false, NOW)).toBeNull();
    expect((await oldestMail(async () => true, NOW))!.getUTCFullYear()).toBe(
      1980,
    );
  });

  it("asks each question as a one-id search before a day, in the form Gmail's help documents", async () => {
    const list = vi.fn(async () => ({ data: {} }));
    await mailboxOver(
      provider({
        getProfile: async () => ({ data: {} }),
        labelsList: async () => ({ data: {} }),
        list,
      }),
    ).size();
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        q: expect.stringMatching(/^before:\d{4}\/\d{2}\/\d{2}$/),
        maxResults: 1,
      }),
    );
  });
});
