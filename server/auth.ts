// Minimal, dependency-free auth for Pocket Planet.
//
// Passwords are hashed with scrypt (Node built-in) + a per-user random salt.
// Sessions are STATELESS signed tokens (HMAC-SHA256), so nothing extra needs to
// be stored server-side and they survive restarts as long as the secret does.
// The signing secret is generated once and persisted under the data dir.

import { randomBytes, scrypt, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '.data');
const SECRET_FILE = join(DATA_DIR, 'auth-secret');

// These tokens are bearer credentials kept in the browser, and there is no
// server-side session list to revoke them from — so a stolen one is valid until
// it expires. 60 days made that a two-month window; a week keeps "stay signed
// in" honest while bounding the damage. Override for a deployment that wants
// stricter (or looser) sessions.
const TOKEN_TTL_MS = Number(process.env.AUTH_TOKEN_TTL_HOURS ?? 24 * 7) * 60 * 60 * 1000;

// Promisified so hashing runs on the libuv threadpool instead of blocking the
// event loop — see hashPassword below.
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

function loadSecret(): string {
  try {
    // 0700 on the directory: everything under it is account data (emails, saved
    // trips, password hashes) plus this signing secret. The secret file is
    // already 0600, but the sibling users.json is written 0644 by store.ts, so
    // locking the directory is what actually keeps other local accounts out.
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    else chmodSync(DATA_DIR, 0o700);
    if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, 'utf8').trim();
    const secret = randomBytes(48).toString('hex');
    writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    return secret;
  } catch {
    // Last-resort ephemeral secret (tokens won't survive a restart).
    return randomBytes(48).toString('hex');
  }
}

const SECRET = process.env.AUTH_SECRET || loadSecret();

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------
// scrypt is deliberately expensive (~100ms here) — that cost is what makes the
// stored hashes hard to crack. The SYNC variant charges that cost to the event
// loop, so the whole server froze for the duration of every signup and every
// login attempt, and a handful of concurrent guesses was enough to take the app
// down. The async form hands the work to the libuv threadpool, so the process
// keeps serving guides while it hashes.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 64)).toString('hex');
  return `${salt}:${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = await scryptAsync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ---------------------------------------------------------------------------
// Tokens  (base64url(payload).base64url(hmac))
// ---------------------------------------------------------------------------
function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function sign(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function signToken(userId: string): string {
  const payload = b64url(JSON.stringify({ uid: userId, exp: Date.now() + TOKEN_TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): string | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof uid !== 'string' || typeof exp !== 'number' || Date.now() > exp) return null;
    return uid;
  } catch {
    return null;
  }
}

/** Pull the bearer user id out of an Authorization header, or null. */
export function userIdFromAuthHeader(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? verifyToken(m[1]) : null;
}
