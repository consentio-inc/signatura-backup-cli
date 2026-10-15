import assert from 'node:assert/strict';
import { test } from 'node:test';

import { certificateFileName, documentFolder, pdfFileName, slug } from '../src/archive_paths.js';
import { archiveDateStamp } from '../src/document.js';

const docWith = (title, id = '0192f1c2111170008000000000000001') => ({
  id,
  title,
  archiveDateStamp: archiveDateStamp(Date.UTC(2024, 2, 11, 14, 22)),
});
const fileNamed = (name, order = 0) => ({ id: 'f', name, digest: 'abc', order });

test('slug strips diacritics and punctuation, capped at 40 chars', () => {
  const s = slug('Contrato de Locación: Av. Rivadavia 1234 4°B — ACME S.R.L. y otros');
  assert.equal(s, 'Contrato-de-Locacion-Av-Rivadavia-1234');
  assert.equal(s.length, 38);
});

test('slug never ends in a hyphen after truncation', () => {
  assert.ok(!slug('A'.repeat(39) + ' B').endsWith('-'));
});

test('slug falls back when a title has no usable characters', () => {
  assert.equal(slug('¿¡---!?'), 'documento');
});

test('documentFolder nests year / year-month / dated folder with the id tail', () => {
  assert.equal(documentFolder(docWith('Contrato ACME')), '2024/2024-03/2024-03-11_Contrato-ACME_000001');
  assert.ok(documentFolder(docWith('X', '0199b7c4d1e270008000000000aaaaaa')).endsWith('_aaaaaa'));
});

test('archive date is the Argentina calendar day', () => {
  // 01:30 UTC on the 12th is 22:30 on the 11th in Buenos Aires.
  assert.equal(archiveDateStamp(Date.UTC(2024, 2, 12, 1, 30)), '2024-03-11');
});

test('file names keep accents, prefix multi-file order, and add the certificate suffix', () => {
  assert.equal(pdfFileName(fileNamed('Contrato Locación.pdf'), false), 'Contrato Locación.pdf');
  assert.equal(pdfFileName(fileNamed('Anexo B.pdf', 1), true), '2 - Anexo B.pdf');
  assert.equal(certificateFileName(fileNamed('Contrato.pdf'), false), 'Contrato [certificado].pdf');
});

test('file names are made Windows-safe', () => {
  assert.equal(pdfFileName(fileNamed('Reporte 03/2024: v2*final?.pdf'), false), 'Reporte 03-2024- v2-final-.pdf');
  assert.equal(pdfFileName(fileNamed('CON.pdf'), false), 'CON_.pdf');
  assert.equal(pdfFileName(fileNamed('lpt1.pdf'), false), 'lpt1_.pdf');
  assert.equal(pdfFileName(fileNamed('Contrato . . .pdf'), false), 'Contrato.pdf');
  assert.equal(pdfFileName(fileNamed('\\/:*?"<>|.pdf'), false), 'documento.pdf');
  assert.equal(pdfFileName(fileNamed('Contrato--2024.pdf'), false), 'Contrato--2024.pdf');
});

test('stems are capped at 60 characters before the order prefix', () => {
  assert.equal(pdfFileName(fileNamed('x'.repeat(200) + '.pdf'), false), 'x'.repeat(60) + '.pdf');
  assert.equal(pdfFileName(fileNamed('x'.repeat(200) + '.pdf', 0), true), '1 - ' + 'x'.repeat(60) + '.pdf');
});
