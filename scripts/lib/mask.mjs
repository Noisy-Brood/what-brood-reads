// Blank the comments in a source file, leaving everything else as it was.
//
// Three checks need the text of a file without its comments, and each had its own
// copy of the idea: one string-aware, two not. The two that were not could be
// walked around with a string holding `/*` and another holding `*/`, which blanked
// the code between them. They share this one now (conventions/dry-and-reuse.md).

/**
 * Blank every comment, keeping the file's length and line breaks.
 *
 * Two things depend on it. A `format: "metadata"` sitting in a comment is text
 * nobody executes and must not satisfy the rule; and an unbalanced parenthesis
 * in ordinary prose must not be counted as call nesting — `// the backfill path
 * (see DD1 §4 for why` left the depth non-zero at its own call's closing
 * parenthesis, so the scan ran on into the next call and borrowed its `format`.
 *
 * String literals are stepped over rather than blanked, because `"metadata"` is
 * the thing being looked for and a `//` inside a URL starts no comment. That is
 * also what stops one string holding the opener of a block comment and another
 * holding its closer from blanking the code between them, which is how a check
 * that strips comments without knowing about strings is walked around with
 * ordinary valid JavaScript.
 *
 * `line` is the token that starts a line comment: `//` for code, `--` for SQL.
 *
 * **Regex literals are stepped over too** (review of #479): a regex ending in
 * `//`, holding a quote or holding `/*` is none of a comment and a string, and
 * reading it as one blanked or swallowed the code after it. A `/` opens a regex
 * where an expression may begin: at the start, after an operator or opening
 * punctuation, or after a keyword such as `return`. Anywhere else it is
 * division. Only for `//` code: in SQL a slash is division.
 *
 * Lexical rather than a parser, and the limit is worth naming: a template
 * substitution nesting another template, or a regex after `)` (`if (x) /re/`),
 * can still mislead it. Which is why the bound below does not depend on this
 * being right.
 */
const REGEX_AFTER_PUNCTUATION = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_AFTER_WORD =
  /\b(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

export const maskComments = (src, { line = "//" } = {}) => {
  const out = [...src];
  const code = line === "//";
  // The last character that was code, not space or comment: what decides
  // whether a `/` opens a regex or divides.
  let last = -1;
  let i = 0;
  const regexMayStart = () => {
    if (last < 0) return true;
    if (REGEX_AFTER_PUNCTUATION.has(src[last])) return true;
    return REGEX_AFTER_WORD.test(src.slice(Math.max(0, last - 11), last + 1));
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < src.length && src[i] !== ch) i += src[i] === "\\" ? 2 : 1;
      last = i;
      i++;
    } else if (
      code &&
      ch === "/" &&
      src[i + 1] !== "/" &&
      src[i + 1] !== "*" &&
      regexMayStart()
    ) {
      // A regex literal: to the closing slash outside a character class.
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\") i += 2;
        else if (src[i] === "[") ((inClass = true), i++);
        else if (src[i] === "]") ((inClass = false), i++);
        else if (src[i] === "/" && !inClass) break;
        else i++;
      }
      last = i;
      i++;
    } else if (src.startsWith(line, i)) {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
    } else if (ch === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
    } else {
      if (!/\s/.test(ch)) last = i;
      i++;
    }
  }
  return out.join("");
};
