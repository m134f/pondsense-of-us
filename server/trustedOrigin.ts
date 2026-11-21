import type { Request } from 'express';

const productionOrigin = 'https://pondsense-of-us.vercel.app';

export function trustedOrigins(): string[] {
  const configured = process.env.FRONTEND_URL?.trim().replace(/\/+$/, '');
  return [...new Set([
    productionOrigin,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    configured
  ].filter((origin): origin is string => Boolean(origin)))];
}

export function isTrustedJsonRequest(req: Request): boolean {
  const contentType = req.headers['content-type'];
  return Boolean(
    req.headers.origin &&
    trustedOrigins().includes(req.headers.origin) &&
    typeof contentType === 'string' &&
    contentType.split(';', 1)[0].trim().toLowerCase() === 'application/json'
  );
}
