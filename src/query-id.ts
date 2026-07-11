import { createHash } from "node:crypto";
import {
  isEscapeStringPrefix,
  isIdentifierContinuation,
  readBlockComment,
  readDollarQuoted,
  readLineComment,
  readQuotedIdentifier,
  readSingleQuoted,
} from "./sql-lex";

export function queryId(query: string): string {
  return createHash("sha256").update(normalizeQuery(query)).digest("hex").slice(0, 16);
}

function normalizeQuery(query: string): string {
  let out = "";
  let pendingSpace = false;
  let i = 0;

  const emit = (text: string) => {
    if (pendingSpace && out.length > 0) out += " ";
    out += text;
    pendingSpace = false;
  };

  const markSpace = () => {
    if (out.length > 0) pendingSpace = true;
  };

  while (i < query.length) {
    const ch = query[i]!;
    if (/\s/.test(ch)) {
      markSpace();
      i++;
      continue;
    }
    if (ch === "-" && query[i + 1] === "-") {
      i = readLineComment(query, i);
      markSpace();
      continue;
    }
    if (ch === "/" && query[i + 1] === "*") {
      i = readBlockComment(query, i);
      markSpace();
      continue;
    }
    if (ch === "'") {
      const next = readSingleQuoted(query, i, isEscapeStringPrefix(query, i));
      emit(query.slice(i, next));
      i = next;
      continue;
    }
    if (ch === "\"") {
      const next = readQuotedIdentifier(query, i);
      emit(query.slice(i, next));
      i = next;
      continue;
    }
    if (ch === "$") {
      const next = i === 0 || !isIdentifierContinuation(query[i - 1]!) ? readDollarQuoted(query, i) : null;
      if (next !== null) {
        emit(query.slice(i, next));
        i = next;
        continue;
      }
    }
    emit(ch);
    i++;
  }
  return out;
}
