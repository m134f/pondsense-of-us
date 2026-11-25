import { Router } from 'express';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { requireRole, verifyAuthToken, type AuthRequest } from '../auth';
import { isSmsConfigured } from '../sms';
import { effectiveOwnerAlertPhone, incidentRecipients, philippinePhone, waterSmsPolicy } from '../services/FishpenSms';
import { isTrustedJsonRequest } from '../trustedOrigin';

async function contactFishpen(db: Pool | PoolConnection, owner: number, lock = false) {
  const [[pen]] = await db.query<RowDataPacket[]>(`SELECT p.id, p.name, p.owner_alert_phone,
    p.caretaker_phone, p.caretaker_enabled, u.phone AS owner_phone
    FROM owner_fishpen_assignments a JOIN sms_fishpens p ON p.id = a.fishpen_id AND p.owner_user_id = a.owner_user_id
    JOIN users u ON u.id = a.owner_user_id
    WHERE a.owner_user_id = ? AND u.role = 'farmer' AND u.phone <> '+639000000000'${lock ? ' FOR UPDATE' : ''}`, [owner]);
  return pen || null;
}

function adminContact(pen: RowDataPacket) {
  return { id: Number(pen.id), name: String(pen.name), loginPhone: philippinePhone(pen.owner_phone),
    ownerAlertPhone: philippinePhone(pen.owner_alert_phone), ownerPhone: effectiveOwnerAlertPhone({ owner_phone: pen.owner_phone, owner_alert_phone: pen.owner_alert_phone }),
    caretakerPhone: philippinePhone(pen.caretaker_phone), caretakerEnabled: Boolean(pen.caretaker_enabled) };
}

const maskedPhone = (phone: string | null) => phone ? `**** ${phone.slice(-4)}` : null;

export function fishpenSmsRouter(db: Pool | null) {
  const router = Router();
  const requireAdmin = requireRole('admin', db);
  router.use(['/fishpen-sms', '/admin/water-sms'], async (req, res, next) => {
    const auth = verifyAuthToken(req);
    if (!auth) return res.status(401).json({ message: 'Please log in again.' });
    if (!db) return res.status(503).json({ message: 'SMS settings are temporarily unavailable.' });
    try {
      const [users] = await db.query<RowDataPacket[]>('SELECT role, phone FROM users WHERE id = ?', [auth.sub]);
      const expected = req.originalUrl.startsWith('/api/admin/') ? 'admin' : 'farmer';
      if (!users[0] || users[0].role !== expected || users[0].phone === '+639000000000') return res.status(403).json({ message: 'This account cannot access these SMS settings.' });
      res.locals.owner = auth.sub;
      next();
    } catch { res.status(503).json({ message: 'Unable to verify account access.' }); }
  });
  router.get('/fishpen-sms', async (_req, res) => {
    try {
      const pen = await contactFishpen(db!, res.locals.owner);
      const contact = pen ? adminContact(pen) : null;
      const enabled = pen ? incidentRecipients(pen as Parameters<typeof incidentRecipients>[0]) : [];
      res.set('Cache-Control', 'private, no-store').json({ fishpens: contact ? [{ id: contact.id, name: contact.name,
        owner_enabled: enabled.some(r => r.type === 'owner'), caretaker_phone: maskedPhone(contact.caretakerPhone),
        caretaker_enabled: enabled.some(r => r.type === 'caretaker') }] : [],
        ownerPhone: maskedPhone(contact?.ownerPhone ?? null), configured: isSmsConfigured(), policy: waterSmsPolicy() });
    } catch { res.status(503).json({ message: 'Unable to load SMS settings.' }); }
  });
  router.put('/fishpen-sms/:id', (_req, res) => {
    res.status(403).json({ message: 'SMS recipients are managed by your administrator.' });
  });

  const adminPath = '/admin/owners/:ownerId/sms-recipients';
  router.get(adminPath, requireAdmin, async (req, res) => {
    const owner = Number(req.params.ownerId);
    if (!Number.isSafeInteger(owner) || owner <= 0) return res.status(400).json({ message: 'Invalid farmer.' });
    try {
      const pen = await contactFishpen(db!, owner);
      res.set('Cache-Control', 'private, no-store').json({ fishpen: pen ? adminContact(pen) : null });
    } catch { res.status(503).json({ message: 'Unable to load SMS recipients.' }); }
  });
  router.put(adminPath, requireAdmin, async (req: AuthRequest, res) => {
    if (!isTrustedJsonRequest(req)) return res.status(403).json({ message: 'Untrusted request origin.' });
    const owner = Number(req.params.ownerId);
    const { fishpenId, ownerAlertPhone, caretakerPhone, caretakerEnabled, consentConfirmed } = req.body || {};
    const validInput = (value: unknown): value is string | null => value === null || (typeof value === 'string' && value.length <= 25);
    if (!Number.isSafeInteger(owner) || owner <= 0 || !Number.isSafeInteger(fishpenId) || fishpenId <= 0 ||
      typeof caretakerEnabled !== 'boolean' || typeof consentConfirmed !== 'boolean' ||
      !validInput(ownerAlertPhone) || !validInput(caretakerPhone)) {
      return res.status(400).json({ message: 'Invalid SMS recipient settings.' });
    }
    const entered = caretakerPhone?.trim();
    const phone = philippinePhone(entered);
    const ownerOverride = philippinePhone(ownerAlertPhone);
    if (ownerAlertPhone?.trim() && !ownerOverride) return res.status(400).json({ message: 'Enter a valid Philippine mobile number for the fishpen owner.' });
    if ((entered || caretakerEnabled) && !phone) return res.status(400).json({ message: 'Enter a valid Philippine mobile number.' });
    let connection: PoolConnection | undefined;
    try {
      connection = await db!.getConnection();
      await connection.beginTransaction();
      const pen = await contactFishpen(connection, owner, true);
      if (!pen || Number(pen.id) !== fishpenId) {
        await connection.rollback(); return res.status(409).json({ message: 'The assigned fishpen has changed. Reload farmer details and try again.' });
      }
      const updatedPen = { ...pen, owner_alert_phone: ownerOverride };
      const duplicate = !!phone && phone === effectiveOwnerAlertPhone({ owner_phone: pen.owner_phone, owner_alert_phone: ownerOverride });
      const enabled = caretakerEnabled && !duplicate;
      if (enabled && !consentConfirmed && (!pen.caretaker_enabled || phone !== philippinePhone(pen.caretaker_phone))) {
        await connection.rollback(); return res.status(400).json({ message: 'Confirm the caretaker has consented to receive water alerts.' });
      }
      if (ownerOverride !== pen.owner_alert_phone || phone !== pen.caretaker_phone || enabled !== Boolean(pen.caretaker_enabled)) {
        await connection.execute('UPDATE sms_fishpens SET owner_alert_phone = ?, caretaker_phone = ?, caretaker_enabled = ? WHERE id = ? AND owner_user_id = ?', [ownerOverride, phone, enabled, fishpenId, owner]);
        await connection.execute('INSERT INTO admin_audit_logs (admin_id, action, details) VALUES (?, ?, ?)',
          [req.auth!.sub, 'owner_sms_recipients_updated', JSON.stringify({ ownerId: owner, fishpenId, ownerRecipientChanged: ownerOverride !== pen.owner_alert_phone, caretakerEnabled: enabled, consentConfirmed })]);
      }
      await connection.commit();
      res.set('Cache-Control', 'private, no-store').json({ fishpen: adminContact({ ...updatedPen, caretaker_phone: phone, caretaker_enabled: enabled }) });
    } catch {
      await connection?.rollback();
      res.status(503).json({ message: 'Unable to save SMS recipients.' });
    } finally { connection?.release(); }
  });
  router.get('/admin/water-sms', async (_req, res) => {
    try {
      const [logs] = await db!.query<RowDataPacket[]>(`SELECT id, owner_user_id, fishpen_name, recipient_type, recipient_phone, parameter_name, severity,
        reading_value, DATE_FORMAT(measured_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS measured_at, status,
        DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at,
        DATE_FORMAT(attempted_at, '%Y-%m-%dT%H:%i:%sZ') AS attempted_at, provider_response, provider_message_id, provider
        FROM sms_water_attempts ORDER BY id DESC LIMIT 200`);
      const [incidentLogs] = await db!.query<RowDataPacket[]>(`SELECT id, owner_user_id, fishpen_name, recipient_type, recipient_phone,
        critical_keys AS parameter_name, kind, status, message,
        DATE_FORMAT(measured_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS measured_at,
        DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
        DATE_FORMAT(attempted_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS attempted_at,
        provider_response, provider_message_id, provider FROM sms_critical_notifications ORDER BY id DESC LIMIT 200`);
      const combined: Array<Record<string, unknown>> = [...logs.map(row => ({ ...row, log_type: 'legacy' })),
        ...incidentLogs.map(row => ({ ...row, log_type: 'incident' }))];
      res.json({ logs: combined.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 200) });
    } catch { res.status(503).json({ message: 'Unable to load water SMS logs.' }); }
  });
  return router;
}
