import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { requeueFailures, runBackup } from './backup_runner.js';
import { freeBytes } from './disk_space.js';
import { ApiError, UnauthorizedError } from './errors.js';
import { formatBytes, formatDuration } from './format.js';
import { PHASES, estimateBeforeRunMs, estimatedRemainingMs, pendingRequests, projectedTotalBytes, totalRequests } from './progress.js';
import { closePrompts, confirm, promptHidden } from './prompt.js';
import { RateLimiter } from './rate_limiter.js';
import { resumeMatchesWorkspace } from './resume_check.js';
import { logPathIn } from './run_log.js';
import { SignaturaClient } from './signatura_client.js';
import { StateDb, hasExistingRun } from './state_db.js';

export const DEFAULT_BASE_URL = 'https://connect.signatura.co/api/v2';

const USAGE = `Signatura Backup: descarga todos los documentos de su espacio de trabajo.

Uso: signatura-backup [opciones] <carpeta-de-destino>

La clave de API se lee de la variable de entorno SIGNATURA_API_KEY o se pide
por teclado sin mostrarla. Nunca se guarda en disco.

Si la carpeta ya contiene una copia interrumpida, se reanuda automáticamente.

Opciones:
  -y, --yes               No pedir confirmación antes de iniciar.
  -r, --retry-failed      Volver a intentar los elementos que fallaron en una
                          copia anterior de la misma carpeta.
  -v, --verbose           Mostrar el registro completo en la terminal.
      --base-url <url>    URL base de la API (o SIGNATURA_BASE_URL).
      --concurrency <n>   Descargas simultáneas (predeterminado: 4).
  -h, --help              Mostrar esta ayuda.
`;

export function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      yes: { type: 'boolean', short: 'y', default: false },
      'retry-failed': { type: 'boolean', short: 'r', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      'base-url': { type: 'string' },
      concurrency: { type: 'string', default: '4' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const concurrency = Number.parseInt(values.concurrency, 10);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('--concurrency debe ser un entero mayor que cero.');
  }
  if (positionals.length > 1) throw new Error('Indique una sola carpeta de destino.');
  return {
    help: values.help,
    yes: values.yes,
    retryFailed: values['retry-failed'],
    verbose: values.verbose,
    baseUrl: values['base-url'] ?? process.env.SIGNATURA_BASE_URL ?? DEFAULT_BASE_URL,
    concurrency,
    destination: positionals[0] ?? null,
  };
}

async function obtainApiKey(io) {
  const fromEnv = process.env.SIGNATURA_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const typed = await promptHidden('Pegue su clave de API: ', io);
  return typed?.trim() || null;
}

/** Turns a pre-run API failure into the Spanish message the operator sees. */
function describeApiError(error) {
  if (error instanceof UnauthorizedError) {
    return new CliError(
      error.statusCode === 403
        ? 'Esta clave no tiene acceso a este espacio de trabajo. Solicite a un administrador una clave del espacio correcto.'
        : 'La clave no fue aceptada. Verifique que esté activa en el panel de Signatura.',
    );
  }
  if (error instanceof ApiError) return new CliError(`Signatura respondió con un error (HTTP ${error.statusCode}).`);
  return new CliError('No se pudo conectar con Signatura. Verifique su conexión a internet.');
}

/** Validates the key and returns the document count. */
async function verifyKey(client) {
  try {
    return await client.verifyKey();
  } catch (error) {
    throw describeApiError(error);
  }
}

/**
 * A folder holding another workspace's run must not be resumed: enumeration
 * would be skipped and every stored document would fail under the new key,
 * ending in "0 archivos" with no explanation.
 */
async function ensureResumeMatches(client, destination) {
  let matches;
  try {
    matches = await resumeMatchesWorkspace({ client, destinationRoot: destination });
  } catch (error) {
    throw describeApiError(error);
  }
  if (!matches) {
    throw new CliError(
      'Esta carpeta contiene una copia de otro espacio de trabajo. Elija otra carpeta de ' +
        'destino, o use la clave de API del espacio original para reanudar la copia.',
    );
  }
}

/** Persisted counts for a folder, or null. Unreadable state is a courtesy miss, never a blocker. */
function readResumeCounts(destination) {
  if (!hasExistingRun(destination)) return null;
  let db = null;
  try {
    db = StateDb.openIn(destination);
    return db.counts();
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export class CliError extends Error {}

/** Draws one status line on a TTY, or periodic lines otherwise. */
class ProgressView {
  #out;
  #isTty;
  #last = 0;
  #lastLine = '';
  #lastState = '';

  constructor(out) {
    this.#out = out;
    this.#isTty = Boolean(out.isTTY);
  }

  render(snapshot) {
    const now = Date.now();
    const minGap = this.#isTty ? 250 : 15_000;
    // Phase changes and the start or end of a reconnection always show, even
    // inside the quiet gap: a log reader must see when "Reconectando" ended.
    const state = `${snapshot.phase}/${snapshot.reconnecting}`;
    const force = state !== this.#lastState;
    this.#lastState = state;
    if (!force && now - this.#last < minGap) return;
    this.#last = now;

    const { counts } = snapshot;
    const total = totalRequests(counts);
    const pending = pendingRequests(counts);
    const fraction = total === 0 ? 0 : Math.min(1, (total - pending) / total);
    const parts = [PHASES[snapshot.phase]];
    if (snapshot.phase === 'enumerating') {
      parts.push(`${counts.documentsListed} documentos`);
    } else if (snapshot.phase === 'fetchingDetails') {
      parts.push(`${counts.documentsSettled} de ${counts.documentsListed} documentos`);
    } else {
      parts.push(`${counts.pdfsDone} de ${counts.filesTotal} archivos`);
    }
    if (snapshot.phase !== 'finished') {
      parts.push(`${Math.floor(fraction * 100)}%`);
      parts.push(`restante ${formatDuration(estimatedRemainingMs(counts))}`);
    }
    if (counts.bytesWritten > 0) parts.push(formatBytes(counts.bytesWritten));
    const projected = projectedTotalBytes(counts);
    if (projected !== null && snapshot.phase !== 'finished') parts.push(`≈ ${formatBytes(projected)} en total`);
    if (counts.failures > 0) parts.push(`${counts.failures} errores`);
    if (snapshot.reconnecting) parts.push('Reconectando...');

    this.#write(parts.join(' · '));
  }

  #write(line) {
    if (this.#isTty) {
      const width = this.#out.columns ?? 80;
      const clipped = line.length > width - 1 ? `${line.slice(0, width - 2)}…` : line;
      this.#out.write(`\r\x1b[2K${clipped}`);
      this.#lastLine = clipped;
    } else {
      this.#out.write(`${line}\n`);
    }
  }

  /** Clears the status line so another message can be printed cleanly. */
  clear() {
    if (this.#isTty && this.#lastLine !== '') {
      this.#out.write('\r\x1b[2K');
      this.#lastLine = '';
    }
  }

  /** Writes a message above the status line and redraws it. */
  interject(text) {
    const previous = this.#lastLine;
    this.clear();
    this.#out.write(text.endsWith('\n') ? text : `${text}\n`);
    if (previous !== '' && this.#isTty) this.#write(previous);
  }

  finish() {
    if (this.#isTty) this.#out.write('\n');
  }
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, fetchImpl = globalThis.fetch } = {}) {
  const say = (text) => stderr.write(`${text}\n`);
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    say(error.message);
    say('');
    say(USAGE);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (options.destination === null) {
    say(USAGE);
    return 2;
  }

  const io = { input: stdin, output: stderr };
  try {
    const destination = path.resolve(options.destination);
    fs.mkdirSync(destination, { recursive: true });

    const apiKey = await obtainApiKey(io);
    if (!apiKey) throw new CliError('No se indicó una clave de API.');

    say('Verificando la clave...');
    const client = new SignaturaClient({ baseUrl: options.baseUrl, apiKey, limiter: new RateLimiter(), fetchImpl });
    const documentCount = await verifyKey(client);
    say(`${documentCount} documentos encontrados.`);

    const resuming = hasExistingRun(destination);
    if (resuming) await ensureResumeMatches(client, destination);

    if (options.retryFailed) {
      if (!resuming) throw new CliError('No hay una copia anterior en esta carpeta para reintentar.');
      requeueFailures(destination);
      say('Se volverán a intentar los elementos que fallaron.');
    }

    const resumeCounts = readResumeCounts(destination);
    say(`Destino: ${destination}`);
    if (resumeCounts !== null) {
      say(
        `Ya existe una copia en esta carpeta. Se reanudará desde ${resumeCounts.documentsSettled} de ` +
          `${documentCount} documentos.`,
      );
    }
    say(`Tiempo estimado: ${formatDuration(estimateBeforeRunMs(documentCount, resumeCounts))}`);
    const free = await freeBytes(destination);
    if (free !== null) say(`${formatBytes(free)} disponibles en el disco.`);
    say('La copia puede demorar varias horas. Mantenga el equipo encendido y conectado a la corriente.');

    if (!options.yes) {
      const go = await confirm(resumeCounts !== null ? '¿Reanudar la copia?' : '¿Iniciar la copia?', io);
      if (!go) {
        say('Cancelado.');
        return 1;
      }
    }
    // No more questions: let go of stdin so the process can exit on its own.
    closePrompts(stdin);

    const view = new ProgressView(stderr);
    let warnedLowDisk = false;
    const onSigint = () => {
      view.clear();
      say('\nCopia detenida. Se conservó todo lo descargado hasta ahora.');
      say('Para continuar, vuelva a ejecutar el comando con la misma carpeta.');
      say('Los archivos indice.csv y errores.csv se generan al finalizar la copia.');
      process.exit(130);
    };
    process.once('SIGINT', onSigint);

    let outcome;
    try {
      outcome = await runBackup({
        destinationRoot: destination,
        apiKey,
        baseUrl: options.baseUrl,
        concurrency: options.concurrency,
        fetchImpl,
        echoLog: options.verbose ? (line) => view.interject(line) : null,
        onProgress: (snapshot) => {
          view.render(snapshot);
          const projected = projectedTotalBytes(snapshot.counts);
          if (!warnedLowDisk && free !== null && projected !== null && projected > free) {
            warnedLowDisk = true;
            view.interject('Aviso: el espacio libre podría no alcanzar para completar la copia.');
          }
        },
      });
    } finally {
      process.off('SIGINT', onSigint);
      view.finish();
    }

    say('');
    say(outcome.completed ? 'Copia finalizada.' : 'Copia interrumpida.');
    say(`${outcome.counts.pdfsDone} archivos descargados, ${outcome.counts.failures} errores registrados.`);
    if (outcome.abortReason) say(outcome.abortReason);
    if (outcome.counts.failures > 0) {
      say('Para reintentar los elementos fallidos, ejecute el mismo comando con --retry-failed.');
    }
    say(`Registro: ${logPathIn(destination)}`);
    if (outcome.completed) {
      say('Le recomendamos desactivar esta clave de API en el panel de Signatura ahora que terminó la copia.');
    }
    return outcome.completed ? 0 : 1;
  } catch (error) {
    if (error instanceof CliError) {
      say(error.message);
      return 1;
    }
    say(`Error inesperado: ${error?.stack ?? error}`);
    return 1;
  } finally {
    closePrompts(stdin);
  }
}
