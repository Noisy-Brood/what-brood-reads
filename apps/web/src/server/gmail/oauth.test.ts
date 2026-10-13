import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
  authorizationUrl,
  missingScopes,
  PartialGrantError,
  redeemCode,
  SCOPES,
  GrantNotRevokedError,
} from "./oauth";

/**
 * Authorization at Google, through the one way in: `redeemCode`. The exchange
 * and the profile read hold tokens and are module-private, so they are tested
 * as the rest of the app reaches them.
 */

const SENTINEL = "SENTINEL-must-not-appear";
const client = {
  clientId: "client-id",
  clientSecret: `secret-${SENTINEL}`,
  redirectUri: "http://localhost:3000/api/connect/callback",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A stand-in for Google: one answer per endpoint, and a record of every call. */
const google = (answers: {
  token?: () => Response;
  profile?: () => Response;
  revoke?: () => Response;
}) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes("/token"))
      return (
        answers.token ??
        (() =>
          json({
            refresh_token: `1//${SENTINEL}`,
            access_token: "ya29.a",
            scope: SCOPES.join(" "),
          }))
      )();
    if (u.includes("/profile"))
      return (
        answers.profile ?? (() => json({ emailAddress: "Tim@Example.test" }))
      )();
    if (u.includes("/revoke"))
      return (answers.revoke ?? (() => new Response("", { status: 200 })))();
    throw new Error("unexpected url");
  }) as typeof fetch;
  return {
    fn,
    calls,
    to: (part: string) => calls.filter((c) => c.url.includes(part)),
  };
};

/** Everything an error could carry out of the process: message, name, fields, serialisation. */
const everything = (e: unknown) =>
  e instanceof Error
    ? `${e.message} ${e.name} ${e.stack ?? ""} ${JSON.stringify(e)} ${JSON.stringify(Object.entries(e))}`
    : String(e);

const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

describe("the consent request (DD1 §3.1)", () => {
  const params = new URL(authorizationUrl(client, "the-state", "the-challenge"))
    .searchParams;

  it("asks for exactly D2's scopes, and nothing that identifies the person", () => {
    expect(params.get("scope")!.split(" ")).toEqual([...SCOPES]);
    expect(SCOPES).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.labels",
      "https://www.googleapis.com/auth/gmail.settings.basic",
    ]);
    expect(params.get("scope")).not.toMatch(/openid|email|profile/);
  });

  it("asks for a refresh token, and for one again on a reconnect", () => {
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
  });

  it("binds the request with state and an S256 PKCE challenge", () => {
    expect(params.get("state")).toBe("the-state");
    expect(params.get("code_challenge")).toBe("the-challenge");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("redirect_uri")).toBe(client.redirectUri);
  });

  it("never sends the client secret in the browser's URL", () => {
    expect(authorizationUrl(client, "s", "c")).not.toContain("secret");
  });
});

describe("redeeming, as the rest of the app sees it (DD1 §11)", () => {
  it("sends the code with its verifier, and names the mailbox, lowercased", async () => {
    const g = google({});
    const redeemed = await redeemCode(client, "the-code", "the-verifier", g.fn);
    expect(redeemed.address).toBe("tim@example.test");
    const body = new URLSearchParams(String(g.to("/token")[0]!.init!.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBe("the-verifier");
    expect(
      new Headers(g.to("/profile")[0]!.init!.headers).get("authorization"),
    ).toBe("Bearer ya29.a");
  });

  it("gives back the address and ways to seal or discard, and no token", async () => {
    const redeemed = await redeemCode(client, "c", "v", google({}).fn);
    expect(Object.keys(redeemed).sort()).toEqual([
      "address",
      "discard",
      "sealInto",
    ]);
    expect(JSON.stringify(redeemed)).not.toContain(SENTINEL);
  });

  it("seals the refresh token into the vault it is given, and only there", async () => {
    const redeemed = await redeemCode(client, "c", "v", google({}).fn);
    const sealed: string[] = [];
    await redeemed.sealInto(
      { seal: async (_sql: null, _ref, token) => void sealed.push(token) },
      null,
      { userId: "u", accountId: "a" },
    );
    expect(sealed).toEqual([`1//${SENTINEL}`]);
  });

  it("revokes the token at Google when asked to discard it", async () => {
    const g = google({});
    const redeemed = await redeemCode(client, "c", "v", g.fn);
    expect(await redeemed.discard()).toBe(true);
    expect(
      new URLSearchParams(String(g.to("/revoke")[0]!.init!.body)).get("token"),
    ).toBe(`1//${SENTINEL}`);
  });
});

describe("failures carry the step, the status and Google's code, and nothing else", () => {
  it("a refused exchange", async () => {
    const g = google({
      token: () =>
        json(
          { error: "invalid_grant", error_description: `bad ${SENTINEL}` },
          400,
        ),
    });
    const error = await failure(
      redeemCode(client, `code-${SENTINEL}`, `verifier-${SENTINEL}`, g.fn),
    );
    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error).toMatchObject({
      step: "exchange",
      status: 400,
      providerCode: "invalid_grant",
    });
    expect(everything(error)).not.toContain(SENTINEL);
  });

  it("keeps Google's code only when it looks like one, so a body cannot ride in on it", async () => {
    const error = await failure(
      redeemCode(
        client,
        "c",
        "v",
        google({ token: () => json({ error: `invalid ${SENTINEL}` }, 400) }).fn,
      ),
    );
    expect(error).toMatchObject({ providerCode: null });
    expect(everything(error)).not.toContain(SENTINEL);
  });

  it("a request that never completes, without its URL", async () => {
    const g = google({
      token: () => {
        throw new TypeError(`fetch failed for https://x/?code=${SENTINEL}`);
      },
    });
    const error = await failure(redeemCode(client, "c", "v", g.fn));
    expect(error).toMatchObject({ step: "exchange", status: 0 });
    expect(everything(error)).not.toContain(SENTINEL);
  });

  it.each([
    ["an empty body", () => new Response("", { status: 200 })],
    [
      "a body that is not JSON",
      () => new Response(`<html>${SENTINEL}`, { status: 200 }),
    ],
    ["JSON null", () => json(null)],
  ])("a successful response with %s", async (_name, token) => {
    const error = await failure(
      redeemCode(client, "c", "v", google({ token }).fn),
    );
    expect(error).toMatchObject({
      step: "exchange",
      providerCode: "malformed_response",
    });
    expect(everything(error)).not.toContain(SENTINEL);
  });

  it("a response without a refresh token, rather than connect something that lapses", async () => {
    const error = await failure(
      redeemCode(
        client,
        "c",
        "v",
        google({ token: () => json({ access_token: "a" }) }).fn,
      ),
    );
    expect(error).toMatchObject({ providerCode: "no_refresh_token" });
  });
});

describe("a token minted and not kept is revoked", () => {
  it("revokes it when the profile read fails, and reports the profile failure", async () => {
    const g = google({ profile: () => json({ error: "backend_error" }, 503) });
    const error = await failure(redeemCode(client, "c", "v", g.fn));
    expect(error).toMatchObject({ step: "profile", status: 503 });
    expect(g.to("/revoke")).toHaveLength(1);
  });

  it("says the grant is still live when Google does not confirm the revocation (#615)", async () => {
    for (const revoke of [
      () => json({ error: "invalid_token" }, 400),
      () => {
        throw new Error("revoke unreachable");
      },
    ]) {
      const g = google({ profile: () => json({}), revoke });
      const error = await failure(redeemCode(client, "c", "v", g.fn));
      expect(error).toBeInstanceOf(GrantNotRevokedError);
      // A code, and nothing of the grant or of the failure before it.
      expect((error as GrantNotRevokedError).code).toBe(
        "connect_grant_not_revoked",
      );
      // The class of what failed first, for the operator, and nothing more.
      expect((error as GrantNotRevokedError).first).toBe("AuthorizationError");
      expect(String((error as Error).message)).not.toMatch(/token|code=/);
      expect(g.to("/revoke")).toHaveLength(1);
    }
  });

  it("revokes nothing when the exchange itself failed, since nothing was minted", async () => {
    const g = google({ token: () => json({ error: "invalid_grant" }, 400) });
    await failure(redeemCode(client, "c", "v", g.fn));
    expect(g.to("/revoke")).toHaveLength(0);
  });
});

describe("a grant short of D2's scopes connects nothing (#598)", () => {
  const granting = (scope: string | undefined) =>
    google({
      token: () =>
        json({
          refresh_token: `1//${SENTINEL}`,
          access_token: "ya29.a",
          scope,
        }),
    });

  for (const left of SCOPES)
    it(`refuses a grant without ${left.split("/").pop()}, revokes it, and reads nothing with it`, async () => {
      const g = granting(SCOPES.filter((s) => s !== left).join(" "));
      const error = await failure(redeemCode(client, "c", "v", g.fn));
      expect(error).toBeInstanceOf(PartialGrantError);
      expect((error as PartialGrantError).missing).toEqual([left]);
      expect((error as PartialGrantError).revoked).toBe(true);
      expect(g.to("/profile")).toHaveLength(0);
      expect(g.to("/revoke")).toHaveLength(1);
      expect(String(g.to("/revoke")[0]!.init!.body)).toContain(SENTINEL);
      expect(everything(error)).not.toContain(SENTINEL);
    });

  it("says when Google did not confirm the revocation, rather than claim it (review of #614)", async () => {
    const g = google({
      token: () =>
        json({
          refresh_token: `1//${SENTINEL}`,
          access_token: "ya29.a",
          scope: SCOPES[0],
        }),
      revoke: () => json({ error: "invalid_token" }, 400),
    });
    const error = await failure(redeemCode(client, "c", "v", g.fn));
    expect(error).toBeInstanceOf(PartialGrantError);
    expect((error as PartialGrantError).revoked).toBe(false);
    expect(everything(error)).not.toContain(SENTINEL);
  });

  it("treats a response that names no scopes as granting none of them", async () => {
    const g = granting(undefined);
    const error = await failure(redeemCode(client, "c", "v", g.fn));
    expect((error as PartialGrantError).missing).toEqual([...SCOPES]);
    expect(g.to("/revoke")).toHaveLength(1);
  });

  it("accepts the whole grant in any order, with any whitespace between", () => {
    expect(missingScopes(`  ${[...SCOPES].reverse().join("\t")} `)).toEqual([]);
  });

  it("matches a scope exactly, never by a prefix or another's case", () => {
    expect(missingScopes(SCOPES.map((s) => s.toUpperCase()).join(" "))).toEqual(
      [...SCOPES],
    );
    expect(missingScopes(SCOPES.map((s) => `${s}.extra`).join(" "))).toEqual([
      ...SCOPES,
    ]);
  });
});
