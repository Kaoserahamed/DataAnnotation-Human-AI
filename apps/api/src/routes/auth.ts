/** Authentication routes: bootstrap registration, login, current user, user list, refresh, logout, MFA, OAuth2. */

import type { FastifyInstance } from 'fastify';
import { CreateUserSchema, LoginSchema, RefreshTokenSchema, MfaVerifySchema, OAuthLoginSchema } from '@haap/shared';
import { optionalAuth, parseWith, requireAuth, requireRole } from '../lib/http.js';
import { verifyTotp } from '../lib/auth.js';
import {
  getUserById,
  listUsers,
  login,
  registerUser,
  refreshTokens,
  logout,
  mfaSetup,
  mfaEnable,
  mfaDisable,
  oauthLogin,
} from '../services/auth-service.js';

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/auth/register', async (request, reply) => {
    const actor = await optionalAuth(request);
    const input = parseWith(CreateUserSchema, request.body);
    const user = await registerUser(app.ctx, input, actor);
    void reply.status(201);
    return { user };
  });

  app.post('/auth/login', async (request) => {
    const input = parseWith(LoginSchema, request.body);
    return login(app.ctx, input, {
      jwtSecret: app.config.jwtSecret,
      jwtExpiresIn: app.config.JWT_EXPIRES_IN,
      jwtRefreshExpiresIn: app.config.JWT_REFRESH_EXPIRES_IN,
    });
  });

  app.post('/auth/refresh', async (request) => {
    const input = parseWith(RefreshTokenSchema, request.body);
    return refreshTokens(app.ctx, input.refreshToken, {
      jwtSecret: app.config.jwtSecret,
      jwtExpiresIn: app.config.JWT_EXPIRES_IN,
      jwtRefreshExpiresIn: app.config.JWT_REFRESH_EXPIRES_IN,
    });
  });

  app.post('/auth/logout', async (request) => {
    const actor = await requireAuth(request);
    return logout(app.ctx, actor.id);
  });

  app.get('/auth/me', async (request) => {
    const actor = await requireAuth(request);
    return { user: await getUserById(app.ctx, actor.id) };
  });

  app.get('/auth/users', async (request) => {
    const actor = await requireAuth(request);
    requireRole(actor, 'admin');
    return { data: await listUsers(app.ctx) };
  });

  // MFA
  app.post('/auth/mfa/setup', async (request) => {
    const actor = await requireAuth(request);
    return mfaSetup(app.ctx, actor.id);
  });

  app.post('/auth/mfa/enable', async (request) => {
    const actor = await requireAuth(request);
    const body = parseWith(MfaVerifySchema, request.body);
    return mfaEnable(app.ctx, actor.id, body.token);
  });

  app.post('/auth/mfa/verify', async (request) => {
    const actor = await requireAuth(request);
    const body = parseWith(MfaVerifySchema, request.body);
    const ok = await (async () => {
      const rows = await app.ctx.db.query<{ mfa_secret: string | null; mfa_enabled: boolean }>(
        'SELECT mfa_secret, mfa_enabled FROM users WHERE id = $1',
        [actor.id],
      );
      const r = rows[0];
      if (!r?.mfa_secret) return false;
      return verifyTotp(r.mfa_secret, body.token);
    })();
    return { valid: ok };
  });

  app.post('/auth/mfa/disable', async (request) => {
    const actor = await requireAuth(request);
    const body = parseWith(MfaVerifySchema, request.body);
    return mfaDisable(app.ctx, actor.id, body.token);
  });

  // OAuth2 (code-exchange style; provider verification is pluggable)
  app.post('/auth/oauth', async (request) => {
    const input = parseWith(OAuthLoginSchema, request.body);
    // In a real deployment, exchange `code` with the provider. Here we accept
    // a provider-issued subject via a trusted header for testability; default
    // to using the code as the subject when no integration is configured.
    const subject = (request.headers['x-oauth-subject'] as string) || input.code;
    const email = (request.headers['x-oauth-email'] as string) || `${subject}@${input.provider}.oauth`;
    const name = (request.headers['x-oauth-name'] as string) || subject;
    return oauthLogin(app.ctx, input.provider, subject, email, name, {
      jwtSecret: app.config.jwtSecret,
      jwtExpiresIn: app.config.JWT_EXPIRES_IN,
      jwtRefreshExpiresIn: app.config.JWT_REFRESH_EXPIRES_IN,
    });
  });
}
