// Assert the Gmail read discipline that D2 rests on.
//
// D2 traded "we cannot read your content" for "we never do." That trade is only
// worth anything if the second half is enforced, so the check goes in BEFORE the
// first Gmail call rather than after — the same ordering as conventions/secrets.md
// going in before the first secret.
//
// Three rules:
//   1. Gmail API calls live in ONE module. A chokepoint everything else routes
//      through is what makes the discipline reviewable. Held by text and by
//      structure: outside it nothing imports a Google client library or any of
//      its modules but its index, and the index hands out no client and no read.
//   2. The body-bearing reads are the ones listed in READS below, and no
//      others. threads.get is never called; messages.get is called once in
//      each read's file (readEvent in observe.ts, readUnsubscribe in
//      unsubscribe.ts, #595) and nowhere else, and asks for format: "metadata"
//      EXPLICITLY, with an exact argument shape. Rejecting
//      "full"/"raw"/"minimal" is not enough — Google does not promise metadata
//      when the parameter is omitted, so silence is not safe. Ask positively.
//      Every use of the API in the chokepoint is a direct call, so no read can
//      be made through an alias the count does not see.
//   3. Each read's metadataHeaders is its own shared constant, and that
//      constant holds exactly the headers DD1 §2.2 allows it, and no others.
//      Subject is in neither: DD11 §6 declined to store subjects, and a header
//      never fetched cannot be stored, logged, or end up in a stack trace by
//      accident.
//
// Written before the first Gmail call and deliberately vacuous until it landed,
// so that the day someone wrote the first fetch the rule was already in the gate.
// That day came with #172, and a tree without the adapter now fails: it is the
// chokepoint moved or renamed, and passing over it would be the skip-that-passes
// make-hub forbids (#443).
//
// Two more rules came from the scripts/ review (#443). The chokepoint calls only
// the Gmail methods listed here, so a new one (`drafts.get`, which returns a
// message) is a deliberate edit to this file and not a line that slips in. And it
// builds no Gmail URL by hand but the ones listed, since a hand-built request is
// a read the parse cannot see as a call.
import { readFileSync, existsSync } from "node:fs";
import { loadTypeScript } from "./lib/typescript.mjs";
import { dirname, posix } from "node:path";
import { maskComments } from "./lib/mask.mjs";
import {
  BUILD_DIRS,
  CODE as CODE_PATH,
  listTree,
  TEST_FILE,
} from "./lib/tree.mjs";
import { codeContainers } from "./lib/workspaces.mjs";
import { failed } from "./lib/report.mjs";

// The single permitted chokepoint. Changing this path is a deliberate act.
const CHOKEPOINT = "apps/web/src/server/gmail";

const ROOTS = codeContainers();
// The build folders every check skips, one list (tree.mjs), and coverage.
const SKIP = new Set([...BUILD_DIRS, "coverage"]);
const CODE = CODE_PATH;

const files = listTree(ROOTS, { excludeDirs: [...SKIP] }).filter((p) =>
  CODE.test(p),
);
let fail = false;

// A test's support (#789) is a typed stand-in for the client, which writes
// the client's resources as keys. Support is held to being test-only below:
// nothing but a test (`TEST_FILE`) may import it.
const TEST_SUPPORT = /\.test-support(\.[cm]?[jt]sx?)?$/;
const say = (m) => console.log(`  ${m}`);

if (!existsSync(CHOKEPOINT)) {
  fail = true;
  say(`the chokepoint is missing: there is no ${CHOKEPOINT}/.`);
  say(
    "The adapter has lived there since #172, so a tree without it is the chokepoint",
  );
  say("moved or renamed, and there is nothing here to hold to D2's claim.");
}

// ── 1. Gmail API access is confined to the chokepoint ────────────────────────
// `users.messages` and `users.threads` match whatever follows them, so an alias
// taken outside the chokepoint (`const get = gmail.users.messages.get`) is as
// much a use as a call.
const GMAIL_CALL =
  /gmail\.googleapis\.com|users\.(messages|threads)\b|googleapis?\.gmail|gmail\(\s*['"]v1['"]/;

const strays = files.filter(
  // The trailing slash matters. Without it a sibling directory whose name merely
  // begins with the chokepoint's — `…/server/gmail-sandbox` — is excluded from
  // the scan, so Gmail calls in it are neither confined nor reported. That is a
  // silent pass, in the one check D2's privacy claim rests on.
  (f) =>
    !f.startsWith(CHOKEPOINT + "/") && GMAIL_CALL.test(readFileSync(f, "utf8")),
);

if (strays.length) {
  fail = true;
  say(
    `Gmail API used outside ${CHOKEPOINT}/ — every call routes through the chokepoint.`,
  );
  say("See docs/decisions/D2-oauth-scopes.md §4.");
  strays.forEach((f) => say(`  ${f}`));
} else {
  say(`no Gmail calls outside ${CHOKEPOINT}/`);
}

// ── 1b. No way to a Gmail client from outside the chokepoint ────────────────
// A text pattern cannot see every spelling of a use: `const { messages } =
// client.users` names no `users.messages`, and neither does `client["users"]`.
// So confinement is also held where it can be held by structure, at the import.
// Outside the chokepoint nothing imports a Google client library, and nothing
// imports a module inside it except its index, which exports no client and no
// read: outside this directory Gmail is reached through a Mailbox or not at all.
//
// The limit: an import whose specifier is computed at runtime cannot be read.
const CLIENT_PACKAGE =
  /^(googleapis|@googleapis\/.+|google-auth-library|gaxios)(\/.*)?$/;
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s*)(['"`])([^'"`\n]+)\1/gm;
const INDEX = new Set(
  ["", "/index", "/index.ts", "/index.js", "/index.mjs"].map(
    (x) => CHOKEPOINT + x,
  ),
);
const APP_SRC = "apps/web/src";

/** Where an import specifier points, as a repo path, or null for a package. */
const resolveSpecifier = (from, spec) => {
  if (spec.startsWith("."))
    return posix.normalize(posix.join(dirname(from), spec));
  if (spec.startsWith("@/") && from.startsWith("apps/web/"))
    return posix.normalize(posix.join(APP_SRC, spec.slice(2)));
  return null;
};

const clientImports = [];
const deepImports = [];
for (const f of files.filter((f) => !f.startsWith(CHOKEPOINT + "/"))) {
  const src = maskComments(readFileSync(f, "utf8"));
  for (const m of src.matchAll(SPECIFIER)) {
    const spec = m[2];
    const line = `${f}:${src.slice(0, m.index).split("\n").length}  ${spec}`;
    if (CLIENT_PACKAGE.test(spec)) clientImports.push(line);
    const target = resolveSpecifier(f, spec)?.replace(CODE_PATH, "");
    if (
      target &&
      (target === CHOKEPOINT || target.startsWith(CHOKEPOINT + "/")) &&
      !INDEX.has(target) &&
      !INDEX.has(target + ".ts")
    )
      deepImports.push(line);
  }
}

// The index is the door, so what it hands out is part of the rule. It only
// re-exports, by name: an `import` or an `export *` in it could hand on a whole
// module under another name (`import * as raw from "./client"; export { raw }`),
// which no list of names would catch.
const indexFile = [`${CHOKEPOINT}/index.ts`].find((f) => files.includes(f));
const rawExports = [];
if (indexFile) {
  const src = maskComments(readFileSync(indexFile, "utf8"));
  for (const m of src.matchAll(/^\s*import\b|\bexport\s*\*/gm))
    rawExports.push(`${indexFile}:${src.slice(0, m.index).split("\n").length}`);
  for (const m of src.matchAll(/\bexport\b[^;]*;/g)) {
    if (
      /from\s*["']\.\/client(\.[jt]s)?["']/.test(m[0]) ||
      /\b(createClient|readEvent|readUnsubscribe|listEventIds)\b/.test(m[0])
    )
      rawExports.push(
        `${indexFile}:${src.slice(0, m.index).split("\n").length}`,
      );
  }
}

// Test support is read as a test, so it must stay one: imported by a test and
// by nothing else, or the exemption would be a way around every rule here.
const supportImports = [];
for (const f of files.filter((f) => !TEST_FILE.test(f))) {
  const src = maskComments(readFileSync(f, "utf8"));
  for (const m of src.matchAll(SPECIFIER)) {
    if (TEST_SUPPORT.test(m[2]))
      supportImports.push(
        `${f}:${src.slice(0, m.index).split("\n").length}  ${m[2]}`,
      );
  }
}
if (supportImports.length) {
  fail = true;
  say("test support imported by code that is not a test:");
  supportImports.forEach((r) => say(`  ${r}`));
}

if (clientImports.length) {
  fail = true;
  say(`a Google client library is imported outside ${CHOKEPOINT}/:`);
  clientImports.forEach((l) => say(`  ${l}`));
}
if (deepImports.length) {
  fail = true;
  say(
    `a module inside ${CHOKEPOINT}/ is imported from outside it, other than its index:`,
  );
  deepImports.forEach((l) => say(`  ${l}`));
}
if (rawExports.length) {
  fail = true;
  say(
    "the chokepoint's index exports the raw client or a read function, or imports or re-exports a whole module:",
  );
  rawExports.forEach((l) => say(`  ${l}`));
}
if (!clientImports.length && !deepImports.length && !rawExports.length) {
  say(
    `outside ${CHOKEPOINT}/, no Google client library is imported and the chokepoint is reached only through its index`,
  );
}

// ── 2. No read requests a format other than metadata ─────────────────────────
// D2: gmail.modify is held for the write path only. Reads are metadata, always.
// Asked for as a property, or in a URL's query, which is how a request built by
// hand would ask (#443).
const BAD_FORMAT = /format\s*[:=]\s*['"`](full|raw|minimal)['"`]/g;
const BAD_QUERY = /[?&]format=(full|raw|minimal)\b/g;

const offenders = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of [...src.matchAll(BAD_FORMAT), ...src.matchAll(BAD_QUERY)]) {
    const line = src.slice(0, m.index).split("\n").length;
    offenders.push(`${f}:${line}  ${m[0]}`);
  }
}

if (offenders.length) {
  fail = true;
  say('a Gmail read requests a format other than "metadata".');
  say("This is the line D2's entire privacy claim rests on. See D2 §3.");
  offenders.forEach((o) => say(`  ${o}`));
} else {
  say("no reads request format full/raw/minimal");
}

// ── 2b. One body-bearing read, and it asks for exactly metadata ─────────────
// An omitted `format` is not an explicit "metadata": Google's reference does not
// promise metadata as the default, and the privacy claim must not rest on a
// default we neither control nor are promised (DD1 §2.1).
//
//   - `threads.get` is not called at all. It returns bodies too (DD1 §5 costs it
//     at 40 units, so it is a call someone may reach for), and the day it is
//     needed it joins the one read below, deliberately.
//   - `messages.get` is called once in each read's file (READS) and nowhere
//     else.
//   - Each call has one argument, an object literal whose properties are
//     exactly `format: "metadata"`, `metadataHeaders:` its own constant,
//     `fields:` its own mask as a literal, `userId: "me"` and an `id` that is a
//     plain identifier, and nothing else. The mask names every part of a
//     message the read takes: without it Gmail may send `snippet`, the opening
//     of the body, which Google's reference does not say `metadata` omits.
//     No other property can sit in the call to spoof a format, and no spread or
//     variable can supply one.
//
// **Read with the TypeScript compiler, not a hand lexer (#286).** This rule was
// first enforced by lexing JavaScript by hand, and every review round found a
// form the lexer did not know (#182, #282): a regex literal holding a quote was
// the last, and it hid a second read beside the compliant one. The compiler's
// parse is the one the code will actually run as, so a comment, a string, a
// template or a regex cannot move it. It is the compiler `apps/web` already
// depends on, found from this script's own location: the repository root first,
// which is where the public mirror installs it (D10 §3), then the workspace.
// If it cannot be found the check fails, by name. It is not a dependency of
// `scripts/` in its manifest, because `scripts/` has none; it is one in fact,
// and that is the trade, written down here and in conventions/testing.md.
const ts = loadTypeScript();
if (!ts) {
  say(
    "the TypeScript compiler could not be loaded, so the reads cannot be parsed.",
  );
  say(
    "Install the workspace (make install), or typescript at the repository root.",
  );
  failed();
}

const parse = (f) =>
  ts.createSourceFile(
    f,
    readFileSync(f, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    /\.tsx$/.test(f)
      ? ts.ScriptKind.TSX
      : /\.jsx$/.test(f)
        ? ts.ScriptKind.JSX
        : /\.[cm]?js$/.test(f)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS,
  );
const lineOf = (file, node) =>
  file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
const walkNodes = (node, visit) => {
  visit(node);
  ts.forEachChild(node, (child) => walkNodes(child, visit));
};

/** Is this `…messages.get` or `…threads.get`, and which? */
const getOf = (node) => {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "get")
    return null;
  const owner = node.expression;
  const name = ts.isPropertyAccessExpression(owner)
    ? owner.name.text
    : ts.isIdentifier(owner)
      ? owner.text
      : null;
  return name === "messages" || name === "threads" ? name : null;
};

/**
 * Each message read: the file it lives in, the one header list it asks for,
 * and what that list holds (DD1 §2.2). A new read is a row here, which is the
 * deliberate act: #595 added the second, for one-click unsubscribe.
 */
const READS = [
  {
    file: `${CHOKEPOINT}/observe.ts`,
    fn: "readEvent",
    constant: "METADATA_HEADERS",
    fields: "id,threadId,labelIds,internalDate,payload/headers",
    allowed: [
      "From",
      "To",
      "Cc",
      "Message-ID",
      "In-Reply-To",
      "References",
      "List-Unsubscribe",
      "List-Id",
      "List-Unsubscribe-Post",
      "DKIM-Signature",
      "Authentication-Results",
    ],
  },
  {
    file: `${CHOKEPOINT}/unsubscribe.ts`,
    fn: "readUnsubscribe",
    constant: "UNSUBSCRIBE_HEADERS",
    fields: "payload/headers",
    allowed: [
      "From",
      "List-Unsubscribe",
      "List-Unsubscribe-Post",
      "DKIM-Signature",
      "Authentication-Results",
    ],
  },
];
const readFor = (file) => READS.find((r) => r.file === file);

/** The only arguments a read may have, compared on the parse. */
const isExactRead = (call, constant, fields) => {
  if (call.arguments.length !== 1) return false;
  const [arg] = call.arguments;
  if (!ts.isObjectLiteralExpression(arg) || arg.properties.length !== 5)
    return false;
  const seen = new Set();
  for (const p of arg.properties) {
    let ok = false;
    if (ts.isShorthandPropertyAssignment(p)) {
      ok = p.name.text === "id";
    } else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
      const v = p.initializer;
      ok =
        (p.name.text === "format" &&
          ts.isStringLiteral(v) &&
          v.text === "metadata") ||
        (p.name.text === "metadataHeaders" &&
          ts.isIdentifier(v) &&
          v.text === constant) ||
        (p.name.text === "fields" &&
          ts.isStringLiteral(v) &&
          v.text === fields) ||
        (p.name.text === "userId" &&
          ts.isStringLiteral(v) &&
          v.text === "me") ||
        (p.name.text === "id" && ts.isIdentifier(v));
    }
    if (!ok || seen.has(p.name.text)) return false;
    seen.add(p.name.text);
  }
  return seen.size === 5;
};

const reads = [];
const parsed = new Map(files.map((f) => [f, parse(f)]));
for (const [f, file] of parsed) {
  walkNodes(file, (node) => {
    const kind = getOf(node);
    if (!kind) return;
    // A direct call: `…messages.get({…})`.
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      reads.push({
        file: f,
        line: lineOf(file, node),
        kind,
        exact:
          kind === "messages" &&
          !!readFor(f) &&
          isExactRead(node.parent, readFor(f).constant, readFor(f).fields),
      });
    }
    // `…messages.get.call(…)`, `.apply(…)`, `.bind(…)`: a read by another name,
    // counted, and never the exact one.
    else if (
      ts.isPropertyAccessExpression(node.parent) &&
      node.parent.expression === node &&
      ["call", "apply", "bind"].includes(node.parent.name.text)
    ) {
      reads.push({ file: f, line: lineOf(file, node), kind, exact: false });
    }
  });
}

// Counting call sites only counts what is written as a call. Inside the
// chokepoint a read could be made without one: `const get =
// client.users.messages.get; get({...})`, a destructured `{ get }`, or
// `messages.get.call(...)`, and the count would see nothing. So every reference
// to the API's `users` resource must be the head of a direct call chain
// (`.users.messages.get(`, `.users.settings.sendAs.list(`) with no `call`,
// `apply` or `bind` in it; a bare `users` cannot be destructured, passed around
// or named as a key; and none of these names may be reached by a computed key.
// A URL the chokepoint builds by hand is a string, and the parse knows it.
//
// Test files are not read by this rule: a test builds a fake client, which is
// where `users:` is written as a key, and a test never holds a real mailbox.
//
// The limit: a key assembled at runtime, `client[k]`, cannot be read. That is
// not a mistake anyone makes by accident, and in the chokepoint it is the thing
// review is there to refuse.
const INDIRECT_NAMES = new Set(["call", "apply", "bind"]);
const COMPUTED = new Set(["users", "messages", "threads", "get"]);
const indirect = [];

// Every method the chokepoint may call, as its chain from `users` (#443). A
// method not here fails, so a new one is a deliberate edit, made after reading
// what it returns: `drafts.get` and `messages.attachments.get` return content,
// and D2 §3's claim is that nothing does. `messages.get` is the one read, held
// to exactly metadata by rule 2b.
const GMAIL_METHODS = new Set([
  "getProfile",
  "history.list",
  "labels.create",
  // A label's counts, for a mailbox's size (#558), and its colour (#796). No
  // message; the chokepoint never asks for an unread count.
  "labels.get",
  "labels.list",
  "labels.patch",
  "messages.batchModify",
  "messages.get",
  "messages.list",
  "settings.filters.create",
  "settings.filters.delete",
  "settings.filters.get",
  "settings.filters.list",
  "settings.sendAs.list",
  "stop",
  "watch",
]);
const unlisted = [];
/**
 * Whether `node` sits inside a type, which compiles to nothing.
 *
 * `ExpressionWithTypeArguments` counts as a type node to the compiler, and is
 * one only in an `implements` clause or an interface's `extends`. In a class's
 * `extends users.Base` it is a value read, and so is an instantiation
 * expression, `client.users.get<T>`, which is an alias (review of #790).
 */
const inType = (node) => {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isExpressionWithTypeArguments(n)) {
      const clause = n.parent;
      return (
        ts.isHeritageClause(clause) &&
        (clause.token === ts.SyntaxKind.ImplementsKeyword ||
          ts.isInterfaceDeclaration(clause.parent))
      );
    }
    if (
      ts.isTypeNode(n) ||
      ts.isInterfaceDeclaration(n) ||
      ts.isTypeAliasDeclaration(n)
    )
      return true;
  }
  return false;
};
// A label's counts include its unread totals, which interface-prohibitions
// refuses to show and which Brood therefore never fetches (#558). So every
// `labels.get` asks Gmail for a partial response, with one argument, an object
// literal whose `fields` is a string literal naming no unread count; a call
// without the mask would fetch them (review of #596).
const unmasked = [];
/**
 * The one `fields` a call names, as a string literal, or null: one argument,
 * an object literal with no spread and exactly one `fields`.
 */
const fieldsOf = (call) => {
  if (call.arguments.length !== 1) return null;
  const [arg] = call.arguments;
  if (!ts.isObjectLiteralExpression(arg)) return null;
  // No spread, which could bring a second `fields`; a shorthand `id` is fine.
  if (
    arg.properties.some(
      (p) =>
        !ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p),
    )
  )
    return null;
  // Exactly one: a repeated key takes its last value, which a check reading
  // the first would never see (review of #596).
  const all = arg.properties.filter(
    (p) =>
      ts.isPropertyAssignment(p) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === "fields",
  );
  if (all.length !== 1) return null;
  const [fields] = all;
  return ts.isStringLiteral(fields.initializer)
    ? fields.initializer.text
    : null;
};
const isMaskedLabelRead = (call) => {
  const fields = fieldsOf(call);
  return !!fields && !/unread/i.test(fields);
};

// The person's own filters are text they wrote to match their mail, which
// can hold words from it (D21, #1106, #1107). So every
// `settings.filters.list` names exactly this mask: each filter's id, action
// and the sender it names, nothing else it matches.
// Brood's own filters are read whole by id, with `settings.filters.get`.
const RULE_LIST_FIELDS = "filter(id,criteria/from,action)";
const unmaskedRules = [];
let ruleLists = 0;

// The Gmail URLs the chokepoint may build by hand, whole (#443). A request
// built from a string is a read the parse does not see as a call, so any other
// string or template naming the host fails. The profile is the one fetch made
// before a client exists, to learn whose mailbox was just connected.
const GMAIL_HOST = "gmail.googleapis.com";
const GMAIL_URLS = new Set([
  "https://gmail.googleapis.com/gmail/v1/users/me/profile",
]);
const handBuilt = [];

// Every request the chokepoint makes by hand goes through `fetch` or an
// injected `fetchFn`, to one of these URLs by the name of the constant that
// holds it, and each constant holds exactly its URL (review of #475). A check
// of string fragments alone passes a host split across two strings; the
// destination of the request is what is checked here.
const REQUESTS = new Map([
  ["PROFILE", "https://gmail.googleapis.com/gmail/v1/users/me/profile"],
  ["TOKEN", "https://oauth2.googleapis.com/token"],
  ["REVOKE", "https://oauth2.googleapis.com/revoke"],
]);
const FETCHERS = new Set(["fetch", "fetchFn"]);
const unnamed = [];
const misnamed = [];
for (const [f, file] of parsed) {
  if (!f.startsWith(CHOKEPOINT + "/") || TEST_FILE.test(f)) continue;
  walkNodes(file, (node) => {
    if (
      ts.isElementAccessExpression(node) &&
      (ts.isStringLiteral(node.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) &&
      COMPUTED.has(node.argumentExpression.text)
    ) {
      indirect.push(`${f}:${lineOf(file, node)}`);
      return;
    }
    if (!ts.isIdentifier(node) || node.text !== "users") return;
    // A name in a type, such as the `users` member of the ProviderClient
    // interface (#789), is erased when the code is compiled and can read
    // nothing. Every `users` in a value position is held as before.
    if (inType(node)) return;
    const access = node.parent;
    if (!ts.isPropertyAccessExpression(access) || access.name !== node) {
      indirect.push(`${f}:${lineOf(file, node)}`);
      return;
    }
    // Climb the chain `.users.a.b…` to its top, and ask whether that is called.
    let top = access;
    const names = [];
    while (
      ts.isPropertyAccessExpression(top.parent) &&
      top.parent.expression === top
    ) {
      top = top.parent;
      names.push(top.name.text);
    }
    const called =
      ts.isCallExpression(top.parent) && top.parent.expression === top;
    if (!called || !names.length || names.some((n) => INDIRECT_NAMES.has(n)))
      indirect.push(`${f}:${lineOf(file, node)}`);
    else if (!GMAIL_METHODS.has(names.join(".")))
      unlisted.push(`${f}:${lineOf(file, node)}  users.${names.join(".")}`);
    else if (names.join(".") === "labels.get" && !isMaskedLabelRead(top.parent))
      unmasked.push(`${f}:${lineOf(file, node)}`);
    else if (names.join(".") === "settings.filters.list") {
      ruleLists++;
      if (fieldsOf(top.parent) !== RULE_LIST_FIELDS)
        unmaskedRules.push(`${f}:${lineOf(file, node)}`);
    }
  });
  walkNodes(file, (node) => {
    const text =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
        ? node.text
        : null;
    if (text === null || !text.includes(GMAIL_HOST)) return;
    const whole =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
    if (!whole || !GMAIL_URLS.has(text))
      handBuilt.push(`${f}:${lineOf(file, node)}  ${text.slice(0, 70)}`);
  });
  walkNodes(file, (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name === null || !FETCHERS.has(name)) return;
      const [target] = node.arguments;
      if (!target || !ts.isIdentifier(target) || !REQUESTS.has(target.text))
        unnamed.push(`${f}:${lineOf(file, node)}`);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      REQUESTS.has(node.name.text)
    ) {
      // A const, holding exactly its URL: a `let` could be given another
      // value between here and the fetch (review of #475).
      const v = node.initializer;
      const isConst = (node.parent.flags & ts.NodeFlags.Const) !== 0;
      if (
        !isConst ||
        !v ||
        !ts.isStringLiteralLike(v) ||
        v.text !== REQUESTS.get(node.name.text)
      )
        misnamed.push(`${f}:${lineOf(file, node)}  ${node.name.text}`);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left) &&
      REQUESTS.has(node.left.text)
    )
      misnamed.push(`${f}:${lineOf(file, node)}  ${node.left.text} (assigned)`);
  });
}
if (unlisted.length) {
  fail = true;
  say("the chokepoint calls a Gmail method this check does not allow. A new");
  say("method is a new thing Brood asks Gmail for: read what it returns, then");
  say("add it to GMAIL_METHODS here, deliberately (D2 §3):");
  unlisted.forEach((r) => say(`  ${r}`));
} else {
  say(
    `the chokepoint calls only the ${GMAIL_METHODS.size} Gmail methods this check allows`,
  );
}
if (unmasked.length) {
  fail = true;
  say("a labels.get may ask for an unread count. Each names a fields mask, a");
  say(
    "string literal with no unread count in it (#558, interface-prohibitions):",
  );
  unmasked.forEach((r) => say(`  ${r}`));
} else {
  say("every labels.get names a fields mask with no unread count in it");
}
if (unmaskedRules.length) {
  fail = true;
  say("a settings.filters.list may receive what the person's filters match.");
  say(
    `Each names exactly fields: "${RULE_LIST_FIELDS}", a string literal (D21 §2, #1106):`,
  );
  unmaskedRules.forEach((r) => say(`  ${r}`));
} else {
  say(
    `${ruleLists} settings.filters.list call(s), each naming fields: "${RULE_LIST_FIELDS}" and nothing more`,
  );
}
if (unnamed.length) {
  fail = true;
  say(
    "a request the chokepoint makes goes somewhere this check does not name.",
  );
  say(
    `Every fetch goes to one of ${[...REQUESTS.keys()].join(", ")}, by name:`,
  );
  unnamed.forEach((r) => say(`  ${r}`));
}
if (misnamed.length) {
  fail = true;
  say("a named request URL is not the URL this check allows for it:");
  misnamed.forEach((r) => say(`  ${r}`));
}
if (!unnamed.length && !misnamed.length) {
  say(
    "every request the chokepoint makes by hand goes to a URL this check names",
  );
}
if (handBuilt.length) {
  fail = true;
  say(
    "the chokepoint builds a Gmail URL other than the ones this check allows.",
  );
  say("A request built by hand is a read the parse cannot see as a call:");
  handBuilt.forEach((r) => say(`  ${r}`));
}
if (indirect.length) {
  fail = true;
  say("the Gmail API is used other than by a direct call. An alias, a");
  say("destructured method or a computed key is a read the count cannot see:");
  indirect.forEach((r) => say(`  ${r}`));
} else {
  say("every use of the Gmail API in the chokepoint is a direct call");
}

const threads = reads.filter((r) => r.kind === "threads");
const messages = reads.filter((r) => r.kind === "messages");
if (threads.length) {
  fail = true;
  say(
    "threads.get is called. It returns bodies too, and is not called at all:",
  );
  say(
    "the body-bearing reads are messages.get, one in each read's file. See #182.",
  );
  threads.forEach((r) => say(`  ${r.file}:${r.line}`));
}
const stray = messages.filter((r) => !readFor(r.file));
if (stray.length) {
  fail = true;
  say(
    `messages.get is called outside the reads (${READS.map((r) => r.file).join(", ")}).`,
  );
  say("Every other read goes through readEvent or readUnsubscribe. See #182.");
  stray.forEach((r) => say(`  ${r.file}:${r.line}`));
}
for (const read of READS) {
  const sites = messages.filter((r) => r.file === read.file);
  if (sites.length > 1) {
    fail = true;
    say(
      `messages.get has ${sites.length} call sites in ${read.file}; it has exactly one, in ${read.fn}.`,
    );
    sites.forEach((r) => say(`  ${r.file}:${r.line}`));
  } else if (sites.length === 1) {
    const [site] = sites;
    if (!site.exact) {
      fail = true;
      say(
        `the Gmail read in ${read.file} does not ask for exactly metadata. Its arguments are`,
      );
      say(
        `exactly format: "metadata", metadataHeaders: ${read.constant}, fields: "${read.fields}", userId: "me"`,
      );
      say(
        "and id, and nothing else. Omitting format is not asking for metadata (DD1 §2.1).",
      );
      say(`  ${site.file}:${site.line}`);
    } else {
      say(
        `one body-bearing read in ${read.file}, asking for exactly metadata, ${read.constant} and the fields ${read.fields}`,
      );
    }
  } else {
    fail = true;
    say(
      `no messages.get in ${read.file}. ${read.fn} reads through it (#172, #595), so`,
    );
    say("a chokepoint without it is one this check has lost track of.");
  }
}

// ── 3. metadataHeaders is a read's shared constant, and holds its allowlist ─
// The previous version of this check scanned for the word "subject" near
// "metadataHeaders". That is a proximity test, not an allowlist: passing a
// variable — `metadataHeaders: HEADERS` where HEADERS contains Subject, or any
// other sensitive header — sailed through while CI reported clean. So instead of
// guessing at the argument, constrain it: each list is defined in exactly one
// place, and every call site uses one by name.
const CONSTANTS = READS.map((r) => r.constant);

const inlineArgs = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/metadataHeaders\s*:\s*([^,\n}]+)/g)) {
    const arg = m[1].trim();
    if (!CONSTANTS.includes(arg)) {
      inlineArgs.push(
        `${f}:${src.slice(0, m.index).split("\n").length}  ${arg.slice(0, 40)}`,
      );
    }
  }
}

if (inlineArgs.length) {
  fail = true;
  say(
    `metadataHeaders must be one of the shared lists (${CONSTANTS.join(", ")}), not an inline value.`,
  );
  say("One definition is what makes the allowlist checkable at all. DD1 §2.2.");
  inlineArgs.forEach((o) => say(`  ${o}`));
} else {
  say(`metadataHeaders is always one of ${CONSTANTS.join(", ")}`);
}

// And each constant, wherever it lives, holds exactly its allowed headers. Read
// from the parse, not a pattern (#443): a pattern found only `= [`, so a list
// frozen where it was defined, or an alias of another list, fell through to
// "not yet" while the read used it. The definition is one `const`, and what it
// holds is a literal list of strings, frozen or asserted to a type or not,
// since anything else is a list this check cannot read.
const unwrap = (node) => {
  for (;;) {
    if (
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node)
    )
      node = node.expression;
    else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      node.expression.getText() === "Object.freeze"
    )
      node = node.arguments[0];
    else return node;
  }
};
for (const { constant: CONST_NAME, allowed: ALLOWED } of READS) {
  const defs = [];
  const renamed = [];
  for (const [f, file] of parsed) {
    walkNodes(file, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === CONST_NAME
      )
        defs.push({ f, file, node });
      if (
        (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) &&
        node.name.text === CONST_NAME &&
        node.propertyName &&
        node.propertyName.text !== CONST_NAME
      )
        renamed.push(`${f}:${lineOf(file, node)}`);
    });
  }

  if (renamed.length) {
    fail = true;
    say(`${CONST_NAME} is another name renamed to ${CONST_NAME}, which hides`);
    say("the list the read actually uses from this check:");
    renamed.forEach((r) => say(`  ${r}`));
  }
  if (defs.length > 1) {
    fail = true;
    say(`${CONST_NAME} is defined in ${defs.length} places — it must be one.`);
    defs.forEach(({ f }) => say(`  ${f}`));
  } else if (defs.length === 1) {
    const [{ f, file, node }] = defs;
    const list = node.initializer && unwrap(node.initializer);
    const isConst = (node.parent.flags & ts.NodeFlags.Const) !== 0;
    const literal =
      list &&
      ts.isArrayLiteralExpression(list) &&
      list.elements.every(
        (e) => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e),
      );
    if (!isConst || !literal) {
      fail = true;
      say(
        `${CONST_NAME} in ${f}:${lineOf(file, node)} is not a literal list of header names`,
      );
      say(
        "held by a const, so what it holds cannot be read. Write it as one. DD1 §2.2.",
      );
    } else {
      const got = list.elements.map((e) => e.text);
      const extra = got.filter((h) => !ALLOWED.includes(h));
      const missing = ALLOWED.filter((h) => !got.includes(h));
      if (extra.length || missing.length) {
        fail = true;
        say(`${CONST_NAME} in ${f} does not match DD1 §2.2's allowlist.`);
        if (extra.length) say(`  not allowed: ${extra.join(", ")}`);
        if (missing.length) say(`  missing:     ${missing.join(", ")}`);
        say(
          "  Changing the allowlist means changing DD1 §2.2 and DD11 §6 first.",
        );
      } else {
        say(
          `${CONST_NAME} holds exactly the allowed headers (${ALLOWED.length})`,
        );
      }
    }
  } else {
    fail = true;
    say(`${CONST_NAME} is not defined anywhere, and a read asks for it.`);
    say("Without its definition the allowlist cannot be checked. DD1 §2.2.");
  }
}

if (fail) {
  failed();
}
