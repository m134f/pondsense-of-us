import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { RowDataPacket } from "mysql2";
import { pool } from "./db";

const cookieName = "pondsense_auth";
const defaultSecret = "pondsense-local-dev-jwt-secret";

type Role = "farmer" | "admin";

type JwtHeader = {
  alg: "HS256";
  typ: "JWT";
};

type JwtPayload = {
  sub: number;
  role: Role;
  exp: number;
};

export type AuthRequest = Request & {
  auth?: JwtPayload;
};

function base64urlJson(value: object) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(input: string) {
  return crypto
    .createHmac("sha256", process.env.SESSION_SECRET || process.env.JWT_SECRET || defaultSecret)
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

export function createAuthSession(res: Response, userId: number, role: Role) {
  const header: JwtHeader = { alg: "HS256", typ: "JWT" };
  const payload: JwtPayload = {
    sub: userId,
    role,
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
  if (!header || !payload || !signature) return null;
  if (sign(`${header}.${payload}`) !== signature) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JwtPayload;
    if ((decoded.role !== "farmer" && decoded.role !== "admin") || decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function requireRole(role: Role) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const payload = verifyAuthToken(req);
    if (!payload) return res.status(401).json({ message: "Login required." });
    if (payload.role !== role) return res.status(403).json({ message: `${role} role required.` });
    if (!pool) return res.status(503).json({ message: "Database is required for authentication." });

    const [rows] = await pool.execute<RowDataPacket[]>(
      "SELECT id FROM users WHERE id = ? AND role = ? LIMIT 1",
      [payload.sub, role]
    );
    if (!rows.length) return res.status(403).json({ message: `${role} role required.` });

    req.auth = payload;
    next();
  };
}

export const requireFarmer = requireRole("farmer");
export const requireAdmin = requireRole("admin");
