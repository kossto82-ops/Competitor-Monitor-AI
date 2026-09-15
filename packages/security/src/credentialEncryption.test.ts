import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialEncryptionError, decryptCredential, encryptCredential } from "./credentialEncryption.js";

const ORIGINAL_KEY = process.env["CMA_AI_ENCRYPTION_KEY"];

describe("encryptCredential / decryptCredential", () => {
  beforeEach(() => {
    process.env["CMA_AI_ENCRYPTION_KEY"] = "test-encryption-key-do-not-use-in-prod";
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env["CMA_AI_ENCRYPTION_KEY"];
    else process.env["CMA_AI_ENCRYPTION_KEY"] = ORIGINAL_KEY;
  });

  it("round-trips a plaintext API key", () => {
    const plaintext = "sk-test-1234567890abcdef";
    const encrypted = encryptCredential(plaintext);
    expect(decryptCredential(encrypted)).toBe(plaintext);
  });

  it("never stores the plaintext inside the encrypted string", () => {
    const plaintext = "sk-super-secret-value";
    const encrypted = encryptCredential(plaintext);
    expect(encrypted).not.toContain(plaintext);
  });

  it("produces a different ciphertext every time (random IV), even for the same plaintext", () => {
    const plaintext = "sk-same-value";
    const first = encryptCredential(plaintext);
    const second = encryptCredential(plaintext);
    expect(first).not.toBe(second);
    expect(decryptCredential(first)).toBe(plaintext);
    expect(decryptCredential(second)).toBe(plaintext);
  });

  it("fails to decrypt (rather than silently returning garbage) if the ciphertext was tampered with", () => {
    const encrypted = encryptCredential("sk-original-value");
    const parts = encrypted.split(".");
    const tampered = [parts[0], parts[1], parts[2]!.slice(0, -2) + "zz"].join(".");
    expect(() => decryptCredential(tampered)).toThrow(CredentialEncryptionError);
  });

  it("fails to decrypt with the wrong key", () => {
    const encrypted = encryptCredential("sk-original-value");
    process.env["CMA_AI_ENCRYPTION_KEY"] = "a-completely-different-key";
    expect(() => decryptCredential(encrypted)).toThrow(CredentialEncryptionError);
  });

  it("throws a clear error when CMA_AI_ENCRYPTION_KEY is not set", () => {
    delete process.env["CMA_AI_ENCRYPTION_KEY"];
    expect(() => encryptCredential("sk-value")).toThrow(/CMA_AI_ENCRYPTION_KEY/);
  });

  it("rejects a malformed encoded string (not iv.authTag.ciphertext)", () => {
    expect(() => decryptCredential("not-a-valid-format")).toThrow(CredentialEncryptionError);
  });
});
