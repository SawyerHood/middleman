import DatabaseConstructor from "better-sqlite3";

import { STORE_MIGRATIONS, type MigrationDefinition } from "./schema.js";

export type Database = InstanceType<typeof DatabaseConstructor>;

interface MigrationRow {
  id: string;
}

interface AppliedMigrationRow {
  id: string;
  applied_at: string;
}

export function createDatabase(dbPath: string): Database {
  const db = new DatabaseConstructor(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  return db;
}

export function runMigrations(
  db: Database,
  options?: { migrations?: readonly MigrationDefinition[] },
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const getAppliedMigration = db.prepare<{ id: string }, MigrationRow>(
    "SELECT id FROM migrations WHERE id = @id",
  );
  const insertMigration = db.prepare<AppliedMigrationRow>(
    "INSERT INTO migrations (id, applied_at) VALUES (@id, @applied_at)",
  );
  const migrations = [...STORE_MIGRATIONS, ...(options?.migrations ?? [])];
  const seenMigrationIds = new Set<string>();

  const migrate = db.transaction(() => {
    for (const migration of migrations) {
      if (seenMigrationIds.has(migration.id)) {
        throw new Error(`Duplicate migration id: ${migration.id}`);
      }

      seenMigrationIds.add(migration.id);
      const existing = getAppliedMigration.get({ id: migration.id });

      if (existing) {
        continue;
      }

      db.exec(migration.sql);
      insertMigration.run({
        id: migration.id,
        applied_at: new Date().toISOString(),
      });
    }
  }).immediate;

  migrate();
}
