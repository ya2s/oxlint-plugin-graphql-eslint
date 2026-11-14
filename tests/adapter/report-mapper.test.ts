import { describe, expect, it, vi } from "vitest";
import { createReportMapper } from "../../src/adapter/report-mapper.js";
import type { EmbeddedDocument, GqlNode } from "../../src/adapter/types.js";

const document: EmbeddedDocument = {
  filePath: "/repo/app.ts/0_document.graphql",
  text: "{ id }",
  lineOffset: 2,
  offset: 15,
};

const node: GqlNode = {
  type: "Field",
  loc: { start: { line: 1, column: 2 }, end: { line: 1, column: 4 } },
  range: [2, 4],
} as GqlNode;

describe("createReportMapper", () => {
  it("shifts lines by the document's line offset and leaves columns alone", () => {
    const emit = vi.fn();
    const report = createReportMapper({ document, emit });

    report({ node, message: "boom" });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "boom",
        loc: { start: { line: 3, column: 2 }, end: { line: 3, column: 4 } },
      }),
    );
  });

  // oxlint itself resolves `messageId` and interpolates `data`, so they must reach it untouched
  // (and an absent field must stay absent, not become an explicit `undefined` key).
  it("passes messageId and data through untouched", () => {
    const emit = vi.fn();
    const report = createReportMapper({ document, emit });

    report({ node, messageId: "named", data: { name: "id" } });

    const diagnostic = emit.mock.calls[0]![0];
    expect(diagnostic.messageId).toBe("named");
    expect(diagnostic.data).toEqual({ name: "id" });
    expect(Object.hasOwn(diagnostic, "message")).toBe(false);
  });

  it("shifts fix ranges by the document's character offset", () => {
    const emit = vi.fn();
    const report = createReportMapper({ document, emit });

    report({ node, message: "boom", fix: (fixer) => fixer.replaceText(node, "name") });

    expect(emit.mock.calls[0]![0].fix!()).toEqual([{ range: [17, 19], text: "name" }]);
  });

  it("shifts suggestion fix ranges too", () => {
    const emit = vi.fn();
    const report = createReportMapper({ document, emit });

    report({
      node,
      message: "boom",
      suggest: [{ messageId: "s", data: { x: "name" }, fix: (fixer) => fixer.removeRange([0, 1]) }],
    });

    const suggestion = emit.mock.calls[0]![0].suggest![0]!;
    expect(suggestion.messageId).toBe("s");
    expect(suggestion.data).toEqual({ x: "name" });
    expect(Object.hasOwn(suggestion, "desc")).toBe(false);
    expect(suggestion.fix()).toEqual([{ range: [15, 16], text: "" }]);
  });

  it("accepts a descriptor with loc instead of node", () => {
    const emit = vi.fn();
    const report = createReportMapper({ document, emit });

    report({ loc: { start: { line: 1, column: 0 } }, message: "boom" });

    expect(emit.mock.calls[0]![0].loc).toEqual({ start: { line: 3, column: 0 } });
  });

  // Real graphql-eslint rules (e.g. graphql-js-validation.js, match-document-filename/index.js,
  // relay-page-info/index.js) report with `loc: REPORT_ON_FIRST_CHARACTER`, a bare
  // `{ column, line }` point rather than a `{ start, end? }` wrapper — description-style/index.js
  // does the same via `loc: isBlock ? node.loc : node.loc.start`. ESLint's own
  // node_modules/eslint/lib/linter/file-report.js `normalizeReportLoc` special-cases exactly
  // this: `descriptor.loc.start ? descriptor.loc : { start: descriptor.loc, end: null }`.
  it("accepts a bare { line, column } point as loc, matching real graphql-eslint call sites", () => {
    const emit = vi.fn();
    const report = createReportMapper({ document, emit });

    report({ loc: { line: 1, column: 0 }, message: "boom" });

    expect(emit.mock.calls[0]![0].loc).toEqual({ start: { line: 3, column: 0 } });
  });

  // graphql-eslint's `alphabetize` rule is the one real rule whose `fix` yields more than one
  // fix from a single report (a generator that yields two `replaceTextRange` fixes to swap two
  // fields). ESLint's `mergeFixes` (node_modules/eslint/lib/linter/file-report.js) always
  // collapses multiple fixes from one report into a single fix spanning the earliest start to
  // the latest end, splicing in the untouched source between them. We must reproduce that, not
  // just shift-and-pass-through each fix separately.
  it("merges multiple fixes from one report into a single fix, like ESLint's mergeFixes", () => {
    const emit = vi.fn();
    // document.text = "{ id }" -> indices: { =0, space=1, i=2, d=3, space=4, }=5
    const report = createReportMapper({ document, emit });

    report({
      node,
      message: "boom",
      fix: function* (fixer) {
        yield fixer.replaceTextRange([2, 4], "XX");
        yield fixer.replaceTextRange([0, 1], "Y");
      },
    });

    // Sorted by range start: [0,1) "Y" comes first, then untouched "{" is NOT sliced (start=0 so
    // Math.max(0, start=0, lastPos=MIN) => 0, slice(0,0) = ""), then "Y", then gap text between
    // fix1 end (1) and fix2 start (2) = text.slice(1,2) = " ", then "XX", then trailing gap
    // text.slice(4, end=4) = "".
    // Merged fix before offset: range [0, 4), text "Y XX"
    expect(emit.mock.calls[0]![0].fix!()).toEqual([{ range: [15, 19], text: "Y XX" }]);
  });

  it("throws when a report yields overlapping fixes, matching ESLint's mergeFixes assertion", () => {
    const emit = vi.fn();
    const report = createReportMapper({ document, emit });

    report({
      node,
      message: "boom",
      fix: function* (fixer) {
        yield fixer.replaceTextRange([0, 3], "A");
        yield fixer.replaceTextRange([2, 4], "B");
      },
    });

    expect(() => emit.mock.calls[0]![0].fix!()).toThrow(/overlap/);
  });
});
