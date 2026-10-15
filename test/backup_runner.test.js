import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { requeueFailures, runBackup } from '../src/backup_runner.js';
import { StateDb } from '../src/state_db.js';
import { FakeClock } from './fake_clock.js';
import { FakeSignaturaServer } from './fake_server.js';

let server;
let dest;

const run = (overrides = {}) =>
  runBackup({
    destinationRoot: dest,
    apiKey: 'test-key',
    baseUrl: server.baseUrl,
    requestIntervalMs: 0,
    ...overrides,
  });

const id = (n) => `0192f1c2-1111-7000-8000-${String(n).padStart(12, '0')}`;

before(async () => {
  server = new FakeSignaturaServer();
  await server.start();
});
after(async () => server.stop());
beforeEach(() => {
  server.documents.length = 0;
  server.requestLog.length = 0;
  server.throttleEvery = 0;
  server.failListPagesFrom = 0;
  server.failNextPdf = 0;
  server.rejectAllWith = 0;
  dest = fs.mkdtempSync(path.join(os.tmpdir(), 'signatura-backup-'));
});

test('a full run writes the archive, the index and the error file', async () => {
  server.addDocument({ id: id(1), title: 'Contrato ACME', createdAt: Date.UTC(2024, 2, 11, 14, 22) });
  server.addDocument({
    id: id(2), title: 'Anexos', status: 'PE', createdAt: Date.UTC(2024, 2, 12, 1, 30), fileNames: ['Anexo A.pdf', 'Anexo B.pdf'],
  });

  const outcome = await run();

  assert.equal(outcome.completed, true);
  assert.equal(outcome.counts.pdfsDone, 3);
  assert.equal(outcome.counts.failures, 0);
  const folder1 = path.join(dest, '2024', '2024-03', '2024-03-11_Contrato-ACME_000001');
  assert.equal(fs.readFileSync(path.join(folder1, 'Contrato.pdf'), 'utf8'), '%PDF contenido');
  assert.equal(fs.readFileSync(path.join(folder1, 'Contrato [certificado].pdf'), 'utf8'), '%PDF certificado');
  // 01:30 UTC on the 12th is still the 11th in Buenos Aires.
  const folder2 = path.join(dest, '2024', '2024-03', '2024-03-11_Anexos_000002');
  assert.ok(fs.existsSync(path.join(folder2, '1 - Anexo A.pdf')));
  assert.ok(fs.existsSync(path.join(folder2, '2 - Anexo B.pdf')));
  assert.ok(!fs.existsSync(path.join(folder2, '1 - Anexo A [certificado].pdf')));

  const index = fs.readFileSync(path.join(dest, 'indice.csv'), 'utf8');
  assert.ok(index.startsWith('﻿fecha;titulo;estado;firmantes;carpeta;archivo;archivo_original;certificado;sha256\r\n'));
  assert.ok(index.includes('2024-03-11;Contrato ACME;Completado;firmante@acme.com;'));
  assert.ok(index.includes('Pendiente;firmante@acme.com;2024/2024-03/2024-03-11_Anexos_000002;1 - Anexo A.pdf;Anexo A.pdf;No disponible;'));
  assert.ok(fs.existsSync(path.join(dest, '.signatura-backup', 'errores.csv')));
  assert.ok(fs.existsSync(path.join(dest, '.signatura-backup', 'registro.log')));
});

test('resume skips enumeration and refetches no details', async () => {
  for (let i = 1; i <= 60; i++) server.addDocument({ id: id(i), title: `Doc ${i}`, createdAt: Date.UTC(2024, 0, i % 28 + 1) });
  server.failNextPdf = 1;
  const first = await run();
  assert.equal(first.counts.failures, 0, 'the retry policy absorbs a single 500');

  // Simulate a kill after details: wipe download state for one file.
  const db = StateDb.openIn(dest);
  db.markPdfFailed(`${id(5)}-f0`);
  db.close();
  requeueFailures(dest);
  fs.unlinkSync(path.join(dest, '2024', '2024-01', '2024-01-05_Doc-5_000005', 'Contrato.pdf'));

  server.requestLog.length = 0;
  const second = await run();
  assert.equal(second.completed, true);
  const paths = server.requestLog.map((u) => u.pathname + u.search);
  assert.equal(paths.filter((p) => p.endsWith('/documents') || p.includes('/documents?')).length, 0, 'no listing');
  assert.equal(paths.filter((p) => /\/documents\/[^/]+$/.test(p)).length, 0, 'no detail calls');
  assert.deepEqual(paths, [`/api/v2/documents/${id(5)}/download/document?file=${id(5)}-f0`]);
});

test('created_before is pinned so documents added mid-run are excluded', async () => {
  server.addDocument({ id: id(1), title: 'Viejo', createdAt: Date.now() - 60_000 });
  let added = false;
  const outcome = await run({
    onProgress: () => {
      if (!added) {
        added = true;
        server.addDocument({ id: id(2), title: 'Nuevo', createdAt: Date.now() + 60_000 });
      }
    },
  });
  assert.equal(outcome.counts.documentsListed, 1);
});

test('throttling is absorbed without recording failures', async () => {
  for (let i = 1; i <= 5; i++) server.addDocument({ id: id(i), title: `Doc ${i}`, createdAt: Date.UTC(2024, 0, i) });
  server.throttleEvery = 3;
  const clock = new FakeClock();
  const outcome = await run({ clock });
  assert.equal(outcome.completed, true);
  assert.ok(server.throttledCount > 0);
  assert.equal(outcome.counts.failures, 0);
  assert.ok(clock.sleeps.some((ms) => ms >= 1000), 'Retry-After was honoured');
});

test('a rejected key aborts with the Spanish reason', async () => {
  server.rejectAllWith = 401;
  const outcome = await run();
  assert.equal(outcome.completed, false);
  assert.match(outcome.abortReason, /clave de API fue rechazada/);
});

test('a total enumeration failure aborts; a partial one continues', async () => {
  server.failListPagesFrom = 1;
  const clock = new FakeClock();
  const total = await run({ clock });
  assert.equal(total.completed, false);
  assert.match(total.abortReason, /lista de documentos/);

  dest = fs.mkdtempSync(path.join(os.tmpdir(), 'signatura-backup-'));
  for (let i = 1; i <= 60; i++) server.addDocument({ id: id(i), title: `Doc ${i}`, createdAt: Date.UTC(2024, 0, i % 28 + 1) });
  server.failListPagesFrom = 2;
  const partial = await run({ clock });
  assert.equal(partial.completed, true);
  assert.equal(partial.counts.documentsListed, 50);
  assert.equal(partial.counts.failures, 1);
  const errors = fs.readFileSync(path.join(dest, '.signatura-backup', 'errores.csv'), 'utf8');
  assert.ok(errors.includes(';enumeración;;;'));
});

test('digest mismatches are retried and then recorded as failures', async () => {
  server.addDocument({ id: id(1), title: 'Malo', createdAt: Date.UTC(2024, 0, 1) });
  const realFetch = globalThis.fetch;
  const fetchImpl = async (url, init) => {
    const response = await realFetch(url, init);
    if (!String(url).endsWith(id(1))) return response;
    const json = await response.json();
    json.files[0].digest = 'deadbeef';
    return new Response(JSON.stringify(json), { status: 200 });
  };
  const clock = new FakeClock();
  const outcome = await run({ fetchImpl, clock });
  assert.equal(outcome.completed, true);
  assert.equal(outcome.counts.pdfsDone, 0);
  assert.equal(outcome.counts.failures, 1);
  const folder = path.join(dest, '2024', '2024-01', '2024-01-01_Malo_000001');
  assert.ok(!fs.existsSync(path.join(folder, 'Contrato.pdf')));
  assert.ok(!fs.existsSync(path.join(folder, 'Contrato.pdf.part')));
});
