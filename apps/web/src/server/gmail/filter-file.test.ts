import { describe, expect, it } from "vitest";
import { rulesFile } from "./filter-file";
import { UnrenderableRuleError } from "./rules";

const AT = new Date("2026-10-12T23:57:32.123Z");

/**
 * Brood's rules as Gmail's own filter file (#1108). The expected text is the
 * shape Gmail's Export wrote for the filters Brood installed in a real mailbox
 * (on #1108), with invented values and without the rule's tag.
 */
describe("Brood's rules as Gmail's filter file", () => {
  it("writes each rule as Gmail's export writes the ones Brood installed", () => {
    expect(
      rulesFile(
        [
          {
            scope: {
              from: { kind: "domain", value: "shop.test" },
              exclude: ["no-reply@accounts.example.com"],
              excludeCc: ["alert@example.com"],
            },
            path: "external/shop",
            quieted: false,
          },
        ],
        AT,
      ),
    ).toBe(
      [
        "<?xml version='1.0' encoding='UTF-8'?>",
        "<feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='http://schemas.google.com/apps/2006'>",
        "\t<title>Mail Filters</title>",
        "\t<id>tag:mail.google.com,2008:filters:1</id>",
        "\t<updated>2026-10-12T23:57:32Z</updated>",
        "\t<entry>",
        "\t\t<category term='filter'></category>",
        "\t\t<title>Mail Filter</title>",
        "\t\t<id>tag:mail.google.com,2008:filter:1</id>",
        "\t\t<updated>2026-10-12T23:57:32Z</updated>",
        "\t\t<content></content>",
        "\t\t<apps:property name='hasTheWord' value='from:shop.test'/>",
        "\t\t<apps:property name='doesNotHaveTheWord' value='from:no-reply@accounts.example.com OR cc:alert@example.com'/>",
        "\t\t<apps:property name='label' value='brood/ext/shop'/>",
        "\t\t<apps:property name='shouldArchive' value='true'/>",
        "\t</entry>",
        "</feed>",
        "",
      ].join("\n"),
    );
  });

  it("carries no tag of Brood's, so a filter made from it is the person's own", () => {
    const file = rulesFile(
      [
        {
          scope: {
            from: { kind: "address", value: "a@shop.test" },
            exclude: [],
          },
          path: "external/shop",
          quieted: false,
        },
      ],
      AT,
    );
    expect(file).not.toContain(".invalid");
    expect(file).not.toContain("doesNotHaveTheWord");
    expect(file).toContain("value='from:a@shop.test'");
  });

  it("names a quieted home where a quieted home is, and numbers each entry", () => {
    const file = rulesFile(
      [
        {
          scope: { from: { kind: "domain", value: "a.test" }, exclude: [] },
          path: "external/a",
          quieted: true,
        },
        {
          scope: { from: { kind: "domain", value: "b.test" }, exclude: [] },
          path: "external/b",
          quieted: false,
        },
      ],
      AT,
    );
    expect(file).toContain("value='brood/quieted/ext/a'");
    expect(file).toContain("value='brood/ext/b'");
    expect(file).toContain("<id>tag:mail.google.com,2008:filters:1,2</id>");
    expect(file).toContain("<id>tag:mail.google.com,2008:filter:2</id>");
  });

  it("writes an empty file for no rules", () => {
    expect(rulesFile([], AT)).not.toContain("<entry>");
  });

  it("refuses a value it cannot render rather than writing it roughly", () => {
    expect(() =>
      rulesFile(
        [
          {
            scope: {
              from: { kind: "domain", value: "shop.test' x='y" },
              exclude: [],
            },
            path: "external/shop",
            quieted: false,
          },
        ],
        AT,
      ),
    ).toThrow(UnrenderableRuleError);
  });
});
