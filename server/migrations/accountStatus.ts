import type { Pool } from 'mysql2/promise';

export async function migrateAccountStatus(db: Pool) {
  try {
    // Existing rows inherit ACTIVE; changing the default afterwards affects only new accounts.
    await db.query("ALTER TABLE users ADD COLUMN account_status ENUM('PENDING','ACTIVE','REJECTED','SUSPENDED') NOT NULL DEFAULT 'ACTIVE'");
  } catch (error) {
    if ((error as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw error;
  }
  await db.query("ALTER TABLE users ALTER COLUMN account_status SET DEFAULT 'PENDING'");
  try { await db.query('ALTER TABLE users ADD COLUMN auth_version INT NOT NULL DEFAULT 0'); }
  catch (error) { if ((error as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw error; }
}
