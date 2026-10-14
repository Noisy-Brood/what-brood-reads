<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/banner-dark.png">
  <img alt="Noisy Brood: What Brood reads" src=".github/banner-light.png">
</picture>

# What Brood reads

[![The check, on the latest copy](https://github.com/Noisy-Brood/what-brood-reads/actions/workflows/check.yml/badge.svg)](https://github.com/Noisy-Brood/what-brood-reads/actions/workflows/check.yml)
[![Licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)

Brood holds a permission to read a mailbox and promises never to read what is in
it. This repository is the code that does the reading, published so the promise
can be checked rather than taken on trust.

It is a one-way copy. The code is written, reviewed and deployed elsewhere, in a
private repository, and copied here by that repository's CI whenever it changes.
Nothing here is edited by hand, and it takes no pull requests: this is evidence,
not a library.

## What you can check, and what you cannot

Every read path implements one contract, `apps/web/src/server/channel/`: the types, errors and
declared capabilities through which the rest of Brood speaks to a mailbox. It
holds no client and makes no request; what reads a mailbox is in the read paths.

### Gmail

`apps/web/src/server/gmail/`, checked by `scripts/verify_gmail_reads.mjs`.

- **You can check.** Every read that could fetch a message body asks for metadata only, and names exactly which headers it wants. Subject is never one of them. There are two such reads, each in its own file. One reads each message's sender and recipients, and whether it offers a signed one-click unsubscribe. The other runs only when a person asks to be unsubscribed from a mailing, and reads that one message's unsubscribe and signature headers. Look at the code.
- **You have our word.** No other code in Brood calls Gmail. That is a claim about the whole application, which is private, so you have our word for it rather than code to read. The check runs over the full application whenever its code changes; here it has nothing to look at and passes regardless.

## What this repository cannot prove

**It shows the code we wrote, not the code that is running.** You can read the
source here, but nothing here lets you confirm that the live service was built
from it.

**It cannot show that this is the only code that reaches the provider.** Each
check does two jobs. The first looks inside its directory, at the reads each
section above lists under "You can check", and you can confirm those by reading
the code. The second looks at the rest of the application, to make sure no other
code reaches the provider. The rest of the application is private, so here the
second job has nothing to look at and passes regardless: its green tick here is
not evidence. In the private repository it runs over all the code whenever any
of it changes, and for that you have only our word.

## Reading the comments

The code's comments refer to internal design documents and issues, such as
`DD1 §2.2` or `#182`. Those are private. You do not need them to read the code
or run the checks.

## Running the checks

```
npm ci
node scripts/verify_gmail_reads.mjs
```

The same commands run in this repository's CI on every copy.

## Questions, and code that does not match

Open an issue: there is a form for a question, and one for a read that does not
do what this README or the check says. Point to the code. Please never paste
mail or message headers from a mailbox, yours or anyone's.

## Reporting a security problem

Privately, never in an issue: from this repository's Security and quality tab, or
to security@noisybrood.com. See `SECURITY.md`.

## Licence

Apache License 2.0. See `LICENSE`.
