// `npm run demo`: build the app, start ONE server (app + API) on :8787, and open a
// public https link with a Cloudflare quick tunnel so a second device (phone) can join.
// No accounts needed. Stop with Ctrl+C.
import { execSync, spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';

const PORT = 8787;
const win = process.platform === 'win32';
const procs = [];
const stop = (code = 0) => {
  for (const p of procs) {
    try {
      if (win) execSync(`taskkill /PID ${p.pid} /T /F`, { stdio: 'ignore' });
      else p.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }
  process.exit(code);
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(0));

const busy = (host) =>
  new Promise((res) => {
    const s = net.connect({ port: PORT, host });
    s.setTimeout(800);
    s.once('connect', () => (s.destroy(), res(true)));
    s.once('timeout', () => (s.destroy(), res(false)));
    s.once('error', () => res(false));
  });
if ((await busy('127.0.0.1')) || (await busy('::1'))) {
  console.error(`\nPort ${PORT} is in use (ZeroSight may already be running).\n  Windows: netstat -ano | findstr :${PORT}   then   taskkill /PID <pid> /F /T\n`);
  process.exit(1);
}

console.log('1/3 Building the app…');
execSync('npm --prefix web run build', { stdio: 'inherit' });

console.log('2/3 Starting the server…');
const key = Buffer.from(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
const server = spawn('node api/src/server.ts', { shell: true, stdio: 'inherit', env: { ...process.env, PORT: String(PORT), RECEIPT_SIGNING_KEY: process.env.RECEIPT_SIGNING_KEY ?? key } });
procs.push(server);
server.on('exit', (c) => (console.error('Server stopped.'), stop(c ?? 1)));
for (let i = 0; i < 60 && !(await busy('127.0.0.1')); i++) await new Promise((r) => setTimeout(r, 500));

console.log('3/3 Opening a public https link…');
const exe = win ? 'tools/cloudflared.exe' : 'tools/cloudflared';
if (!existsSync(exe)) {
  mkdirSync('tools', { recursive: true });
  const url = win
    ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    : `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${process.platform === 'darwin' ? 'darwin-amd64.tgz' : 'linux-amd64'}`;
  execSync(`curl -sSL -o ${exe} ${url}`, { stdio: 'inherit' });
  if (!win) execSync(`chmod +x ${exe}`);
}
const tunnel = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
procs.push(tunnel);
let shown = false;
const onOut = (buf) => {
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString());
  if (!m || shown) return;
  shown = true;
  const line = '═'.repeat(m[0].length + 4);
  console.log(`\n${line}\n  ${m[0]}\n${line}\n  Open this on both devices (takes ~10 s to become reachable).\n  Local: http://localhost:${PORT}   ·   Ctrl+C to stop.\n`);
  try {
    execSync(win ? `start "" "${m[0]}"` : `${process.platform === 'darwin' ? 'open' : 'xdg-open'} ${m[0]}`, { stdio: 'ignore', shell: true });
  } catch {
    /* open manually */
  }
};
tunnel.stdout.on('data', onOut);
tunnel.stderr.on('data', onOut);
tunnel.on('exit', () => (console.error('Tunnel stopped. The local app still runs at http://localhost:' + PORT), void 0));
