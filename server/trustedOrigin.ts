import type { Request } from 'express';

const productionOrigin = 'https://pondsense-of-us.vercel.app';

export function trustedOrigins(): string[] {
  const configured = process.env.FRONTEND_URL?.trim().replace(/\/+$/, '');
  if (process.env.NODE_ENV === 'production') {
    try {
      const url = new URL(configured || productionOrigin);
      return url.protocol === 'https:' && url.origin === url.href.slice(0, -1) ? [url.origin] : [];
    } catch { return []; }
  }
  return [...new Set([
    productionOrigin,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    configured
  ].filter((origin): origin is string => Boolean(origin)))];
}

const deviceUploads = new Set(['/v1/sensors/measurements', '/v1/sensors/turbidity', '/v1/sensors/data', '/sensor/readings',
  '/v2/hardware/assignment', '/v2/hardware/readings']);

export function isDeviceUpload(req: Request) {
  return req.method === 'POST' && deviceUploads.has(req.path);
}

export function needsBrowserOrigin(req: Request) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isDeviceUpload(req);
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
