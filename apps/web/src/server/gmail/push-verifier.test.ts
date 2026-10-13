import { describe, expect, it, vi } from "vitest";

/**
 * One verifier for the process (#452): Google's signing certificates are
 * cached on the client that fetched them, so a client per push fetched them
 * on every push. Google's client is a stand-in that counts how many are made
 * and how often certificates are asked for.
 */

const made = vi.hoisted(() => ({ clients: 0, certs: 0 }));

vi.mock("@googleapis/gmail", async (actual) => {
  const real = await actual<typeof import("@googleapis/gmail")>();
  class OAuth2 {
    constructor() {
      made.clients++;
    }
    async getFederatedSignonCertsAsync() {
      made.certs++;
      return { certs: {} };
    }
    async verifySignedJwtWithCertsAsync() {
      throw new Error("not a real token");
    }
  }
  return { ...real, auth: { ...real.auth, OAuth2 } };
});

const { verifyPush } = await import("./push");

const config = {
  audience: "https://app.example.test/api/push/gmail",
  serviceAccount: "push@example.iam.gserviceaccount.com",
};

describe("verifying pushes", () => {
  it("makes one Google client for the process, not one a push", async () => {
    const before = made.clients;
    for (let i = 0; i < 3; i++)
      await verifyPush("Bearer a.b.c", async () => ({}), config).catch(
        () => {},
      );
    expect(made.certs).toBe(3);
    expect(made.clients - before).toBe(0);
  });
});
