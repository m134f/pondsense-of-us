// Local hardware bench only. Never load the workspace's application .env.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { access, cp, copyFile, mkdir, mkdtemp, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:https';
import { createServer as tcpServer, isIPv4 } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import mysql from 'mysql2/promise';

const args = process.argv.slice(2);
const webOnly = args.includes('--web-only');
const [host = '127.0.0.1', mode, sourceFolderPath, loginLog] = args.filter(arg => arg !== '--web-only');
if (mode && (!['--resume', '--recover-copy'].includes(mode) || !sourceFolderPath || (mode === '--recover-copy' && !loginLog))) {
  throw new Error('Use --resume <bench folder> or --recover-copy <old bench folder> <old login file>.');
}
const localAddresses = Object.values(networkInterfaces()).flat().filter(Boolean).map(entry => entry.address);
if (!isIPv4(host) || !localAddresses.includes(host) || !/^(127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
  throw new Error('Use 127.0.0.1 or a private IPv4 address assigned to this PC.');
}
const xampp = process.env.PONDSENSE_BENCH_XAMPP || 'C:/xampp';
const bin = name => join(xampp, 'mysql', 'bin', name);
const apiPort = 5100, webPort = 5180, sqlPort = 3310, tlsPort = 8443;
const site = `http://127.0.0.1:${webPort}`;
const localApi = `http://127.0.0.1:${apiPort}`;
const boardApi = `https://${host}:${tlsPort}/api/v2/hardware`;
const checkPort = async (port, address) => new Promise((resolve, reject) => {
  const server = tcpServer();
  server.once('error', reject);
  server.listen(port, address, () => server.close(resolve));
});
for (const port of [apiPort, webPort, sqlPort]) await checkPort(port, '127.0.0.1');
if (!webOnly) await checkPort(tlsPort, host);

let sourceFolder;
if (mode) {
  sourceFolder = await realpath(sourceFolderPath);
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (!same(dirname(sourceFolder), await realpath(tmpdir())) || !/^pondsense-esp32-bench-[\w-]+$/.test(basename(sourceFolder)) ||
      !same(await realpath(join(sourceFolder, 'mysql')), join(sourceFolder, 'mysql'))) {
    throw new Error('Only a local PondSense bench folder can be resumed or recovered.');
  }
  for (const file of ['bench.env', 'mysql/pondsense_esp32_bench', 'server.pem', 'server.key']) await access(join(sourceFolder, file));
  if (!webOnly && !new X509Certificate(await readFile(join(sourceFolder, 'server.pem'))).checkIP(host)) {
    throw new Error('The original bench certificate does not match the requested LAN IP.');
  }
}
const folder = mode === '--resume' ? sourceFolder : await mkdtemp(join(tmpdir(), 'pondsense-esp32-bench-'));
const path = name => join(folder, name);
const dbRootPassword = randomBytes(16).toString('hex');
let state = {
  dbUser: 'bench', dbPassword: randomBytes(16).toString('hex'), adminPassword: randomBytes(12).toString('base64url'),
  pin: String(100000 + (randomBytes(4).readUInt32LE() % 900000)), sessionSecret: randomBytes(32).toString('hex')
};
if (mode === '--resume') {
  state = JSON.parse(await readFile(path('bench-runtime.json'), 'utf8'));
} else if (mode === '--recover-copy') {
  const log = await readFile(loginLog, 'utf8');
  state.dbUser = 'bench_resume';
  state.adminPassword = /Temporary bench password: ([A-Za-z0-9_-]+)/.exec(log)?.[1] || '';
  state.pin = /Bench PIN: (\d{6})/.exec(log)?.[1] || '';
  if (state.adminPassword.length < 12 || !state.pin) throw new Error('The original bench login file is needed to keep its web credentials.');
  await cp(sourceFolder, folder, { recursive: true });
}
if (!['bench', 'bench_resume'].includes(state.dbUser) || !/^[a-f0-9]{32}$/.test(state.dbPassword) ||
    !/^[a-f0-9]{64}$/.test(state.sessionSecret) || !/^\d{6}$/.test(state.pin) || state.adminPassword.length < 12) {
  throw new Error('Invalid local bench runtime configuration.');
}
const { dbUser, dbPassword, adminPassword, pin, sessionSecret } = state;
const sql = { host: '127.0.0.1', port: sqlPort, user: 'root', password: dbRootPassword };
const isolatedEnv = {
  ...process.env,
  DOTENV_CONFIG_PATH: path('bench.env'), DOTENV_CONFIG_OVERRIDE: 'false',
  NODE_ENV: 'test', PORT: String(apiPort), PONDSENSE_LOCAL_BENCH: '1',
  MYSQL_HOST: sql.host, MYSQL_PORT: String(sqlPort), MYSQL_USER: dbUser, MYSQL_PASSWORD: dbPassword,
  MYSQL_DATABASE: 'pondsense_esp32_bench', MYSQL_SSL: 'false',
  ADMIN_USERNAME: 'bench-admin', ADMIN_FULL_NAME: 'Bench administrator', ADMIN_PHONE: '+639100000001',
  ADMIN_PASSWORD: adminPassword, ADMIN_PIN: pin, ADMIN_ACCOUNT_ID: '',
  SESSION_SECRET: sessionSecret, FRONTEND_URL: site, IPROG_SMS_API_TOKEN: '',
  WATER_SMS_THRESHOLDS_REVIEWED: 'false', WATER_SMS_RULES_REFERENCE: '',
  PONDSENSE_LEGACY_TEST: '', PONDSENSE_ENABLE_SHARED_UPLOADS: 'true', PONDSENSE_PAUSE_HARDWARE_UPLOADS: webOnly ? 'true' : ''
};
if (!mode) await writeFile(path('bench.env'), '# Empty on purpose; staging values are supplied by the launcher.\n', { flag: 'wx' });

const children = [];
let tls;
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  tls?.close();
  for (const child of children.reverse()) if (child.exitCode === null) child.kill();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.once('exit', stop);
function start(label, exe, args, options = {}) {
  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true, ...options });
  children.push(child);
  child.on('error', error => { console.error(`${label}: ${error.message}`); process.exitCode = 1; stop(); });
  child.on('exit', code => {
    if (!stopping) { console.error(`${label} stopped unexpectedly (${code}).`); process.exitCode = 1; stop(); }
  });
}
async function ready(fn, label) {
  for (let i = 0; i < 100 && !stopping; i++) {
    const result = await Promise.resolve().then(fn).catch(() => null);
    if (result) return result;
    await wait(150);
  }
  throw new Error(`${label} did not start.`);
}

try {
  console.log(mode ? 'Opening existing local bench records...' : 'Preparing an isolated local database, web app, and ESP32 HTTPS endpoint...');
  let bootstrap;
  if (!mode) {
    execFileSync(bin('mysql_install_db.exe'), [`--datadir=${path('mysql')}`, `--password=${dbRootPassword}`, '--silent'], { windowsHide: true });
  } else if (mode === '--recover-copy') {
    // Use a new loopback-only runtime account on the copy; no existing credentials are changed.
    bootstrap = path('recover-bench.sql');
    await writeFile(bootstrap, `CREATE USER 'bench_resume'@'localhost' IDENTIFIED BY '${dbPassword}';\nGRANT SELECT, INSERT, UPDATE, DELETE ON pondsense_esp32_bench.* TO 'bench_resume'@'localhost';\n`, { mode: 0o600, flag: 'wx' });
  }
  try {
    start('Bench MariaDB', bin('mysqld.exe'), ['--no-defaults', `--datadir=${path('mysql')}`, '--bind-address=127.0.0.1', `--port=${sqlPort}`, '--console',
      ...(bootstrap ? [`--init-file=${bootstrap}`] : [])]);
    if (!mode) {
      const db = await ready(() => mysql.createConnection({ ...sql, multipleStatements: true }), 'Bench MariaDB');
      try {
        await db.query('CREATE DATABASE pondsense_esp32_bench; USE pondsense_esp32_bench');
        const schema = (await readFile('server/schema.sql', 'utf8')).replace(/^CREATE DATABASE IF NOT EXISTS pondsense;\s*USE pondsense;\s*/, '');
        if (!schema.startsWith('CREATE TABLE')) throw new Error('Unexpected base schema format.');
        await db.query(schema);
        await db.query("CREATE USER 'bench'@'localhost' IDENTIFIED BY ?; GRANT ALL ON pondsense_esp32_bench.* TO 'bench'@'localhost'", [dbPassword]);
      } finally { await db.end(); }
      execFileSync(process.execPath, ['--import', 'tsx', 'server/prepare-local-database.ts'], { env: isolatedEnv, windowsHide: true, stdio: 'inherit' });
    } else {
      const db = await ready(() => mysql.createConnection({ ...sql, user: dbUser, password: dbPassword, database: 'pondsense_esp32_bench' }), 'Existing bench database');
      try {
        const [rows] = await db.query('SELECT COUNT(*) AS accounts FROM users');
        console.log(`Retained accounts in isolated bench: ${Number(rows[0].accounts)}`);
      } finally { await db.end(); }
    }
    if (mode !== '--resume') await writeFile(path('bench-runtime.json'), JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  } finally { if (bootstrap) await unlink(bootstrap); }
  start('Bench backend', process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: isolatedEnv });
  await ready(async () => (await (await fetch(`${localApi}/api/health`)).json()).database === 'mysql-connected', 'Bench API');
  start('Bench frontend', process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
    env: { ...isolatedEnv, NODE_ENV: 'development', PONDSENSE_DEV_API_TARGET: localApi, VITE_API_URL: '' }
  });
  await ready(async () => (await fetch(site)).ok, 'Bench frontend');

  const sketchName = 'pondsense_temperature_turbidity_lcd';
  const sketch = name => join(folder, sketchName, name);
  if (webOnly) {
    console.log(`Website: ${site}/admin/login\nHardware ingestion is paused in web-only mode.`);
  } else {
    if (!mode) {
      const ssl = (...args) => execFileSync(join(xampp, 'apache', 'bin', 'openssl.exe'), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      const sslConfig = join(xampp, 'apache', 'conf', 'openssl.cnf');
      ssl('req', '-config', sslConfig, '-new', '-newkey', 'rsa:2048', '-nodes', '-x509', '-days', '7', '-subj', '/CN=PondSense Bench CA',
        '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', path('ca.key'), '-out', path('ca.pem'));
      ssl('req', '-config', sslConfig, '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=PondSense Bench',
        '-keyout', path('server.key'), '-out', path('server.csr'));
      await writeFile(path('server.ext'), `subjectAltName=IP:${host}\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n`);
      ssl('x509', '-req', '-in', path('server.csr'), '-CA', path('ca.pem'), '-CAkey', path('ca.key'), '-CAcreateserial',
        '-days', '7', '-extfile', path('server.ext'), '-out', path('server.pem'));
      const ca = await readFile(path('ca.pem'), 'utf8');
      const source = join('hardware', sketchName);
      await mkdir(path(sketchName));
      for (const file of [`${sketchName}.ino`, 'server_ca_cert.h']) await copyFile(join(source, file), sketch(file));
      const template = await readFile(join(source, 'device_secrets.h.example'), 'utf8');
      await writeFile(sketch('device_secrets.h'), template.replace('// #include "bench_config.h"', '#include "bench_config.h"'));
      await writeFile(sketch('bench_config.h'), `#pragma once\n#define PONDSENSE_BENCH\n#define PONDSENSE_HARDWARE_API "${boardApi}"\nstatic const char* const PONDSENSE_BENCH_CA = R"BENCH(${ca})BENCH";\n#define PONDSENSE_HARDWARE_CA PONDSENSE_BENCH_CA\n`);
    }
    tls = createServer({ key: await readFile(path('server.key')), cert: await readFile(path('server.pem')) }, (req, res) => {
      if (req.method !== 'POST' || !['/api/v2/hardware/assignment', '/api/v2/hardware/readings'].includes(req.url)) {
        res.writeHead(404).end();
        return;
      }
      const headers = { 'Content-Type': req.headers['content-type'] || 'application/json', 'X-API-Key': req.headers['x-api-key'] || '' };
      const upstream = httpRequest(`${localApi}${req.url}`, { method: 'POST', headers }, response => {
        res.writeHead(response.statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end(); });
      res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
      req.pipe(upstream);
    });
    await new Promise((resolve, reject) => { tls.once('error', reject); tls.listen(tlsPort, host, resolve); });
    console.log(`Website: ${site}/admin/login\nBoard HTTPS API: ${boardApi}\nArduino IDE bench sketch: ${sketch(`${sketchName}.ino`)}`);
  }
  console.log(`Local-only admin: bench-admin\nTemporary bench password: ${adminPassword}\nBench PIN: ${pin}\nBench state folder: ${folder}\nStop with Ctrl+C. Use --resume with this folder to preserve records and configuration.`);
} catch (error) {
  console.error(error instanceof Error ? error.message.split('\n')[0] : 'Bench setup failed.');
  process.exitCode = 1;
  stop();
}
