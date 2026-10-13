/**
 * How Gmail draws a home's colour (#796). Like the home's name, the colour is a
 * rendering of a classification, never part of the decision (DD16 §1): the
 * core chooses which colour each home has and in what order colours are given
 * (`server/rules/colours.ts`), and this module only draws them. Gmail takes a
 * pair of hex values from a fixed list. Microsoft takes a preset whose shade
 * depends on the client (`microsoft-2026-outlook-category`), so an adapter
 * there would map each colour to its nearest preset.
 */

/**
 * The colours a home can be drawn in: a colour of its own, each a hue word any
 * adapter can map, or the pale tint homes with little mail share. A port type,
 * like `Mailbox`, so it lives here until the port is its own module (#456).
 */
export type HomeColour = "blue" | "green" | "lavender" | "gold" | "muted";

/**
 * Every value Gmail allows for a label's text or background colour, as its
 * reference lists them (`google-2026-gmail-labels`). Read only by the test
 * that holds each pair below to this list.
 */
export const GMAIL_LABEL_PALETTE: readonly string[] = (
  "#000000 #434343 #666666 #999999 #cccccc #efefef #f3f3f3 #ffffff " +
  "#fb4c2f #ffad47 #fad165 #16a766 #43d692 #4a86e8 #a479e2 #f691b3 " +
  "#f6c5be #ffe6c7 #fef1d1 #b9e4d0 #c6f3de #c9daf8 #e4d7f5 #fcdee8 " +
  "#efa093 #ffd6a2 #fce8b3 #89d3b2 #a0eac9 #a4c2f4 #d0bcf1 #fbc8d9 " +
  "#e66550 #ffbc6b #fcda83 #44b984 #68dfa9 #6d9eeb #b694e8 #f7a7c0 " +
  "#cc3a21 #eaa041 #f2c960 #149e60 #3dc789 #3c78d8 #8e63ce #e07798 " +
  "#ac2b16 #cf8933 #d5ae49 #0b804b #2a9c68 #285bac #653e9b #b65775 " +
  "#822111 #a46a21 #aa8831 #076239 #1a764d #1c4587 #41236d #83334c " +
  "#464646 #e7e7e7 #0d3472 #b6cff5 #0d3b44 #98d7e4 #3d188e #e3d7ff " +
  "#711a36 #fbd3e0 #8a1c0a #f2b2a8 #7a2e0b #ffc8af #7a4706 #ffdeb5 " +
  "#594c05 #fbe983 #684e07 #fdedc1 #0b4f30 #b3efd3 #04502e #a2dcc1 " +
  "#c2c2c2 #4986e7 #2da2bb #b99aff #994a64 #f691b2 #ff7537 #ffad46 " +
  "#662e37 #ebdbde #cca6ac #094228 #42d692 #16a765"
).split(" ");

export interface LabelColour {
  backgroundColor: string;
  textColor: string;
}

/**
 * How Gmail draws each colour (DD1 §8.4). The four backgrounds were chosen
 * from Gmail's list by running the dataviz palette validator over every
 * set of four that excludes reds and greys: worst pair ΔE 19.5 under
 * protanopia (the target is 8) and 21.5 to normal vision (the floor is 15).
 * Each text colour gives at least 4.5:1 against its background, and none is
 * pure black or white. Blue's and green's text is Gmail's near-white, the
 * only text in its list that reaches 4.5:1 on green; it is text, not a mark
 * standing for data, so #655's rule is about the backgrounds. The pale tint
 * is Tim's choice over grey (#796): quiet, not gone.
 */
export const GMAIL_COLOURS: Readonly<Record<HomeColour, LabelColour>> = {
  blue: { backgroundColor: "#285bac", textColor: "#f3f3f3" },
  green: { backgroundColor: "#0b804b", textColor: "#f3f3f3" },
  lavender: { backgroundColor: "#b694e8", textColor: "#41236d" },
  gold: { backgroundColor: "#d5ae49", textColor: "#41236d" },
  muted: { backgroundColor: "#c9daf8", textColor: "#1c4587" },
};

/**
 * Which of Brood's colours a label has, as Gmail returns its colour: null for
 * none, and `other` for a colour that is none of Brood's. Compared without
 * regard to case, since the reference does not say which case Gmail returns.
 */
export function colourOf(
  found: { backgroundColor?: string | null; textColor?: string | null } | null,
): HomeColour | null | "other" {
  const bg = found?.backgroundColor?.toLowerCase() ?? null;
  const text = found?.textColor?.toLowerCase() ?? null;
  if (bg === null && text === null) return null;
  // Object.keys of a record whose keys are the union.
  const names = Object.keys(GMAIL_COLOURS) as HomeColour[];
  return (
    names.find(
      (n) =>
        GMAIL_COLOURS[n].backgroundColor === bg &&
        GMAIL_COLOURS[n].textColor === text,
    ) ?? "other"
  );
}
