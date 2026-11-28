import { BlockList, isIP } from 'node:net';
import type { Request } from 'express';
import type { RowDataPacket } from 'mysql2';
import type { Pool } from 'mysql2/promise';
import { authBucket } from './auth';

export function trustedProxy(env: NodeJS.ProcessEnv): false | ((address: string) => boolean) {
  const configured = env.AUTH_TRUSTED_PROXY_CIDRS?.trim();
  if (!configured) return false;
  const ipv4 = new BlockList();
  const ipv6 = new BlockList();
  const mapped = new BlockList();
  mapped.addSubnet('::ffff:0:0', 96, 'ipv6');
  for (const cidr of configured.split(',')) {
    const [address, prefix, extra] = cidr.trim().split('/');
    const version = isIP(address);
    if (extra !== undefined || !version || !/^[0-9]{1,3}$/.test(prefix || '') ||
        Number(prefix) < (version === 4 ? 8 : 16) || Number(prefix) > (version === 4 ? 32 : 128) ||
        (version === 6 && mapped.check(address, 'ipv6'))) {
      throw new Error('AUTH_TRUSTED_PROXY_CIDRS must use narrow native IPv4 or IPv6 CIDRs for verified proxies only.');
    }
    const list = version === 4 ? ipv4 : ipv6;
    list.addSubnet(address, Number(prefix), version === 4 ? 'ipv4' : 'ipv6');
  }
  return address => {
    const version = isIP(address);
    if (version === 4) return ipv4.check(address, 'ipv4');
    if (version !== 6) return false;
    return (mapped.check(address, 'ipv6') ? ipv4 : ipv6).check(address, 'ipv6');
  };
}

let nextCleanup = 0;
export async function allowAttempt(db: Pool, scope: string, subject: string, limit: number) {
  const bucket = authBucket(scope, subject);
  if (Date.now() >= nextCleanup) {
    nextCleanup = Date.now() + 300_000;
    await db.execute('DELETE FROM admin_auth_rate WHERE resets_at <= UTC_TIMESTAMP() LIMIT 500').catch(() => undefined);
  }
  await db.execute(`INSERT INTO admin_auth_rate (bucket, attempts, resets_at) VALUES (?, 1, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE))
    ON DUPLICATE KEY UPDATE attempts = IF(resets_at <= UTC_TIMESTAMP(), 1, LEAST(attempts + 1, 100000)),
    resets_at = IF(resets_at <= UTC_TIMESTAMP(), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE), resets_at)`, [bucket]);
  const [rows] = await db.query<RowDataPacket[]>('SELECT attempts FROM admin_auth_rate WHERE bucket = ?', [bucket]);
  return Number(rows[0]?.attempts) <= limit;
}

export function allowSource(db: Pool, req: Request, scope: string, limit: number, env = process.env) {
  if (env.NODE_ENV === 'production' && env.RENDER === 'true' && !env.AUTH_TRUSTED_PROXY_CIDRS?.trim()) {
    // Without a verified ingress, use one shared limit instead of trusting client-supplied addresses.
    return allowAttempt(db, `${scope}:shared`, 'unconfigured-proxy', limit);
  }
  // Express derives req.ip from the socket and stops at the first untrusted hop.
  const ip = req.ip ?? req.socket.remoteAddress;
  const address = ip?.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.)/, '');
  return address && isIP(address) ? allowAttempt(db, `${scope}:ip`, address, limit) : Promise.resolve(false);
}
