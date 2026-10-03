import { createHash } from "crypto";

/**
 * Deterministic one-way hash for API key lookup by exact match. Not a
 * password hash (no per-value salt, no slow KDF) - API keys are
 * high-entropy random tokens compared by equality, so a fast, indexable
 * digest is the right tool, unlike bcrypt for user passwords.
 */
export function hashApiKey(key: string): string {
    return createHash("sha256").update(key).digest("hex");
}
