import type { Pool } from 'mysql2/promise';

export async function migrateOwnerFishpen(db: Pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS owner_fishpen_assignments (
    owner_user_id INT PRIMARY KEY, fishpen_id INT NOT NULL UNIQUE,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (fishpen_id) REFERENCES sms_fishpens(id),
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL)`);
  try { await db.query('ALTER TABLE harvest_batches ADD COLUMN fishpen_id INT NULL'); }
  catch (error) { if ((error as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw error; }
  // Preserve legacy records; only unambiguous existing owner configurations are assigned.
  await db.query(`INSERT IGNORE INTO owner_fishpen_assignments (owner_user_id, fishpen_id)
    SELECT p.owner_user_id, MIN(p.id) FROM sms_fishpens p JOIN users u ON u.id = p.owner_user_id
    WHERE u.role = 'farmer' AND u.phone <> '+639000000000'
    GROUP BY p.owner_user_id HAVING COUNT(*) = 1`);
}
