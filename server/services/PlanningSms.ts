import type { Pool } from 'mysql2/promise';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { isSmsConfigured, sendSms } from '../sms';

export async function sendDailySms(db: Pool, owner: number, phone: string, message: string, kind: string, sender: typeof sendSms = sendSms) {
  const skipped = (reason: string) => ({ configured: isSmsConfigured(), ok: false, skipped: true, message: reason });
  if (!isSmsConfigured()) return skipped('SMS is temporarily unavailable.');
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const [previous] = await db.query<RowDataPacket[]>("SELECT id FROM alerts WHERE user_id = ? AND sms_sent = 1 AND DATE(sent_at) = CURDATE() LIMIT 1", [owner]);
  if (previous.length) return skipped('Daily SMS limit reached.');
  const [claim] = await db.execute<ResultSetHeader>(`INSERT IGNORE INTO planning_sms_log (owner_user_id, send_day, kind, status) VALUES (?, ?, ?, 'pending')`, [owner, day, kind]);
  if (!claim.affectedRows) return skipped('Daily SMS limit reached.');
  // An ambiguous provider failure is not automatically resent: this avoids double texts.
  let result;
  try { result = await sender(phone, message); }
  catch { result = { configured: true, ok: false, message: 'SMS provider request failed.' }; }
  await db.execute('UPDATE planning_sms_log SET status = ?, error_message = ? WHERE id = ?', [result.ok ? 'sent' : 'failed', result.ok ? null : result.message.slice(0, 500), claim.insertId]);
  return { ...result, skipped: false };
}
