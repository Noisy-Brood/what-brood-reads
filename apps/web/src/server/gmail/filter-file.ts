import {
  homeAtProvider,
  quietedHomeAtProvider,
  renderRule,
  type RuleScope,
} from "./rules";

/**
 * Brood's rules as Gmail's own filter file, the `.xml` its *Import filters*
 * takes (D21 §3, #1108). Google's help does not document the format
 * (`google-2026-gmail-filters-help`), so it is the one Gmail's *Export* wrote
 * for the filters Brood installed in a real mailbox (Tim, 2026-10-12, on
 * #1108): an Atom feed, one entry per filter, each criterion and action an
 * `apps:property`. Brood's query is `hasTheWord` and its carve-outs
 * `doesNotHaveTheWord`, each exactly as Gmail holds them; the home is the
 * label's full name; out of the inbox is `shouldArchive`.
 *
 * Written from Brood's record, with no read. The rule's tag (`ruleTag`) is
 * left out: it means something only beside Brood's record, and a filter made
 * from this file is the person's own.
 */

/** One rule to write: what it files, and where its home is now. */
export interface RuleToWrite {
  scope: RuleScope;
  /** The home's path, as the core names it. */
  path: string;
  quieted: boolean;
}

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&apos;",
  '"': "&quot;",
};

/** A value inside a single-quoted attribute, as Gmail's export quotes them. */
const attr = (value: string): string =>
  value.replace(/[&<>'"]/g, (c) => ESCAPES[c]!);

const property = (name: string, value: string): string =>
  `\t\t<apps:property name='${name}' value='${attr(value)}'/>`;

/**
 * The file, for these rules, stamped `at`. Each rule's ids are its place in
 * the file: Gmail gives a filter its own id when it imports one.
 */
export function rulesFile(rules: readonly RuleToWrite[], at: Date): string {
  const updated = at.toISOString().replace(/\.\d{3}Z$/, "Z");
  const ids = rules.map((_, i) => String(i + 1));
  const entries = rules.map((rule, i) => {
    const { query, negatedQuery } = renderRule(rule.scope);
    const home = rule.quieted
      ? quietedHomeAtProvider(rule.path)
      : homeAtProvider(rule.path);
    return [
      "\t<entry>",
      "\t\t<category term='filter'></category>",
      "\t\t<title>Mail Filter</title>",
      `\t\t<id>tag:mail.google.com,2008:filter:${ids[i]}</id>`,
      `\t\t<updated>${updated}</updated>`,
      "\t\t<content></content>",
      property("hasTheWord", query),
      ...(negatedQuery ? [property("doesNotHaveTheWord", negatedQuery)] : []),
      property("label", home),
      property("shouldArchive", "true"),
      "\t</entry>",
    ].join("\n");
  });
  return [
    "<?xml version='1.0' encoding='UTF-8'?>",
    "<feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='http://schemas.google.com/apps/2006'>",
    "\t<title>Mail Filters</title>",
    `\t<id>tag:mail.google.com,2008:filters:${ids.join(",")}</id>`,
    `\t<updated>${updated}</updated>`,
    ...entries,
    "</feed>",
    "",
  ].join("\n");
}
