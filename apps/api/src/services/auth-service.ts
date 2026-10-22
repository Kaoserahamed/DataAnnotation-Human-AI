/**
 * Authentication service: registration, login, user listings.
 *
 * Registration rule: the very first account becomes admin automatically
 * (bootstrap from a fresh database); afterwards only admins may create users.
 */

import type { CreateUserInput, LoginInput } from '@haap/shared';
import { hashPassword, signToken, verifyPassword, verifyToken, generateTotpSecret, verifyTotp, buildOtpauthUrl } from '../lib/auth.js';
import { errors } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { UserRow } from '../db/rows.js';
import type { AuthUser, ServiceContext } from './context.js';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRow['role'];
  createdAt: string;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function countUsers(ctx: ServiceContext): Promise<number> {
  const rows = await ctx.db.query<{ count: string }>('SELECT count(*)::text AS count FROM users');
  return Number(rows[0]?.count ?? 0);
}

export async function registerUser(
  ctx: ServiceContext,
  input: CreateUserInput,
  actor: AuthUser | null,
): Promise<PublicUser> {
  const existing = await countUsers(ctx);
  if (existing > 0 && actor === null) {
    throw errors.forbidden('only an admin may create users after the first account');
  }
  if (existing > 0 && actor !== null && actor.role !== 'admin') {
    throw errors.forbidden('only an admin may create users');
  }

  const role = existing === 0 ? 'admin' : input.role;
  const row: UserRow = {
    id: newId(),
    email: input.email.toLowerCase(),
    name: input.name,
    password_hash: await hashPassword(input.password),
    role,
    refresh_token: null,
    mfa_enabled: false,
    mfa_secret: null,
    oauth_provider: null,
    oauth_subject: null,
    created_at: new Date(),
  };

  await ctx.db.execute(
    `INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5)`,
    [row.id, row.email, row.name, row.password_hash, row.role],
  );
  return toPublicUser(row);
}

export interface LoginResult {
  token: string;
  refreshToken: string;
  user: PublicUser;
  requiresMfa?: boolean;
  userId?: string;
}

export async function login(
  ctx: ServiceContext,
  input: LoginInput,
  config: { jwtSecret: string; jwtExpiresIn: string; jwtRefreshExpiresIn?: string },
): Promise<LoginResult> {
  const rows = await ctx.db.query<UserRow>('SELECT * FROM users WHERE email = $1', [
    input.email.toLowerCase(),
  ]);
  const user = rows[0];
  if (!user) throw errors.unauthorized('invalid email or password');
  const valid = await verifyPassword(input.password, user.password_hash);
  if (!valid) throw errors.unauthorized('invalid email or password');

  // MFA gate
  if (user.mfa_enabled) {
    if (!input.mfaToken || !user.mfa_secret || !verifyTotp(user.mfa_secret, input.mfaToken)) {
      return {
        token: '',
        refreshToken: '',
        user: toPublicUser(user),
        requiresMfa: true,
        userId: user.id,
      };
    }
  }

  return issueTokens(ctx, user, config);
}

async function issueTokens(
  ctx: ServiceContext,
  user: UserRow,
  config: { jwtSecret: string; jwtExpiresIn: string; jwtRefreshExpiresIn?: string },
): Promise<LoginResult> {
  const token = await signToken(
    { sub: user.id, email: user.email, role: user.role },
    config.jwtSecret,
    config.jwtExpiresIn,
  );
  const refreshToken = await signToken(
    { sub: user.id, email: user.email, role: user.role },
    config.jwtSecret,
    config.jwtRefreshExpiresIn ?? '7d',
  );
  await ctx.db.execute('UPDATE users SET refresh_token = $1 WHERE id = $2', [refreshToken, user.id]);
  return { token, refreshToken, user: toPublicUser(user), requiresMfa: false };
}

export async function refreshTokens(
  ctx: ServiceContext,
  refreshToken: string,
  config: { jwtSecret: string; jwtExpiresIn: string; jwtRefreshExpiresIn?: string },
): Promise<LoginResult> {
  const claims = await verifyToken(refreshToken, config.jwtSecret);
  if (!claims) throw errors.unauthorized('invalid refresh token');

  const rows = await ctx.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [claims.sub]);
  const user = rows[0];
  if (!user) throw errors.unauthorized('invalid refresh token');
  if (user.refresh_token !== refreshToken) throw errors.unauthorized('invalid refresh token');
  return issueTokens(ctx, user, config);
}

export async function logout(ctx: ServiceContext, userId: string): Promise<{ message: string }> {
  await ctx.db.execute('UPDATE users SET refresh_token = NULL WHERE id = $1', [userId]);
  return { message: 'logged out' };
}

export async function mfaSetup(
  ctx: ServiceContext,
  userId: string,
): Promise<{ secret: string; otpauthUrl: string }> {
  const rows = await ctx.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) throw errors.notFound('user', userId);
  if (user.mfa_enabled) throw errors.validation('MFA already enabled');
  const secret = generateTotpSecret();
  await ctx.db.execute('UPDATE users SET mfa_secret = $1 WHERE id = $2', [secret, userId]);
  const otpauthUrl = buildOtpauthUrl(secret, user.email, 'HumanAI Annotation');
  return { secret, otpauthUrl };
}

export async function mfaEnable(
  ctx: ServiceContext,
  userId: string,
  token: string,
): Promise<{ message: string; backupCodes: string[] }> {
  const rows = await ctx.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) throw errors.notFound('user', userId);
  if (!user.mfa_secret) throw errors.validation('MFA not set up');
  if (!verifyTotp(user.mfa_secret, token)) throw errors.unauthorized('invalid MFA token');
  await ctx.db.execute('UPDATE users SET mfa_enabled = TRUE WHERE id = $1', [userId]);
  const backupCodes = Array.from({ length: 8 }, () => Math.random().toString(36).slice(2, 10));
  return { message: 'MFA enabled', backupCodes };
}

export async function mfaDisable(ctx: ServiceContext, userId: string, token: string): Promise<{ message: string }> {
  const rows = await ctx.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) throw errors.notFound('user', userId);
  if (!user.mfa_enabled || !user.mfa_secret) throw errors.validation('MFA not enabled');
  if (!verifyTotp(user.mfa_secret, token)) throw errors.unauthorized('invalid MFA token');
  await ctx.db.execute('UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL WHERE id = $1', [userId]);
  return { message: 'MFA disabled' };
}

export async function oauthLogin(
  ctx: ServiceContext,
  provider: string,
  subject: string,
  email: string,
  name: string,
  config: { jwtSecret: string; jwtExpiresIn: string; jwtRefreshExpiresIn?: string },
): Promise<LoginResult> {
  // find by oauth identity or email
  let rows = await ctx.db.query<UserRow>(
    'SELECT * FROM users WHERE oauth_provider = $1 AND oauth_subject = $2',
    [provider, subject],
  );
  let user = rows[0];
  if (!user) {
    rows = await ctx.db.query<UserRow>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    user = rows[0];
    if (user) {
      await ctx.db.execute(
        'UPDATE users SET oauth_provider = $1, oauth_subject = $2 WHERE id = $3',
        [provider, subject, user.id],
      );
    } else {
      const newUser: UserRow = {
        id: newId(),
        email: email.toLowerCase(),
        name: name || email,
        password_hash: await hashPassword(Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)),
        role: 'client',
        refresh_token: null,
        mfa_enabled: false,
        mfa_secret: null,
        oauth_provider: provider,
        oauth_subject: subject,
        created_at: new Date(),
      };
      await ctx.db.execute(
        `INSERT INTO users (id, email, name, password_hash, role, oauth_provider, oauth_subject) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [newUser.id, newUser.email, newUser.name, newUser.password_hash, newUser.role, provider, subject],
      );
      user = newUser;
    }
  }
  // re-fetch to get updated
  const fresh = await ctx.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [user.id]);
  return issueTokens(ctx, fresh[0] ?? user, config);
}
export async function getUserById(ctx: ServiceContext, id: string): Promise<PublicUser> {
  const rows = await ctx.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  const row = rows[0];
  if (!row) throw errors.notFound('user', id);
  return toPublicUser(row);
}

export async function listUsers(ctx: ServiceContext): Promise<PublicUser[]> {
  const rows = await ctx.db.query<UserRow>('SELECT * FROM users ORDER BY created_at ASC');
  return rows.map(toPublicUser);
}
