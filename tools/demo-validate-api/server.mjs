/**
 * Demo API for short-text "Validate with an API".
 *
 *   node tools/demo-validate-api/server.mjs
 *
 * In the builder: short answer → Validation → Validate with an API 
 * URL: http://localhost:3001/verify-name
 *
 * The form POSTs { [fieldKey]: "typed value" }. This server accepts any key.
 * Allowed names (case-insensitive): Lokesh, Asha Rao, Priya.
 */
import http from 'node:http';

const PORT = Number(process.env.DEMO_VALIDATE_PORT ?? 3001);
const NAMES = new Set(['lokesh', 'asha rao', 'jayesh']);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function typedValue(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  for (const value of Object.values(data)) {
    if (typeof value === 'string') return value;
  }
  return '';
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const path = req.url?.split('?')[0] ?? '';
  if (req.method !== 'POST' || path !== '/verify-name') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, message: 'Not found' }));
    return;
  }

  let data = {};
  try {
    data = JSON.parse((await readBody(req)) || '{}');
  } catch {
    data = {};
  }

  const name = typedValue(data).trim().toLowerCase();
  const ok = NAMES.has(name);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(ok ? { ok: true } : { ok: false, message: 'Name not found' }));
});

server.listen(PORT, () => {
  process.stdout.write(`Demo validation API http://localhost:${PORT}/verify-name\n`);
});
