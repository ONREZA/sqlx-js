export function isIdentifierContinuation(value: string): boolean {
  return /[A-Za-z0-9_$\u0080-\uFFFF]/.test(value);
}

export function isEscapeStringPrefix(query: string, quote: number): boolean {
  const prefix = query[quote - 1];
  if (prefix !== "e" && prefix !== "E") return false;
  const before = query[quote - 2];
  return before === undefined || !isIdentifierContinuation(before);
}

export function readSingleQuoted(query: string, start: number, escapeBackslash: boolean): number {
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

export function readQuotedIdentifier(query: string, start: number): number {
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

export function readDollarQuoted(query: string, start: number): number | null {
  let end = start + 1;
  if (query[end] !== "$" && !/[A-Za-z_\u0080-\uFFFF]/.test(query[end]!)) return null;
  while (end < query.length && /[A-Za-z0-9_\u0080-\uFFFF]/.test(query[end]!)) end++;
  if (query[end] !== "$") return null;
  const tag = query.slice(start, end + 1);
  const close = query.indexOf(tag, end + 1);
  return close === -1 ? query.length : close + tag.length;
}

export function readLineComment(query: string, start: number): number {
  const end = query.indexOf("\n", start + 2);
  return end === -1 ? query.length : end + 1;
}

export function readBlockComment(query: string, start: number): number {
  let depth = 1;
  let i = start + 2;
  while (i < query.length && depth > 0) {
    if (query[i] === "/" && query[i + 1] === "*") { depth++; i += 2; continue; }
    if (query[i] === "*" && query[i + 1] === "/") { depth--; i += 2; continue; }
    i++;
  }
  return i;
}
