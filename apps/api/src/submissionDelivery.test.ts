import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Db, DbHandle } from '@form/db';
import { buildApp } from './app.ts';
import { parseConfig } from './config.ts';
import { forgetPublished, savePublished } from './routes/public.ts';
import { projectPart, renderDelivery, valueForField } from './submissionDelivery.ts';
import { COMPUTED_FIELD_TYPES, INPUT_FIELD_TYPES, type ValueFieldType } from '@form/schema';

function config() {
  const r = parseConfig({
    DEPLOYMENT_MODE: 'onprem',
    DATABASE_URL: 'postgres://fr_app:x@127.0.0.1:1/form',
    LOG_LEVEL: 'info',
    PUBLIC_BUILDER_URL: 'https://app.form.test',
    AUTH_SECRET: 'A'.repeat(43),
    KMS_KEYFILE_PATH: '/run/secrets/form-master.key',
    MAILER_DRIVER: 'log',
    PRIVACY_CONTACT_EMAIL: 'privacy@form.test',
  });
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.config;
}

const fakeDb = (): DbHandle => ({ db: {} as Db, pool: { query: async () => ({ rows: [] }) } as unknown as pg.Pool, close: async () => {} });

describe('submission delivery', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    forgetPublished();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it('renders a nested json body from the mapped field values', () => {
    const rendered = renderDelivery(
      {
        enabled: true,
        url: 'https://example.test/hook',
        format: 'json',
        keys: [
          { path: 'customer.name', fieldKey: 'name', part: '', required: true },
          { path: 'items.0.sku', fieldKey: 'sku', part: '', required: false },
        ],
      },
      [
        { key: 'name', value: 'Lokesh' },
        { key: 'sku', value: 'A1' },
      ],
    );
    expect(rendered).toMatchObject({ contentType: 'application/json' });
    if ('body' in rendered) expect(JSON.parse(rendered.body)).toEqual({ customer: { name: 'Lokesh' }, items: [{ sku: 'A1' }] });
  });

  it('posts the mapped body to the URL saved with the published form', async () => {
    const received: { type?: string; body?: string } = {};
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.type = req.headers['content-type'];
        received.body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(204);
        res.end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const formId = '01970000-0000-7000-8000-0000000000aa';
    const versionId = '01970000-0000-7000-8000-0000000000bb';
    await savePublished({
      slug: 'delivery-form',
      formId,
      version: { versionId },
      submissionApi: {
        enabled: true,
        url: `http://127.0.0.1:${port}/hooks`,
        format: 'json',
        keys: [{ path: 'customer.name', fieldKey: 'name', part: '', required: true }],
      },
    });
    const logStream = new Writable({ write(_c, _e, cb) { cb(); } });
    const app = await buildApp(config(), { db: fakeDb(), logStream, underPressure: false });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/p/delivery-form/submissions',
      headers: { 'content-type': 'application/json' },
      payload: {
        formVersionId: versionId,
        answers: { name: 'Lokesh' },
        fields: [{ key: 'name', label: 'Name', value: 'Lokesh' }],
      },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(received.type).toBe('application/json');
    expect(JSON.parse(received.body ?? '{}')).toEqual({ customer: { name: 'Lokesh' } });
  });

  it('sends every field type as structured data, and a configurable list as rows plus a summary', () => {
    const options = { options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] };
    const samples: Record<ValueFieldType, { config?: Record<string, unknown>; answer: unknown; expect: unknown }> = {
      short_text: { answer: 'Lokesh', expect: 'Lokesh' },
      long_text: { answer: 'Notes', expect: 'Notes' },
      full_name: { answer: { first: 'Lokesh', last: 'K' }, expect: { first: 'Lokesh', last: 'K' } },
      email: { answer: { address: 'lokesh@example.com', otpProof: 'secret' }, expect: 'lokesh@example.com' },
      phone: { answer: { e164: '+9198', country: 'IN' }, expect: '+9198' },
      address: { answer: { line1: 'MG Road', city: 'Pune' }, expect: { line1: 'MG Road', city: 'Pune' } },
      number: { answer: '12', expect: '12' },
      url: { answer: 'https://example.com', expect: 'https://example.com' },
      single_choice: { config: options, answer: { optionId: 'a' }, expect: 'Alpha' },
      multi_choice: { config: options, answer: { optionIds: ['a', 'b'], other: 'Other' }, expect: ['Alpha', 'Beta', 'Other'] },
      date: { answer: '2026-11-20', expect: '2026-11-20' },
      date_range: { answer: { start: '2026-11-01', end: '2026-11-20' }, expect: { start: '2026-11-01', end: '2026-11-20' } },
      datetime: { answer: { local: '2026-11-20T10:00', timeZone: 'Asia/Kolkata', instant: '2026-11-20T04:30:00.000Z' }, expect: { local: '2026-11-20T10:00', timeZone: 'Asia/Kolkata', instant: '2026-11-20T04:30:00.000Z' } },
      time: { answer: { start: '10:00' }, expect: { start: '10:00' } },
      rating: { answer: 4, expect: 4 },
      linear_scale: { answer: 7, expect: 7 },
      nps: { answer: 9, expect: 9 },
      ranking: { config: options, answer: ['b', 'a'], expect: ['Beta', 'Alpha'] },
      matching: { answer: { p1: 'a' }, expect: { p1: 'a' } },
      likert: { answer: { s1: 3 }, expect: { s1: 3 } },
      constant_sum: { answer: { a: 40, b: 60 }, expect: { a: 40, b: 60 } },
      maxdiff: { answer: { best: 'a', worst: 'b' }, expect: { best: 'a', worst: 'b' } },
      card_sort: { answer: { c1: 'bucket' }, expect: { c1: 'bucket' } },
      semantic_differential: { answer: { pair: 2 }, expect: { pair: 2 } },
      number_range: { answer: { from: '1', to: '5' }, expect: { from: '1', to: '5' } },
      schedule_grid: { answer: [{ weekday: 'mon', time: '09:00' }], expect: [{ weekday: 'mon', time: '09:00' }] },
      matrix: { answer: { rows: { r1: 'c1' } }, expect: { r1: 'c1' } },
      repeating_group: { answer: { rows: [{ rowId: '1', values: { item: { type: 'short_text', value: 'Pen' } } }] }, expect: [{ item: { type: 'short_text', value: 'Pen' } }] },
      dynamic_table: {
        config: { columns: [{ id: 'item', label: 'Item', summary: 'none' }, { id: 'amount', label: 'Amount', input: 'number', summary: 'sum', summaryLabel: 'Total' }] },
        answer: { rows: [{ cells: { item: 'Pen', amount: '10' } }, { cells: { item: 'Book', amount: '20' } }] },
        expect: { rows: [{ Item: 'Pen', Amount: '10' }, { Item: 'Book', Amount: '20' }], summary: { Total: 30 } },
      },
      file_upload: { answer: [{ fileId: 'f1', name: 'a.pdf' }], expect: [{ fileId: 'f1', name: 'a.pdf' }] },
      signature: { answer: { file: { fileId: 's1', name: 'sign.png' } }, expect: { fileId: 's1', name: 'sign.png' } },
      hidden: { answer: 'ref', expect: 'ref' },
      consent: { answer: { items: { terms: true }, noticeLocale: 'en-IN', noticeVersion: 1 }, expect: { items: { terms: true }, noticeLocale: 'en-IN', noticeVersion: 1 } },
      payment: { answer: { productId: 'p1' }, expect: { productId: 'p1' } },
      appointment: { answer: { start: '2026-11-20T04:30:00.000Z', end: '2026-11-20T05:00:00.000Z', respondentTimeZone: 'Asia/Kolkata' }, expect: { start: '2026-11-20T04:30:00.000Z', end: '2026-11-20T05:00:00.000Z', respondentTimeZone: 'Asia/Kolkata' } },
      calculation: { answer: '42', expect: '42' },
      context: { answer: { source: 'ad' }, expect: { source: 'ad' } },
      unique_id: { answer: 'FR-1', expect: 'FR-1' },
    };
    const types = [...INPUT_FIELD_TYPES, ...COMPUTED_FIELD_TYPES];
    expect(Object.keys(samples).sort()).toEqual([...types].sort());
    for (const type of types) {
      const sample = samples[type];
      expect(valueForField({ type, config: sample.config }, { type, value: sample.answer }), type).toEqual(sample.expect);
    }
    const listed = valueForField(
      { type: 'dynamic_table', config: { columns: [{ id: 'item', label: 'Item' }] } },
      { rows: [{ cells: { item: 'Pen' } }] },
    );
    expect(listed).toEqual({ rows: [{ Item: 'Pen' }] });
    const table = samples.dynamic_table.expect;
    const rendered = renderDelivery(
      {
        enabled: true,
        url: 'https://example.test',
        format: 'json',
        keys: [
          { path: 'order.lines[].item', fieldKey: 'lines', part: 'column:Item', required: true },
          { path: 'order.lines[].amount', fieldKey: 'lines', part: 'column:Amount', required: true },
          { path: 'order.total', fieldKey: 'lines', part: 'summary:Total', required: false },
        ],
      },
      [{ key: 'lines', value: table }],
    );
    if ('body' in rendered) {
      expect(JSON.parse(rendered.body)).toEqual({
        order: { lines: [{ item: 'Pen', amount: '10' }, { item: 'Book', amount: '20' }], total: 30 },
      });
    }
    expect(projectPart(table, 'column:Item')).toEqual(['Pen', 'Book']);
  });
});
