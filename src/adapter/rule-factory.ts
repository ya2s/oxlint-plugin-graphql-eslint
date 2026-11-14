import { defineRule } from "@oxlint/plugins";
import type { Context, Rule } from "@oxlint/plugins";
import esquery from "esquery";
import { createRuleContext } from "./context.js";
import { parseDocuments } from "./parse.js";
import { createReportMapper } from "./report-mapper.js";
import type { GqlReportDescriptor } from "./report-mapper.js";
import { compareSpecificity, parseSelector } from "./selectors.js";
import { createSourceCode } from "./source-code.js";
import { traverse } from "./traverse.js";
import type { GqlNode, ParsedDocument } from "./types.js";

export type GraphQLESLintRuleLike = {
  meta: {
    messages?: Record<string, string>;
    fixable?: "code" | "whitespace";
    hasSuggestions?: boolean;
    schema?: unknown;
    docs?: { description?: string };
  };
  create(context: unknown): Record<string, ((node: GqlNode) => void) | undefined>;
};

export function readSchemaSdl(settings: Readonly<Record<string, unknown>>): string | undefined {
  const graphql = settings.graphql as { schemaSdl?: unknown } | undefined;
  return typeof graphql?.schemaSdl === "string" ? graphql.schemaSdl : undefined;
}

export function toOxlintRule(ruleId: string, rule: GraphQLESLintRuleLike): Rule {
  return defineRule({
    meta: {
      fixable: rule.meta.fixable,
      hasSuggestions: rule.meta.hasSuggestions,
      // Without forwarding the rule's own options schema, oxlint rejects any config that passes
      // options at all ("Rule '<id>' does not accept options") — measured running no-root-type
      // (which requires a `disallow` option) through `oxlintrc.json`.
      schema: rule.meta.schema,
      // oxlint resolves every forwarded `messageId` against this table (see runRuleOnDocument),
      // so it must be forwarded for any report that uses one.
      messages: rule.meta.messages,
      docs: { description: rule.meta.docs?.description ?? ruleId },
    },
    createOnce(context) {
      return {
        Program() {
          let parsed: ParsedDocument[];
          try {
            parsed = parseDocuments({
              code: context.sourceCode.text,
              filePath: context.physicalFilename,
              schemaSdl: readSchemaSdl(context.settings as Readonly<Record<string, unknown>>),
            });
          } catch (error) {
            // A parse-time failure (e.g. graphql-config's `schema` pointing at a file that
            // doesn't exist) escapes parseDocuments as a raw, unattributed error -- unlike a
            // rule's own create()/visitor throwing, which wrapRuleError below already attributes.
            // Without this wrapper, the raw error reaches the user as graphql-eslint/graphql-config's
            // own 20-frame node_modules stack, with nothing saying which plugin or file caused it.
            // Wrapped the same way as a rule-execution error, for the same reason: attribution and
            // fail-fast, not a change in behavior (parsing still aborts the file either way).
            throw wrapRuleError(error, ruleId, context.physicalFilename);
          }

          for (const document of parsed) {
            if (document.kind !== "parsed") continue;
            runRuleOnDocument({ ruleId, rule, parsed: document, context });
          }
        },
      };
    },
  } as Parameters<typeof defineRule>[0]);
}

type VisitorObject = Record<string, ((node: GqlNode) => void) | undefined>;

/** esquery's own types come from `estree`, which GqlNode doesn't structurally satisfy (GraphQL
 *  AST node kinds aren't ESTree node kinds). The matcher logic itself is fully structural (it
 *  only ever reads `.type` and duck-typed fields), so a cast through this alias is safe. */
type EsqueryNode = Parameters<typeof esquery.matches>[0];

function runRuleOnDocument(input: {
  ruleId: string;
  rule: GraphQLESLintRuleLike;
  parsed: Extract<ParsedDocument, { kind: "parsed" }>;
  context: Context;
}): void {
  const { ruleId, rule, parsed, context } = input;

  const sourceCode = createSourceCode({
    text: parsed.document.text,
    ast: parsed.ast,
    services: parsed.services,
  });

  // `message`/`messageId`/`data` are passed through exactly as the rule wrote them: oxlint
  // resolves `messageId` against `meta.messages` (forwarded in `toOxlintRule` above) and
  // interpolates `data` with the same `{{ key }}` placeholder syntax as ESLint's `interpolate`,
  // so diagnostics keep their `messageId` and the rendered message matches ESLint's. Only the
  // location and fix ranges need translating onto the host file.
  const report = createReportMapper({
    document: parsed.document,
    emit: ({ fix, suggest, ...diagnostic }) => {
      context.report({
        ...diagnostic,
        ...(fix ? { fix: () => fix() } : {}),
        ...(suggest ? { suggest: suggest.map((s) => ({ ...s, fix: () => s.fix() })) } : {}),
      } as Parameters<Context["report"]>[0]);
    },
  });

  const ruleContext = createRuleContext({
    ruleId,
    options: context.options,
    settings: (context.settings ?? {}) as Readonly<Record<string, unknown>>,
    filename: parsed.document.filePath,
    physicalFilename: context.physicalFilename,
    sourceCode,
    report: report as (descriptor: GqlReportDescriptor) => void,
  });

  let visitor: VisitorObject;
  try {
    visitor = rule.create(ruleContext);
  } catch (error) {
    throw wrapRuleError(error, ruleId, context.physicalFilename);
  }

  try {
    runVisitor(parsed.ast, visitor);
  } catch (error) {
    throw wrapRuleError(error, ruleId, context.physicalFilename);
  }
}

/**
 * graphql-eslint rules register their visitors under ESLint-style esquery selector keys, not
 * only plain node-type names: e.g. no-anonymous-operations uses
 * `"OperationDefinition[name=undefined]"`, no-root-type uses
 * `":matches(ObjectTypeDefinition, ObjectTypeExtension) > .name[value=/^(...)$/]"`, and several
 * others use attribute selectors, field selectors (`.gqlType`), or comma-separated lists. A
 * naive `visitor[node.type]` dispatch — the obvious reading of Task 4's `traverse` callback
 * shape — silently drops every one of those listeners, including the plugin's own baseline
 * example rule (no-anonymous-operations). This mirrors ESLint's NodeEventGenerator: each
 * listener key is parsed once (and cached — see selectors.ts) as an esquery selector (a bare
 * type name like "Field" parses to an "identifier" selector, so plain-type listeners keep
 * working unchanged), then tested against the node with its ancestry — parent-first, which is
 * esquery's convention and the reverse of `traverse`'s root-first order — on enter, or on leave
 * for a `:exit`-suffixed key.
 *
 * When more than one selector matches the *same* node, ESLint fires them in ascending
 * specificity order (attribute/field count, then identifier count, then source as a tiebreak —
 * see selectors.ts's `compareSpecificity`), the same way for both the enter and exit phases.
 * Sorting each phase's listener list once, up front, produces that same relative order at every
 * node without needing ESLint's own per-node-type bucketing (an unneeded optimization here,
 * since this dispatch already just tests every listener against every node).
 */
function runVisitor(ast: GqlNode, visitor: VisitorObject): void {
  const listeners = Object.entries(visitor)
    .filter((entry): entry is [string, (node: GqlNode) => void] => typeof entry[1] === "function")
    .map(([key, fn]) => ({ selector: parseSelector(key), fn }));

  if (listeners.length === 0) return;

  const enterListeners = listeners.filter((l) => !l.selector.isExit).sort((a, b) => compareSpecificity(a.selector, b.selector));
  const exitListeners = listeners.filter((l) => l.selector.isExit).sort((a, b) => compareSpecificity(a.selector, b.selector));

  traverse(ast, {
    enter: (node, ancestors) => {
      const ancestry = ancestors.reverse() as unknown as EsqueryNode[];
      for (const listener of enterListeners) {
        if (esquery.matches(node as unknown as EsqueryNode, listener.selector.root, ancestry)) listener.fn(node);
      }
    },
    leave: (node, ancestors) => {
      const ancestry = ancestors.reverse() as unknown as EsqueryNode[];
      for (const listener of exitListeners) {
        if (esquery.matches(node as unknown as EsqueryNode, listener.selector.root, ancestry)) listener.fn(node);
      }
    },
  });
}

/** Exported so parse-error.ts (which also calls parseDocuments directly, from its own
 *  Program()) can attribute a parse-time failure the same way a rule-execution failure is
 *  attributed here. */
export function wrapRuleError(error: unknown, ruleId: string, filePath: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  // Do NOT overwrite `.stack` with the original error's stack: its first line repeats the
  // *original* message, so the wrapper text above (rule id + file path) would never be visible
  // to anything reading `.stack` (e.g. an uncaught-exception logger) — only `.message` would
  // carry it. `cause` preserves the original error (and its stack) for inspection without
  // clobbering ours.
  return new Error(`[oxlint-plugin-graphql-eslint] rule "${ruleId}" failed on ${filePath}: ${message}`, {
    cause: error,
  });
}
