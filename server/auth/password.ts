import crypto from "node:crypto";
import argon2 from "argon2";

// OWASP minimum for Argon2id: 19 MiB memory, 2 iterations, 1 lane
const OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (pw: string) => argon2.hash(pw, OPTS);

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

// verified against when the username does not exist, so timing does not reveal valid usernames
let dummy: Promise<string> | null = null;
export const dummyHash = () => (dummy ??= hashPassword(crypto.randomBytes(16).toString("hex")));

const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes
export function generatePassword(len = 16): string {
  return Array.from({ length: len }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
}
