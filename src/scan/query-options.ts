import ts from "typescript";
import type { QueryValidationExpectation } from "../query";

export type ScannedQueryOptions = {
  nullableParams?: number[];
  expectedValidation?: QueryValidationExpectation;
};

type Fail = (node: ts.Node, message: string) => never;

export function parseQueryDefinitionOptions(
  node: ts.Expression | undefined,
  paramNames: readonly string[],
  positionalCount: number,
  fail: Fail,
): ScannedQueryOptions {
  if (!node) return {};
  if (!ts.isObjectLiteralExpression(node)) {
    fail(node, "defineQuery() options must be an object literal");
  }
  const result: ScannedQueryOptions = {};
  const seen = new Set<string>();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      fail(property, "defineQuery() options must use property assignments");
    }
    const name = propertyName(property.name, fail);
    if (seen.has(name)) fail(property.name, `defineQuery() option ${JSON.stringify(name)} is duplicated`);
    seen.add(name);
    if (name === "nullableParams") {
      result.nullableParams = parseNullableParams(property.initializer, paramNames, positionalCount, fail);
      continue;
    }
    if (name === "expectedValidation") {
      if (!ts.isStringLiteralLike(property.initializer) || property.initializer.text !== "parse-only") {
        fail(property.initializer, "defineQuery() expectedValidation must be the string literal \"parse-only\"");
      }
      result.expectedValidation = "parse-only";
      continue;
    }
    fail(property.name, `defineQuery() has unknown option ${JSON.stringify(name)}`);
  }
  return result;
}

function parseNullableParams(
  node: ts.Expression,
  paramNames: readonly string[],
  positionalCount: number,
  fail: Fail,
): number[] {
  if (!ts.isArrayLiteralExpression(node)) {
    fail(node, "defineQuery() nullableParams must be an array literal");
  }
  const named = paramNames.length > 0;
  const indexes = node.elements.map((element) => {
    if (named) {
      if (!ts.isStringLiteralLike(element)) {
        fail(element, "defineQuery() nullableParams must use names for a named-parameter query");
      }
      const index = paramNames.indexOf(element.text);
      if (index < 0) {
        fail(element, `defineQuery() nullableParams references unknown parameter ${JSON.stringify(element.text)}`);
      }
      return index + 1;
    }
    if (!ts.isNumericLiteral(element)) {
      fail(element, "defineQuery() nullableParams must use 1-based indexes for a positional query");
    }
    const index = Number(element.text);
    if (!Number.isSafeInteger(index) || index < 1 || index > positionalCount) {
      fail(element, `defineQuery() nullableParams index must be between 1 and ${positionalCount}`);
    }
    return index;
  });
  if (new Set(indexes).size !== indexes.length) {
    fail(node, "defineQuery() nullableParams must be unique");
  }
  return indexes.sort((a, b) => a - b);
}

function propertyName(node: ts.PropertyName, fail: Fail): string {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return fail(node, "defineQuery() option names must be identifiers or string literals");
}
