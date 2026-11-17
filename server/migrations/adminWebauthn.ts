import type { Pool } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';

export async function migrateAdminWebauthn(db: Pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS admin_auth_rate (
    bucket VARCHAR(40) PRIMARY KEY, attempts INT NOT NULL, resets_at DATETIME NOT NULL)`);
  await db.query(`CREATE TABLE IF NOT EXISTS admin_security (
    id INT PRIMARY KEY, admin_id INT NOT NULL, enforced BOOLEAN NOT NULL DEFAULT FALSE,
    FOREIGN KEY (admin_id) REFERENCES users(id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS admin_credentials (
    id INT AUTO_INCREMENT PRIMARY KEY, admin_id INT NOT NULL,
    credential_id VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    credential_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
    public_key BLOB NOT NULL, signature_counter BIGINT UNSIGNED NOT NULL DEFAULT 0,
    label VARCHAR(100) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME NULL, revoked_at DATETIME NULL,
    FOREIGN KEY (admin_id) REFERENCES users(id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS admin_auth_flows (
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    admin_id INT NOT NULL, kind VARCHAR(20) NOT NULL, challenge TEXT NULL,
    expires_at DATETIME NOT NULL, consumed_at DATETIME NULL,
    FOREIGN KEY (admin_id) REFERENCES users(id), INDEX (expires_at))`);
  const [existing] = await db.query<RowDataPacket[]>('SELECT id FROM admin_security WHERE id = 1');
  if (!existing.length) {
    const [admins] = await db.query<RowDataPacket[]>('SELECT id FROM users WHERE role = ?', ['admin']);
    const selected = process.env.ADMIN_ACCOUNT_ID ? admins.find(row => Number(row.id) === Number(process.env.ADMIN_ACCOUNT_ID)) : admins.length === 1 ? admins[0] : null;
    if (!selected) throw new Error('Choose the existing administrator with ADMIN_ACCOUNT_ID before Phase 2 startup. No accounts were deleted.');
    await db.execute('INSERT IGNORE INTO admin_security (id, admin_id) VALUES (1, ?)', [selected.id]);
  }
}
