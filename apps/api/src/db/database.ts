/**
 * Database access layer.
 *
 * A single `Database` interface is implemented by two drivers:
 *
 *   - PGlite  — an embedded Postgres 16 engine (WASM). Default for dev and
 *     test because it needs no server and runs the *same engine* used in
 *     production, so integration tests exercise real Postgres semantics.
 *   - node-postgres (`pg`) — a classic Postgres server connection used when
 *     `DB_CLIENT=postgres` (CI service container, docker-compose deployment).
 *
 * Services only ever see `Database`, so driver choice never leaks upward.
 */

import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type { AppConfig } from '../config.js';

export type Row = Record<string, unknown>;

export interface Database {
  /** Return all rows of a single statement with bound parameters. */
  query<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Execute a single statement and return the affected row count. */
  execute(sql: string, params?: readonly unknown[]): Promise<number>;
  /** Execute a (possibly multi-statement) script without parameters. */
  exec(sql: string): Promise<void>;
  /** Run `fn` inside a transaction; rolls back when `fn` throws. */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  /** Round-trip probe returning latency in ms, or `null` when unreachable. */
  ping(): Promise<number | null>;
  close(): Promise<void>;
}

/** Serialize a value for a `JSONB` parameter. */
export function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Parse a `JSONB` column that may already have been decoded by the driver. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

class PgliteDatabase implements Database {
  constructor(private readonly client: PGlite) {}

  async query<T = Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const result = await this.client.query<T>(sql, params as unknown[]);
    return result.rows;
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    const result = await this.client.query(sql, params as unknown[]);
    return result.affectedRows ?? 0;
  }

  async exec(sql: string): Promise<void> {
    await this.client.exec(sql);
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return this.client.transaction(async (tx) => {
      const wrapped: Database = {
        query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
          (await tx.query<R>(sql, params as unknown[])).rows,
        execute: async (sql: string, params: readonly unknown[] = []): Promise<number> =>
          (await tx.query(sql, params as unknown[])).affectedRows ?? 0,
        exec: async (sql: string): Promise<void> => {
          await tx.exec(sql);
        },
        transaction: () => {
          throw new Error('nested transactions are not supported');
        },
        ping: async () => null,
        close: async () => {
          /* owned by the outer connection */
        },
      };
      return fn(wrapped);
    });
  }

  async ping(): Promise<number | null> {
    try {
      const startedAt = performance.now();
      await this.client.query('SELECT 1');
      return Math.round(performance.now() - startedAt);
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

class PostgresDatabase implements Database {
  constructor(private readonly pool: pg.Pool) {}

  async query<T = Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, params as unknown[]);
    return result.rows as T[];
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    const result = await this.pool.query(sql, params as unknown[]);
    return result.rowCount ?? 0;
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const wrapped: Database = {
      query: async (sql, params = []) => (await client.query(sql, params as unknown[])).rows,
      execute: async (sql, params = []) =>
        (await client.query(sql, params as unknown[])).rowCount ?? 0,
      exec: async (sql) => {
        await client.query(sql);
      },
      transaction: () => {
        throw new Error('nested transactions are not supported');
      },
      ping: async () => null,
      close: async () => {
        /* owned by the pool */
      },
    };
    try {
      await client.query('BEGIN');
      const result = await fn(wrapped);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<number | null> {
    try {
      const startedAt = performance.now();
      await this.pool.query('SELECT 1');
      return Math.round(performance.now() - startedAt);
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Create a driver-backed database from validated configuration. */
export async function createDatabase(config: AppConfig): Promise<Database> {
  if (config.DB_CLIENT === 'postgres') {
    const pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      // Fail fast so /ready reports degraded instead of hanging.
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 10_000,
    });
    return new PostgresDatabase(pool);
  }

  const client = config.PGLITE_DIR ? new PGlite({ dataDir: config.PGLITE_DIR }) : new PGlite();
  await client.waitReady;
  return new PgliteDatabase(client);
}
