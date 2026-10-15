import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detailFromJson } from '../src/document.js';

test('extracts signers preferring email, then AFIP legal name, then phone', () => {
  const detail = detailFromJson({
    id: 'd1',
    title: 'T',
    status: 'CO',
    creation_date: '2024-03-11T14:22:00Z',
    files: [{ id: 'f2', name: 'B.pdf', digest: '', order: 1 }, { id: 'f1', name: ' ', digest: 'ab', order: 0 }],
    signatures: [
      { validations: { EM: { value: 'a@x.com' }, AF: { value: { CUIT: '20-1' } } } },
      { validations: { AF: { value: { CUIT: '20-2', full_name: 'Ana Pérez' } } } },
      { validations: { AF: { value: { CUIT: '20-3', first_name: 'Juan', last_name: 'Gil' } } } },
      { validations: { PH: { value: '+54911' } } },
      { validations: { BI: { value: { provider: 'x' } } } },
      { validations: { AF: { value: 'not-an-object' } } },
    ],
  });
  assert.deepEqual(detail.signers, ['a@x.com', '20-2 (Ana Pérez)', '20-3 (Juan Gil)', '+54911', 'not-an-object']);
  assert.deepEqual(detail.files.map((f) => f.id), ['f1', 'f2']);
  assert.equal(detail.files[0].name, 'documento.pdf');
  assert.equal(detail.isMultiFile, true);
  assert.equal(detail.archiveDateStamp, '2024-03-11');
});

test('rejects unknown statuses', () => {
  assert.throws(() => detailFromJson({ id: 'd', status: 'ZZ', creation_date: '2024-01-01T00:00:00Z' }));
});
