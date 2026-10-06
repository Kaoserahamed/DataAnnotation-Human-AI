/**
 * Idempotent migration runner.
 *
 * Migrations are plain `.sql` files applied in filename order inside a
 * transaction and recorded in `schema_migrations`, so a failed migration can
 * never leave a half-applied schema and re-running is always safe.
 */

import { readdir, readFile } from 'node:fs/promises';
import type { Database } from './database.js';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

export interface MigrationOutcome {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(db: Database): Promise<MigrationOutcome> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const appliedRows = await db.query<{ id: string }>('SELECT id FROM schema_migrations');
  const alreadyApplied = new Set(appliedRows.map((row) => row.id));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of await migrationFiles()) {
    if (alreadyApplied.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.execute('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
    });
    applied.push(file);
  }

  return { applied, skipped };
}
