import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STACK_PORTS, stackEnv } from './stack-ports.ts';

/*
 * Starts apps/api/test/e2e-stack.ts (Postgres, Mailpit, a mock OpenID provider and the API) for
 * playwright.stack.config.ts, and stops it afterwards by telling it to on stdin, so it removes its containers itself:
 * a webServer is killed outright on Windows and would leave them running. If the runner dies, stdin closes and the
 * stack stops the same way.
 *
 * On POSIX the stack runs in a process group of its own (`detached`), so a stack that has not exited after the grace period
 * is sent SIGTERM as a group: the shell, pnpm, tsx and the node process that holds the containers all get it, and the
 * stack's handler removes its containers. Killing only the shell, as before, left that node process to die with the
 * runner's container and the stack's own containers running on the Docker host.
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
  const group = process.platform !== 'win32';
  const child = spawn('pnpm exec tsx test/e2e-stack.ts', { cwd: API_DIR, shell: true, detached: group, stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, ...stackEnv() } });
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
  const waitFor = (ms: number) => Promise.race([done, new Promise((r) => setTimeout(r, ms))]);
  /** SIGTERM to the whole stack (its process group on POSIX), not just to the shell that started it. */
  const terminate = () => {
    try {
      if (group && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
      else child.kill();
    } catch {
      /* already gone */
    }
  };
  return async () => {
    child.stdin.end('stop\n');
    await waitFor(60_000);
    if (exited) return;
    process.stderr.write('e2e stack: still running 60 s after stop; sending SIGTERM to its process group\n');
    terminate();
    // The stack's SIGTERM handler waits for the stop already under way, each step bounded to 15 s.
    await waitFor(60_000);
    if (!exited) process.stderr.write('e2e stack: did not exit; its Postgres and Mailpit containers may still be running\n');
  };
}
