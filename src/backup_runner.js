import fs from 'node:fs';
import path from 'node:path';

import { systemClock } from './clock.js';
import { DiskFullError, UnauthorizedError } from './errors.js';
import { writeErrors, writeIndex } from './manifest_writer.js';
import { download, enumerate, fetchDetails } from './phases.js';
import { REQUEST_INTERVAL_MS } from './progress.js';
import { RateLimiter } from './rate_limiter.js';
import { RetryPolicy } from './retry_policy.js';
import { RunLog } from './run_log.js';
import { SignaturaClient } from './signatura_client.js';
import { StateDb } from './state_db.js';

export const MESSAGES = Object.freeze({
  enumerationFailed:
    'No se pudo obtener la lista de documentos. Verifique su conexión a internet e intente nuevamente.',
  unauthorized: 'La clave de API fue rechazada. Verifique que siga activa en el panel de Signatura.',
  diskFull: 'No hay espacio suficiente en el disco de destino.',
  unexpected:
    'La copia se detuvo por un error inesperado. Lo descargado hasta ahora se conservó y puede ' +
    'reanudarla eligiendo la misma carpeta. Si el problema persiste, envíe el archivo registro.log a soporte.',
  indexFailed:
    'No se pudieron escribir los archivos de índice. Verifique el espacio disponible y los permisos de la carpeta.',
});

/** Resets failed rows to pending for the next run (`--retry-failed`). */
export function requeueFailures(destinationRoot) {
  const db = StateDb.openIn(destinationRoot);
  try {
    db.requeueFailures();
  } finally {
    db.close();
  }
}

/**
 * Deletes `.part` files left by an interrupted run. Best-effort: a backup must
 * not fail over tidying.
 */
function sweepStalePartFiles(destinationRoot, log) {
  try {
    if (!fs.existsSync(destinationRoot)) return;
    let removed = 0;
    for (const entry of fs.readdirSync(destinationRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.part')) continue;
      try {
        fs.unlinkSync(path.join(entry.parentPath ?? entry.path, entry.name));
        removed++;
      } catch {
        // Locked or already gone; the next run will try again.
      }
    }
    if (removed > 0) log.info(`Se eliminaron ${removed} archivos .part de una copia anterior`);
  } catch (error) {
    log.warn(`No se pudieron limpiar los archivos .part: ${error}`);
  }
}

/**
 * Orchestrates enumerate -> detail -> download, then writes indice.csv and
 * errores.csv. Aborts only on a rejected key or a full disk (spec 3.7).
 *
 * Resolves to `{ completed, counts, abortReason }`; `onProgress` receives
 * `{ phase, counts, reconnecting }` snapshots.
 */
export async function runBackup({
  destinationRoot,
  apiKey,
  baseUrl,
  concurrency = 4,
  clock = systemClock,
  requestIntervalMs = REQUEST_INTERVAL_MS,
  onProgress = null,
  echoLog = null,
  fetchImpl = globalThis.fetch,
}) {
  const log = RunLog.openIn(destinationRoot, { echo: echoLog });
  const db = StateDb.openIn(destinationRoot);
  sweepStalePartFiles(destinationRoot, log);
  // On a fresh run this pins the enumeration window; on resume the stored pin
  // wins and this value is discarded (spec 3.5).
  db.startOrResume(clock.now());

  const limiter = new RateLimiter({ minIntervalMs: requestIntervalMs, clock });
  const client = new SignaturaClient({ baseUrl, apiKey, limiter, fetchImpl });

  let phase = 'enumerating';
  let reconnecting = false;
  const emit = () => onProgress?.({ phase, counts: db.counts(), reconnecting });

  // Transient failures show as "Reconectando...", not as failed items (spec 3.12).
  const retry = new RetryPolicy({
    limiter,
    clock,
    onTransientWait: (waiting) => {
      if (reconnecting === waiting) return;
      reconnecting = waiting;
      emit();
    },
  });

  let abortReason = null;

  try {
    try {
      log.info(`Iniciando copia en ${destinationRoot}`);
      emit();

      try {
        await enumerate({ client, db, retry, log, onCount: () => emit() });
      } catch (error) {
        if (error instanceof UnauthorizedError || error instanceof DiskFullError) throw error;
        // Enumeration has no per-item catch, so its failures land here.
        // Record and carry on: pages that did list are still worth fetching.
        db.recordFailure({ kind: 'enumeración', message: String(error) });
        log.error(`Enumeración: ${error}`);
        if (db.counts().documentsListed === 0) abortReason = MESSAGES.enumerationFailed;
      }

      if (abortReason === null) {
        phase = 'fetchingDetails';
        emit();
        await fetchDetails({ client, db, retry, log, concurrency, onProgress: emit });

        phase = 'downloading';
        emit();
        await download({ client, db, retry, log, destinationRoot, concurrency, onProgress: emit });
      }
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        abortReason = MESSAGES.unauthorized;
      } else if (error instanceof DiskFullError) {
        abortReason = MESSAGES.diskFull;
      } else {
        abortReason = MESSAGES.unexpected;
      }
      log.error(`Abortado: ${error?.stack ?? error}`);
    }

    // Written even on abort, but must never throw: after a disk-full abort
    // these fail too, and escaping would lose the outcome and its message.
    try {
      await writeIndex(destinationRoot, db.manifestRows());
      await writeErrors(destinationRoot, db.failureRows());
    } catch (error) {
      log.error(`No se pudieron escribir los índices: ${error}`);
      abortReason ??= MESSAGES.indexFailed;
    }

    phase = 'finished';
    const counts = db.counts();
    emit();
    log.info(`Finalizado: ${counts.pdfsDone} archivos, ${counts.failures} errores.`);

    return { completed: abortReason === null, counts, abortReason };
  } finally {
    log.close();
    db.close();
  }
}
