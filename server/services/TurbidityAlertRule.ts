import type { RowDataPacket } from 'mysql2';
import type { Pool } from 'mysql2/promise';
import { parseTurbidityThresholds, proposedTurbidityRule, type TurbidityThresholds } from '../../src/lib/turbidityAlert';

const settingKey = 'turbidity_alert_proposal';

export async function loadTurbidityProposal(db: Pick<Pool, 'execute'>) {
  const [rows] = await db.execute<RowDataPacket[]>('SELECT setting_val FROM admin_settings WHERE setting_key = ?', [settingKey]);
  if (!rows.length) return proposedTurbidityRule;
  const value = parseTurbidityThresholds(JSON.parse(rows[0].setting_val));
  if (!value) throw new Error('Invalid stored turbidity proposal');
  return { ...value, approval: 'pending' as const };
}

export async function saveTurbidityProposal(db: Pick<Pool, 'execute'>, input: TurbidityThresholds) {
  const thresholds = parseTurbidityThresholds(input);
  if (!thresholds) throw new Error('Invalid turbidity thresholds');
  const json = JSON.stringify(thresholds);
  await db.execute(`INSERT INTO admin_settings (setting_key, setting_val) VALUES (?, ?)
    ON DUPLICATE KEY UPDATE setting_val = ?`, [settingKey, json, json]);
  return { ...thresholds, approval: 'pending' as const };
}
