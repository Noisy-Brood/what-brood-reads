/**
 * Spacing Gmail's message reads so a mailbox never outruns its quota (#381).
 *
 * Gmail allows a user 6,000 quota units a minute, and a message read is 20
 * (https://developers.google.com/workspace/gmail/api/reference/quota): 300 reads.
 * Read as fast as Gmail answers, a backfill does 500 to 1,000 a minute, meets
 * the limit, and waits: a minute locally, and in production until the next
 * pass. Spaced under the ceiling instead, it never meets it
 * in the ordinary case, and a pass spends its budget reading.
 *
 * Per account, since the limit is per user. The state lives for the process, so
 * the steps of one run and the passes of one cron invocation share it, and a
 * mailbox opened afresh for each step does not start a fresh allowance. Another
 * process reading the same account at the same moment is the lease's to
 * prevent; a limit met anyway is still waited out (`rateLimited`). That covers
 * one mailbox connected by two Brood users too: each account has its own
 * allowance, so together they can meet the limit, and wait it out. Keying by the
 * mailbox's address instead would need this module to query the database
 * (D10 §7), or a call to Gmail at every open (review of #382).
 */

/** Under the 300 a minute a read costs, with room for the listings between. */
export const READS_PER_MINUTE = 250;

export interface Pacer {
  /** Resolves when a read for this key may go. */
  wait(key: string): Promise<void>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function createPacer(
  perMinute: number,
  clock: Clock = realClock,
): Pacer {
  const interval = 60_000 / perMinute;
  const next = new Map<string, number>();
  return {
    async wait(key) {
      const now = clock.now();
      // Claimed before sleeping, so calls that arrive together queue behind
      // one another rather than all waking at the same moment.
      const at = Math.max(now, next.get(key) ?? now);
      next.set(key, at + interval);
      if (at > now) await clock.sleep(at - now);
    },
  };
}

/** The process's pacer for message reads, shared by every mailbox it opens. */
export const readPacer = createPacer(READS_PER_MINUTE);
