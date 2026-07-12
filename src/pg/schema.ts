import { PgClient, decodeText } from "./wire";
import { arrayElementOid, arrayTsType, isBuiltinOid, oidToTs, type ArrayElementNullability } from "./oids";

export type ColumnInfo = {
  attrelid: number;
  attnum: number;
  notNull: boolean;
  typeOid: number;
  name?: string;
};

export type EnumInfo = { kind: "enum"; name: string; values: string[] };
export type EnumArrayInfo = { kind: "enumArray"; element: EnumInfo };
export type ScalarInfo = { kind: "scalar"; name: string; tsType: string; notNull?: boolean; baseOid?: number };
export type ScalarArrayInfo = { kind: "scalarArray"; name: string; element: ScalarInfo };
export type CompositeField = { name: string; tsType: string; nullable: boolean };
export type CompositeInfo = { kind: "composite"; name: string; fields: CompositeField[] };
export type CompositeArrayInfo = { kind: "compositeArray"; name: string; element: CompositeInfo };
export type CustomTypeInfo =
  | EnumInfo
  | EnumArrayInfo
  | ScalarInfo
  | ScalarArrayInfo
  | CompositeInfo
  | CompositeArrayInfo;

export function compositeLiteral(info: CompositeInfo): string {
  if (info.fields.length === 0) return "Record<string, unknown>";
  const parts = info.fields.map((f) => {
    const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(f.name) ? f.name : JSON.stringify(f.name);
    return `${name}: ${f.tsType}${f.nullable ? " | null" : ""}`;
  });
  return `{ ${parts.join("; ")} }`;
}

export class SchemaCache {
  private byOidNum = new Map<string, ColumnInfo>();
  private nameToOid = new Map<string, number[]>();
  private oidToName = new Map<number, { schema: string; name: string }>();
  private columnsByOid = new Map<number, Map<string, ColumnInfo>>();
  private fullyLoaded = new Set<number>();
  private customTypes = new Map<number, CustomTypeInfo>();
  private customArrayElements = new Map<number, number>();
  private typesProbed = new Set<number>();
  private typeRegistry: Record<string, string> = {};
  private userTypeRegistry: Record<string, string> = {};

  constructor(private client: PgClient) {}

  setTypeRegistry(
    registry: Record<string, string>,
    userRegistry: Record<string, string> = {},
  ): void {
    this.typeRegistry = registry;
    this.userTypeRegistry = userRegistry;
  }

  async validateUserTypeRegistry(): Promise<void> {
    const names = Object.keys(this.userTypeRegistry).sort();
    if (names.length === 0) return;
    const literals = names.map((name) => `'${name.replace(/'/g, "''")}'`).join(", ");
    const result = await this.client.simpleQueryAll(`
      SELECT n.nspname, t.typname, t.typtype, t.typcategory
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname IN (${literals})
      ORDER BY n.nspname, t.typname
    `);
    const matches = new Map<string, { schema: string; kind: string; category: string }[]>();
    for (const row of result.rows) {
      const name = decodeText(row[1]!)!;
      const values = matches.get(name) ?? [];
      values.push({
        schema: decodeText(row[0]!)!,
        kind: decodeText(row[2]!)!,
        category: decodeText(row[3]!)!,
      });
      matches.set(name, values);
    }
    for (const name of names) {
      const types = matches.get(name) ?? [];
      if (types.length === 0) {
        throw new Error(`sqlx-js: customTypes type ${name} does not exist in the prepare database`);
      }
      if (types.some((type) =>
        type.schema === "pg_catalog"
        || type.schema === "information_schema"
        || type.schema.startsWith("pg_toast")
        || type.schema.startsWith("pg_temp_"))) {
        throw new Error(`sqlx-js: customTypes cannot override PostgreSQL system type ${name}`);
      }
      if (types.some((type) => type.kind === "d")) {
        throw new Error(
          `sqlx-js: customTypes cannot override PostgreSQL domain ${name} because PostgreSQL reports domain results as the base type`,
        );
      }
      if (types.some((type) => type.category === "A")) {
        throw new Error(`sqlx-js: customTypes must name the array element type, not PostgreSQL array type ${name}`);
      }
    }
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
    const sql = `SELECT attrelid::int8, attnum::int4, attnotnull, attname, atttypid::int8 FROM pg_attribute WHERE (attrelid, attnum) IN (${pairs.join(",")})`;
    const r = await this.client.simpleQueryAll(sql);
    for (const row of r.rows) {
      const attrelid = Number(decodeText(row[0]!));
      const attnum = Number(decodeText(row[1]!));
      const notNull = decodeText(row[2]!) === "t";
      const name = decodeText(row[3]!) ?? undefined;
      const typeOid = Number(decodeText(row[4]!));
      this.byOidNum.set(key(attrelid, attnum), { attrelid, attnum, notNull, typeOid, name });
    }
  }

  async loadTableNames(names: { schema?: string; name: string }[]): Promise<void> {
    const explicit: { schema: string; name: string }[] = [];
    const visible: string[] = [];
    for (const n of names) {
      if (n.schema) {
        if (!this.nameToOid.has(`${n.schema}.${n.name}`)) explicit.push({ schema: n.schema, name: n.name });
      } else if (!this.nameToOid.has(unqualifiedKey(n.name))) {
        visible.push(n.name);
      }
    }
    if (explicit.length > 0) {
      const where = explicit.map((n) => `(n.nspname = ${quote(n.schema)} AND c.relname = ${quote(n.name)})`).join(" OR ");
      const sql = `SELECT c.oid::int8, n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${where}`;
      const result = await this.client.simpleQueryAll(sql);
      for (const row of result.rows) this.recordTable(row);
    }
    if (visible.length > 0) {
      const requested = [...new Set(visible)].map(quote).join(",");
      const sql = `SELECT c.oid::int8, n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname IN (${requested}) AND pg_table_is_visible(c.oid)`;
      const result = await this.client.simpleQueryAll(sql);
      for (const row of result.rows) {
        this.recordTable(row, true);
      }
    }
  }

  isNotNull(tableOid: number, attno: number): boolean | undefined {
    return this.byOidNum.get(key(tableOid, attno))?.notNull;
  }

  resolveTable(schema: string | undefined, name: string): number | undefined {
    const k = schema ? `${schema}.${name}` : unqualifiedKey(name);
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
    for (const row of r.rows) this.recordTable(row);
  }

  private recordTable(row: (Uint8Array | null)[], visible = false): void {
    const oid = Number(decodeText(row[0]!));
    const schema = decodeText(row[1]!)!;
    const name = decodeText(row[2]!)!;
    const key = `${schema}.${name}`;
    const arr = this.nameToOid.get(key) ?? [];
    if (!arr.includes(oid)) arr.push(oid);
    this.nameToOid.set(key, arr);
    if (visible) this.nameToOid.set(unqualifiedKey(name), [oid]);
    this.oidToName.set(oid, { schema, name });
  }

  columnNameByAttno(tableOid: number, attno: number): string | undefined {
    return this.byOidNum.get(key(tableOid, attno))?.name;
  }

  async loadColumnsForTables(tableOids: number[]): Promise<void> {
    const need = tableOids.filter((oid) => !this.fullyLoaded.has(oid));
    if (need.length === 0) return;
    const list = [...new Set(need)].join(",");
    const sql = `SELECT attrelid::int8, attnum::int4, attname, attnotnull, atttypid::int8 FROM pg_attribute WHERE attrelid IN (${list}) AND attnum > 0 AND NOT attisdropped`;
    const r = await this.client.simpleQueryAll(sql);
    const grouped = new Map<number, Map<string, ColumnInfo>>();
    for (const row of r.rows) {
      const attrelid = Number(decodeText(row[0]!));
      const attnum = Number(decodeText(row[1]!));
      const attname = decodeText(row[2]!)!;
      const notNull = decodeText(row[3]!) === "t";
      const typeOid = Number(decodeText(row[4]!));
      const info: ColumnInfo = { attrelid, attnum, notNull, typeOid, name: attname };
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
    const need = typeOids.filter((oid) => oid > 0 && !isBuiltinOid(oid) && !this.typesProbed.has(oid));
    if (need.length === 0) return;
    for (const oid of need) this.typesProbed.add(oid);

    const list1 = [...new Set(need)].join(",");
    const sql1 = `SELECT oid::int8, typname, typtype, typcategory, typelem::int8, typbasetype::int8, typrelid::int8, typnotnull FROM pg_type WHERE oid IN (${list1})`;
    const r1 = await this.client.simpleQueryAll(sql1);

    const enumOids: number[] = [];
    const arrayInfos: { arrayOid: number; arrayName: string; elemOid: number }[] = [];
    const domainInfos: { oid: number; name: string; baseOid: number; notNull: boolean }[] = [];
    const compositeInfos: { oid: number; name: string; relOid: number }[] = [];

    for (const row of r1.rows) {
      const oid = Number(decodeText(row[0]!));
      const name = decodeText(row[1]!)!;
      const typtype = decodeText(row[2]!);
      const typcategory = decodeText(row[3]!);
      const typelem = Number(decodeText(row[4]!));
      const typbasetype = Number(decodeText(row[5]!));
      const typrelid = Number(decodeText(row[6]!));
      const typnotnull = decodeText(row[7]!) === "t";

      if (typcategory === "A" && typelem > 0) {
        arrayInfos.push({ arrayOid: oid, arrayName: name, elemOid: typelem });
        this.customArrayElements.set(oid, typelem);
      } else if (Object.hasOwn(this.userTypeRegistry, name) && typtype === "d") {
        throw new Error(
          `sqlx-js: customTypes cannot override PostgreSQL domain ${name} because PostgreSQL reports domain results as the base type`,
        );
      } else if (Object.hasOwn(this.userTypeRegistry, name)) {
        this.customTypes.set(oid, {
          kind: "scalar",
          name,
          tsType: this.userTypeRegistry[name]!,
        });
      } else if (typtype === "e") {
        enumOids.push(oid);
        this.customTypes.set(oid, { kind: "enum", name, values: [] });
      } else if (typtype === "b" && this.typeRegistry[name]) {
        this.customTypes.set(oid, { kind: "scalar", name, tsType: this.typeRegistry[name]! });
      } else if (typtype === "d" && typbasetype > 0) {
        domainInfos.push({ oid, name, baseOid: typbasetype, notNull: typnotnull });
      } else if (typtype === "c" && typrelid > 0) {
        compositeInfos.push({ oid, name, relOid: typrelid });
      }
    }

    const compositeAttrs = new Map<number, { name: string; typeOid: number; notNull: boolean }[]>();
    if (compositeInfos.length > 0) {
      const relList = [...new Set(compositeInfos.map((c) => c.relOid))].join(",");
      const sqlc = `SELECT c.oid::int8, a.attname, a.atttypid::int8, a.attnotnull FROM pg_attribute a JOIN pg_type c ON c.typrelid = a.attrelid WHERE a.attrelid IN (${relList}) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.oid, a.attnum`;
      const rc = await this.client.simpleQueryAll(sqlc);
      for (const row of rc.rows) {
        const typoid = Number(decodeText(row[0]!));
        const attname = decodeText(row[1]!)!;
        const atttypid = Number(decodeText(row[2]!));
        const notNull = decodeText(row[3]!) === "t";
        const arr = compositeAttrs.get(typoid) ?? [];
        arr.push({ name: attname, typeOid: atttypid, notNull });
        compositeAttrs.set(typoid, arr);
      }
    }

    const elemsToProbe = arrayInfos.map((a) => a.elemOid).filter((o) => !this.typesProbed.has(o));
    const basesToProbe = domainInfos.map((d) => d.baseOid).filter((o) => !this.typesProbed.has(o) && !isBuiltinOid(o));
    const fieldsToProbe = [...compositeAttrs.values()].flat().map((f) => f.typeOid).filter((o) => !this.typesProbed.has(o) && !isBuiltinOid(o));
    const recurse = [...new Set([...elemsToProbe, ...basesToProbe, ...fieldsToProbe])];
    if (recurse.length > 0) await this.loadCustomTypes(recurse);

    if (enumOids.length > 0) {
      const list2 = enumOids.join(",");
      const sql2 = `SELECT enumtypid::int8, enumlabel FROM pg_enum WHERE enumtypid IN (${list2}) ORDER BY enumtypid, enumsortorder`;
      const r2 = await this.client.simpleQueryAll(sql2);
      for (const row of r2.rows) {
        const oid = Number(decodeText(row[0]!));
        const label = decodeText(row[1]!)!;
        const type = this.customTypes.get(oid);
        if (type?.kind === "enum") type.values.push(label);
      }
    }

    for (const { oid, name, baseOid, notNull } of domainInfos) {
      const resolved = this.resolveBaseTs(baseOid);
      if (resolved) {
        this.customTypes.set(oid, { kind: "scalar", name, tsType: resolved, notNull, baseOid });
      }
    }

    for (const { oid, name } of compositeInfos) {
      const attrs = compositeAttrs.get(oid) ?? [];
      const fields: CompositeField[] = attrs.map((a) => ({
        name: a.name,
        tsType: this.resolveBaseTs(a.typeOid) ?? "unknown",
        nullable: !a.notNull,
      }));
      this.customTypes.set(oid, { kind: "composite", name, fields });
    }

    for (const { arrayOid, arrayName, elemOid } of arrayInfos) {
      const elem = this.customTypes.get(elemOid);
      if (elem && elem.kind === "enum") {
        this.customTypes.set(arrayOid, { kind: "enumArray", element: elem });
      } else if (elem && elem.kind === "scalar") {
        this.customTypes.set(arrayOid, { kind: "scalarArray", name: arrayName, element: elem });
      } else if (elem && elem.kind === "composite") {
        this.customTypes.set(arrayOid, { kind: "compositeArray", name: arrayName, element: elem });
      }
    }

  }

  private resolveBaseTs(baseOid: number): string | undefined {
    if (baseOid === 0) return undefined;
    if (isBuiltinOid(baseOid)) return oidToTs(baseOid).ts;
    const info = this.customTypes.get(baseOid);
    if (!info) return undefined;
    if (info.kind === "scalar") return info.tsType;
    if (info.kind === "scalarArray") return arrayTsType(info.element.tsType, info.element.notNull ? "non-null" : "unknown");
    if (info.kind === "enum") {
      if (info.values.length === 0) return "string";
      return info.values.map((v) => JSON.stringify(v)).join(" | ");
    }
    if (info.kind === "enumArray") {
      const element = info.element.values.length === 0
        ? "string"
        : info.element.values.map((v) => JSON.stringify(v)).join(" | ");
      return arrayTsType(element);
    }
    if (info.kind === "composite") return compositeLiteral(info);
    if (info.kind === "compositeArray") return arrayTsType(compositeLiteral(info.element));
    return undefined;
  }

  customType(oid: number): CustomTypeInfo | undefined {
    return this.customTypes.get(oid);
  }

  arrayElement(oid: number): { typeOid: number; tsType: string; nullability: ArrayElementNullability } | undefined {
    const type = this.customTypes.get(oid);
    if (type?.kind === "scalar" && type.baseOid) return this.arrayElement(type.baseOid);
    const typeOid = arrayElementOid(oid) ?? this.customArrayElements.get(oid);
    if (typeOid === undefined) return undefined;
    const custom = this.customTypes.get(typeOid);
    return {
      typeOid,
      tsType: this.resolveBaseTs(typeOid) ?? "unknown",
      nullability: custom?.kind === "scalar" && custom.notNull ? "non-null" : "unknown",
    };
  }

  tsType(oid: number): string {
    return this.resolveBaseTs(oid) ?? "unknown";
  }
}

function key(oid: number, attno: number): string {
  return `${oid}/${attno}`;
}

function unqualifiedKey(name: string): string {
  return `\0${name}`;
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
