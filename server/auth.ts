// Minimal, dependency-free auth for Pocket Planet.
//
// Passwords are hashed with scrypt (Node built-in) + a per-user random salt.
// Sessions are STATELESS signed tokens (HMAC-SHA256), so nothing extra needs to
// be stored server-side and they survive restarts as long as the secret does.
// The signing secret is generated once and persisted under the data dir.

import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '.data');
const SECRET_FILE = join(DATA_DIR, 'auth-secret');

const TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

function loadSecret(): string {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
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
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
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
