import type { Pool, RowDataPacket } from 'mysql2/promise';

export async function migratePartialManual(db: Pool) {
  const [columns] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM water_readings");
  const types: Record<string, string> = { ph: 'DECIMAL(4,2)', temperature: 'DECIMAL(5,2)', turbidity: 'DECIMAL(8,2)', ammonia: 'DECIMAL(6,4)', dissolved_oxygen: 'DECIMAL(5,2)', status: "ENUM('Safe','Warning','Critical')" };
  const changes = columns.filter(c => types[c.Field] && c.Null === 'NO').map(c => `MODIFY COLUMN ${c.Field} ${types[c.Field]} NULL`);
  if (changes.length) await db.query(`ALTER TABLE water_readings ${changes.join(', ')}`);
}
