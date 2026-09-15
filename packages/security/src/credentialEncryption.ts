import crypto from "node:crypto";

/**
 * Phase 3.1 (Section 5): encrypts customer AI provider credentials
 * before they ever reach Postgres. AES-256-GCM: authenticated
 * encryption, so a tampered ciphertext fails to decrypt rather than
 * silently returning garbage that gets sent to a provider as an API
 * key. Lives in @cma/security (not @cma/db) because it is a pure
 * cryptographic operation with no database dependency - the same
 * reasoning as resolveHost.ts/safeFetch.ts living here rather than in
 * whichever package happens to call them first.
 */
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the standard/recommended size for GCM

export class CredentialEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialEncryptionError";
  }
}

/**
 * `CMA_AI_ENCRYPTION_KEY` may be any length/format an operator chooses
 * (a passphrase, a base64 string, etc.) - SHA-256 deterministically
 * derives exactly the 32 bytes AES-256 requires, rather than forcing a
 * fragile "must be exactly 32 raw bytes" operational constraint.
 */
function deriveKey(): Buffer {
  const secret = process.env["CMA_AI_ENCRYPTION_KEY"];
  if (!secret) {
    throw new CredentialEncryptionError(
      "CMA_AI_ENCRYPTION_KEY is not set. It is required to store or read any organization's AI provider credential.",
    );
  }
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Encodes as `{iv}.{authTag}.{ciphertext}`, each base64url - a single
 * opaque string that fits in one text column (AiConnection.encryptedApiKey)
 * without needing separate columns for the nonce/tag.
 */
export function encryptCredential(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((buf) => buf.toString("base64url")).join(".");
}

/**
 * Never logs or echoes the plaintext it returns - callers (the worker's
 * provider-resolution path) must pass the result directly into a
 * provider constructor and never into a log line, an error message, or
 * anything persisted.
 */
export function decryptCredential(encoded: string): string {
  const key = deriveKey();
  const parts = encoded.split(".");
  if (parts.length !== 3) {
    throw new CredentialEncryptionError("Encrypted credential is not in the expected iv.authTag.ciphertext format.");
  }
  const [ivB64, authTagB64, ciphertextB64] = parts as [string, string, string];
  try {
    const iv = Buffer.from(ivB64, "base64url");
    const authTag = Buffer.from(authTagB64, "base64url");
    const ciphertext = Buffer.from(ciphertextB64, "base64url");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (err) {
    // Deliberately generic - a decryption failure could mean a wrong key,
    // corrupted data, or a tampering attempt. None of those distinctions
    // are safe or useful to expose to a caller.
    const message = err instanceof Error ? err.message : String(err);
    throw new CredentialEncryptionError(`Failed to decrypt credential: ${message}`);
  }
}
