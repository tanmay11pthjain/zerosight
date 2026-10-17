// `npm run dev`: API on :8787 (memory storage + in-process Postgres) and the web app on :5173.
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';

const PORTS = { api: 8787, web: 5173 };

// A port is busy if anything answers on IPv4 or IPv6 localhost (Vite binds ::1, the API 0.0.0.0).
const answers = (port, host) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.setTimeout(800);
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('timeout', () => (s.destroy(), resolve(false)));
    s.once('error', () => resolve(false));
  });
const portFree = async (port) => !(await answers(port, '127.0.0.1')) && !(await answers(port, '::1'));

for (const [name, port] of Object.entries(PORTS)) {
  if (!(await portFree(port))) {
    const hint =
      process.platform === 'win32'
        ? `  Find it:  netstat -ano | findstr :${port}\n  Stop it:  taskkill /PID <pid> /F /T`
        : `  Find and stop it:  lsof -ti :${port} | xargs kill`;
    console.error(`\nPort ${port} (${name}) is already in use. ZeroSight may already be running in another terminal.\n${hint}\n`);
    process.exit(1);
  }
}

const procs = [];
let stopping = false;
const stopAll = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const p of procs) {
    try {
      if (process.platform === 'win32') execSync(`taskkill /PID ${p.pid} /T /F`, { stdio: 'ignore' });
      else p.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
};

const run = (name, cwd, cmd) => {
  const p = spawn(cmd, { cwd, shell: true, stdio: 'inherit', env: { ...process.env } });
  p.on('exit', (code) => {
    if (stopping) return;
    console.error(`[${name}] stopped (exit ${code}). Stopping everything.`);
    stopAll(code ?? 1);
  });
  procs.push(p);
};

run('api', 'api', 'node src/server.ts');
run('web', 'web', 'npx vite');
console.log('\nZeroSight: open http://localhost:5173  (Ctrl+C to stop)\n');
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopAll(0));
