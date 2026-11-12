import type { Pool } from 'mysql2/promise';

export async function migrateActiveFishSpecies(db: Pool) {
  try {
    await db.query('ALTER TABLE fish_species ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE');
  } catch (error) {
    if ((error as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw error;
  }

  // Preserve older species for historical records while limiting the current catalog.
  await db.execute(`UPDATE fish_species SET is_active = CASE
    WHEN name IN ('Tilapia', 'Mamali', 'Milkfish (Bangus)', 'Bangus', 'Bangus (Milkfish)') THEN TRUE
    ELSE FALSE END`);
}
