import path from 'node:path';

import { writeArchiveFile } from './archive_writer.js';
import { detailFromJson } from './document.js';
import { ApiError, DiskFullError, NotFoundError, UnauthorizedError } from './errors.js';
import { PAGE_SIZE } from './signatura_client.js';
import { runPool } from './worker_pool.js';

const BATCH_SIZE = 200;

function isFatal(error) {
  return error instanceof UnauthorizedError || error instanceof DiskFullError;
}

/**
 * Phase 1: walk `GET /documents` and record every id, title and status.
 *
 * `created_before` is pinned in the database, never recomputed: the listing
 * is page-numbered by `-creation_date`, so a new document would shift every
 * page (spec 3.5).
 */
export async function enumerate({ client, db, retry, log, onCount }) {
  if (db.run.enumerationComplete) {
    log.info('Enumeración ya completa; se omite.');
    return;
  }

  const createdBeforeIso = db.run.createdBeforeIso;
  let page = db.run.lastPageDone + 1;
  // The pinned window keeps `count` stable, so it bounds the page count; a
  // server reporting hasNext forever must not hang the run.
  let maxPages = null;

  for (;;) {
    const result = await retry.run(() => client.listDocuments({ page, createdBeforeIso }));

    maxPages ??= Math.ceil(result.count / PAGE_SIZE) + 2;
    if (page > maxPages) {
      throw new ApiError(
        null,
        `La enumeración excedió ${maxPages} páginas para ${result.count} documentos; ` +
          'se interrumpe para no continuar indefinidamente.',
      );
    }

    db.insertListed(result.items);
    db.setLastPageDone(page);
    onCount?.(result.count);
    log.info(`Página ${page}: ${result.items.length} documentos (total ${result.count}).`);

    if (!result.hasNext) {
      db.markEnumerationComplete(result.count);
      log.info(`Enumeración completa: ${result.count} documentos.`);
      return;
    }
    page++;
  }
}

/**
 * Phase 2: fetch `GET /documents/{id}` for every listed document. The only
 * source of `creation_date` and `files[]`; the raw payload is stored so resume
 * never refetches it.
 */
export async function fetchDetails({ client, db, retry, log, concurrency, onProgress }) {
  // Bounded: the loop only terminates if each pass settles something.
  let previousRemaining = -1;
  for (;;) {
    const batch = db.documentsNeedingDetail(BATCH_SIZE);
    if (batch.length === 0) return;

    const counts = db.counts();
    const remaining = counts.documentsListed - counts.documentsSettled;
    if (remaining === previousRemaining) {
      log.error(
        `Se detuvo la obtención de detalles: ${remaining} documentos no avanzaron tras un ciclo completo.`,
      );
      for (const doc of batch) {
        db.markDocumentFailed(doc.id);
        db.recordFailure({
          documentId: doc.id,
          kind: 'detalle',
          message: 'El documento no avanzó tras un ciclo completo de obtención de detalles.',
        });
      }
      return;
    }
    previousRemaining = remaining;

    await runPool(batch, concurrency, async (summary) => {
      try {
        const json = await retry.run(() => client.fetchDetailJson(summary.id));
        db.saveDetail(detailFromJson(json), JSON.stringify(json));
      } catch (error) {
        if (isFatal(error)) throw error;
        db.markDocumentFailed(summary.id);
        db.recordFailure({ documentId: summary.id, kind: 'detail', message: String(error) });
        log.error(`Detalle ${summary.id}: ${error}`);
      } finally {
        onProgress?.();
      }
    });
  }
}

/**
 * Phase 3: stream each PDF, then each audit certificate, into the archive.
 *
 * PDFs are verified against `files[].digest`; certificates are generated on
 * demand and carry no stored digest, so they are written unverified.
 */
export async function download({ client, db, retry, log, destinationRoot, concurrency, onProgress }) {
  const absolute = (relative) => path.join(destinationRoot, ...relative.split('/'));

  // Write the file before `markPdfDone`: a power cut may then lose the row
  // (one re-download) but the database never claims a missing file.
  async function downloadPdf(row) {
    try {
      const result = await retry.run(async () => {
        const stream = await client.downloadDocument(row.documentId, row.id);
        return writeArchiveFile(stream, absolute(row.pdfPath), { expectedSha256: row.digest });
      });
      db.markPdfDone(row.id, result.bytes);
    } catch (error) {
      if (isFatal(error)) throw error;
      db.markPdfFailed(row.id);
      db.recordFailure({ documentId: row.documentId, fileId: row.id, kind: 'pdf', message: String(error) });
      log.error(`PDF ${row.pdfPath}: ${error}`);
    } finally {
      onProgress?.();
    }
  }

  async function downloadCertificate(row) {
    try {
      const result = await retry.run(async () => {
        const stream = await client.downloadCertificate(row.documentId, row.id);
        return writeArchiveFile(stream, absolute(row.certPath));
      });
      db.markCertState(row.id, 'done', result.bytes);
    } catch (error) {
      if (error instanceof NotFoundError) {
        // Expected: COMPLETED documents can still have no completed signature.
        db.markCertState(row.id, 'unavailable');
        log.info(`Sin certificado: ${row.certPath}`);
        return;
      }
      if (isFatal(error)) throw error;
      db.markCertState(row.id, 'failed');
      db.recordFailure({ documentId: row.documentId, fileId: row.id, kind: 'certificado', message: String(error) });
      log.error(`Certificado ${row.certPath}: ${error}`);
    } finally {
      onProgress?.();
    }
  }

  async function drain(next, body) {
    for (;;) {
      const batch = next(BATCH_SIZE);
      if (batch.length === 0) return;
      await runPool(batch, concurrency, body);
    }
  }

  await drain((limit) => db.filesNeedingPdf(limit), downloadPdf);
  await drain((limit) => db.filesNeedingCertificate(limit), downloadCertificate);
}
