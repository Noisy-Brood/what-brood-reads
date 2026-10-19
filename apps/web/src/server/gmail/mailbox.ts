import { auth } from "@googleapis/gmail";
import type postgres from "postgres";
import { TokenRevokedError, type AccountRef, type ReadReason } from "../tokens";
import { createTokenOpener, type TokenOpener } from "../tokens/open";
import type { RefreshToken } from "../tokens/secret";
import { readPacer, type Pacer } from "./pace";
import { createClient, type ProviderClient } from "./client";
import { colourOf, GMAIL_COLOURS } from "./colours";
import type { OAuthClient } from "./oauth";
import { listChanges, listEventIds, readEvent } from "./observe";
import { readUnsubscribe } from "./unsubscribe";
import {
  AuthorizationError,
  revokeToken,
  sendJson,
  TOKEN,
  type Fetch,
} from "./request";
import {
  broodRuleOf,
  heldAsSent,
  HOME_PARENT,
  homeAtProvider,
  quietedHomeAtProvider,
  adoptableOf,
  describeOwnRules,
  ownRuleOf,
  type ProviderRule,
  renderRule,
  searchFor,
  UnrenderableRuleError,
} from "./rules";
import {
  type Capabilities,
  DraftNotAnEventError,
  type HomeParent,
  type Mailbox,
  MissingArrivalTimeError,
  type ProviderFailure,
  ProviderRequestError,
  type RecordedRule,
  type RuleIdentity,
  RuleNotFoundError,
  type RuleScope,
} from "../channel";

/**
 * Gmail's implementation of the channel port's `Mailbox` (`../channel`).
 *
 * `openMailbox` takes an account, opens its sealed refresh token, trades it for
 * an access token, and closes over a provider client built from that. The
 * refresh token is used for one request and dropped. The access token lives in
 * the client, and the client lives in this closure. What comes back is
 * functions over it, and nothing that holds a credential.
 *
 * Its imports from the rest of the app are the port it implements
 * (`../channel`), published beside it (D10 §7), and the token opener, with the
 * type it returns, `RefreshToken`, which prints `[redacted]` and gives its value
 * only to `reveal()`, called here where the token is sent (#369). D10 §7 counts
 * the encryption helpers as a dependency the chokepoint names rather than
 * contains, and `scripts/verify_token_access.mjs` permits this directory to
 * import it.
 *
 * **An access token lasts about an hour and is not refreshed here.** A mailbox is
 * opened for one unit of work, a backfill step, say, and a new one is opened for
 * the next. A long-lived handle would need to refresh, and refreshing would need
 * the refresh token kept in memory for as long as the handle lives.
 */

/** The most homes a size read counts, one request each. */
export const MAX_HOMES_COUNTED = 100;

/** A day as Gmail's search help writes one: YYYY/MM/DD. */
export const gmailDate = (ms: number) =>
  new Date(ms).toISOString().slice(0, 10).replace(/-/g, "/");

/** More halvings than any search from the floor to now needs. */
const MAX_STEPS = 64;

/** As far back as the search for the oldest mail looks: mail imported into Gmail keeps its own date. */
const OLDEST_FLOOR = Date.UTC(1980, 0, 1);
// Its own day, not server/days': this module is published as it stands, and
// imports nothing from the rest of the app (D10 §7, #451).
const DAY_MS = 86_400_000;

/**
 * The day the oldest mail in the mailbox arrived, found by halving: is there
 * any mail before this day? Each question lists one id and reads nothing,
 * with the `before:` operator in the form Gmail's search help documents,
 * `before:YYYY/MM/DD` (support.google.com/mail/answer/7190), since a day is
 * all this needs. About fifteen questions from 1980 to now. Mail before the
 * floor is answered as the floor.
 */
export async function oldestMail(
  any: (beforeMs: number) => Promise<boolean>,
  now: number,
): Promise<Date | null> {
  let lo = OLDEST_FLOOR;
  // `before:` takes a day and leaves that day out, so the search runs to
  // tomorrow: mail that arrived today counts (review of #596).
  let hi = now + DAY_MS;
  if (!(await any(hi))) return null;
  if (await any(lo)) return new Date(lo);
  // No mail before lo, some before hi: the oldest arrived in [lo, hi).
  // About fifteen steps from 1980; a search still going after many more has
  // stopped narrowing, and fails rather than hold its pass forever.
  for (let step = 0; hi - lo > DAY_MS; step += 1) {
    if (step >= MAX_STEPS)
      throw new Error("the search for the oldest mail did not end");
    // At least a day past lo, so each question narrows the range: with less
    // than two days between them, half rounds down to nothing and the
    // search would never end.
    const mid = lo + Math.max(1, Math.floor((hi - lo) / 2 / DAY_MS)) * DAY_MS;
    if (await any(mid)) hi = mid;
    else lo = mid;
  }
  return new Date(lo);
}

/** The user's labels by name, which is how a home is found (DD1 §8). */
async function homesByName(
  provider: ProviderClient,
): Promise<Map<string, string>> {
  const { data } = await provider.users.labels.list({ userId: "me" });
  return new Map(
    (data.labels ?? [])
      .filter((l) => l.type === "user" && l.id && l.name)
      .map((l) => [l.name!, l.id!]),
  );
}

/**
 * The name each parent Brood makes has in Gmail (#1124): `brood`, and
 * `brood/ext`, which `homeAtProvider` makes for the homes on `external/`.
 * Read from the functions that name the homes, so the two cannot disagree.
 */
const PARENTS_AT_PROVIDER: readonly (readonly [HomeParent, string])[] = [
  ["root", HOME_PARENT],
  ["external", homeAtProvider("external")],
];

/**
 * The id of the label `name`, each part of it found or made, parent first, so
 * no step depends on how Gmail treats a missing parent. `byName` is kept up to
 * date with what is made.
 */
async function makeHome(
  provider: ProviderClient,
  byName: Map<string, string>,
  name: string,
): Promise<string> {
  const parts = name.split("/");
  let id = "";
  for (let i = 1; i <= parts.length; i++) {
    const part = parts.slice(0, i).join("/");
    const found = byName.get(part);
    if (found) {
      id = found;
      continue;
    }
    const { data: made } = await provider.users.labels.create({
      userId: "me",
      requestBody: {
        name: part,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    if (!made.id) throw new Error("no id");
    byName.set(part, made.id);
    id = made.id;
  }
  return id;
}

/**
 * The search for a window. `after:` takes epoch seconds and works on Google's
 * internal clock, so it agrees with `internalDate` (DD1 §5.1). `-in:drafts`
 * because a draft reached nobody and is not an event (DD1 §2.3): leaving drafts
 * out of the listing saves the read, and the derivation refuses any that arrive
 * another way. `before:` takes epoch seconds as well (Google's filtering guide,
 * read 2026-10-04), which says nothing of whether either bound includes the
 * second it names, so a caller bounding both overlaps them.
 */
export const windowQuery = (since: Date, before?: Date, sent = false): string =>
  `${sent ? "in:sent " : ""}after:${Math.floor(since.getTime() / 1000)}${
    before ? ` before:${Math.floor(before.getTime() / 1000)}` : ""
  } -in:drafts`;

export interface MailboxDeps {
  opener?: TokenOpener;
  fetchFn?: Fetch;
  /**
   * Why the token is read, for its audit record. Said by every caller, never
   * assumed (#451): a route that copied its neighbour would otherwise record
   * every token it opened as sync.
   */
  reason: ReadReason;
  /** What spaces message reads, per account (#381). The process's own unless given. */
  pacer?: Pacer;
}

/**
 * Gmail's rate limits, which it may send as a 403 as well as a 429: its guide
 * gives exponential backoff as the remedy for both
 * (https://developers.google.com/workspace/gmail/api/guides/handle-errors).
 * `dailyLimitExceeded` is not here: a day's quota is not waited out in a pass.
 */
const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

/** Google's reason, when it is a plain code and nothing more. */
const reasonOf = (e: unknown): string | null => {
  const errors = (
    e as { response?: { data?: { error?: { errors?: unknown } } } }
  )?.response?.data?.error?.errors;
  const reason = Array.isArray(errors)
    ? (errors[0] as { reason?: unknown } | undefined)?.reason
    : undefined;
  return typeof reason === "string" && /^[A-Za-z]{1,40}$/.test(reason)
    ? reason
    : null;
};

const statusOf = (e: unknown): number => {
  const candidate =
    (e as { status?: unknown })?.status ??
    (e as { response?: { status?: unknown } })?.response?.status;
  return typeof candidate === "number" ? candidate : 0;
};

/**
 * What a Gmail failure means, in the port's terms (#456). Only this module
 * knows Gmail's statuses, so only it says what each means; the core reads
 * the kind.
 *
 * - A 404 on `changes` is a cursor older than Gmail keeps history for, the
 *   documented state DD1 §4.4 recovers from by a full resync.
 * - A 404 on a request that asks for one thing by its id (`byId`: a message,
 *   a rule's home, a home's colour) is that thing not there: Gmail answers
 *   404 for a resource that does not exist, by its API's general rule. A 404
 *   anywhere else, making or listing, is a failure.
 * - A 400 on a listing that sent a page token (`paged`) is that token
 *   refused: Google does not say how long one lives. Without one it is a
 *   failure.
 * - A 429, or a 403 whose reason is a rate limit, is a limit to wait out:
 *   Gmail's guide gives exponential backoff as the remedy for both.
 */
/** What a request was, where that decides what its failure means. */
export interface RequestShape {
  /** It sent a page token. */
  paged?: boolean;
  /** It asked for one thing by its id. */
  byId?: boolean;
}

export function failureOf(
  operation: ProviderRequestError["operation"],
  status: number,
  reason: string | null,
  { paged = false, byId = false }: RequestShape = {},
): ProviderFailure {
  if (status === 404) {
    if (operation === "changes") return "cursor_expired";
    if (byId) return "gone";
  }
  if (status === 400 && paged) return "page_refused";
  if (
    status === 429 ||
    (status === 403 && reason !== null && RATE_LIMIT_REASONS.has(reason))
  )
    return "rate_limited";
  return "failed";
}

/**
 * Run one request, and let nothing of the library's error out but its status,
 * Google's reason code and what they mean. `shape` says what the request was,
 * which `failureOf` needs to read a 404 or a 400.
 */
async function guard<T>(
  operation: ProviderRequestError["operation"],
  run: () => Promise<T>,
  shape: RequestShape = {},
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    // The derivation's own refusals carry a provider id and nothing else, and
    // the caller decides what they mean.
    if (
      e instanceof DraftNotAnEventError ||
      e instanceof MissingArrivalTimeError ||
      e instanceof RuleNotFoundError ||
      // Already one, made with a code of Brood's own: wrapped again, its
      // code would be lost (#659).
      e instanceof ProviderRequestError
    )
      throw e;
    const status = statusOf(e);
    const reason = reasonOf(e);
    throw new ProviderRequestError(
      operation,
      status,
      reason,
      failureOf(operation, status, reason, shape),
    );
  }
}

/** Trade the refresh token for an access token. `invalid_grant` is a revoked grant (E12 §5). */
async function accessToken(
  client: OAuthClient,
  refreshToken: RefreshToken,
  fetchFn: Fetch,
): Promise<string> {
  let body: Record<string, unknown>;
  try {
    body = await sendJson("refresh", () =>
      fetchFn(TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken.reveal(),
          client_id: client.clientId,
          client_secret: client.clientSecret,
        }).toString(),
      }),
    );
  } catch (e) {
    if (e instanceof AuthorizationError && e.providerCode === "invalid_grant") {
      throw new TokenRevokedError(e.status, "invalid_grant");
    }
    throw e;
  }
  if (typeof body.access_token !== "string") {
    throw new AuthorizationError("refresh", 200, "no_access_token");
  }
  return body.access_token;
}

/**
 * The mailbox over a client that is already authorized. Exported to this
 * directory's tests and not from the index: it takes a client, and nothing
 * outside the chokepoint has one to give it.
 */
/**
 * What Gmail can do, in the port's terms (D14 §4, DD16 §4). Filters run as
 * mail arrives, so they act before delivery (D14 §5); a filter cannot be
 * edited, so a rule is replaced by making the new one and removing the old
 * (DD1 §7.5); a message carries many labels, any of them applied to mail
 * already delivered; and the History API is a delta (DD1 §4.3).
 */
export const GMAIL_CAPABILITIES: Capabilities = Object.freeze({
  installsRules: true,
  rulesActBeforeDelivery: true,
  rulesEditable: false,
  canMove: true,
  canClassifyRetroactively: true,
  supportsMultipleClassifications: true,
  incrementalSync: true,
});

export function mailboxOver(
  provider: ProviderClient,
  /** Awaited before each message read, to keep under the quota (#381). */
  pace: () => Promise<void> = async () => {},
): Mailbox {
  return {
    capabilities: GMAIL_CAPABILITIES,
    // Gmail's change cursor is its `historyId`.
    historyCursor: () =>
      guard("cursor", async () => {
        const { data } = await provider.users.getProfile({ userId: "me" });
        if (typeof data.historyId !== "string" || data.historyId === "") {
          throw new Error("no history id");
        }
        return data.historyId;
      }),
    list: ({ since, before, sent, pageToken, pageSize }) =>
      guard(
        "list",
        () =>
          listEventIds(provider, {
            query: windowQuery(since, before, sent),
            pageToken: pageToken ?? undefined,
            pageSize,
          }),
        { paged: pageToken != null },
      ),
    read: async (id, options) => {
      await pace();
      return guard("read", () => readEvent(provider, id, options), {
        byId: true,
      });
    },
    oneClick: async (id) => {
      await pace();
      return guard("read", () => readUnsubscribe(provider, id), {
        byId: true,
      });
    },
    changes: ({ since, pageToken, pageSize }) =>
      guard("changes", () =>
        listChanges(provider, {
          since,
          pageToken: pageToken ?? undefined,
          pageSize,
        }),
      ),
    watch: (topic) =>
      guard("watch", async () => {
        // Every change, not a label's: an event is any arrival, and the sync
        // asks history for additions alone.
        const { data } = await provider.users.watch({
          userId: "me",
          requestBody: { topicName: topic },
        });
        const expiresAt = Number(data.expiration);
        if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
          throw new Error("no expiration");
        }
        return { expiresAt: new Date(expiresAt) };
      }),
    matching: (scope, options = {}) =>
      guard(
        "matching",
        () =>
          listEventIds(provider, {
            query: searchFor(scope),
            pageToken: options.pageToken ?? undefined,
            pageSize: options.pageSize,
          }),
        { paged: options.pageToken != null },
      ),
    // Parent before child: Gmail's labels reference does not say how it
    // treats a missing parent.
    ensureHome: (path) =>
      guard("home", async () => {
        const byName = await homesByName(provider);
        return makeHome(provider, byName, homeAtProvider(path));
      }),
    showHome: (homeId, path, as) =>
      guard("home", async () => {
        const byName = await homesByName(provider);
        const name = {
          active: homeAtProvider(path),
          quieted: quietedHomeAtProvider(path),
        };
        const to = name[as];
        const from = name[as === "active" ? "quieted" : "active"];
        const current = [...byName].find(([, id]) => id === homeId)?.[0];
        // Already there: an earlier pass renamed it and its record did not follow.
        if (current === to) return "shown";
        // Renamed by the person, or removed: theirs, and not fought (DD1 §8).
        if (current !== from) return "left";
        // Another label has the name already, or this one has homes under it,
        // which a rename of the parent alone would leave behind. Whether Gmail
        // renames children with their parent is not documented, so it is not
        // relied on.
        if (byName.has(to)) return "left";
        if ([...byName.keys()].some((n) => n.startsWith(`${from}/`)))
          return "left";
        await makeHome(provider, byName, to.slice(0, to.lastIndexOf("/")));
        await provider.users.labels.patch({
          userId: "me",
          id: homeId,
          requestBody: { name: to },
        });
        return "shown";
      }),
    homeColour: (homeId) =>
      guard(
        "home",
        async () => {
          // A listing leaves the colour out (`google-2026-gmail-labels-list`).
          const { data } = await provider.users.labels.get({
            userId: "me",
            id: homeId,
            fields: "color",
          });
          return colourOf(data.color ?? null);
        },
        { byId: true },
      ),
    colourHome: (homeId, to) =>
      guard("home", async () => {
        await provider.users.labels.patch({
          userId: "me",
          id: homeId,
          requestBody: { color: GMAIL_COLOURS[to] },
        });
      }),
    parentHomes: () =>
      guard("home", async () => {
        const byName = await homesByName(provider);
        const found = new Map<HomeParent, string>();
        for (const [parent, name] of PARENTS_AT_PROVIDER) {
          const id = byName.get(name);
          if (id) found.set(parent, id);
        }
        return found;
      }),
    installRule: (scope, homeId, identity) =>
      guard("rule", () => createRule(provider, scope, [homeId], identity)),
    replaceRule: (providerRuleId, scope, identity) =>
      guard("rule", async () => {
        let homes: string[];
        try {
          homes = await homesOf(provider, providerRuleId);
        } catch (e) {
          if (statusOf(e) === 404) throw new RuleNotFoundError();
          throw e;
        }
        const made = await createRule(provider, scope, homes, identity);
        try {
          await deleteRule(provider, providerRuleId);
        } catch (e) {
          await deleteRule(provider, made).catch(() => {});
          throw e;
        }
        return made;
      }),
    listRules: (recorded) =>
      guard("rule", async () => {
        const data = await listRuleActions(provider);
        const known = new Set(recorded.map((r) => r.providerRuleId));
        const homes = await broodHomes(provider, recorded);
        const ours = (data.filter ?? []).filter(
          (f) =>
            typeof f.id === "string" &&
            (known.has(f.id) ||
              (f.action?.addLabelIds ?? []).some((l) => homes.has(l))),
        );
        const read = [];
        for (const f of ours) {
          const whole = await ruleById(provider, f.id!);
          if (whole)
            read.push({ providerRuleId: f.id!, rule: broodRuleOf(whole) });
        }
        return read;
      }),
    ownRules: () =>
      guard("rule", async () => {
        const data = await listRuleActions(provider);
        const theirs = await theirLabels(provider);
        return (data.filter ?? []).flatMap((f) => {
          const named = ownRuleOf(f, theirs);
          return named ? [named] : [];
        });
      }),
    ownRulesShown: (recorded) =>
      guard("rule", async () => {
        const data = await listRuleActions(provider);
        const byName = await homesByName(provider);
        const names = new Map([...byName].map(([name, id]) => [id, name]));
        const brood = await broodHomes(provider, recorded);
        const theirs = new Set(
          [...(await theirLabels(provider))].filter((l) => !brood.has(l)),
        );
        return {
          ...describeOwnRules(data.filter ?? [], names, brood, theirs),
          theirHomeNames: [...theirs].flatMap((id) => {
            const name = names.get(id);
            return name === undefined ? [] : [name];
          }),
        };
      }),
    ownRuleWhole: (providerRuleId) =>
      guard("rule", async () => {
        const whole = await ruleById(provider, providerRuleId);
        if (!whole) return null;
        return adoptableOf(whole, await theirLabels(provider));
      }),
    restoreOwnRule: (rule) =>
      guard("rule", async () => {
        const { data } = await provider.users.settings.filters.create({
          userId: "me",
          requestBody: {
            criteria: { from: rule.names.value },
            action: { addLabelIds: [rule.homeId], removeLabelIds: ["INBOX"] },
          },
        });
        if (!data.id) throw new Error("no id for the restored rule");
        return data.id;
      }),
    ruleHome: (providerRuleId) =>
      guard("rule", async () => (await homesOf(provider, providerRuleId))[0]!, {
        byId: true,
      }),
    removeRule: (providerRuleId) =>
      guard("rule", () => deleteRule(provider, providerRuleId)),
    fileExisting: (providerEventIds, homeId) =>
      guard("file", async () => {
        for (let i = 0; i < providerEventIds.length; i += FILE_BATCH) {
          await provider.users.messages.batchModify({
            userId: "me",
            requestBody: {
              ids: providerEventIds.slice(i, i + FILE_BATCH),
              addLabelIds: [homeId],
              removeLabelIds: ["INBOX"],
            },
          });
        }
      }),
    homeHandles: (recorded) =>
      guard("home", async () => {
        const homes = await broodHomes(provider, recorded);
        for (const r of recorded) {
          if (r.homeId !== null) continue;
          const whole = await ruleById(provider, r.providerRuleId);
          for (const l of whole?.action?.addLabelIds ?? [])
            if (l !== "INBOX") homes.add(l);
        }
        return homes;
      }),
    bringIntoView: (providerEventIds) =>
      guard("view", async () => {
        for (let i = 0; i < providerEventIds.length; i += FILE_BATCH) {
          await provider.users.messages.batchModify({
            userId: "me",
            requestBody: {
              ids: providerEventIds.slice(i, i + FILE_BATCH),
              addLabelIds: ["INBOX"],
            },
          });
        }
      }),
    returnFromHome: (providerEventIds, homeIds) =>
      guard("return", async () => {
        // Never INBOX, which this adds, and never none: a return that removed
        // nothing is `bringIntoView`, said by the caller, not assumed here.
        if (homeIds.length === 0 || homeIds.includes("INBOX"))
          throw new UnrenderableRuleError();
        for (let i = 0; i < providerEventIds.length; i += FILE_BATCH) {
          await provider.users.messages.batchModify({
            userId: "me",
            requestBody: {
              ids: providerEventIds.slice(i, i + FILE_BATCH),
              addLabelIds: ["INBOX"],
              removeLabelIds: [...new Set(homeIds)],
            },
          });
        }
      }),
    // Only totals, with Gmail's `fields` parameter. Its reference does not
    // say whether a system label such as the inbox carries counts, so one it
    // does not give is null.
    size: () =>
      guard("size", async () => {
        const count = (n: unknown) =>
          typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
        const { data: profile } = await provider.users.getProfile({
          userId: "me",
          fields: "messagesTotal,threadsTotal",
        });
        const { data: inbox } = await provider.users.labels.get({
          userId: "me",
          id: "INBOX",
          fields: "messagesTotal",
        });
        // Every home under `brood`, at any depth, quieted ones included, one
        // request each. Homes outlive their rules, so a mailbox can gather
        // many; past MAX_HOMES_COUNTED the total is not counted at all, so a
        // pass stays inside its time budget (review of #596).
        const homes = [...(await homesByName(provider))].filter(([name]) =>
          name.startsWith(`${HOME_PARENT}/`),
        );
        let filed: number | null = homes.length > MAX_HOMES_COUNTED ? null : 0;
        for (const [, id] of filed === null ? [] : homes) {
          const { data } = await provider.users.labels.get({
            userId: "me",
            id,
            fields: "messagesTotal",
          });
          const n = count(data.messagesTotal);
          filed = n === null || filed === null ? null : filed + n;
        }
        const oldest = await oldestMail(
          async (beforeMs) =>
            (
              await listEventIds(provider, {
                query: `before:${gmailDate(beforeMs)}`,
                pageSize: 1,
              })
            ).providerEventIds.length > 0,
          Date.now(),
        );
        return {
          messages: count(profile.messagesTotal),
          conversations: count(profile.threadsTotal),
          inbox: count(inbox.messagesTotal),
          filed,
          oldest,
        };
      }),
    // The primary, and every send-as alias Gmail has verified (`accepted`).
    // Workspace aliases are not among them: Gmail does not list them here,
    // and reading them needs an admin-directory scope outside D2, which is
    // not requested (DD1 §2.3).
    addresses: () =>
      guard("addresses", async () => {
        const { data } = await provider.users.settings.sendAs.list({
          userId: "me",
        });
        return [
          ...new Set(
            (data.sendAs ?? [])
              .filter(
                (a) =>
                  typeof a.sendAsEmail === "string" &&
                  (a.isPrimary === true || a.verificationStatus === "accepted"),
              )
              .map((a) => a.sendAsEmail!.trim().toLowerCase()),
          ),
        ];
      }),
  };
}

/** `batchModify` takes at most a thousand ids a request (`google-2026-gmail-batchmodify`). */
export const FILE_BATCH = 1000;

/**
 * Make a filter for `scope` that files into `homes` and out of the inbox. Filing
 * takes two changes, not one: a home alone would leave the mail where it was
 * (DD1 §8).
 */
async function createRule(
  provider: ProviderClient,
  scope: RuleScope,
  homes: string[],
  identity: RuleIdentity,
): Promise<string> {
  const { query, negatedQuery } = renderRule(scope, identity);
  const { data } = await provider.users.settings.filters.create({
    userId: "me",
    requestBody: {
      criteria: { query, ...(negatedQuery ? { negatedQuery } : {}) },
      action: { addLabelIds: homes, removeLabelIds: ["INBOX"] },
    },
  });
  if (!data.id) throw new Error("no id");
  // Gmail answers with the filter it made (filters.create's reference). One
  // that carves out less than was sent is taken back out and the change
  // fails, so a shortened filter is never left filing what the list keeps
  // (#659, `heldAsSent`).
  if (!heldAsSent({ scope, identity }, data.criteria)) {
    // Tried twice. A filter that still will not go carries this rule's tag.
    // Made to replace a rule, it sits beside the recorded filter, and the
    // rules sweep removes it as a replacement whose cleanup failed; made for a
    // rule not yet recorded, the sweep reports it and leaves it, as it does any
    // tag nothing records. The error says it was left.
    try {
      await deleteRule(provider, data.id);
    } catch {
      try {
        await deleteRule(provider, data.id);
      } catch {
        throw new ProviderRequestError("rule", 0, "shortFilterLeft");
      }
    }
    throw new ProviderRequestError("rule", 0, "notHeldAsSent");
  }
  return data.id;
}

/** The homes a filter files into: what it adds, less the inbox. Never none. */
async function homesOf(
  provider: ProviderClient,
  providerRuleId: string,
): Promise<string[]> {
  const { data } = await provider.users.settings.filters.get({
    userId: "me",
    id: providerRuleId,
  });
  const homes = (data.action?.addLabelIds ?? []).filter((l) => l !== "INBOX");
  if (homes.length === 0) throw new Error("no home");
  return homes;
}

/**
 * Every rule's id, action and the sender its `from` names, and nothing else it
 * matches: the person's own rules are text they wrote and may hold words from
 * their mail (D21, #1106, #1107). Gmail answers only the fields named
 * (`google-2026-gmail-partial-response`); scripts/verify_gmail_reads holds
 * the mask.
 */
async function listRuleActions(provider: ProviderClient) {
  const { data } = await provider.users.settings.filters.list({
    userId: "me",
    fields: "filter(id,criteria/from,action)",
  });
  return data;
}

/** The person's own labels: every user label not under Brood's parent. */
async function theirLabels(provider: ProviderClient): Promise<Set<string>> {
  return new Set(
    [...(await homesByName(provider))]
      .filter(([name]) => !name.startsWith(`${HOME_PARENT}/`))
      .map(([, id]) => id),
  );
}

/** Every label under Brood's parent, and each recorded rule's home. */
async function broodHomes(
  provider: ProviderClient,
  recorded: readonly RecordedRule[],
): Promise<Set<string>> {
  const within = `${HOME_PARENT}/`;
  const named = [...(await homesByName(provider))]
    .filter(([name]) => name.startsWith(within))
    .map(([, id]) => id);
  return new Set([
    ...named,
    ...recorded.flatMap((r) => (r.homeId === null ? [] : [r.homeId])),
  ]);
}

/** A rule read whole by its id, or null where it is gone. */
async function ruleById(
  provider: ProviderClient,
  providerRuleId: string,
): Promise<ProviderRule | null> {
  try {
    const { data } = await provider.users.settings.filters.get({
      userId: "me",
      id: providerRuleId,
    });
    return data;
  } catch (e) {
    if (statusOf(e) !== 404) throw e;
    return null;
  }
}

/** Delete a filter; one already gone is what was wanted. */
async function deleteRule(
  provider: ProviderClient,
  providerRuleId: string,
): Promise<void> {
  try {
    await provider.users.settings.filters.delete({
      userId: "me",
      id: providerRuleId,
    });
  } catch (e) {
    if (statusOf(e) !== 404) throw e;
  }
}

/**
 * Open the account's mailbox for sync. The token read is recorded as `sync`
 * by the opener, and fails closed with it.
 */
export async function openMailbox(
  sql: postgres.Sql | postgres.TransactionSql,
  ref: AccountRef,
  client: OAuthClient,
  deps: MailboxDeps,
): Promise<Mailbox> {
  const opener = deps.opener ?? createTokenOpener();
  const fetchFn = deps.fetchFn ?? fetch;
  const token = await accessToken(
    client,
    await opener.open(sql, ref, deps.reason),
    fetchFn,
  );
  const credentials = new auth.OAuth2();
  credentials.setCredentials({ access_token: token });
  const pacer = deps.pacer ?? readPacer;
  return mailboxOver(createClient(credentials), () =>
    pacer.wait(ref.accountId),
  );
}

/**
 * Use the account's refresh token, and nothing else (#801, D4 §3): trade it
 * for an access token and drop that. Google expires a refresh token unused
 * for six months (`google-2026-oauth2-refresh-expiry`, E12 §6), so a stopped
 * mailbox's is used well inside that. An OAuth call, so no Gmail request and
 * no Gmail quota. Read for `keepalive`. A revoked grant is `TokenRevokedError`, as
 * anywhere else.
 */
export async function keepGrant(
  sql: postgres.Sql | postgres.TransactionSql,
  ref: AccountRef,
  client: OAuthClient,
  deps: Omit<MailboxDeps, "reason"> = {},
): Promise<void> {
  const opener = deps.opener ?? createTokenOpener();
  await accessToken(
    client,
    await opener.open(sql, ref, "keepalive"),
    deps.fetchFn ?? fetch,
  );
}

/**
 * Google did not confirm a revocation: its HTTP status, or 0 when the request never
 * completed. Nothing else, since the request held the refresh token.
 */
export class RevocationError extends Error {
  constructor(readonly status: number) {
    super(`revocation not confirmed: ${status}`);
    this.name = "RevocationError";
  }
}

/** How the grant ended: revoked now, or found already dead, by Google's own answer. */
export type Revocation = "revoked" | "already_revoked";

/**
 * End Brood's grant to the account's mailbox (DD14 §4, #223). The half of a
 * disconnect that happens at Google, and the only half that can be checked: once
 * Google has revoked the grant, the token is dead wherever a copy sits.
 *
 * 1. The refresh token is opened, audited as `revoke`, and traded for an access
 *    token. **If Google says the grant is already dead** (`invalid_grant`: revoked,
 *    expired, or a password change, E12 §5), there is nothing left to revoke, and
 *    that is the answer.
 * 2. **The watch is stopped** while the grant still allows it, so Gmail stops
 *    pushing notices for a mailbox Brood no longer reads. Best effort: a push that
 *    arrives after is a hint about an account that syncs nothing, and a failure to
 *    stop is not a reason to keep a grant alive.
 * 3. **The refresh token is revoked.** Only Google's 200 counts; anything else is a
 *    `RevocationError`, and the caller must not erase its copy, since the key must
 *    not go before the token that needs revoking has been revoked.
 *
 * One `fetchFn` carries all three requests, the watch's included, so a test sees
 * them in order. `sql` may be a transaction: a disconnect reads the token inside
 * the one that holds the account, so the grant revoked is the grant it saw.
 */
export async function revokeMailbox(
  sql: postgres.Sql | postgres.TransactionSql,
  ref: AccountRef,
  client: OAuthClient,
  /** Read for `revoke`, always: no reason is taken. */
  deps: Omit<MailboxDeps, "reason"> = {},
): Promise<Revocation> {
  const opener = deps.opener ?? createTokenOpener();
  const fetchFn = deps.fetchFn ?? fetch;
  const refreshToken = await opener.open(sql, ref, "revoke");

  let token: string;
  try {
    token = await accessToken(client, refreshToken, fetchFn);
  } catch (e) {
    if (e instanceof TokenRevokedError) return "already_revoked";
    throw e;
  }

  try {
    const credentials = new auth.OAuth2();
    credentials.setCredentials({ access_token: token });
    await createClient(credentials).users.stop(
      { userId: "me" },
      { fetchImplementation: fetchFn },
    );
  } catch {
    // Best effort, as above. Nothing of the library's error is kept: it holds
    // the request, and the request's headers hold the access token.
  }

  const status = await revokeToken(refreshToken.reveal(), fetchFn);
  if (status !== 200) throw new RevocationError(status);
  return "revoked";
}
