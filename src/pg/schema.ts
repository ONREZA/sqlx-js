import { PgClient, decodeText } from "./wire";
import { isBuiltinOid, oidToTs } from "./oids";

export type ColumnInfo = {
  attrelid: number;
  attnum: number;
  notNull: boolean;
  name?: string;
};

export type EnumInfo = { kind: "enum"; name: string; values: string[] };
export type EnumArrayInfo = { kind: "enumArray"; element: EnumInfo };
export type ScalarInfo = { kind: "scalar"; name: string; tsType: string };
export type ScalarArrayInfo = { kind: "scalarArray"; name: string; element: ScalarInfo };
export type CustomTypeInfo = EnumInfo | EnumArrayInfo | ScalarInfo | ScalarArrayInfo;

export class SchemaCache {
  private byOidNum = new Map<string, ColumnInfo>();
  private nameToOid = new Map<string, number[]>();
  private oidToName = new Map<number, { schema: string; name: string }>();
  private columnsByOid = new Map<number, Map<string, ColumnInfo>>();
  private fullyLoaded = new Set<number>();
  private customTypes = new Map<number, CustomTypeInfo>();
  private typesProbed = new Set<number>();
  private typeRegistry: Record<string, string> = {};

  constructor(private client: PgClient) {}

  setTypeRegistry(registry: Record<string, string>): void {
    this.typeRegistry = registry;
  }

  async loadAttributes(refs: { tableOid: number; attno: number }[]): Promise<void> {
    const need = refs.filter((r) => r.tableOid !== 0 && r.attno !== 0 && !this.byOidNum.has(key(r.tableOid, r.attno)));
    if (need.length === 0) return;
    const seen = new Set<string>();
    const pairs: string[] = [];
    for (const r of need) {
      const k = key(r.tableOid, r.attno);
      if (seen.has(k)) continue;
      seen.add(k);
      pairs.push(`(${r.tableOid},${r.attno})`);
    }
    const sql = `SELECT attrelid::int8, attnum::int4, attnotnull, attname FROM pg_attribute WHERE (attrelid, attnum) IN (${pairs.join(",")})`;
    const r = await this.client.simpleQueryAll(sql);
    for (const row of r.rows) {
      const attrelid = Number(decodeText(row[0]!));
      const attnum = Number(decodeText(row[1]!));
      const notNull = decodeText(row[2]!) === "t";
      const name = decodeText(row[3]!) ?? undefined;
      this.byOidNum.set(key(attrelid, attnum), { attrelid, attnum, notNull, name });
    }
  }

  async loadTableNames(names: { schema?: string; name: string }[]): Promise<void> {
    const need: { schema: string; name: string }[] = [];
    for (const n of names) {
      const schema = n.schema ?? "public";
      const key = `${schema}.${n.name}`;
      if (!this.nameToOid.has(key)) need.push({ schema, name: n.name });
    }
    if (need.length === 0) return;
    const where = need.map((n) => `(n.nspname = ${quote(n.schema)} AND c.relname = ${quote(n.name)})`).join(" OR ");
    const sql = `SELECT c.oid::int8, n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${where}`;
    const r = await this.client.simpleQueryAll(sql);
    for (const row of r.rows) {
      const oid = Number(decodeText(row[0]!));
      const schema = decodeText(row[1]!)!;
      const name = decodeText(row[2]!)!;
      const k = `${schema}.${name}`;
      const arr = this.nameToOid.get(k) ?? [];
      arr.push(oid);
      this.nameToOid.set(k, arr);
      this.oidToName.set(oid, { schema, name });
    }
  }

  isNotNull(tableOid: number, attno: number): boolean | undefined {
    return this.byOidNum.get(key(tableOid, attno))?.notNull;
  }

  resolveTable(schema: string | undefined, name: string): number | undefined {
    const k = `${schema ?? "public"}.${name}`;
    const arr = this.nameToOid.get(k);
    return arr?.[0];
  }

  tableNameByOid(oid: number): { schema: string; name: string } | undefined {
    return this.oidToName.get(oid);
  }

  async loadTableNamesByOid(oids: number[]): Promise<void> {
    const need = [...new Set(oids.filter((o) => o > 0 && !this.oidToName.has(o)))];
    if (need.length === 0) return;
    const sql = `SELECT c.oid::int8, n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid IN (${need.join(",")})`;
    const r = await this.client.simpleQueryAll(sql);
    for (const row of r.rows) {
      const oid = Number(decodeText(row[0]!));
      const schema = decodeText(row[1]!)!;
      const name = decodeText(row[2]!)!;
      const k = `${schema}.${name}`;
      const arr = this.nameToOid.get(k) ?? [];
      if (!arr.includes(oid)) arr.push(oid);
      this.nameToOid.set(k, arr);
      this.oidToName.set(oid, { schema, name });
    }
  }

  columnNameByAttno(tableOid: number, attno: number): string | undefined {
    return this.byOidNum.get(key(tableOid, attno))?.name;
  }

  async loadColumnsForTables(tableOids: number[]): Promise<void> {
    const need = tableOids.filter((oid) => !this.fullyLoaded.has(oid));
    if (need.length === 0) return;
    const list = [...new Set(need)].join(",");
    const sql = `SELECT attrelid::int8, attnum::int4, attname, attnotnull FROM pg_attribute WHERE attrelid IN (${list}) AND attnum > 0 AND NOT attisdropped`;
    const r = await this.client.simpleQueryAll(sql);
    const grouped = new Map<number, Map<string, ColumnInfo>>();
    for (const row of r.rows) {
      const attrelid = Number(decodeText(row[0]!));
      const attnum = Number(decodeText(row[1]!));
      const attname = decodeText(row[2]!)!;
      const notNull = decodeText(row[3]!) === "t";
      const info: ColumnInfo = { attrelid, attnum, notNull, name: attname };
      this.byOidNum.set(key(attrelid, attnum), info);
      const m = grouped.get(attrelid) ?? new Map<string, ColumnInfo>();
      m.set(attname, info);
      grouped.set(attrelid, m);
    }
    for (const oid of need) {
      const m = grouped.get(oid) ?? new Map<string, ColumnInfo>();
      this.columnsByOid.set(oid, m);
      this.fullyLoaded.add(oid);
    }
  }

  columnsOf(tableOid: number): Map<string, ColumnInfo> | undefined {
    return this.columnsByOid.get(tableOid);
  }

  async loadCustomTypes(typeOids: number[]): Promise<void> {
    const need = typeOids.filter((oid) => oid > 0 && !this.typesProbed.has(oid));
    if (need.length === 0) return;
    for (const oid of need) this.typesProbed.add(oid);

    const list1 = [...new Set(need)].join(",");
    const sql1 = `SELECT oid::int8, typname, typtype, typcategory, typelem::int8, typbasetype::int8 FROM pg_type WHERE oid IN (${list1})`;
    const r1 = await this.client.simpleQueryAll(sql1);

    const enumOids: number[] = [];
    const arrayInfos: { arrayOid: number; arrayName: string; elemOid: number }[] = [];
    const domainInfos: { oid: number; name: string; baseOid: number }[] = [];

    for (const row of r1.rows) {
      const oid = Number(decodeText(row[0]!));
      const name = decodeText(row[1]!)!;
      const typtype = decodeText(row[2]!);
      const typcategory = decodeText(row[3]!);
      const typelem = Number(decodeText(row[4]!));
      const typbasetype = Number(decodeText(row[5]!));

      if (typtype === "e") {
        enumOids.push(oid);
        this.customTypes.set(oid, { kind: "enum", name, values: [] });
      } else if (typcategory === "A" && typelem > 0) {
        arrayInfos.push({ arrayOid: oid, arrayName: name, elemOid: typelem });
      } else if (typtype === "b" && this.typeRegistry[name]) {
        this.customTypes.set(oid, { kind: "scalar", name, tsType: this.typeRegistry[name]! });
      } else if (typtype === "d" && typbasetype > 0) {
        domainInfos.push({ oid, name, baseOid: typbasetype });
      }
    }

    const elemsToProbe = arrayInfos.map((a) => a.elemOid).filter((o) => !this.typesProbed.has(o));
    const basesToProbe = domainInfos.map((d) => d.baseOid).filter((o) => !this.typesProbed.has(o) && !isBuiltinOid(o));
    const recurse = [...new Set([...elemsToProbe, ...basesToProbe])];
    if (recurse.length > 0) await this.loadCustomTypes(recurse);

    for (const { oid, name, baseOid } of domainInfos) {
      const resolved = this.resolveBaseTs(baseOid);
      if (resolved) {
        this.customTypes.set(oid, { kind: "scalar", name, tsType: resolved });
      }
    }

    for (const { arrayOid, arrayName, elemOid } of arrayInfos) {
      const elem = this.customTypes.get(elemOid);
      if (elem && elem.kind === "enum") {
        this.customTypes.set(arrayOid, { kind: "enumArray", element: elem });
      } else if (elem && elem.kind === "scalar") {
        this.customTypes.set(arrayOid, { kind: "scalarArray", name: arrayName, element: elem });
      }
    }

    if (enumOids.length > 0) {
      const list2 = enumOids.join(",");
      const sql2 = `SELECT enumtypid::int8, enumlabel FROM pg_enum WHERE enumtypid IN (${list2}) ORDER BY enumtypid, enumsortorder`;
      const r2 = await this.client.simpleQueryAll(sql2);
      for (const row of r2.rows) {
        const oid = Number(decodeText(row[0]!));
        const label = decodeText(row[1]!)!;
        const t = this.customTypes.get(oid);
        if (t && t.kind === "enum") t.values.push(label);
      }
    }
  }

  private resolveBaseTs(baseOid: number): string | undefined {
    if (baseOid === 0) return undefined;
    if (isBuiltinOid(baseOid)) return oidToTs(baseOid).ts;
    const info = this.customTypes.get(baseOid);
    if (!info) return undefined;
    if (info.kind === "scalar") return info.tsType;
    if (info.kind === "scalarArray") return `(${info.element.tsType})[]`;
    if (info.kind === "enum") {
      if (info.values.length === 0) return "string";
      return info.values.map((v) => JSON.stringify(v)).join(" | ");
    }
    if (info.kind === "enumArray") {
      if (info.element.values.length === 0) return "string[]";
      return `(${info.element.values.map((v) => JSON.stringify(v)).join(" | ")})[]`;
    }
    return undefined;
  }

  customType(oid: number): CustomTypeInfo | undefined {
    return this.customTypes.get(oid);
  }
}

function key(oid: number, attno: number): string {
  return `${oid}/${attno}`;
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
