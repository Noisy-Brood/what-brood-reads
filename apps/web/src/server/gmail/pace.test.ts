import { describe, expect, it } from "vitest";
import { createPacer, READS_PER_MINUTE, type Clock } from "./pace";

/**
 * The read pacer (#381), on a fake clock: reads for one account are spaced,
 * other accounts are not held by it, a read after a quiet interval goes at once,
 * and calls that arrive together queue rather than wake together.
 */

const fakeClock = () => {
  let t = 1_000_000;
  const slept: number[] = [];
  const clock: Clock = {
    now: () => t,
    async sleep(ms) {
      slept.push(ms);
      t += ms;
    },
  };
  return { clock, slept, advance: (ms: number) => (t += ms) };
};

describe("the read pacer", () => {
  it("keeps the rate under Gmail's 300 reads a user a minute", () => {
    // 6,000 units a minute at 20 a read (the quota reference).
    expect(READS_PER_MINUTE).toBeLessThan(6_000 / 20);
  });

  it("lets the first read go at once, and spaces the next for the same account", async () => {
    const { clock, slept } = fakeClock();
    const pacer = createPacer(60, clock);
    await pacer.wait("a");
    await pacer.wait("a");
    expect(slept).toEqual([1_000]);
  });

  it("does not hold one account's read behind another's", async () => {
    const { clock, slept } = fakeClock();
    const pacer = createPacer(60, clock);
    await pacer.wait("a");
    await pacer.wait("b");
    expect(slept).toEqual([]);
  });

  it("lets a read go at once after a quiet interval", async () => {
    const { clock, slept, advance } = fakeClock();
    const pacer = createPacer(60, clock);
    await pacer.wait("a");
    advance(5_000);
    await pacer.wait("a");
    expect(slept).toEqual([]);
  });

  it("queues reads that arrive together, rather than waking them together", async () => {
    const t = 0;
    const slept: number[] = [];
    // A clock whose sleeps do not move time, as when calls are made together.
    const pacer = createPacer(60, {
      now: () => t,
      async sleep(ms) {
        slept.push(ms);
      },
    });
    await Promise.all([pacer.wait("a"), pacer.wait("a"), pacer.wait("a")]);
    expect(slept).toEqual([1_000, 2_000]);
  });
});
