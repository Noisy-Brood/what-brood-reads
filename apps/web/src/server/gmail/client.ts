import { gmail, type gmail_v1 } from "@googleapis/gmail";

/**
 * An authenticated client for one connected account.
 *
 * The credential arrives as an argument and is never constructed here. DD1 §3.2
 * seals refresh tokens with a per-user data key wrapped by a KMS master key, and
 * §11 requires that no plaintext token leaves the chokepoint — so this module
 * *names* the encryption helpers rather than containing them, and the caller
 * hands it an auth client that is already unsealed. D10 §7 wants the same thing
 * for a different reason: this module will be published, and one that reaches
 * into the app's key management cannot be mirrored without dragging it along.
 */
export type ProviderAuth = NonNullable<gmail_v1.Options["auth"]>;

/** One call: its parameters, and an answer of which only the body is read. */
type Call<Params, Data> = (params: Params) => Promise<{ data: Data }>;

/**
 * The provider client, as the calls Brood makes and nothing else (#789).
 * Nothing outside this module should hold one.
 *
 * Google's generated client offers every Gmail method, each with several
 * overloads and an answer carrying the whole HTTP exchange. This names the
 * ones this module calls, so what the chokepoint can reach is listed in one
 * place: a method not here cannot be called without adding it, in review.
 * `createClient` returns Google's client as one, which the compiler checks,
 * and a test hands in a stand-in of exactly this shape.
 */
export interface ProviderClient {
  users: {
    getProfile: Call<
      gmail_v1.Params$Resource$Users$Getprofile,
      gmail_v1.Schema$Profile
    >;
    watch: Call<
      gmail_v1.Params$Resource$Users$Watch,
      gmail_v1.Schema$WatchResponse
    >;
    /** With the fetch it goes through, so revoking never asks the network another way. */
    stop: (
      params: gmail_v1.Params$Resource$Users$Stop,
      options: { fetchImplementation: typeof fetch },
    ) => Promise<{ data: void }>;
    history: {
      list: Call<
        gmail_v1.Params$Resource$Users$History$List,
        gmail_v1.Schema$ListHistoryResponse
      >;
    };
    messages: {
      get: Call<
        gmail_v1.Params$Resource$Users$Messages$Get,
        gmail_v1.Schema$Message
      >;
      list: Call<
        gmail_v1.Params$Resource$Users$Messages$List,
        gmail_v1.Schema$ListMessagesResponse
      >;
      batchModify: Call<
        gmail_v1.Params$Resource$Users$Messages$Batchmodify,
        void
      >;
    };
    labels: {
      list: Call<
        gmail_v1.Params$Resource$Users$Labels$List,
        gmail_v1.Schema$ListLabelsResponse
      >;
      get: Call<
        gmail_v1.Params$Resource$Users$Labels$Get,
        gmail_v1.Schema$Label
      >;
      create: Call<
        gmail_v1.Params$Resource$Users$Labels$Create,
        gmail_v1.Schema$Label
      >;
      patch: Call<
        gmail_v1.Params$Resource$Users$Labels$Patch,
        gmail_v1.Schema$Label
      >;
    };
    settings: {
      filters: {
        list: Call<
          gmail_v1.Params$Resource$Users$Settings$Filters$List,
          gmail_v1.Schema$ListFiltersResponse
        >;
        get: Call<
          gmail_v1.Params$Resource$Users$Settings$Filters$Get,
          gmail_v1.Schema$Filter
        >;
        create: Call<
          gmail_v1.Params$Resource$Users$Settings$Filters$Create,
          gmail_v1.Schema$Filter
        >;
        delete: Call<
          gmail_v1.Params$Resource$Users$Settings$Filters$Delete,
          void
        >;
      };
      sendAs: {
        list: Call<
          gmail_v1.Params$Resource$Users$Settings$Sendas$List,
          gmail_v1.Schema$ListSendAsResponse
        >;
      };
    };
  };
}

export function createClient(auth: ProviderAuth): ProviderClient {
  return gmail({ version: "v1", auth });
}
