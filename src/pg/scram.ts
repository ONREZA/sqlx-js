import { createHash, createHmac, pbkdf2Sync } from "node:crypto";

export function computeScramProof(
  password: string,
  salt: Uint8Array,
  iterations: number,
  authMessage: string,
): { saltedPassword: Buffer; clientProofB64: string; serverSignatureB64: string } {
  const saltedPassword = pbkdf2Sync(password, Buffer.from(salt), iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const clientSignature = createHmac("sha256", storedKey).update(authMessage).digest();
  const clientProof = Buffer.alloc(clientKey.length);
  for (let index = 0; index < clientKey.length; index++) {
    clientProof[index] = clientKey[index]! ^ clientSignature[index]!;
  }
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
  const serverSignature = createHmac("sha256", serverKey).update(authMessage).digest();
  return {
    saltedPassword,
    clientProofB64: clientProof.toString("base64"),
    serverSignatureB64: serverSignature.toString("base64"),
  };
}

export function parseScramFields(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(",")) {
    const separator = part.indexOf("=");
    if (separator >= 0) out[part.slice(0, separator)] = part.slice(separator + 1);
  }
  return out;
}

export function requireScramField(fields: Record<string, string>, key: string): string {
  const value = fields[key];
  if (value === undefined) throw new Error(`SCRAM: missing field "${key}"`);
  return value;
}
