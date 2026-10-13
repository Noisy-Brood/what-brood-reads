// The TypeScript compiler, for the checks that must read code as it parses
// rather than as text (#286, #597): a comment, a string, a template or a
// regex cannot move a parse. It is the compiler apps/web already depends on,
// found from the repository root first, which is where the public mirror
// installs it (D10 §3), then the workspace. Null when it cannot be found, and
// each check that asks fails by name. It is not a dependency of `scripts/` in
// its manifest, because `scripts/` has none; it is one in fact, and that is
// the trade, written down in conventions/testing.md.
import { createRequire } from "node:module";

export const loadTypeScript = () => {
  for (const base of [
    new URL("../../package.json", import.meta.url),
    new URL("../../apps/web/package.json", import.meta.url),
  ]) {
    try {
      return createRequire(base)("typescript");
    } catch {
      // Try the next place; failing all of them is the caller's to report.
    }
  }
  return null;
};
