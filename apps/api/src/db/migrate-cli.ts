/** CLI: apply pending migrations. Safe to run repeatedly. */

import { loadConfig } from '../config.js';
import { createDatabase } from './database.js';
import { runMigrations } from './migrate.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await createDatabase(config);
  try {
    const outcome = await runMigrations(db);
    console.log(
      `migrations applied: ${outcome.applied.length}` +
        (outcome.applied.length > 0 ? ` (${outcome.applied.join(', ')})` : ''),
    );
    console.log(`already applied: ${outcome.skipped.length}`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error('migration failed:', error);
  process.exitCode = 1;
});
