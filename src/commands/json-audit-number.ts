import { JSON_NUMBER_LIMITS } from "../json-number";

export function renderCanonicalJsonNumberAnalysis(value: string): string {
  const maximumExponent = JSON_NUMBER_LIMITS.integerDigits + JSON_NUMBER_LIMITS.fractionDigits;
  return `SELECT
  CASE
    WHEN parsed.parts IS NULL
      OR pg_catalog.length(token.value) > ${JSON_NUMBER_LIMITS.tokenLength}
      OR positioned.exponent IS NULL
      OR pg_catalog.abs(positioned.exponent) > ${maximumExponent}
      THEN NULL
    WHEN positioned.first_non_zero = 0 THEN 1::bigint
    WHEN sized.integer_digits > ${JSON_NUMBER_LIMITS.integerDigits}
      OR sized.fraction_digits > ${JSON_NUMBER_LIMITS.fractionDigits}
      THEN NULL
    ELSE (
      pg_catalog.length(parsed.parts[1])
      + CASE WHEN sized.integer_digits = 0
        THEN 2 + sized.fraction_digits
        ELSE sized.integer_digits
          + CASE WHEN sized.fraction_digits > 0 THEN 1 + sized.fraction_digits ELSE 0 END
      END
    )::bigint
  END AS canonical_bytes
FROM (
  SELECT pg_catalog.btrim(${value}, E' \\t\\r\\n') AS value
) AS token
CROSS JOIN LATERAL (
  SELECT pg_catalog.regexp_match(
    CASE WHEN pg_catalog.length(token.value) <= ${JSON_NUMBER_LIMITS.tokenLength}
      THEN token.value
      ELSE NULL
    END,
    '^(-?)(0|[1-9][0-9]*)(?:\\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$'
  ) AS parts
) AS parsed
CROSS JOIN LATERAL (
  SELECT
    parsed.parts[2] || COALESCE(parsed.parts[3], '') AS digits,
    COALESCE(
      NULLIF(
        pg_catalog.ltrim(
          pg_catalog.regexp_replace(COALESCE(parsed.parts[4], '0'), '^[+-]', ''),
          '0'
        ),
        ''
      ),
      '0'
    ) AS exponent_digits,
    CASE WHEN pg_catalog.left(COALESCE(parsed.parts[4], '0'), 1) = '-'
      THEN -1 ELSE 1 END AS exponent_sign
) AS components
CROSS JOIN LATERAL (
  SELECT
    pg_catalog.regexp_instr(components.digits, '[1-9]') AS first_non_zero,
    CASE WHEN pg_catalog.length(components.exponent_digits) <= ${String(maximumExponent).length}
      THEN components.exponent_digits::integer * components.exponent_sign
      ELSE NULL
    END AS exponent
) AS positioned
CROSS JOIN LATERAL (
  SELECT
    pg_catalog.length(components.digits) - positioned.first_non_zero + 1 AS significant_digits,
    pg_catalog.length(parsed.parts[2]) + positioned.exponent
      - (positioned.first_non_zero - 1) AS decimal_position
) AS shifted
CROSS JOIN LATERAL (
  SELECT
    CASE WHEN shifted.decimal_position <= 0 THEN 0
      ELSE shifted.decimal_position END AS integer_digits,
    CASE
      WHEN shifted.decimal_position <= 0
        THEN -shifted.decimal_position + shifted.significant_digits
      WHEN shifted.decimal_position >= shifted.significant_digits THEN 0
      ELSE shifted.significant_digits - shifted.decimal_position
    END AS fraction_digits
) AS sized`;
}

export function renderCanonicalJsonbNumberAnalysis(value: string): string {
  // Numeric's wire header exposes decimal weight and scale without expanding exponent notation.
  return `SELECT
  CASE WHEN header.ndigits = 0 THEN 1::bigint
    ELSE (
      CASE WHEN numeric_value.value < 0 THEN 1 ELSE 0 END
      + CASE WHEN header.weight < 0
        THEN 2 + header.dscale
        ELSE header.weight * 4
          + CASE WHEN header.first_digit < 10 THEN 1
            WHEN header.first_digit < 100 THEN 2
            WHEN header.first_digit < 1000 THEN 3
            ELSE 4
          END
          + CASE WHEN header.dscale > 0 THEN 1 + header.dscale ELSE 0 END
      END
    )::bigint
  END AS canonical_bytes
FROM (
  SELECT (${value})::pg_catalog.numeric AS value
) AS numeric_value
CROSS JOIN LATERAL (
  SELECT pg_catalog.numeric_send(numeric_value.value) AS value
) AS encoded_numeric
CROSS JOIN LATERAL (
  SELECT
    pg_catalog.get_byte(encoded_numeric.value, 0) * 256
      + pg_catalog.get_byte(encoded_numeric.value, 1) AS ndigits,
    pg_catalog.get_byte(encoded_numeric.value, 2) * 256
      + pg_catalog.get_byte(encoded_numeric.value, 3) AS unsigned_weight,
    pg_catalog.get_byte(encoded_numeric.value, 6) * 256
      + pg_catalog.get_byte(encoded_numeric.value, 7) AS dscale,
    CASE WHEN pg_catalog.octet_length(encoded_numeric.value) > 8
      THEN pg_catalog.get_byte(encoded_numeric.value, 8) * 256
        + pg_catalog.get_byte(encoded_numeric.value, 9)
      ELSE 0
    END AS first_digit
) AS raw_header
CROSS JOIN LATERAL (
  SELECT
    raw_header.ndigits,
    raw_header.unsigned_weight
      - CASE WHEN raw_header.unsigned_weight >= 32768 THEN 65536 ELSE 0 END AS weight,
    raw_header.dscale,
    raw_header.first_digit
) AS header`;
}
