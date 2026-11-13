/**
 * Demo API for short-text "Validate with an API" and choice "Load options from an API".
 *
 *   node tools/demo-validate-api/server.mjs
 *
 * Validate: POST http://localhost:3001/verify-name
 *           POST http://localhost:3001/verify-name.xml
 * Options:  GET  http://localhost:3001/cities
 *           GET  http://localhost:3001/cities.xml
 *           GET  http://localhost:3001/cities-map
 *           GET  http://localhost:3001/cities-names.xml
 *
 * The form POSTs { [fieldKey]: "typed value" }. This server accepts any key.
 * Allowed names (case-insensitive): Lokesh, Asha Rao, Jayesh.
 */
import http from 'node:http';

const PORT = Number(process.env.DEMO_VALIDATE_PORT ?? 3001);
const NAMES = new Set(['lokesh', 'asha rao', 'jayesh']);
const CITIES = [
  { id: 'mum', name: 'Mumbai' },
  { id: 'del', name: 'Delhi' },
  { id: 'blr', name: 'Bengaluru' },
];

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function xml(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8' });
  res.end(body);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function citiesXml() {
  const rows = CITIES.map((city) => `    <city>
      <id>${escapeXml(city.id)}</id>
      <name>${escapeXml(city.name)}</name>
    </city>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<root>
  <cities>
${rows}
  </cities>
</root>
`;
}

function cityNamesXml() {
  const rows = CITIES.map((city) => `  <city>${escapeXml(city.name)}</city>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<cities>
${rows}
</cities>
`;
}

function verifyXml(ok, name) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<root>
  <ok>${ok}</ok>
  <success>${ok}</success>
  <code>${ok ? 1 : 0}</code>
  <status>${ok ? 'validated' : 'rejected'}</status>
  <message>${escapeXml(ok ? 'Name is on the list' : 'Name not found')}</message>
  <checked>${escapeXml(name)}</checked>
  <count>${ok ? NAMES.size : 0}</count>
</root>
`;
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

  if (req.method === 'GET' && path === '/cities') {
    json(res, 200, { data: { cities: CITIES } });
    return;
  }
  if (req.method === 'GET' && path === '/cities.xml') {
    xml(res, 200, citiesXml());
    return;
  }
  if (req.method === 'GET' && path === '/cities-map') {
    json(res, 200, Object.fromEntries(CITIES.map((city) => [city.id, city.name])));
    return;
  }
  if (req.method === 'GET' && path === '/cities-names.xml') {
    xml(res, 200, cityNamesXml());
    return;
  }

  const verifyXmlPath = path === '/verify-name.xml';
  if (req.method !== 'POST' || (path !== '/verify-name' && !verifyXmlPath)) {
    json(res, 404, { ok: false, message: 'Not found' });
    return;
  }

  let data = {};
  try {
    data = JSON.parse((await readBody(req)) || '{}');
  } catch {
    data = {};
  }

  const name = typedValue(data).trim();
  const ok = NAMES.has(name.toLowerCase());
  if (verifyXmlPath) {
    xml(res, 200, verifyXml(ok, name));
    return;
  }
  json(res, 200, ok
    ? {
        ok: true,
        success: true,
        code: 1,
        status: 'validated',
        message: 'Name is on the list',
        checked: name,
        count: NAMES.size,
      }
    : {
        ok: false,
        success: false,
        code: 0,
        status: 'rejected',
        message: 'Name not found',
        checked: name,
        count: 0,
      });
});

server.listen(PORT, () => {
  process.stdout.write(`Demo API http://localhost:${PORT}/verify-name (POST JSON), /verify-name.xml (POST XML), /cities (GET JSON), /cities.xml (GET XML)\n`);
});
