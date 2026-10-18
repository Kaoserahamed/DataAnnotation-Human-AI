/**
 * Central error taxonomy and the single global error handler.
 *
 * Routes never build error responses by hand: services throw `AppError`
 * subclasses, Zod failures surface as `ZodError`, and everything funnels
 * through `registerErrorHandler` so every response has the same
 * `{ error: { code, message, details?, requestId } }` envelope.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { ErrorResponse } from '../shared.js';
import { logAndCapture } from './telemetry.js';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export const errors = {
  unauthorized: (message = 'authentication required') => new AppError('UNAUTHORIZED', message),
  forbidden: (message = 'insufficient permissions') => new AppError('FORBIDDEN', message),
  notFound: (resource: string, id?: string) =>
    new AppError('NOT_FOUND', id ? `${resource} ${id} not found` : `${resource} not found`),
  conflict: (message: string, details?: unknown) => new AppError('CONFLICT', message, details),
  precondition: (message: string, details?: unknown) =>
    new AppError('PRECONDITION_FAILED', message, details),
  validation: (message: string, details?: unknown) =>
    new AppError('VALIDATION_ERROR', message, details),
};

/** Postgres unique-violation; mapped to 409 instead of leaking SQL. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '23505';
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    if (error instanceof ZodError) {
      const body: ErrorResponse = {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'request validation failed',
          details: error.issues,
          requestId,
        },
      };
      void reply.status(400).send(body);
      return;
    }

    if (error instanceof AppError) {
      const body: ErrorResponse = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
          requestId,
        },
      };
      // 5xx AppErrors are unexpected — capture them in the tracker.
      if (error.statusCode >= 500) {
        logAndCapture(request.log, request.server.ctx.tracker, {
          requestId,
          code: error.code,
          statusCode: error.statusCode,
          message: error.message,
          err: error,
        });
      }
      void reply.status(error.statusCode).send(body);
      return;
    }

    if (isUniqueViolation(error)) {
      const body: ErrorResponse = {
        error: {
          code: 'CONFLICT',
          message: 'resource already exists',
          requestId,
        },
      };
      void reply.status(409).send(body);
      return;
    }

    // Unexpected failure: log the stack, capture via tracker, return opaque message.
    logAndCapture(request.log, request.server.ctx.tracker, {
      requestId,
      code: 'INTERNAL_ERROR',
      statusCode: 500,
      message: error instanceof Error ? error.message : 'internal server error',
      err: error,
    });
    const body: ErrorResponse = {
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'internal server error',
        requestId,
      },
    };
    void reply.status(500).send(body);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const body: ErrorResponse = {
      error: {
        code: 'NOT_FOUND',
        message: `route ${request.method} ${request.url} not found`,
        requestId: request.id,
      },
    };
    void reply.status(404).send(body);
  });
}
