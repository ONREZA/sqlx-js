import ts from "typescript";
import type { QueryResultAssertions, QueryValidationExpectation } from "../query";

export type ScannedQueryOptions = {
  nullableParams?: number[];
  expectedValidation?: QueryValidationExpectation;
  resultAssertions?: QueryResultAssertions;
  timestampWithoutTimeZone?: "allow" | "reject";
  temporalReason?: string;
};

type Fail = (node: ts.Node, message: string) => never;

export function parseQueryDefinitionOptions(
  node: ts.Expression | undefined,
  paramNames: readonly string[],
  positionalCount: number,
  queryName: string | undefined,
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
    if (name === "resultAssertions") {
      result.resultAssertions = parseResultAssertions(property.initializer, fail);
      continue;
    }
    if (name === "temporal") {
      const temporal = parseTemporalOptions(property.initializer, queryName, fail);
      result.timestampWithoutTimeZone = temporal.mode;
      if (temporal.reason) result.temporalReason = temporal.reason;
      continue;
    }
    fail(property.name, `defineQuery() has unknown option ${JSON.stringify(name)}`);
  }
  return result;
}

function parseResultAssertions(node: ts.Expression, fail: Fail): QueryResultAssertions {
  if (!ts.isObjectLiteralExpression(node)) {
    fail(node, "defineQuery() resultAssertions must be an object literal");
  }
  const assertions = new Map<string, { elements: "non-null" }>();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      fail(property, "defineQuery() resultAssertions must use property assignments");
    }
    const column = propertyName(property.name, fail);
    if (!column) fail(property.name, "defineQuery() resultAssertions column names must not be empty");
    if (assertions.has(column)) {
      fail(property.name, `defineQuery() resultAssertions column ${JSON.stringify(column)} is duplicated`);
    }
    if (!ts.isObjectLiteralExpression(property.initializer)) {
      fail(property.initializer, `defineQuery() resultAssertions.${column} must be an object literal`);
    }
    const entries = property.initializer.properties;
    if (entries.length !== 1 || !ts.isPropertyAssignment(entries[0]!)) {
      fail(property.initializer, `defineQuery() resultAssertions.${column} must be { elements: \"non-null\" }`);
    }
    const assertionName = propertyName(entries[0].name, fail);
    if (
      assertionName !== "elements"
      || !ts.isStringLiteralLike(entries[0].initializer)
      || entries[0].initializer.text !== "non-null"
    ) {
      fail(entries[0], `defineQuery() resultAssertions.${column} must be { elements: \"non-null\" }`);
    }
    assertions.set(column, { elements: "non-null" });
  }
  return Object.fromEntries([...assertions].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function parseTemporalOptions(
  node: ts.Expression,
  queryName: string | undefined,
  fail: Fail,
): { mode: "allow" | "reject"; reason?: string } {
  if (!ts.isObjectLiteralExpression(node)) {
    fail(node, "defineQuery() temporal must be an object literal");
  }
  if (node.properties.length !== 1) {
    fail(node, "defineQuery() temporal must contain timestampWithoutTimeZone");
  }
  const property = node.properties[0]!;
  if (!ts.isPropertyAssignment(property)) {
    fail(property, "defineQuery() temporal must use a property assignment");
  }
  if (propertyName(property.name, fail) !== "timestampWithoutTimeZone") {
    fail(property.name, "defineQuery() temporal has an unknown option");
  }
  if (ts.isStringLiteralLike(property.initializer) && property.initializer.text === "reject") {
    return { mode: "reject" };
  }
  if (!ts.isObjectLiteralExpression(property.initializer)) {
    fail(
      property.initializer,
      "defineQuery() temporal.timestampWithoutTimeZone must be \"reject\" or { allow: true, reason: string }",
    );
  }
  const values = new Map<string, ts.Expression>();
  for (const nested of property.initializer.properties) {
    if (!ts.isPropertyAssignment(nested)) {
      fail(nested, "defineQuery() temporal allow must use property assignments");
    }
    const name = propertyName(nested.name, fail);
    if (name !== "allow" && name !== "reason") {
      fail(nested.name, `defineQuery() temporal allow has unknown option ${JSON.stringify(name)}`);
    }
    if (values.has(name)) fail(nested.name, `defineQuery() temporal allow option ${JSON.stringify(name)} is duplicated`);
    values.set(name, nested.initializer);
  }
  const allow = values.get("allow");
  const reason = values.get("reason");
  if (allow?.kind !== ts.SyntaxKind.TrueKeyword) {
    fail(allow ?? property.initializer, "defineQuery() temporal allow must set allow: true");
  }
  if (!reason || !ts.isStringLiteralLike(reason) || reason.text.trim() === "") {
    fail(reason ?? property.initializer, "defineQuery() temporal allow requires a non-empty literal reason");
  }
  if (!queryName) {
    fail(property.initializer, "defineQuery() temporal allow requires a named query");
  }
  return { mode: "allow", reason: reason.text };
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
