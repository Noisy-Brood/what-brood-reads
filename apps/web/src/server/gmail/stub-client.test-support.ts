import type { ProviderClient } from "./client";

type Users = ProviderClient["users"];
type Messages = Users["messages"];
type Labels = Users["labels"];
type Filters = Users["settings"]["filters"];

/*
 * Test support for the chokepoint's own tests, and imported by nothing else:
 * verify_gmail_reads reads a `.test-support.ts` file as a test, and refuses
 * one imported by anything that is not a test.
 */

/** The calls a test gives, each where it sits in the client. */
export interface GivenCalls {
  getProfile?: Users["getProfile"];
  watch?: Users["watch"];
  stop?: Users["stop"];
  history?: Partial<Users["history"]>;
  messages?: Partial<Messages>;
  labels?: Partial<Labels>;
  filters?: Partial<Filters>;
  sendAs?: Partial<Users["settings"]["sendAs"]>;
}

/**
 * A whole provider client for a test, typed as one (#789): the calls the test
 * gives, and every other one refusing, naming itself. Each given call is
 * checked against the client's own signature, so a test's stand-in cannot
 * drift from what the chokepoint calls.
 */
export function stubProviderClient(given: GivenCalls = {}): ProviderClient {
  const refuse = (name: string) => async (): Promise<never> => {
    throw new Error(`this test never calls ${name}`);
  };
  return {
    users: {
      getProfile: given.getProfile ?? refuse("getProfile"),
      watch: given.watch ?? refuse("watch"),
      stop: given.stop ?? refuse("stop"),
      history: { list: refuse("history.list"), ...given.history },
      messages: {
        get: refuse("messages.get"),
        list: refuse("messages.list"),
        batchModify: refuse("messages.batchModify"),
        ...given.messages,
      },
      labels: {
        list: refuse("labels.list"),
        get: refuse("labels.get"),
        create: refuse("labels.create"),
        patch: refuse("labels.patch"),
        ...given.labels,
      },
      settings: {
        filters: {
          list: refuse("settings.filters.list"),
          get: refuse("settings.filters.get"),
          create: refuse("settings.filters.create"),
          delete: refuse("settings.filters.delete"),
          ...given.filters,
        },
        sendAs: {
          list: refuse("settings.sendAs.list"),
          ...given.sendAs,
        },
      },
    },
  };
}
