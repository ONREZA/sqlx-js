export const JSON_NUMBER_LIMITS = Object.freeze({
  integerDigits: 131_072,
  fractionDigits: 16_383,
  tokenLength: 131_072 + 16_383 + 16,
});

type JsonNumberAnalysis = {
  sign: string;
  digits: string;
  decimalPosition: number;
  canonicalBytes: number;
};

export function canonicalJsonNumberBytes(value: string): number {
  return analyzeJsonNumber(value).canonicalBytes;
}

export function canonicalJsonNumber(value: string): string {
  const analysis = analyzeJsonNumber(value);
  if (analysis.digits === "0") return "0";
  const { sign, digits, decimalPosition } = analysis;
  let canonical: string;
  if (decimalPosition <= 0) {
    canonical = `0.${"0".repeat(-decimalPosition)}${digits}`;
  } else if (decimalPosition >= digits.length) {
    canonical = digits + "0".repeat(decimalPosition - digits.length);
  } else {
    canonical = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  }
  return sign ? `-${canonical}` : canonical;
}

export function assertJsonBigintDigits(value: string): void {
  const digits = value.startsWith("-") ? value.length - 1 : value.length;
  if (digits > JSON_NUMBER_LIMITS.integerDigits) {
    throw new Error(
      `sqlx-js: Extended JSON bigint exceeds ${JSON_NUMBER_LIMITS.integerDigits} decimal digits`,
    );
  }
}

function analyzeJsonNumber(value: string): JsonNumberAnalysis {
  if (value.length > JSON_NUMBER_LIMITS.tokenLength) {
    throw new Error(
      `sqlx-js: Extended JSON number token exceeds ${JSON_NUMBER_LIMITS.tokenLength} characters`,
    );
  }
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new Error(`sqlx-js: invalid JSON number ${quotedForError(value)}`);
  const sign = match[1]!;
  const integer = match[2]!;
  const fraction = match[3] ?? "";
  const exponent = parseExponent(match[4] ?? "0");
  let digits = integer + fraction;
  let decimalPosition = integer.length + exponent;
  const firstNonZero = digits.search(/[1-9]/);
  if (firstNonZero === -1) {
    return { sign: "", digits: "0", decimalPosition: 1, canonicalBytes: 1 };
  }
  digits = digits.slice(firstNonZero);
  decimalPosition -= firstNonZero;
  let integerDigits: number;
  let fractionDigits: number;
  if (decimalPosition <= 0) {
    integerDigits = 0;
    fractionDigits = -decimalPosition + digits.length;
  } else if (decimalPosition >= digits.length) {
    integerDigits = decimalPosition;
    fractionDigits = 0;
  } else {
    integerDigits = decimalPosition;
    fractionDigits = digits.length - decimalPosition;
  }
  if (
    integerDigits > JSON_NUMBER_LIMITS.integerDigits
    || fractionDigits > JSON_NUMBER_LIMITS.fractionDigits
  ) {
    throw new Error(
      "sqlx-js: Extended JSON number exceeds PostgreSQL jsonb numeric limits "
      + `(${JSON_NUMBER_LIMITS.integerDigits} integer digits, `
      + `${JSON_NUMBER_LIMITS.fractionDigits} fractional digits)`,
    );
  }
  const canonicalBytes = (sign ? 1 : 0)
    + (integerDigits === 0
      ? 2 + fractionDigits
      : integerDigits + (fractionDigits > 0 ? 1 + fractionDigits : 0));
  return { sign, digits, decimalPosition, canonicalBytes };
}

function parseExponent(value: string): number {
  const negative = value.startsWith("-");
  const digits = value.replace(/^[+-]?0*/, "") || "0";
  const maximum = JSON_NUMBER_LIMITS.integerDigits + JSON_NUMBER_LIMITS.fractionDigits;
  if (digits.length > String(maximum).length) {
    throw new Error("sqlx-js: Extended JSON number exponent exceeds PostgreSQL jsonb numeric limits");
  }
  const exponent = Number(digits) * (negative ? -1 : 1);
  if (Math.abs(exponent) > maximum) {
    throw new Error("sqlx-js: Extended JSON number exponent exceeds PostgreSQL jsonb numeric limits");
  }
  return exponent;
}

function quotedForError(value: string): string {
  const limit = 120;
  return JSON.stringify(value.length > limit ? `${value.slice(0, limit)}...` : value);
}
