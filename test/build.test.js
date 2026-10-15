import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

import { build } from '../scripts/build.js';
import { FakeSignaturaServer } from './fake_server.js';

// Async, not execFileSync: the fake server lives in this process and a
// synchronous spawn would block the event loop it answers from.
const run = promisify(execFile);

let server;
let bundle;

before(async () => {
  server = new FakeSignaturaServer();
  await server.start();
  // A directory of its own, with no package.json: the bundle must stand alone.
  bundle = build({ outFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dist-')), 'signatura-backup.mjs') });
});
after(async () => server.stop());

test('the bundle prints help and declares no module syntax', async () => {
  const { stdout: help } = await run(process.execPath, [bundle, '--help'], { encoding: 'utf8' });
  assert.match(help, /^Signatura Backup/);
  assert.ok(!fs.readFileSync(bundle, 'utf8').includes("from './"));
});

test('the bundle completes a backup without printing warnings', async () => {
  server.addDocument({ id: '0192f1c2-1111-7000-8000-000000000001', title: 'Contrato', createdAt: Date.UTC(2024, 2, 11) });
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dest-'));
  const { stdout, stderr } = await run(process.execPath, [bundle, '--yes', dest], {
    encoding: 'utf8',
    env: { ...process.env, SIGNATURA_API_KEY: 'k', SIGNATURA_BASE_URL: server.baseUrl },
  });
  assert.equal(stdout, '');
  assert.match(stderr, /Copia finalizada\./);
  assert.match(stderr, /1 archivos descargados, 0 errores registrados\./);
  assert.doesNotMatch(stderr, /Warning/);
  assert.ok(fs.existsSync(path.join(dest, 'indice.csv')));
  assert.ok(fs.existsSync(path.join(dest, '2024', '2024-03', '2024-03-10_Contrato_000001', 'Contrato.pdf')));
});
