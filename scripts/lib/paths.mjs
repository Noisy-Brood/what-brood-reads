// A path compared against a hardcoded prefix has to agree with it on a separator.
//
// `node:path.join` uses the platform's — a backslash on Windows — while every
// boundary this repo checks is written as a POSIX path: the Gmail chokepoint in
// `verify_gmail_reads.mjs`, the adapter directory in `verify_provider_nouns.mjs`.
// On Windows the `startsWith` then never matches, and both checks report the
// chokepoint's own files as violations of the rule they exist to enforce.
//
// That fails loudly rather than silently, which is the safer of the two
// directions. It still makes the gate unusable on a platform, and
// `conventions/make-hub.md` requires that a green run locally mean a green run
// in CI — a check a contributor cannot run is one they will work around.
//
// So paths are normalised where they are built, rather than at each comparison,
// which is the version of this that cannot be forgotten at a new call site.
import { sep } from "node:path";

export const toPosix = (p) => (sep === "/" ? p : p.split(sep).join("/"));
