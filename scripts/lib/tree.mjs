// Read text files from the working tree the way `grep -rI` did.
//
// Checks that were inline shell in verify.sh could not be pointed at a fixture,
// so nothing could test them (#176). They are modules now, and this is what they
// share. It keeps the semantics that mattered:
//
//   - binary files are skipped (a NUL byte, which is how `-I` decides);
//   - symlinks are not followed, as `grep -r` does not follow them in a walk;
//   - dotfiles and dot-directories are included, so `.github` is read;
//   - results are `path:line:text`, paths relative and POSIX.
//
// And it changes one thing on purpose. `grep ... 2>/dev/null || true` turned a
// missing directory into "none found", so a check whose root had been renamed
// passed forever. A root that does not exist, or a read that finds no files, is a
// failure here, because a check that cannot run must fail rather than report
// green (conventions/make-hub.md).
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toPosix } from "./paths.mjs";
import { failed } from "./report.mjs";

/** Directories that hold build output or other people's code. */
export const BUILD_DIRS = [
  "node_modules",
  "dist",
  ".astro",
  ".next",
  // The device checks' own build, and what Playwright leaves beside it (#899).
  ".next-devices",
  ".vite",
];

// A failure here names the check that called it (#471).
const fail = (message) => failed(message);

/**
 * @param {string[]} roots  directories to walk, relative to the working directory
 * @param {object}   [opts]
 * @param {string[]} [opts.excludeDirs]   directory names skipped at any depth
 * @param {RegExp}   [opts.include]       tested against the file's basename
 * @param {string[]} [opts.excludeFiles]  exact repository-relative paths
 * @returns {{path: string, text: string}[]}  never empty: an empty read fails
 */
export function readTree(
  roots,
  { excludeDirs = [], include = null, excludeFiles = [] } = {},
) {
  // No root at all, as when none of the workspaces' folders exists, is a
  // broken checkout, never a clean one (#467).
  if (!roots.length) fail("  no folder to read: nothing was checked.");
  for (const root of roots) {
    if (!existsSync(root)) fail(`  cannot read ${root}: it does not exist.`);
  }

  const files = listTree(roots, { excludeDirs })
    .filter((p) => !include || include.test(p.split("/").at(-1)))
    .filter((p) => !excludeFiles.includes(p))
    .flatMap((path) => {
      const buffer = readUnlessGone(path);
      return buffer === null || buffer.includes(0)
        ? []
        : [{ path, text: buffer.toString("utf8") }];
    });

  if (!files.length) {
    fail(`  read no files under ${roots.join(", ")}: nothing was checked.`);
  }
  return files;
}

/**
 * The tracked files under `roots`, read: what `git ls-files` lists, so a
 * check reads the same files on a laptop as in CI (#467). `readTree` walks
 * the disk, and on a laptop the disk also holds what git ignores (`.env.local`,
 * `.mirror/`, an editor's folder), which CI never has. For a rule about what
 * the repository holds; a rule about build output, which git does not track,
 * reads the disk.
 *
 * Same options and the same refusals as `readTree`: binary files and symlinks
 * are skipped, and an empty read fails, as does a directory that is not a
 * repository.
 *
 * @param {string[]} roots
 * @param {object}   [opts]  as `readTree`'s
 * @returns {{path: string, text: string}[]}
 */
export function readTracked(
  roots,
  { excludeDirs = [], include = null, excludeFiles = [] } = {},
) {
  // Every root, as readTree refuses one: a renamed path in a check of several
  // roots must not pass on the others (review of #700).
  for (const root of roots) {
    if (!existsSync(root)) fail(`  cannot read ${root}: it does not exist.`);
  }
  let listed;
  try {
    listed = execFileSync("git", ["ls-files", "-z", "--", ...roots], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    fail(
      `  cannot list tracked files: ${String(e.stderr ?? e.message).trim()}`,
    );
  }
  const files = listed
    .split("\0")
    .filter(Boolean)
    .map(toPosix)
    .filter(
      (p) =>
        !p
          .split("/")
          .slice(0, -1)
          .some((d) => excludeDirs.includes(d)),
    )
    .filter((p) => !include || include.test(p.split("/").at(-1)))
    .filter((p) => !excludeFiles.includes(p))
    // Deleted from the tree and not yet from the index: nothing to read.
    .filter((p) => existsSync(p) && !lstatSync(p).isSymbolicLink())
    .flatMap((path) => {
      const buffer = readFileSync(path);
      return buffer.includes(0)
        ? []
        : [{ path, text: buffer.toString("utf8") }];
    });
  if (!files.length) {
    fail(
      `  read no tracked files under ${roots.join(", ")}: nothing was checked.`,
    );
  }
  return files;
}

/**
 * Every file under `roots`, as a relative POSIX path, without reading it: the
 * one walk the checks share (#467), which `readTree` reads through. Symlinks
 * are not followed, as `grep -r` does not follow them; a directory named in
 * `excludeDirs` is skipped at any depth, and with `excludeHidden` so is any
 * file or directory whose name starts with a dot. A root that does not exist is the caller's to
 * refuse, and each caller that walks a build or a surface already has. A
 * folder removed beneath a root as it is walked is passed over; a caller that
 * reads what it lists reads through `readUnlessGone`.
 *
 * @param {string[]} roots
 * @param {{ excludeDirs?: string[], excludeHidden?: boolean }} [opts]
 * @returns {string[]}
 */
export function listTree(
  roots,
  { excludeDirs = [], excludeHidden = false } = {},
) {
  const walk = (dir, root) =>
    entriesOf(dir, root).flatMap((e) => {
      if (e.isSymbolicLink()) return [];
      // A hidden file is left out as a hidden folder is, before either is
      // read as one or the other.
      if (excludeHidden && e.name.startsWith(".")) return [];
      const path = toPosix(dir === "." ? e.name : join(dir, e.name));
      if (e.isDirectory())
        return excludeDirs.includes(e.name) ? [] : walk(path, false);
      return e.isFile() ? [path] : [];
    });
  return roots.flatMap((root) => walk(root, true));
}

// What another process removes between the walk listing it and reading it was
// never the tree's: the a11y check's Playwright removes test-results while
// verify walks beside it (#1388). A root that is gone is still the caller's to
// refuse, so only what lies beneath one is let go.
const isGone = (e) => e?.code === "ENOENT";

function entriesOf(dir, root) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (root || !isGone(e)) throw e;
    return [];
  }
}

/**
 * A listed file's bytes, or null if another process removed it after the walk
 * listed it. Any other failure to read throws. A check that reads what
 * `listTree` gives it reads through this, as `readTree` does.
 *
 * @param {string} path
 * @returns {Buffer | null}
 */
export function readUnlessGone(path) {
  try {
    return readFileSync(path);
  } catch (e) {
    if (!isGone(e)) throw e;
    return null;
  }
}

/** Every line matching `pattern`, as `path:line:text`. */
export function matchLines(files, pattern) {
  return files.flatMap(({ path, text }) =>
    text
      // CRLF files are read as lines too: `$` after a carriage return matches in
      // BSD grep and not in GNU grep, so the shell checks disagreed by platform,
      // and a conflict marker in a Windows-checked-out file went unflagged on CI.
      .split(/\r?\n/)
      .flatMap((line, i) =>
        pattern.test(line) ? [`${path}:${i + 1}:${line}`] : [],
      ),
  );
}

/**
 * The extensions that are code, in every form the app and the sites build:
 * one list, read by every check that means "code" (review of #479). Six
 * checks kept their own copy, and one of them lacked `.mts` and `.cts`.
 */
export const CODE_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
];

/** A path ending in one of `extensions`, and nothing else. */
export const endingIn = (extensions) =>
  new RegExp(`\\.(${extensions.join("|")})$`);

/** A path that is code. */
export const CODE = endingIn(CODE_EXTENSIONS);

/**
 * A test, or a test's support (#789): one pattern for the check that holds
 * support to being test-only and for the mirror, which carries neither
 * (#1410).
 */
export const TEST_FILE = /\.test(-support)?\.[cm]?[jt]sx?$/;
