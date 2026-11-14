import type { EmbeddedDocument, GqlNode } from "./types.js";

export type FixLike = { range: [number, number]; text: string };

export type FixerShim = {
  insertTextBefore(node: GqlNode, text: string): FixLike;
  insertTextBeforeRange(range: [number, number], text: string): FixLike;
  insertTextAfter(node: GqlNode, text: string): FixLike;
  insertTextAfterRange(range: [number, number], text: string): FixLike;
  remove(node: GqlNode): FixLike;
  removeRange(range: [number, number]): FixLike;
  replaceText(node: GqlNode, text: string): FixLike;
  replaceTextRange(range: [number, number], text: string): FixLike;
};

type FixFn = (fixer: FixerShim) => FixLike | FixLike[] | Iterable<FixLike> | null | undefined;

/** A bare `{ line, column }` point, as used by e.g. graphql-eslint's `REPORT_ON_FIRST_CHARACTER`
 *  and `node.loc.start` when passed directly as `loc:`. */
export type GqlPoint = { line: number; column: number };

export type GqlLocRange = { start: GqlPoint; end?: GqlPoint };

/** The message-carrying fields of a report descriptor or suggestion, exactly as a rule wrote them.
 *  Forwarded to oxlint untouched: oxlint resolves `messageId` against the rule's `meta.messages`
 *  and interpolates `data` itself, with the same `{{ key }}` syntax ESLint uses. */
export type MessageFields = {
  message?: string;
  messageId?: string;
  data?: Record<string, unknown>;
};

export type GqlReportDescriptor = MessageFields & {
  node?: GqlNode;
  /** Either a full `{ start, end? }` range or a bare `{ line, column }` point — real
   *  graphql-eslint rules use both (see `normalizeLoc` below). */
  loc?: GqlLocRange | GqlPoint;
  fix?: FixFn;
  suggest?: Array<Omit<MessageFields, "message"> & { desc?: string; fix: FixFn }>;
};

export type MappedDiagnostic = MessageFields & {
  loc: { start: { line: number; column: number }; end?: { line: number; column: number } };
  fix?: () => FixLike[];
  suggest?: Array<Omit<MessageFields, "message"> & { desc?: string; fix: () => FixLike[] }>;
};

const FIXER: FixerShim = {
  insertTextBefore: (node, text) => ({ range: [node.range[0], node.range[0]], text }),
  insertTextBeforeRange: (range, text) => ({ range: [range[0], range[0]], text }),
  insertTextAfter: (node, text) => ({ range: [node.range[1], node.range[1]], text }),
  insertTextAfterRange: (range, text) => ({ range: [range[1], range[1]], text }),
  remove: (node) => ({ range: [node.range[0], node.range[1]], text: "" }),
  removeRange: (range) => ({ range: [range[0], range[1]], text: "" }),
  replaceText: (node, text) => ({ range: [node.range[0], node.range[1]], text }),
  replaceTextRange: (range, text) => ({ range: [range[0], range[1]], text }),
};

export function createReportMapper(options: {
  document: EmbeddedDocument;
  emit: (diagnostic: MappedDiagnostic) => void;
}): (descriptor: GqlReportDescriptor) => void {
  const { document, emit } = options;

  return (descriptor) => {
    const rawLoc = descriptor.loc ?? descriptor.node?.loc;
    if (!rawLoc) throw new Error("report descriptor must have a node or a loc");
    const loc = normalizeLoc(rawLoc);

    const diagnostic: MappedDiagnostic = {
      ...messageFieldsOf(descriptor),
      loc: {
        start: { line: loc.start.line + document.lineOffset, column: loc.start.column },
        ...(loc.end
          ? { end: { line: loc.end.line + document.lineOffset, column: loc.end.column } }
          : {}),
      },
    };

    if (descriptor.fix) {
      const fix = descriptor.fix;
      diagnostic.fix = () => shiftFixes(fix, document);
    }

    if (descriptor.suggest && descriptor.suggest.length > 0) {
      diagnostic.suggest = descriptor.suggest.map((suggestion) => ({
        ...messageFieldsOf(suggestion),
        fix: () => shiftFixes(suggestion.fix, document),
      }));
    }

    emit(diagnostic);
  };
}

/**
 * Normalizes a report descriptor's `loc` to always have a `.start`, mirroring ESLint's own
 * `normalizeReportLoc` (node_modules/eslint/lib/linter/file-report.js): `descriptor.loc.start
 * ? descriptor.loc : { start: descriptor.loc, end: null }`. Real graphql-eslint rules pass a
 * bare `{ line, column }` point as `loc` (e.g. `REPORT_ON_FIRST_CHARACTER` in
 * graphql-js-validation.js / match-document-filename/index.js / relay-page-info/index.js, and
 * `node.loc.start` in description-style/index.js), not only the `{ start, end? }` shape.
 */
function normalizeLoc(loc: GqlLocRange | GqlPoint): GqlLocRange {
  if ("start" in loc && loc.start) return loc;
  return { start: loc as GqlPoint };
}

/**
 * Runs a rule's `fix` function and shifts the fix(es) it returns onto host-file coordinates.
 * When more than one fix comes back from a single call, this reproduces ESLint's own
 * `mergeFixes` (node_modules/eslint/lib/linter/file-report.js): they are collapsed into ONE
 * fix spanning the earliest start to the latest end, splicing in the document's own untouched
 * text for any gap between the individual fixes. ESLint never hands multiple disjoint fixes
 * down from a single report — only graphql-eslint's `alphabetize` rule (a `*fix(fixer)`
 * generator that yields two `replaceTextRange` fixes to swap two fields) actually exercises
 * this among the real rules, so behavioural parity requires the same collapse here rather than
 * shifting-and-passing-through each fix separately.
 */
function shiftFixes(fix: FixFn, document: EmbeddedDocument): FixLike[] {
  const result = fix(FIXER);
  if (result === null || result === undefined) return [];
  const rawFixes = isFix(result) ? [result] : Array.from(result as Iterable<FixLike>);
  if (rawFixes.length === 0) return [];
  const merged = rawFixes.length === 1 ? rawFixes[0]! : mergeFixes(rawFixes, document.text);
  return [{ range: [merged.range[0] + document.offset, merged.range[1] + document.offset], text: merged.text }];
}

function mergeFixes(fixes: FixLike[], documentText: string): FixLike {
  const sorted = [...fixes].sort((a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1]);
  const start = sorted[0]!.range[0];
  const end = sorted[sorted.length - 1]!.range[1];
  let text = "";
  let lastPos = Number.MIN_SAFE_INTEGER;
  for (const item of sorted) {
    if (item.range[0] < lastPos) {
      throw new Error("Fix objects must not be overlapped in a report.");
    }
    if (item.range[0] >= 0) {
      text += documentText.slice(Math.max(0, start, lastPos), item.range[0]);
    }
    text += item.text;
    lastPos = item.range[1];
  }
  text += documentText.slice(Math.max(0, start, lastPos), end);
  return { range: [start, end], text };
}

function isFix(value: FixLike | FixLike[] | Iterable<FixLike>): value is FixLike {
  return !Array.isArray(value) && typeof (value as FixLike).text === "string";
}

/**
 * Copies only the message fields a descriptor actually has, so an absent one stays absent rather
 * than becoming an explicit `undefined` key (oxlint checks `Object.hasOwn` for `messageId` and
 * `data`).
 */
type ForwardedMessageFields = MessageFields & { desc?: string };

function messageFieldsOf(descriptor: ForwardedMessageFields): ForwardedMessageFields {
  const fields: ForwardedMessageFields = {};
  if (descriptor.message !== undefined) fields.message = descriptor.message;
  if (descriptor.desc !== undefined) fields.desc = descriptor.desc;
  if (descriptor.messageId !== undefined) fields.messageId = descriptor.messageId;
  if (descriptor.data !== undefined) fields.data = descriptor.data;
  return fields;
}
