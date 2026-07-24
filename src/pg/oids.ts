export type TsTypeInfo = {
  ts: string;
  bigint?: boolean;
};

export type ArrayElementNullability = "non-null" | "nullable" | "unknown";

export function arrayTsType(elementTs: string, nullability: ArrayElementNullability = "unknown"): string {
  return `(${elementTs}${nullability === "non-null" ? "" : " | null"})[]`;
}

const JSON_VALUE = 'import("@onreza/sqlx-js").JsonValue';
const PG_TEMPORAL = 'import("@onreza/sqlx-js").PgTemporal';

const SCALAR: Record<number, TsTypeInfo> = {
  16: { ts: "boolean" },
  17: { ts: "Uint8Array" },
  18: { ts: "string" },
  19: { ts: "string" },
  20: { ts: "bigint", bigint: true },
  21: { ts: "number" },
  22: { ts: "string" },
  23: { ts: "number" },
  24: { ts: "string" },
  25: { ts: "string" },
  26: { ts: "number" },
  27: { ts: "string" },
  28: { ts: "string" },
  29: { ts: "string" },
  30: { ts: "string" },
  114: { ts: JSON_VALUE },
  142: { ts: "string" },
  600: { ts: "string" },
  601: { ts: "string" },
  602: { ts: "string" },
  603: { ts: "string" },
  604: { ts: "string" },
  628: { ts: "string" },
  650: { ts: "string" },
  700: { ts: "number" },
  701: { ts: "number" },
  718: { ts: "string" },
  774: { ts: "string" },
  790: { ts: "string" },
  829: { ts: "string" },
  869: { ts: "string" },
  1033: { ts: "string" },
  1042: { ts: "string" },
  1043: { ts: "string" },
  1082: { ts: PG_TEMPORAL },
  1083: { ts: "string" },
  1114: { ts: PG_TEMPORAL },
  1184: { ts: PG_TEMPORAL },
  1186: { ts: "string" },
  1266: { ts: "string" },
  1560: { ts: "string" },
  1562: { ts: "string" },
  1700: { ts: "string" },
  1790: { ts: "string" },
  2202: { ts: "string" },
  2203: { ts: "string" },
  2204: { ts: "string" },
  2205: { ts: "string" },
  2206: { ts: "string" },
  2249: { ts: "string" },
  2278: { ts: "void" },
  2950: { ts: "string" },
  2970: { ts: "string" },
  3220: { ts: "string" },
  3614: { ts: "string" },
  3615: { ts: "string" },
  3642: { ts: "string" },
  3734: { ts: "string" },
  3769: { ts: "string" },
  3802: { ts: JSON_VALUE },
  3904: { ts: "string" },
  3906: { ts: "string" },
  3908: { ts: "string" },
  3910: { ts: "string" },
  3912: { ts: "string" },
  3926: { ts: "string" },
  4072: { ts: "string" },
  4089: { ts: "string" },
  4096: { ts: "string" },
  4191: { ts: "string" },
  4451: { ts: "string" },
  4532: { ts: "string" },
  4533: { ts: "string" },
  4534: { ts: "string" },
  4535: { ts: "string" },
  4536: { ts: "string" },
  5038: { ts: "string" },
  5069: { ts: "bigint", bigint: true },
};

const ARRAY: Record<number, number> = {
  143: 142,
  199: 114,
  271: 5069,
  629: 628,
  651: 650,
  719: 718,
  775: 774,
  791: 790,
  1000: 16,
  1001: 17,
  1002: 18,
  1003: 19,
  1005: 21,
  1006: 22,
  1007: 23,
  1008: 24,
  1009: 25,
  1010: 27,
  1011: 28,
  1012: 29,
  1013: 30,
  1014: 1042,
  1015: 1043,
  1016: 20,
  1017: 600,
  1018: 601,
  1019: 602,
  1020: 603,
  1021: 700,
  1022: 701,
  1027: 604,
  1028: 26,
  1034: 1033,
  1040: 829,
  1041: 869,
  1115: 1114,
  1182: 1082,
  1183: 1083,
  1185: 1184,
  1187: 1186,
  1231: 1700,
  1270: 1266,
  1561: 1560,
  1563: 1562,
  2201: 1790,
  2207: 2202,
  2208: 2203,
  2209: 2204,
  2210: 2205,
  2211: 2206,
  2949: 2970,
  2951: 2950,
  3221: 3220,
  3643: 3614,
  3644: 3642,
  3645: 3615,
  3735: 3734,
  3770: 3769,
  3807: 3802,
  3905: 3904,
  3907: 3906,
  3909: 3908,
  3911: 3910,
  3913: 3912,
  3927: 3926,
  4073: 4072,
  4090: 4089,
  4097: 4096,
  4192: 4191,
  5039: 5038,
  6150: 4451,
  6151: 4532,
  6152: 4533,
  6153: 4534,
  6155: 4535,
  6157: 4536,
};

export function oidToTs(oid: number): TsTypeInfo {
  const direct = SCALAR[oid];
  if (direct) return direct;
  const inner = ARRAY[oid];
  if (inner !== undefined) {
    const t = SCALAR[inner];
    return { ts: arrayTsType(t?.ts ?? "unknown"), bigint: t?.bigint };
  }
  return { ts: "unknown" };
}

export function isBuiltinOid(oid: number): boolean {
  return SCALAR[oid] !== undefined || ARRAY[oid] !== undefined;
}

export function builtinArrayOids(): number[] {
  return Object.keys(ARRAY).map(Number);
}

export function arrayElementOid(oid: number): number | undefined {
  return ARRAY[oid];
}

export type ResolveTs = (oid: number) => string;

export function makeResolver(custom: (oid: number) => string | undefined): ResolveTs {
  return (oid: number) => {
    const c = custom(oid);
    if (c !== undefined) return c;
    return oidToTs(oid).ts;
  };
}
