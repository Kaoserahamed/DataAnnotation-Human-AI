/**
 * Environment configuration.
 *
 * Every tunable is declared once here, validated with Zod, and defaulted so a
 * fresh clone runs without any setup while production refuses to boot on
 * development-grade settings (see `assertProductionSafety`).
 */

import { z } from 'zod';

const DEV_JWT_SECRET = 'development-only-insecure-secret-do-not-use-in-production';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  JWT_SECRET: z.string().min(32).optional(),
  JWT_EXPIRES_IN: z.string().min(1).default('12h'),
  DB_CLIENT: z.enum(['pglite', 'postgres']).default('pglite'),
  DATABASE_URL: z.string().min(1).default('postgres://postgres:postgres@localhost:5432/annotation'),
  /** Directory for the file-backed PGlite database; unset means in-memory. */
  PGLITE_DIR: z.string().min(1).optional(),
  AI_PROVIDER: z.enum(['heuristic', 'openai']).default('heuristic'),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  jwtSecret: string;
  isProduction: boolean;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Build the runtime configuration from an environment map.
 *
 * Throws `ConfigError` with an actionable message rather than letting the
 * process start in a state that cannot work in production.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid environment configuration: ${issues}`);
  }

  const raw = parsed.data;
  const isProduction = raw.NODE_ENV === 'production';

  if (raw.AI_PROVIDER === 'openai' && !raw.OPENAI_API_KEY) {
    throw new ConfigError('OPENAI_API_KEY is required when AI_PROVIDER=openai');
  }
  if (raw.DB_CLIENT === 'postgres' && raw.PGLITE_DIR) {
    throw new ConfigError('PGLITE_DIR must not be set when DB_CLIENT=postgres');
  }
  if (isProduction && raw.DB_CLIENT === 'pglite' && !raw.PGLITE_DIR) {
    throw new ConfigError(
      'PGLITE_DIR must be set when DB_CLIENT=pglite in production so data survives restarts',
    );
  }

  const jwtSecret = raw.JWT_SECRET ?? (isProduction ? undefined : DEV_JWT_SECRET);
  if (!jwtSecret) {
    throw new ConfigError(
      'JWT_SECRET (>= 32 characters) is required when NODE_ENV=production; generate one with: openssl rand -hex 32',
    );
  }
  if (isProduction && jwtSecret === DEV_JWT_SECRET) {
    throw new ConfigError('The development JWT_SECRET must not be used when NODE_ENV=production');
  }

  return { ...raw, jwtSecret, isProduction };
}
