import type { SchemaCache } from "./schema";
import type { ArrayElementNullability } from "./oids";
import type { NonNullSet } from "./narrow";

export type AliasInfo = { columnAliases?: readonly string[] } & (
  | { kind: "table"; schema?: string; relname: string; joinNullable: boolean; returning?: { nonNullColumns: ReadonlySet<string> } }
  | { kind: "subquery"; joinNullable: boolean; columns: readonly NamedColumn[] }
  | { kind: "cte"; joinNullable: boolean; columns: readonly NamedColumn[] }
  | { kind: "function"; joinNullable: boolean }
);

export type ColumnSource = { schema: string; table: string; column: string };
export type AnalyzedColumn = {
  nullable: boolean;
  sources: ColumnSource[] | null;
  arrayElementNullability: ArrayElementNullability;
};
export type NamedColumn = readonly [name: string, column: AnalyzedColumn];
export type CteColumnInfo = Map<string, readonly NamedColumn[]>;

export type Scope = {
  aliases: Map<string, AliasInfo>;
  aliasOidByName: Map<string, number>;
  tableRefsByOid: Map<number, AliasInfo[]>;
  unqualifiedStarAlias: string | undefined;
  schema: SchemaCache;
  forcedNonNull: NonNullSet;
  cteColumnInfo: CteColumnInfo;
};

export type AnalysisResult = {
  perColumnNullable: boolean[];
  perColumnSources: (ColumnSource[] | null)[];
  perColumnArrayElementNullability: ArrayElementNullability[];
  referencedTables: { schema?: string; name: string }[];
  degraded?: { reason: string };
};
