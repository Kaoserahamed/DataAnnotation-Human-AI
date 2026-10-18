/**
 * Authentication service: registration, login, user listings.
 *
 * Registration rule: the very first account becomes admin automatically
 * (bootstrap from a fresh database); afterwards only admins may create users.
 */

import type { CreateUserInput, LoginInput } from '../shared.js';
import { hashPassword, signToken, verifyPassword } from '../lib/auth.js';
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
  user: PublicUser;
}

export async function login(
  ctx: ServiceContext,
  input: LoginInput,
  config: { jwtSecret: string; jwtExpiresIn: string },
): Promise<LoginResult> {
  const rows = await ctx.db.query<UserRow>('SELECT * FROM users WHERE email = $1', [
    input.email.toLowerCase(),
  ]);
  const user = rows[0];
  // Same error for unknown email and bad password: no account enumeration.
  if (!user) throw errors.unauthorized('invalid email or password');
  const valid = await verifyPassword(input.password, user.password_hash);
  if (!valid) throw errors.unauthorized('invalid email or password');

  const token = await signToken(
    { sub: user.id, email: user.email, role: user.role },
    config.jwtSecret,
    config.jwtExpiresIn,
  );
  return { token, user: toPublicUser(user) };
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
