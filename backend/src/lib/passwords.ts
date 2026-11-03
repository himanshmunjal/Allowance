import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

// scrypt with a per-password salt (D-053). Shared by parent accounts (auth.ts) and child logins
// (agents.ts, D-061); in its own module so those two don't import each other.

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { ...SCRYPT, N: Number(n) });
  return timingSafeEqual(actual, expected);
}
