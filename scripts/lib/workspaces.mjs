// The pnpm workspaces a check reads, in one place, as pnpm reports them.
//
// These checks used to hold a hardcoded list of *containers* (`apps`,
// `packages`) and read their children, which could not express a directory that
// is itself a workspace: the next root-level one would have sat outside the type
// gate, and adding it to the list would have scanned its subdirectories and read
// nothing (#179).
//
// The first fix parsed pnpm-workspace.yaml by hand, and review found the parser
// wrong twice in a row: a `packages:` key with a trailing comment, and glob
// syntax inside a negated pattern. Each was a corner of pnpm's real semantics,
// and another would follow. So this asks pnpm instead. The set of workspaces is
// pnpm's fact, and a copy of the answer, however careful, is a second place for
// it to be wrong.
//
// One trap, and it is why the missing-file guard below exists: with no
// pnpm-workspace.yaml, pnpm treats every subdirectory as a workspace rather than
// none. A check that read that would believe it had found the whole repo.
//
// Discovery that cannot run fails. A list that came back empty would let every
// check downstream pass over nothing.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { relative } from "node:path";
import { toPosix } from "./paths.mjs";
import { failed } from "./report.mjs";

const FILE = "pnpm-workspace.yaml";

/**
 * The folders the workspaces live in, as `pnpm-workspace.yaml`'s globs name
 * them (`apps/*`, `packages/*`, `services/*`), for the checks that read code
 * and must run where pnpm is not installed: CI's source-only lane (#467).
 * Not a second list of workspaces: `verify_typecheck_coverage`, which asks
 * pnpm, fails when a workspace sits anywhere else, so this cannot drift from
 * pnpm's answer unnoticed. A folder here that does not exist yet is read
 * where it does.
 */
export const CODE_CONTAINERS = ["apps", "packages", "services"];

/** The containers that exist, so a check reads what is there. */
export const codeContainers = () =>
  CODE_CONTAINERS.filter((d) => existsSync(d));

// A failure here names the check that called it (#471).
const fail = (message) => failed(`  workspaces: ${message}`);

/**
 * Every workspace directory, as a POSIX path relative to the working directory.
 * The repository root is not among them: pnpm reports it as the workspace's own,
 * and no check here reads it as a package.
 */
export const workspaces = () => {
  if (!existsSync(FILE)) fail(`${FILE} not found, so nothing can be read.`);

  const run = spawnSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], {
    encoding: "utf8",
  });
  if (run.error) fail(`could not run pnpm: ${run.error.message}`);
  if (run.status !== 0) fail(`pnpm ls failed:\n${run.stderr}${run.stdout}`);

  const root = realpathSync(process.cwd());
  const dirs = JSON.parse(run.stdout)
    .map((p) => toPosix(relative(root, realpathSync(p.path))))
    .filter((dir) => dir !== "")
    .sort();

  if (!dirs.length) fail(`${FILE} resolved no workspaces.`);
  return dirs;
};
