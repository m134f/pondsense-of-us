import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { RowDataPacket } from "mysql2";
import { pool } from "./db";
import type { Pool } from 'mysql2/promise';

const cookieName = "pondsense_auth";
const configuredSecret = process.env.SESSION_SECRET || process.env.JWT_SECRET;
if (process.env.NODE_ENV === "production" && (!configuredSecret || configuredSecret.length < 32 || configuredSecret === "pondsense-local-dev-jwt-secret")) {
  throw new Error("Production requires a strong SESSION_SECRET of at least 32 characters.");
}
const signingSecret = configuredSecret || crypto.randomBytes(48).toString("hex");

type Role = "farmer" | "admin";

type JwtHeader = {
  alg: "HS256";
  typ: "JWT";
};

type JwtPayload = {
  sub: number;
  role: Role;
  exp: number;
  jti: string;
  version?: number;
  credentialId?: number;
  verifiedAt?: number;
};

export function authBucket(scope: string, value: string) {
  return `v2_${crypto.createHmac('sha256', signingSecret).update(scope).update('\0').update(value).digest('hex').slice(0, 37)}`;
}

export function allowFixtureAdmin() {
  return process.env.NODE_ENV === 'test' &&
    (process.env.PONDSENSE_AUTH_FIXTURE === '1' || process.env.PONDSENSE_LOCAL_BENCH === '1' || process.env.PONDSENSE_LEGACY_TEST === '1') &&
    ['localhost', '127.0.0.1', '::1'].includes(process.env.MYSQL_HOST || '');
}

export type AuthRequest = Request & {
  auth?: JwtPayload;
};

function base64urlJson(value: object) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(input: string) {
  return crypto
    .createHmac("sha256", signingSecret)
    .update(input)
    .digest("base64url");
}

function readCookie(req: Request, name: string) {
  const cookie = req.headers.cookie || "";
  return cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function createAuthSession(res: Response, userId: number, role: Role, version = 0, credentialId?: number) {
  const lifetime = role === 'admin' ? 3600 : 8 * 3600;
  const header: JwtHeader = { alg: "HS256", typ: "JWT" };
  const payload: JwtPayload = {
    sub: userId,
    role,
    version,
    jti: crypto.randomBytes(24).toString('hex'),
    ...(credentialId ? { credentialId, verifiedAt: Math.floor(Date.now() / 1000) } : {}),
    exp: Math.floor(Date.now() / 1000) + lifetime
  };
  const unsigned = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const token = `${unsigned}.${sign(unsigned)}`;
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * lifetime,
    path: "/"
  });
}

export function clearAuthSession(res: Response) {
  res.clearCookie(cookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/"
  });
}

export function verifyAuthToken(req: Request): JwtPayload | null {
  const token = readCookie(req, cookieName);
  if (!token) return null;
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature || token.split(".").length !== 3) return null;
  const expected = Buffer.from(sign(`${header}.${payload}`));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JwtPayload;
    if ((decoded.role !== "farmer" && decoded.role !== "admin") || !Number.isSafeInteger(decoded.sub) || decoded.sub <= 0 || !Number.isFinite(decoded.exp) || decoded.exp <= Math.floor(Date.now() / 1000)) return null;
    // Keep already-issued farmer sessions valid and individually revocable during rollout.
    if (decoded.role === 'farmer' && decoded.jti === undefined) {
      decoded.jti = crypto.createHash('sha256').update(signature).digest('hex').slice(0, 48);
    }
    if (typeof decoded.jti !== 'string' || !/^[0-9a-f]{48}$/.test(decoded.jti)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export async function revokeSession(req: Request, res: Response, database: Pool | null = pool) {
  const auth = verifyAuthToken(req);
  if (auth) {
    if (!database) return res.status(503).json({ message: 'Logout could not be confirmed. Please try again.' });
    try {
      await database.execute('INSERT IGNORE INTO auth_session_revocations (session_id, expires_at) VALUES (?, ?)',
        [auth.jti, new Date(auth.exp * 1000).toISOString().slice(0, 19).replace('T', ' ')]);
      await database.execute('DELETE FROM auth_session_revocations WHERE expires_at <= UTC_TIMESTAMP() LIMIT 100');
    } catch { return res.status(503).json({ message: 'Logout could not be confirmed. Please try again.' }); }
  }
  clearAuthSession(res);
  res.json({ ok: true });
}

export function requireRole(role: Role, database: Pool | null = pool) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const payload = verifyAuthToken(req);
    if (!payload) return res.status(401).json({ message: "Login required." });
    if (payload.role !== role) return res.status(403).json({ message: `${role} role required.` });
    if (!database) return res.status(503).json({ message: "Database is required for authentication." });

    const [rows] = await database.execute<RowDataPacket[]>(
      "SELECT id FROM users WHERE id = ? AND role = ? LIMIT 1",
      [payload.sub, role]
    );
    if (!rows.length) return res.status(403).json({ message: `${role} role required.` });
    if (role === 'admin' && !await authorizedAdminDevice(payload, database)) return res.status(403).json({ message: 'Administrator device verification required. Please log in again.' });

    req.auth = payload;
    next();
  };
}

export const requireFarmer = requireRole("farmer");
export const requireAdmin = requireRole("admin");

export async function authorizedAdminDevice(payload: JwtPayload, database: Pool | null = pool) {
  if (!database) return false;
  const [security] = await database.query<RowDataPacket[]>('SELECT admin_id, enforced FROM admin_security WHERE id = 1');
  if (!security[0] || Number(security[0].admin_id) !== payload.sub) return false;
  if (!security[0].enforced) return allowFixtureAdmin() && !payload.credentialId;
  if (!payload.credentialId) return false;
  const [credentials] = await database.execute<RowDataPacket[]>('SELECT id FROM admin_credentials WHERE id = ? AND admin_id = ? AND revoked_at IS NULL', [payload.credentialId, payload.sub]);
  return credentials.length === 1;
}
