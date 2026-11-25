import { pool } from './db';
import { migrateSharedHardware } from './migrations/sharedHardware';
import { verifyStartupSchema } from './startupSchema';

if (!pool || process.env.NODE_ENV === 'production' ||
    !['localhost', '127.0.0.1', '::1'].includes(process.env.MYSQL_HOST ?? '')) {
  throw new Error('This preparation command is restricted to a configured local development database.');
}
try {
  await migrateSharedHardware(pool);
  await verifyStartupSchema(pool);
  console.log('Local shared hardware schema is ready. No hardware or credentials were created.');
} finally { await pool.end(); }
