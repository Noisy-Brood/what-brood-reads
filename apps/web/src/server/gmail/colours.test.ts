import { describe, expect, it } from "vitest";
import type { ProviderClient } from "./client";
import { colourOf, GMAIL_COLOURS, GMAIL_LABEL_PALETTE } from "./colours";
import { mailboxOver } from "./mailbox";
import { stubProviderClient } from "./stub-client.test-support";
import type { HomeColour } from "../channel";

/**
 * A home's colour as Gmail draws it (#796): every pair is one Gmail accepts,
 * readable, never red or grey, and the shared tint paler than every colour of
 * a home's own. Then reading a home's colour as one of Brood's, none, or
 * another, and setting one; which colours are Brood's to change is the core's.
 */

type Labels = ProviderClient["users"]["labels"];

/** WCAG 2's relative luminance and contrast ratio. */
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** Hue in degrees and a saturation from 0 to 1, as HSL has them. */
const hueAndSaturation = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(
    (i) => parseInt(hex.slice(i, i + 2), 16) / 255,
  );
  const max = Math.max(r!, g!, b!);
  const min = Math.min(r!, g!, b!);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g! - b!) / d) % 6);
    else if (max === g) h = 60 * ((b! - r!) / d + 2);
    else h = 60 * ((r! - g!) / d + 4);
  }
  return { hue: (h + 360) % 360, saturation: s };
};

// Object.entries of a record whose keys are the union.
const ALL = Object.entries(GMAIL_COLOURS) as Array<
  [HomeColour, (typeof GMAIL_COLOURS)[HomeColour]]
>;
/** Every colour of a home's own, which is every one but the tint. */
const OWN = ALL.map(([c]) => c).filter((c) => c !== "muted");

describe("how Gmail draws a home's colour", () => {
  it.each(ALL)("%s is a pair Gmail accepts", (_, pair) => {
    expect(GMAIL_LABEL_PALETTE).toContain(pair.backgroundColor);
    expect(GMAIL_LABEL_PALETTE).toContain(pair.textColor);
  });

  it.each(ALL)("%s is readable, at 4.5:1 or more", (_, pair) => {
    expect(
      contrast(pair.backgroundColor, pair.textColor),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each(ALL)(
    "%s is never pure black or white (the brand bible)",
    (_, pair) => {
      for (const c of [pair.backgroundColor, pair.textColor])
        expect(["#000000", "#ffffff"]).not.toContain(c);
    },
  );

  it.each(ALL)(
    "%s is drawn on a background that is never grey, which reads as gone (#655), nor red, which is Barn's",
    (_, pair) => {
      const { hue, saturation } = hueAndSaturation(pair.backgroundColor);
      expect(saturation).toBeGreaterThan(0.25);
      expect(hue >= 30 && hue <= 330).toBe(true);
    },
  );

  it("draws every colour of a home's own, and no two alike", () => {
    const backgrounds = OWN.map((c) => GMAIL_COLOURS[c].backgroundColor);
    expect(new Set(backgrounds).size).toBe(OWN.length);
  });

  it("draws the shared tint paler than every colour of a home's own", () => {
    const tint = luminance(GMAIL_COLOURS.muted.backgroundColor);
    for (const c of OWN)
      expect(tint).toBeGreaterThan(luminance(GMAIL_COLOURS[c].backgroundColor));
  });

  it("reads a colour as Brood's in either case, none as none, and any other as other", () => {
    expect(colourOf({ backgroundColor: "#285BAC", textColor: "#F3F3F3" })).toBe(
      "blue",
    );
    expect(colourOf(null)).toBe(null);
    expect(colourOf({})).toBe(null);
    // Brood's background with another text is not Brood's colour.
    expect(colourOf({ backgroundColor: "#285bac", textColor: "#434343" })).toBe(
      "other",
    );
  });
});

describe("a home's colour at Gmail", () => {
  /** A mailbox whose home `L1` has `colour`, recording what is asked of it. */
  const holding = (
    colour: { backgroundColor: string; textColor: string } | null,
  ) => {
    const asked: Array<{ id: string; fields: string }> = [];
    const patched: Array<{ id: string; color: unknown }> = [];
    const get: Labels["get"] = async (p) => {
      asked.push({ id: p.id ?? "", fields: p.fields ?? "" });
      return { data: colour === null ? {} : { color: colour } };
    };
    const patch: Labels["patch"] = async (p) => {
      patched.push({ id: p.id ?? "", color: p.requestBody?.color });
      return { data: {} };
    };
    const m = mailboxOver(stubProviderClient({ labels: { get, patch } }));
    return { m, asked, patched };
  };

  it("is read by itself, with a mask that asks for the colour alone", async () => {
    const { m, asked, patched } = holding(GMAIL_COLOURS.gold);
    expect(await m.homeColour("L1")).toBe("gold");
    expect(asked).toEqual([{ id: "L1", fields: "color" }]);
    expect(patched).toEqual([]);
  });

  it("is read as other when it is none of Brood's", async () => {
    const { m } = holding({ backgroundColor: "#fb4c2f", textColor: "#000000" });
    expect(await m.homeColour("L1")).toBe("other");
  });

  it("is set as Gmail's pair for the colour", async () => {
    const { m, patched } = holding(null);
    await m.colourHome("L1", "muted");
    expect(patched).toEqual([{ id: "L1", color: GMAIL_COLOURS.muted }]);
  });
});
