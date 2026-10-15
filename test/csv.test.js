import assert from 'node:assert/strict';
import { test } from 'node:test';

import { csvRow } from '../src/csv.js';

test('joins with semicolons and quotes only when needed', () => {
  assert.equal(csvRow(['a', 'b;c', 'say "hi"', 'x\ny']), 'a;"b;c";"say ""hi""";"x\ny"');
});

test('neutralises formula leaders', () => {
  assert.equal(csvRow(['=SUM(A1)', '+1', '-1', '@x']), "'=SUM(A1);'+1;'-1;'@x");
});
