export type RewrittenSql = {
  query: string;
  names: string[];
  positionMap: number[];
};

export function rewriteNamedParameters(query: string): RewrittenSql {
  let out = "";
  let i = 0;
  let positional = false;
  const names: string[] = [];
  const indexes = new Map<string, number>();
  const positionMap: number[] = [];

  const append = (text: string, sourceStart: number) => {
    out += text;
    for (let offset = 0; offset < text.length; offset++) positionMap.push(sourceStart + offset);
  };

  while (i < query.length) {
    const start = i;
    const ch = query[i]!;
    if (ch === "-" && query[i + 1] === "-") {
      i = readLineComment(query, i);
      append(query.slice(start, i), start);
      continue;
    }
    if (ch === "/" && query[i + 1] === "*") {
      i = readBlockComment(query, i);
      append(query.slice(start, i), start);
      continue;
    }
    if (ch === "'") {
      i = readSingleQuoted(query, i, isEscapeStringPrefix(query, i));
      append(query.slice(start, i), start);
      continue;
    }
    if (ch === '"') {
      i = readQuotedIdentifier(query, i);
      append(query.slice(start, i), start);
      continue;
    }
    if (ch === "$") {
      const quotedEnd = readDollarQuoted(query, i);
      if (quotedEnd !== null) {
        i = quotedEnd;
        append(query.slice(start, i), start);
        continue;
      }
      const positionalMatch = /^\$[1-9][0-9]*/.exec(query.slice(i));
      if (positionalMatch) {
        positional = true;
        i += positionalMatch[0].length;
        append(positionalMatch[0], start);
        continue;
      }
      const namedMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(query.slice(i));
      if (namedMatch) {
        const name = namedMatch[1]!;
        let index = indexes.get(name);
        if (index === undefined) {
          names.push(name);
          index = names.length;
          indexes.set(name, index);
        }
        const replacement = `$${index}`;
        append(replacement, start);
        i += namedMatch[0].length;
        continue;
      }
    }
    append(ch, i);
    i++;
  }

  if (positional && names.length > 0) {
    throw new Error("sqlx-js: named and positional parameters cannot be mixed in one query");
  }
  return { query: out, names, positionMap };
}

export function bindNamedParameters(
  rewritten: RewrittenSql,
  args: readonly unknown[],
): { query: string; params: unknown[] } {
  if (rewritten.names.length === 0) return { query: rewritten.query, params: [...args] };
  if (args.length !== 1 || args[0] === null || typeof args[0] !== "object" || Array.isArray(args[0])) {
    throw new Error("sqlx-js: a query with named parameters requires exactly one parameter object");
  }
  const values = args[0] as Record<string, unknown>;
  const missing = rewritten.names.filter((name) => !Object.hasOwn(values, name));
  const expected = new Set(rewritten.names);
  const extra = Object.keys(values).filter((name) => !expected.has(name));
  if (missing.length > 0) throw new Error(`sqlx-js: missing named parameter(s): ${missing.join(", ")}`);
  if (extra.length > 0) throw new Error(`sqlx-js: unknown named parameter(s): ${extra.join(", ")}`);
  return { query: rewritten.query, params: rewritten.names.map((name) => values[name]) };
}

export function originalPosition(rewritten: RewrittenSql, oneBasedPosition: number): number {
  const position = Number(oneBasedPosition);
  if (!Number.isInteger(position) || position < 1) return oneBasedPosition;
  return (rewritten.positionMap[position - 1] ?? position - 1) + 1;
}

function isEscapeStringPrefix(query: string, quote: number): boolean {
  const prefix = query[quote - 1];
  if (prefix !== "e" && prefix !== "E") return false;
  const before = query[quote - 2];
  return before === undefined || !/[A-Za-z0-9_$]/.test(before);
}

function readSingleQuoted(query: string, start: number, escapeBackslash: boolean): number {
  let i = start + 1;
  while (i < query.length) {
    if (escapeBackslash && query[i] === "\\") { i += 2; continue; }
    if (query[i] === "'") {
      if (query[i + 1] === "'") { i += 2; continue; }
      return i + 1;
    }
    i++;
  }
  return query.length;
}

function readQuotedIdentifier(query: string, start: number): number {
  let i = start + 1;
  while (i < query.length) {
    if (query[i] === '"') {
      if (query[i + 1] === '"') { i += 2; continue; }
      return i + 1;
    }
    i++;
  }
  return query.length;
}

function readDollarQuoted(query: string, start: number): number | null {
  let end = start + 1;
  while (end < query.length && /[A-Za-z0-9_]/.test(query[end]!)) end++;
  if (query[end] !== "$") return null;
  const tag = query.slice(start, end + 1);
  const close = query.indexOf(tag, end + 1);
  return close === -1 ? query.length : close + tag.length;
}

function readLineComment(query: string, start: number): number {
  const end = query.indexOf("\n", start + 2);
  return end === -1 ? query.length : end + 1;
}

function readBlockComment(query: string, start: number): number {
  let depth = 1;
  let i = start + 2;
  while (i < query.length && depth > 0) {
    if (query[i] === "/" && query[i + 1] === "*") { depth++; i += 2; continue; }
    if (query[i] === "*" && query[i + 1] === "/") { depth--; i += 2; continue; }
    i++;
  }
  return i;
}
