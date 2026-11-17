import type { Pool } from 'mysql2/promise';

export async function migrateProvisionedOwners(db: Pool) {
  for (const sql of [
    'ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE',
    'ALTER TABLE users ADD COLUMN temporary_password_expires_at DATETIME NULL',
    'ALTER TABLE users ADD COLUMN password_changed_at DATETIME NULL'
  ]) {
    try { await db.query(sql); }
    catch (error) { if ((error as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw error; }
  }
}
