import fs from 'node:fs';
import path from 'node:path';

import { STATE_DIR_NAME } from './state_db.js';

const BEARER = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g;
/**
 * A bare JWT, in case a key appears without `Bearer`. The 20-char segment
 * minimum spares paths and hostnames; real keys have a 36-char header and a
 * 43-char signature.
 */
const BARE_JWT = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g;

const FILE_NAME = 'registro.log';

/** Defence in depth against an error string echoing the auth header. */
export function redact(message) {
  return String(message).replace(BEARER, 'Bearer [REDACTADO]').replace(BARE_JWT, '[REDACTADO]');
}

export function logPathIn(destinationRoot) {
  return path.join(destinationRoot, STATE_DIR_NAME, FILE_NAME);
}

/**
 * Rotating local log. Never transmitted anywhere (spec 3.13).
 *
 * Synchronous appends: no buffer is lost on a kill, and rotation never renames
 * a file with an open handle.
 */
export class RunLog {
  #file;
  #maxBytes;
  /** Mirrors every line to this writable (the terminal) when set. */
  #echo;

  constructor(file, maxBytes, echo) {
    this.#file = file;
    this.#maxBytes = maxBytes;
    this.#echo = echo;
  }

  static openIn(destinationRoot, { maxBytes = 5 * 1024 * 1024, echo = null } = {}) {
    fs.mkdirSync(path.join(destinationRoot, STATE_DIR_NAME), { recursive: true });
    return new RunLog(logPathIn(destinationRoot), maxBytes, echo);
  }

  info(message) { this.#write('INFO ', message); }
  warn(message) { this.#write('WARN ', message); }
  error(message) { this.#write('ERROR', message); }

  #write(level, message) {
    this.#rotateIfNeeded();
    const line = `${new Date().toISOString()} ${level} ${redact(message)}\n`;
    fs.appendFileSync(this.#file, line);
    this.#echo?.(line);
  }

  #rotateIfNeeded() {
    if (!fs.existsSync(this.#file) || fs.statSync(this.#file).size < this.#maxBytes) return;
    const previous = `${this.#file}.1`;
    if (fs.existsSync(previous)) fs.unlinkSync(previous);
    fs.renameSync(this.#file, previous);
  }

  close() {}
}
