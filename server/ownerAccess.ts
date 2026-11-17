import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { verifyAuthToken, clearAuthSession } from './auth';
import { assignedFishpen } from './services/OwnerFishpen';

const deviceUploads = new Set(['/v1/sensors/measurements', '/v1/sensors/turbidity', '/v1/sensors/data', '/sensor/readings']);
export function ownerAccess(db: Pool | null) {
  return async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST' && deviceUploads.has(req.path)) return next(); // Existing device-key guards remain mandatory.
    if (['/health', '/login', '/logout', '/register'].includes(req.path) || req.path.startsWith('/admin/')) return next();
    const auth = verifyAuthToken(req);
    if (!auth) return res.status(401).json({ message: 'Owner login required.' });
    if (auth.role !== 'farmer') return res.status(403).json({ message: 'Use a fishpen owner account for these features.' });
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origins = [process.env.FRONTEND_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'].filter(Boolean);
      if (!req.headers.origin || !origins.includes(req.headers.origin) || !req.is('application/json')) return res.status(403).json({ message: 'Untrusted request origin.' });
    }
    if (!db) return res.status(503).json({ message: 'Authentication unavailable.' });
    try {
      const [rows] = await db.query<RowDataPacket[]>('SELECT role, account_status, auth_version, must_change_password, temporary_password_expires_at FROM users WHERE id = ?', [auth.sub]);
      const user = rows[0];
      if (!user || user.role !== 'farmer' || user.account_status !== 'ACTIVE' || Number(user.auth_version) !== (auth.version ?? 0)) {
        clearAuthSession(res); return res.status(403).json({ message: 'This account is not active. Contact the administrator.' });
      }
      if (user.must_change_password && user.temporary_password_expires_at && new Date(user.temporary_password_expires_at).getTime() <= Date.now()) {
        clearAuthSession(res); return res.status(403).json({ message: 'Temporary password expired. Ask the administrator to reset it.' });
      }
      if (['/session', '/owner/password'].includes(req.path)) return next();
      if (user.must_change_password) return res.status(403).json({ message: 'Change your temporary password before accessing fishpen features.', code: 'PASSWORD_CHANGE_REQUIRED' });
      const assignment = await assignedFishpen(db, auth.sub);
      if (!assignment) return res.status(403).json({ message: 'No valid fishpen is assigned. Contact the administrator.', code: 'FISHPEN_ASSIGNMENT_REQUIRED' });
      res.locals.ownerFishpen = assignment;
      next();
    } catch { res.status(503).json({ message: 'Unable to verify owner access.' }); }
  };
}
