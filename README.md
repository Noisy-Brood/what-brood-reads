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

## What each read path shows, and what it does not

### Gmail

`apps/web/src/server/gmail/`, checked by `scripts/verify_gmail_reads.mjs`.

- **Inspectable.** Every read that can carry a message body asks for metadata explicitly: two calls, each in its own file with its own list of headers, and neither list holds Subject. One reads each message's sender and recipients, and whether it offers a signed one-click unsubscribe; the other, when a person asks to be unsubscribed from a mailing, reads one message's unsubscribe and signature headers. Look at the code.
- **Attested.** No code outside this directory calls Gmail. That is a claim about the whole application, which is not published. The same check runs over the full source on every change; run here, over this directory alone, that half of it passes without having anything to read.

## Two limits, stated plainly

**This shows what was written, not what is running.** You can read the source;
you cannot confirm from here that the deployed service was built from it.

**Half of each check proves nothing here.** Each check also confirms that no code
outside its read path calls the provider. Over this repository, which holds only
the read paths, that half passes with nothing to read. It is run over the full
source privately, on every change, and for that half you have our word.

## Reading the comments

Comments cite design documents and issues by name, such as `DD1 §2.2` or `#182`.
They live in the private repository. The code and its checks are complete without
them.

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
