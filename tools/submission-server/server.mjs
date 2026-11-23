/**
 * Catches the body the form API sends after submit, and keeps each one on disk.
 *
 *   node tools/submission-server/server.mjs
 *
 * POST http://127.0.0.1:4090/hooks
 * From another container: POST http://submission-server:4090/hooks
 * GET  http://127.0.0.1:4090/          every saved body
 *
 * Files land in tools/submission-server/inbox/.
 */
import { createServer } from 'node:http';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'inbox');
const port = Number(process.env.SUBMISSION_PORT ?? 4090);
await mkdir(dir, { recursive: true });

createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
    const names = (await readdir(dir)).filter((name) => name.endsWith('.json') || name.endsWith('.xml')).sort();
    const items = await Promise.all(names.map(async (name) => ({ name, body: await readFile(path.join(dir, name), 'utf8') })));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(items, null, 2));
    return;
  }
  if (req.method === 'POST' && req.url === '/hooks') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const ext = String(req.headers['content-type'] ?? '').includes('xml') ? 'xml' : 'json';
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
    await writeFile(path.join(dir, name), body);
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, '0.0.0.0', () => {
  console.log(`listening on http://0.0.0.0:${port}/hooks`);
  console.log(`saved files in ${dir}`);
});
