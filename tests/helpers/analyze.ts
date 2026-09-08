import type { ColumnInfo, SchemaCache } from "../../src/pg/schema";
import type { FieldDescription } from "../../src/pg/wire";
import { oidToTs } from "../../src/pg/oids";

type TableDef = {
  schema?: string;
  name: string;
  oid: number;
  columns: { name: string; attno: number; notNull: boolean; typeOid?: number }[];
};

export function fakeSchema(tables: TableDef[]): SchemaCache {
  const byOidAttno = new Map<string, ColumnInfo>();
  const byName = new Map<string, number>();
  const byOid = new Map<number, Map<string, ColumnInfo>>();
  const oidToName = new Map<number, { schema: string; name: string }>();
  for (const t of tables) {
    const schema = t.schema ?? "public";
    byName.set(`${schema}.${t.name}`, t.oid);
    oidToName.set(t.oid, { schema, name: t.name });
    const cols = new Map<string, ColumnInfo>();
    for (const c of t.columns) {
      const info: ColumnInfo = {
        attrelid: t.oid,
        attnum: c.attno,
        notNull: c.notNull,
        typeOid: c.typeOid ?? 23,
        name: c.name,
      };
      cols.set(c.name, info);
      byOidAttno.set(`${t.oid}/${c.attno}`, info);
    }
    byOid.set(t.oid, cols);
  }
  return {
    loadTableNames: async () => {},
    loadAttributes: async () => {},
    loadColumnsForTables: async () => {},
    loadTableNamesByOid: async () => {},
    loadCustomTypes: async () => {},
    resolveTable: (s: string | undefined, n: string) => byName.get(`${s ?? "public"}.${n}`),
    isNotNull: (oid: number, attno: number) => byOidAttno.get(`${oid}/${attno}`)?.notNull,
    columnNameByAttno: (oid: number, attno: number) => byOidAttno.get(`${oid}/${attno}`)?.name,
    columnsOf: (oid: number) => byOid.get(oid),
    tableNameByOid: (oid: number) => oidToName.get(oid),
    customType: () => undefined,
    tsType: (oid: number) => oidToTs(oid).ts,
    arrayElement: (oid: number) => oid === 1007
      ? { typeOid: 23, tsType: "number", nullability: "unknown" as const }
      : undefined,
    setTypeRegistry: () => {},
  } as unknown as SchemaCache;
}

export function rowDesc(parts: { name: string; tableOid?: number; attno?: number; typeOid?: number }[]): FieldDescription[] {
  return parts.map((p) => ({
    name: p.name,
    tableOid: p.tableOid ?? 0,
    columnAttr: p.attno ?? 0,
    typeOid: p.typeOid ?? 23,
    typeSize: 4,
    typeModifier: -1,
    format: 0,
  }));
}
