import { describe, expect, test } from "bun:test";
import { computeScramProof } from "../src/pg/wire";

describe("computeScramProof (RFC 7677 SCRAM-SHA-256 vector)", () => {
  test("matches RFC 7677 ClientProof and ServerSignature", () => {
    const password = "pencil";
    const salt = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
    const iterations = 4096;
    const clientFirstBare = "n=user,r=rOprNGfwEbeRWgbNEkqO";
    const serverFirst = "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";
    const clientFinalNoProof = "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
    const authMessage = `${clientFirstBare},${serverFirst},${clientFinalNoProof}`;

    const { clientProofB64, serverSignatureB64 } = computeScramProof(password, salt, iterations, authMessage);

    expect(clientProofB64).toBe("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=");
    expect(serverSignatureB64).toBe("6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
  });

  test("different password produces different ClientProof", () => {
    const salt = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
    const authMessage = "n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
    const a = computeScramProof("pencil", salt, 4096, authMessage);
    const b = computeScramProof("PENCIL", salt, 4096, authMessage);
    expect(a.clientProofB64).not.toBe(b.clientProofB64);
  });
});
