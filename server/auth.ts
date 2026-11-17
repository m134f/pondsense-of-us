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
  version?: number;
  credentialId?: number;
  verifiedAt?: number;
};

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
  const header: JwtHeader = { alg: "HS256", typ: "JWT" };
  const payload: JwtPayload = {
    sub: userId,
    role,
    version,
    ...(credentialId ? { credentialId, verifiedAt: Math.floor(Date.now() / 1000) } : {}),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8
  };
  const unsigned = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const token = `${unsigned}.${sign(unsigned)}`;
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 8,
    path: "/"
  });
}

export function clearAuthSession(res: Response) {
  res.clearCookie(cookieName, {
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
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
    return decoded;
  } catch {
    return null;
  }
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
  if (!security[0].enforced) return true;
  if (!payload.credentialId) return false;
  const [credentials] = await database.execute<RowDataPacket[]>('SELECT id FROM admin_credentials WHERE id = ? AND admin_id = ? AND revoked_at IS NULL', [payload.credentialId, payload.sub]);
  return credentials.length === 1;
}
