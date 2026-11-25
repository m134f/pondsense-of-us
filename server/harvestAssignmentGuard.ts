import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { verifyAuthToken } from './auth';
import { assignedFishpen } from './services/OwnerFishpen';

export function harvestAssignmentGuard(pool: Pool | null, shared = false) {
  return async (req: Request, res: Response, next: NextFunction) => {
  const auth = verifyAuthToken(req);
  if (!auth) return res.status(401).json({ message: 'Login required.' });
  if (auth.role !== 'farmer') return res.status(403).json({ message: 'Farmer account required.' });
  if (!pool) return res.status(503).json({ message: 'Database unavailable.' });
  try {
    const assignment = await assignedFishpen(pool, auth.sub, false, shared);
    res.locals.fishpenAssignment = assignment;
    const match = req.path.match(/^\/(\d+)(?:\/|$)/);
    if (match) {
      const [rows] = await pool.query<RowDataPacket[]>('SELECT fishpen_id FROM harvest_batches WHERE id = ? AND owner_user_id = ?', [Number(match[1]), auth.sub]);
      if (!rows[0]) return res.status(404).json({ message: 'Fish group not found.' });
      if (req.method !== 'GET' && rows[0].fishpen_id != null && Number(rows[0].fishpen_id) !== assignment?.id) return res.status(409).json({ message: 'This historical group belongs to a different fishpen assignment. Contact the administrator.' });
    }
    if (req.method !== 'GET' && !assignment) return res.status(409).json({ message: 'No valid fishpen is assigned to your account. Ask the administrator to assign your fishpen first.' });
    next();
  } catch { res.status(503).json({ message: 'Unable to verify your fishpen assignment.' }); }
  };
}

