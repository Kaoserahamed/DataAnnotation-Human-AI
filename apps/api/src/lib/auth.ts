/**
 * Password hashing and JWT issuance/verification.
 *
 * Passwords use Node's built-in scrypt (memory-hard, zero native
 * dependencies) with a per-user random salt and constant-time comparison.
 * Tokens are compact HS256 JWTs produced by `jose`.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import type { UserRole } from '../shared.js';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/** Cost parameters; 16384 keeps login well under 100ms while staying hard to brute force. */
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const salt = Buffer.from(saltRaw ?? '', 'base64');
  const expected = Buffer.from(hashRaw ?? '', 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  const params = {
    N: Number(nRaw),
    r: Number(rRaw),
    p: Number(pRaw),
    maxmem: SCRYPT_PARAMS.maxmem,
  };
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) {
    return false;
  }

  const derived = await scrypt(password, salt, expected.length, params);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export interface TokenClaims {
  sub: string;
  email: string;
  role: UserRole;
}

function encodeSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Sign an HS256 access token.
 *
 * `expiresIn` accepts jose duration strings ('12h', '7d'). The subject,
 * email and role are embedded so authorization needs no lookup per request.
 */
export async function signToken(
  claims: TokenClaims,
  secret: string,
  expiresIn: string,
): Promise<string> {
  return new SignJWT({ email: claims.email, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(encodeSecret(secret));
}

/**
 * Verify a token and return its claims.
 * Returns `null` for expired, tampered or malformed tokens.
 */
export async function verifyToken(token: string, secret: string): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, encodeSecret(secret), { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;
    if (payload.role !== 'admin' && payload.role !== 'annotator' && payload.role !== 'reviewer') {
      return null;
    }
    return { sub: payload.sub, email: payload.email, role: payload.role };
  } catch {
    return null;
  }
}
