/** Authentication routes: bootstrap registration, login, current user, user list. */

import type { FastifyInstance } from 'fastify';
import { CreateUserSchema, LoginSchema } from '@haap/shared';
import { optionalAuth, parseWith, requireAuth, requireRole } from '../lib/http.js';
import {
  getUserById,
  listUsers,
  login,
  registerUser,
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
    });
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
}
