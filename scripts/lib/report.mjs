// How a check says it failed, in one place (#471).
//
// testing.md has every check print `<name> failed` on its way out of a rule,
// and the tests assert the phrase naming the rule, never this footer. Several
// checks exited without it, and a failure raised inside lib/ named no check at
// all, so a red `make verify` could leave the reader to work out which one.
// The name is the script's own file, `verify_raw_hex.mjs` as `verify-raw-hex`,
// so it cannot drift from the script that printed it.
import { basename } from "node:path";

/** The running check's name, from its file. */
export const checkName = basename(process.argv[1] ?? "check")
  .replace(/\.mjs$/, "")
  .replaceAll("_", "-");

/** Print `lines`, then the footer, and exit 1. */
export function failed(...lines) {
  for (const line of lines) console.log(line);
  console.log(`\n${checkName} failed`);
  process.exit(1);
}
