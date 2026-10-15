import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { LINE_ENDING, csvRow } from './csv.js';
import { STATE_DIR_NAME } from './state_db.js';

/** Without a BOM, es-AR Excel reads the file as Latin-1. */
const BOM = '﻿';

export const INDEX_HEADERS = [
  'fecha', 'titulo', 'estado', 'firmantes', 'carpeta',
  'archivo', 'archivo_original', 'certificado', 'sha256',
];

export const ERROR_HEADERS = ['fecha', 'tipo', 'documento', 'archivo', 'detalle'];

export function writeIndex(destinationRoot, rows) {
  return write(
    path.join(destinationRoot, 'indice.csv'),
    INDEX_HEADERS,
    map(rows, (r) => [
      r.creationDate, r.title, r.statusLabel, r.signers, r.folder,
      r.fileName, r.originalName, r.certificateName, r.digest,
    ]),
  );
}

export function writeErrors(destinationRoot, rows) {
  const dir = path.join(destinationRoot, STATE_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return write(
    path.join(dir, 'errores.csv'),
    ERROR_HEADERS,
    map(rows, (r) => [r.at, r.kind, r.documentId, r.fileId, r.message]),
  );
}

function* map(iterable, fn) {
  for (const item of iterable) yield fn(item);
}

/**
 * Temp file + rename: `rows` is a lazy SQLite cursor, and a failure part-way
 * must not leave a silently truncated index.
 */
async function write(file, headers, rows) {
  const temp = `${file}.tmp`;
  const handle = await fsp.open(temp, 'w');
  try {
    await handle.write(BOM + csvRow(headers) + LINE_ENDING);
    for (const row of rows) await handle.write(csvRow(row) + LINE_ENDING);
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await fsp.unlink(temp).catch(() => {});
    throw error;
  }
  await fsp.rename(temp, file);
}
