import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { after, before, beforeEach, test } from 'node:test';

import { runBackup } from '../src/backup_runner.js';
import { main } from '../src/cli.js';
import { RateLimiter } from '../src/rate_limiter.js';
import { resumeMatchesWorkspace } from '../src/resume_check.js';
import { SignaturaClient } from '../src/signatura_client.js';
import { StateDb } from '../src/state_db.js';
import { FakeClock } from './fake_clock.js';
import { FakeSignaturaServer } from './fake_server.js';

// Two workspaces, each behind its own fake server.
let a;
let b;
let dest;

const id = (ws, n) => `0192f1c2-${ws}-7000-8000-${String(n).padStart(12, '0')}`;
const clientFor = (server) =>
  new SignaturaClient({ baseUrl: server.baseUrl, apiKey: 'k', limiter: new RateLimiter({ minIntervalMs: 0 }) });
const runOn = (server) =>
  runBackup({ destinationRoot: dest, apiKey: 'k', baseUrl: server.baseUrl, requestIntervalMs: 0, clock: new FakeClock() });

before(async () => {
  a = new FakeSignaturaServer();
  b = new FakeSignaturaServer();
  await Promise.all([a.start(), b.start()]);
});
after(async () => Promise.all([a.stop(), b.stop()]));
beforeEach(() => {
  a.documents.length = 0;
  b.documents.length = 0;
  for (let i = 1; i <= 60; i++) a.addDocument({ id: id('aaaa', i), title: `A ${i}`, createdAt: Date.UTC(2024, 0, 1) + i * 1000 });
  for (let i = 1; i <= 3; i++) b.addDocument({ id: id('bbbb', i), title: `B ${i}`, createdAt: Date.UTC(2024, 5, 1) + i * 1000 });
  dest = fs.mkdtempSync(path.join(os.tmpdir(), 'signatura-resume-'));
});

test('a run from workspace A does not match a key for workspace B', async () => {
  await runOn(a);
  assert.equal(await resumeMatchesWorkspace({ client: clientFor(a), destinationRoot: dest }), true);
  assert.equal(await resumeMatchesWorkspace({ client: clientFor(b), destinationRoot: dest }), false);
});

test('a run that listed nothing yet resumes with any key', async () => {
  const db = StateDb.openIn(dest);
  db.startOrResume(Date.now());
  db.close();
  assert.equal(await resumeMatchesWorkspace({ client: clientFor(b), destinationRoot: dest }), true);
});

test('documents created after the pin, or the newest one deleted, still match', async () => {
  await runOn(a);
  a.addDocument({ id: id('aaaa', 999), title: 'Nuevo', createdAt: Date.now() + 60_000 });
  a.documents.splice(a.documents.findIndex((d) => d.id === id('aaaa', 60)), 1);
  assert.equal(await resumeMatchesWorkspace({ client: clientFor(a), destinationRoot: dest }), true);
});

test('the CLI refuses to resume with another workspace and touches nothing', async () => {
  await runOn(a);
  const before = fs.statSync(path.join(dest, '.signatura-backup', 'state.db')).mtimeMs;
  const stderr = new PassThrough();
  let output = '';
  stderr.on('data', (chunk) => (output += chunk));
  process.env.SIGNATURA_API_KEY = 'k';
  process.env.SIGNATURA_BASE_URL = b.baseUrl;
  try {
    const code = await main(['--yes', '--retry-failed', dest], {
      stdout: new PassThrough(),
      stderr,
      stdin: Readable.from([]),
    });
    assert.equal(code, 1);
  } finally {
    delete process.env.SIGNATURA_API_KEY;
    delete process.env.SIGNATURA_BASE_URL;
  }
  assert.match(output, /otro espacio de trabajo/);
  assert.doesNotMatch(output, /Se volverán a intentar/);
  assert.equal(fs.statSync(path.join(dest, '.signatura-backup', 'state.db')).mtimeMs, before);
});
