import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PushRejectedError, verifyPush, type SigningKeys } from "./push";

/**
 * A push is verified before anything is read from it (DD1 §4.5). Tokens here are
 * real RS256 JWTs, signed by a key made for the test and presented as Google's,
 * so what is exercised is the library's signature check and ours around it.
 */

const SENTINEL = "SENTINEL-must-not-appear";
const config = {
  audience: "https://app.example.test/api/push/gmail",
  serviceAccount: "gmail-push@example-project.iam.gserviceaccount.com",
};

const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const google = pair();
const stranger = pair();
const KID = "google-key-1";
const keys: SigningKeys = {
  [KID]: google.publicKey.export({ type: "spki", format: "pem" }).toString(),
};
const deps = { keys: async () => keys };

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const now = () => Math.floor(Date.now() / 1000);

/** The claims Pub/Sub's token carries, with any overridden. */
const claimsOf = (claims: Record<string, unknown> = {}) =>
  b64({
    iss: "https://accounts.google.com",
    aud: config.audience,
    email: config.serviceAccount,
    email_verified: true,
    iat: now() - 10,
    exp: now() + 3000,
    sub: "1234567890",
    ...claims,
  });

/** A token as Pub/Sub signs one, with any claim, or the header, overridden. */
const token = (
  claims: Record<string, unknown> = {},
  key = google.privateKey,
  header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: KID },
) => {
  const signed = `${b64(header)}.${claimsOf(claims)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signed);
  return `${signed}.${signer.sign(key).toString("base64url")}`;
};

/** Gmail's notice as Pub/Sub wraps it. */
const push = (
  notice: unknown = {
    emailAddress: "Tim@Example.test",
    historyId: "9876",
  },
) => ({
  message: {
    data: Buffer.from(JSON.stringify(notice)).toString("base64"),
    messageId: "1",
  },
  subscription: "projects/example-project/subscriptions/gmail-push",
});

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

const everything = (e: unknown) =>
  e instanceof Error
    ? `${e.message} ${e.name} ${e.stack ?? ""} ${JSON.stringify(e)}`
    : String(e);

describe("a push that proves it came from the subscription", () => {
  it("is accepted, and says which mailbox, lowercased, and nothing else", async () => {
    const verified = await verifyPush(
      `Bearer ${token()}`,
      async () => push(),
      config,
      deps,
    );
    expect(verified).toEqual({ address: "tim@example.test" });
  });
});

describe("what is refused before the body is read", () => {
  it.each([
    ["no header", null],
    ["no bearer", `Basic ${token()}`],
    ["an empty bearer", "Bearer "],
  ])("%s", async (_name, header) => {
    const error = await refusal(
      verifyPush(header, async () => push(), config, deps),
    );
    expect(error).toBeInstanceOf(PushRejectedError);
    expect(error).toMatchObject({ reason: "no_token" });
  });

  it.each([
    ["signed by anyone but Google", () => token({}, stranger.privateKey)],
    ["for another audience", () => token({ aud: "https://elsewhere.test" })],
    ["from another issuer", () => token({ iss: "https://evil.test" })],
    ["expired", () => token({ iat: now() - 7200, exp: now() - 3600 })],
    [
      "from another service account",
      () => token({ email: "someone@else.iam.gserviceaccount.com" }),
    ],
    ["with the address unverified", () => token({ email_verified: false })],
    ["not a token at all", () => `${SENTINEL}.${SENTINEL}.${SENTINEL}`],
  ])("a token %s", async (_name, make) => {
    const error = await refusal(
      verifyPush(`Bearer ${make()}`, async () => push(), config, deps),
    );
    expect(error).toBeInstanceOf(PushRejectedError);
    expect(error).toMatchObject({ reason: "invalid_token" });
  });

  // Every claim below is one the subscription's own token carries, so the
  // signature is the only thing that can refuse these. A verifier that decoded
  // the claims and checked them without the signature accepts every one: that
  // is the bug in the write-up that prompted #292, and it is refused here today
  // because of how the library picks a key and an algorithm, which is a detail
  // an upgrade could change.
  it.each([
    [
      "unsigned, alg none, naming Google's key",
      () => `${b64({ alg: "none", typ: "JWT", kid: KID })}.${claimsOf()}.`,
    ],
    [
      "unsigned, alg none, naming no key",
      () => `${b64({ alg: "none", typ: "JWT" })}.${claimsOf()}.`,
    ],
    [
      "HMAC-signed with Google's public key as the secret",
      () => {
        const signed = `${b64({ alg: "HS256", typ: "JWT", kid: KID })}.${claimsOf()}`;
        const mac = createHmac("sha256", keys[KID]!).update(signed);
        return `${signed}.${mac.digest("base64url")}`;
      },
    ],
    [
      "naming a key Google does not publish",
      () =>
        token({}, google.privateKey, {
          alg: "RS256",
          typ: "JWT",
          kid: "not-googles",
        }),
    ],
    [
      "naming an inherited property as its key",
      () =>
        token({}, google.privateKey, {
          alg: "RS256",
          typ: "JWT",
          kid: "__proto__",
        }),
    ],
    [
      "whose claims were changed after Google signed it",
      () => {
        const [header, , signature] = token().split(".");
        return `${header}.${claimsOf({ sub: "someone-else" })}.${signature}`;
      },
    ],
  ])("a token %s", async (_name, make) => {
    const error = await refusal(
      verifyPush(`Bearer ${make()}`, async () => push(), config, deps),
    );
    expect(error).toBeInstanceOf(PushRejectedError);
    expect(error).toMatchObject({ reason: "invalid_token" });
  });

  it("carries nothing of the token or its claims in the refusal", async () => {
    const error = await refusal(
      verifyPush(
        `Bearer ${token({ aud: SENTINEL, sub: SENTINEL })}`,
        async () => push(),
        config,
        deps,
      ),
    );
    expect(everything(error)).not.toContain(SENTINEL);
  });

  it("does not read the body of a push it refused, whatever it sends", async () => {
    let read = false;
    await refusal(
      verifyPush(
        `Bearer ${token({ aud: "x" })}`,
        async () => {
          read = true;
          return push();
        },
        config,
        deps,
      ),
    );
    expect(read).toBe(false);
  });
});

describe("a verified push that is not a notice", () => {
  it.each([
    ["no body", null],
    ["a body that is not JSON", new SyntaxError("Unexpected token")],
    ["no message", { subscription: "s" }],
    ["data that is not base64 JSON", { message: { data: "%%%" } }],
    ["a notice with no address", push({ historyId: "1" })],
    ["an address that is not one", push({ emailAddress: "nobody" })],
  ])("%s is malformed", async (_name, body) => {
    const error = await refusal(
      verifyPush(
        `Bearer ${token()}`,
        async () => {
          if (body instanceof Error) throw body;
          return body;
        },
        config,
        deps,
      ),
    );
    expect(error).toMatchObject({ reason: "malformed" });
  });
});
