export const JSON_NUMBER_LIMITS = Object.freeze({
  integerDigits: 131_072,
  fractionDigits: 16_383,
  tokenLength: 131_072 + 16_383 + 16,
});

export function canonicalJsonNumber(value: string): string {
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
  if (firstNonZero === -1) return "0";
  digits = digits.slice(firstNonZero);
  decimalPosition -= firstNonZero;
  let canonical: string;
  let integerDigits: number;
  let fractionDigits: number;
  if (decimalPosition <= 0) {
    integerDigits = 0;
    fractionDigits = -decimalPosition + digits.length;
    canonical = `0.${"0".repeat(-decimalPosition)}${digits}`;
  } else if (decimalPosition >= digits.length) {
    integerDigits = decimalPosition;
    fractionDigits = 0;
    canonical = digits + "0".repeat(decimalPosition - digits.length);
  } else {
    integerDigits = decimalPosition;
    fractionDigits = digits.length - decimalPosition;
    canonical = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
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
  return sign ? `-${canonical}` : canonical;
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
