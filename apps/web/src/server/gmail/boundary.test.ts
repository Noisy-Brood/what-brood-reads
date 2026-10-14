import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * D10 §7: the chokepoint stays publishable. It imports types and its own
 * configuration, names the encryption helpers as a dependency it does not
 * contain, and reaches into nothing else in the app: not the engine, the
 * index or the rule book. What else it needs arrives as arguments. The mirror
 * publishes this directory, so an import that breaks the rule is a file the
 * mirror would carry pointing at code it does not (#443).
 *
 * Read from the compiler's parse, so a comment or a string naming a path does
 * not count, and every form of import does: a declaration, an `export … from`,
 * a dynamic `import()`, a `require` and an `import x = require(…)`. A relative
 * path is resolved against the file that imports it, so `./x/../../engine`
 * is the engine; and every file under the directory is read, since the mirror
 * carries it whole (review of #475).
 */
const DIR = import.meta.dirname;

/** Where the chokepoint may import from, outside its own directory. */
const ALLOWED: readonly string[] = [
  // The port it implements, published beside it (D10 §7, #456).
  "../channel",
  // The encryption helpers, named and not contained (D10 §7).
  "../tokens",
  "../tokens/open",
  "../tokens/secret",
  // The Gmail client, and the driver whose type the opener takes.
  "@googleapis/gmail",
  "postgres",
];
/**
 * A relative specifier resolved against its file, as a path from DIR: inside
 * the directory, or `../…` once it leaves. Anything else is returned as it is.
 */
const resolved = (path: string, spec: string) =>
  spec.startsWith(".")
    ? posix.normalize(posix.join(posix.dirname(path), spec))
    : spec;
const allowed = (path: string, spec: string, list = ALLOWED) => {
  if (spec.startsWith("node:") || list.includes(spec)) return true;
  const to = resolved(path, spec);
  return spec.startsWith(".")
    ? !to.startsWith("..") || list.includes(to)
    : false;
};

/**
 * The port the chokepoint implements, published beside it (D10 §7, #456).
 * It holds types, errors and the capabilities declaration, so it imports
 * the account's type and the driver's, and nothing else: not even an
 * adapter, which would publish one provider's code as every provider's
 * contract.
 */
const PORT = join(DIR, "../channel");
const PORT_ALLOWED: readonly string[] = ["../tokens", "postgres"];

/**
 * Whether a declaration brings in types alone: `import type`, `export type`,
 * or every name it binds marked `type`. A bare `import "x"` runs the module,
 * and a default import is a value, so neither is.
 */
const typeOnly = (node: ts.ImportDeclaration | ts.ExportDeclaration) => {
  if (ts.isExportDeclaration(node))
    return (
      node.isTypeOnly ||
      (!!node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.every((e) => e.isTypeOnly))
    );
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const named = clause.namedBindings;
  return (
    !clause.name &&
    !!named &&
    ts.isNamedImports(named) &&
    named.elements.every((e) => e.isTypeOnly)
  );
};

/**
 * Every module specifier a source file imports, by any form. With
 * `valuesOnly`, those that bring in more than types: every form but a
 * type-only declaration.
 */
function importsOf(path: string, text: string, valuesOnly = false): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !(valuesOnly && typeOnly(node))
    ) {
      found.push(node.moduleSpecifier.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const e = node.moduleReference.expression;
      found.push(ts.isStringLiteralLike(e) ? e.text : "<computed specifier>");
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const [arg] = node.arguments;
      // A specifier computed at run time cannot be read, so it is refused.
      found.push(
        arg && ts.isStringLiteralLike(arg) ? arg.text : "<computed specifier>",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The imports in a file that reach outside what D10 §7 allows. */
const outward = (path: string, text: string, list = ALLOWED) =>
  importsOf(path, text)
    .filter((spec) => !allowed(path, spec, list))
    .map((spec) => `${path}: ${spec}`);

/**
 * The port's imports that reach outside it: any of a module other than its
 * own, its two allowed ones included, that brings in more than types. A value
 * from `../tokens` would publish the vault's reach as the contract.
 */
const portOutward = (path: string, text: string) => [
  ...outward(path, text, PORT_ALLOWED),
  ...importsOf(path, text, true)
    .filter((spec) => !allowed(path, spec, []))
    .map((spec) => `${path}: ${spec} (a value)`),
];

/** Every source file under `dir`, at any depth, as a path from it. */
const sourcesUnder = (dir: string) =>
  (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => f.split("\\").join("/"))
    .filter(
      (f) => /\.[cm]?[jt]sx?$/.test(f) && !/\.test\.[cm]?[jt]sx?$/.test(f),
    );

describe("the chokepoint's imports (D10 §7)", () => {
  const files = sourcesUnder(DIR);

  it("reads every source file in the chokepoint", () => {
    expect(files).toContain("mailbox.ts");
    expect(files).toContain("observe.ts");
  });

  it("reach nothing in the app but the port and the encryption helpers it names", () => {
    expect(
      files.flatMap((f) => outward(f, readFileSync(join(DIR, f), "utf8"))),
    ).toEqual([]);
  });

  it("leave the port reaching nothing but the account's type and the driver's", () => {
    const port = sourcesUnder(PORT);
    expect(port).toContain("mailbox.ts");
    expect(
      port.flatMap((f) => portOutward(f, readFileSync(join(PORT, f), "utf8"))),
    ).toEqual([]);
  });

  it("refuses the port an import of an adapter", () => {
    expect(portOutward("x.ts", `import type { M } from "../gmail";`)).toEqual([
      "x.ts: ../gmail",
    ]);
  });

  it.each([
    ["a value", `import { createTokenOpener } from "../tokens";`],
    ["a default", `import postgres from "postgres";`],
    ["a module run for its effects", `import "../tokens";`],
    [
      "a value beside a type",
      `import { type AccountRef, open } from "../tokens";`,
    ],
    ["a re-exported value", `export { open } from "../tokens";`],
  ])("refuses the port %s from a module it may take types from", (_w, text) => {
    expect(portOutward("x.ts", text)).not.toEqual([]);
  });

  it.each([
    [`import type { AccountRef } from "../tokens";`],
    [`import type postgres from "postgres";`],
    [`import { type AccountRef } from "../tokens";`],
    [`export type { AccountRef } from "../tokens";`],
  ])("allows the port a type from them: %s", (text) => {
    expect(portOutward("x.ts", text)).toEqual([]);
  });

  it.each([
    ["the engine", `import { run } from "../engine";`, "../engine"],
    ["the index", `export { ingest } from "../ingest";`, "../ingest"],
    [
      "the database",
      `const db = await import("../db/client");`,
      "../db/client",
    ],
    ["an app alias", `import { x } from "@/server/rules";`, "@/server/rules"],
    ["a computed path", `const m = require(name);`, "<computed specifier>"],
  ])("refuses an import of %s, by any form", (_what, text, spec) => {
    expect(outward("x.ts", text)).toEqual([`x.ts: ${spec}`]);
  });

  it.each([
    [
      "a relative path that climbs out and back in",
      `import { run } from "./x/../../engine";`,
      "./x/../../engine",
    ],
    [
      "TypeScript's import-equals form",
      `import engine = require("../engine");`,
      "../engine",
    ],
  ])("refuses %s (review of #475)", (_what, text, spec) => {
    expect(outward("x.ts", text)).toEqual([`x.ts: ${spec}`]);
  });

  it("resolves a path from a file in a subdirectory against that file", () => {
    expect(
      outward(
        "sub/x.ts",
        `import { t } from "../../tokens";\nimport { e } from "../../engine";`,
      ),
    ).toEqual(["sub/x.ts: ../../engine"]);
  });

  it("reads files in subdirectories, which the mirror carries too (review of #475)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gmail-boundary-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "a.ts"), "");
    writeFileSync(join(dir, "sub", "b.ts"), "");
    writeFileSync(join(dir, "sub", "b.test.ts"), "");
    expect(sourcesUnder(dir).sort()).toEqual(["a.ts", "sub/b.ts"]);
  });

  it("is not moved by a path named in a comment or a string", () => {
    expect(
      outward("x.ts", `// import "../engine"\nconst s = "../engine";`),
    ).toEqual([]);
  });
});
