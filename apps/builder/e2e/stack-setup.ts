import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STACK_PORTS, stackEnv } from './stack-ports.ts';

/*
 * Starts apps/api/test/e2e-stack.ts (Postgres, Mailpit, a mock OpenID provider and the API) for
 * playwright.stack.config.ts, and stops it afterwards by telling it to on stdin, so it removes its containers itself:
 * a webServer is killed outright on Windows and would leave them running. If the runner dies, stdin closes and the
 * stack stops the same way.
 */
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../api');
const STACK_API = `http://127.0.0.1:${STACK_PORTS.api}`;

async function ready(deadline: number, exited: () => boolean): Promise<void> {
  for (;;) {
    if (exited()) throw new Error('the e2e stack exited before it was ready');
    try {
      if ((await fetch(`${STACK_API}/livez`)).ok) return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error('the e2e stack did not become ready in 5 minutes');
    await new Promise((r) => setTimeout(r, 500));
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const child = spawn('pnpm exec tsx test/e2e-stack.ts', { cwd: API_DIR, shell: true, stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, ...stackEnv() } });
  let exited = false;
  const done = new Promise<void>((resolve) =>
    child.once('exit', () => {
      exited = true;
      resolve();
    }),
  );
  try {
    await ready(Date.now() + 300_000, () => exited);
  } catch (err) {
    child.stdin.end();
    throw err;
  }
  return async () => {
    child.stdin.end('stop\n');
    await Promise.race([done, new Promise((r) => setTimeout(r, 60_000))]);
    if (!exited) child.kill();
  };
}
