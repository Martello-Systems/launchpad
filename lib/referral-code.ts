import { randomBytes } from "crypto";

// Unambiguous alphabet: no 0/O/1/I/L to keep codes easy to read aloud/type.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * Generate a random referral code of the given length.
 * Uses crypto randomness and a reduced alphabet for human-friendliness.
 */
export function generateReferralCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}
