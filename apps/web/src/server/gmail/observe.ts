import { METADATA_HEADERS } from "./headers";
import { deriveEvent } from "./derive";
import type { ProviderClient } from "./client";
import type {
  ChangeOptions,
  ChangePage,
  ListPage,
  ObservedEvent,
  ReadOptions,
} from "../channel";

/**
 * Observe — the first of the platform's five verbs (D14), and the only one that reads.
 *
 * Every **body-bearing** read here sets `format: "metadata"` explicitly, which
 * is `messages.get` and `threads.get`. `messages.list` returns ids, takes no
 * `format`, and is not what the rule is about. The rule is not
 * "never ask for the whole message"; it is **"always ask for metadata"**, and
 * the difference is the whole of DD1 §2.1: Google's reference does not promise
 * metadata when the parameter is absent, and a privacy guarantee must not rest
 * on a default we neither control nor are promised. Rejecting three bad values
 * while accepting silence was the weaker half of a check that read as complete.
 *
 * There is no format parameter on any function below. A caller *cannot* express
 * the unsafe request, which is a stronger guarantee than a caller choosing not
 * to make it.
 */

export interface ListOptions {
  /**
   * The provider's own search expression, used only to bound a backfill by
   * arrival time — DD1 §5.1's `after:` operator, which works on Google's
   * internal clock and so agrees with `internalDate`.
   */
  query?: string;
  pageToken?: string;
  pageSize?: number;
}

/** One page of event ids. Returns ids only; nothing here reads a message. */
export async function listEventIds(
  client: ProviderClient,
  options: ListOptions = {},
): Promise<ListPage> {
  const { data } = await client.users.messages.list({
    userId: "me",
    q: options.query,
    pageToken: options.pageToken,
    maxResults: options.pageSize,
  });

  return {
    providerEventIds: (data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string"),
    nextPageToken: data.nextPageToken ?? null,
    ...(typeof data.resultSizeEstimate === "number"
      ? { estimate: data.resultSizeEstimate }
      : {}),
  };
}

/**
 * One page of the changes since a cursor (DD1 §4.3): the events added, and how
 * events already there moved (#420). Ids and label handles only, as
 * `listEventIds` returns ids: nothing here reads a message. Label changes are
 * asked for so a person moving filed mail out can be seen.
 */
export async function listChanges(
  client: ProviderClient,
  options: ChangeOptions,
): Promise<ChangePage> {
  const { data } = await client.users.history.list({
    userId: "me",
    startHistoryId: options.since,
    historyTypes: ["messageAdded", "labelAdded", "labelRemoved"],
    pageToken: options.pageToken,
    maxResults: options.pageSize,
  });
  const ids = new Set<string>();
  const moves = new Map<string, { intoView: boolean; outOf: Set<string> }>();
  const moveOf = (id: string) => {
    let m = moves.get(id);
    if (!m) moves.set(id, (m = { intoView: false, outOf: new Set() }));
    return m;
  };
  let through: bigint | null = null;
  // Record by record, in the order the provider lists them: a message's
  // arrival clears whatever was said of it up to and in its own record, which
  // is where it was filed, and a later record moving it is a move (review of
  // #498: a message filed and moved out before the next sync has both on one
  // page).
  for (const change of data.history ?? []) {
    for (const added of change.labelsAdded ?? []) {
      const id = added.message?.id;
      if (typeof id === "string" && added.labelIds?.includes("INBOX")) {
        moveOf(id).intoView = true;
      }
    }
    for (const removed of change.labelsRemoved ?? []) {
      const id = removed.message?.id;
      if (typeof id !== "string") continue;
      for (const label of removed.labelIds ?? []) moveOf(id).outOf.add(label);
    }
    for (const added of change.messagesAdded ?? []) {
      if (typeof added.message?.id !== "string") continue;
      ids.add(added.message.id);
      moves.delete(added.message.id);
    }
    if (typeof change.id === "string" && /^\d+$/.test(change.id)) {
      const id = BigInt(change.id);
      if (through === null || id > through) through = id;
    }
  }
  return {
    providerEventIds: [...ids],
    moved: [...moves]
      .filter(([, m]) => m.intoView || m.outOf.size > 0)
      .map(([providerEventId, m]) => ({
        providerEventId,
        intoView: m.intoView,
        outOf: [...m.outOf],
      })),
    through: through === null ? null : through.toString(),
    nextPageToken: data.nextPageToken ?? null,
    cursor: data.historyId ?? null,
  };
}

/**
 * Read one event's metadata and reduce it to the fields DD1 §2.3 keeps.
 *
 * The raw headers do not leave this function. What the caller receives is
 * derived metadata and nothing else: no subject, no body, no header as sent.
 */
export async function readEvent(
  client: ProviderClient,
  providerEventId: string,
  options: ReadOptions,
): Promise<ObservedEvent> {
  const { data } = await client.users.messages.get({
    format: "metadata",
    metadataHeaders: METADATA_HEADERS,
    // The parts deriveEvent reads, and all Gmail returns: without the mask a
    // message may carry `snippet`, the opening of its body (gmail/index.ts).
    fields: "id,threadId,labelIds,internalDate,payload/headers",
    userId: "me",
    id: providerEventId,
  });

  return deriveEvent(data, options.accountAddresses);
}
