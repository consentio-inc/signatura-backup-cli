export const PHASES = Object.freeze({
  enumerating: 'Buscando documentos',
  fetchingDetails: 'Obteniendo detalles',
  downloading: 'Descargando archivos',
  finished: 'Finalizado',
});

/** The fixed global spacing every request pays (spec 3.6). */
export const REQUEST_INTERVAL_MS = 600;

const atLeastZero = (v) => (v < 0 ? 0 : v);

/**
 * Outstanding calls: a detail per unsettled document, a download per
 * unsettled PDF and certificate. Undetailed documents are assumed to have one
 * file and count their two downloads too. Counts SETTLED, not DONE: a failed
 * item is never requested again.
 */
export function pendingRequests(counts) {
  const awaitingDetail = atLeastZero(counts.documentsListed - counts.documentsSettled);
  const files = counts.filesTotal + awaitingDetail;
  return atLeastZero(awaitingDetail + (files - counts.pdfsSettled) + (files - counts.certsSettled));
}

/** Same assumptions as pendingRequests, so the difference is exactly the work settled. */
export function totalRequests(counts) {
  const awaitingDetail = atLeastZero(counts.documentsListed - counts.documentsSettled);
  return counts.documentsListed + (counts.filesTotal + awaitingDetail) * 2;
}

export function estimatedRemainingMs(counts) {
  return REQUEST_INTERVAL_MS * pendingRequests(counts);
}

/**
 * Remaining time before a run starts: request count times the fixed spacing
 * (spec 3.9). `done` is null for a fresh run, else the persisted counts.
 */
export function estimateBeforeRunMs(documentCount, done = null) {
  const requestsPerUnknownDocument = 3;
  if (done === null) return REQUEST_INTERVAL_MS * atLeastZero(documentCount * requestsPerUnknownDocument);
  const unlisted = atLeastZero(documentCount - done.documentsListed);
  return REQUEST_INTERVAL_MS * (pendingRequests(done) + unlisted * requestsPerUnknownDocument);
}

/** Extrapolated from observed bytes (the API reports no sizes); null until a PDF lands. */
export function projectedTotalBytes(counts) {
  if (counts.pdfsDone === 0 || counts.filesTotal === 0) return null;
  return Math.round((counts.bytesWritten / counts.pdfsDone) * counts.filesTotal);
}
