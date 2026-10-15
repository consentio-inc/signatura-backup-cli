import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { certificateFileName, documentFolder, pdfFileName } from './archive_paths.js';
import { statusLabel } from './document.js';
import { redact } from './run_log.js';

export const STATE_DIR_NAME = '.signatura-backup';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  created_before        TEXT    NOT NULL,
  started_at            TEXT    NOT NULL,
  total_documents       INTEGER,
  enumeration_complete  INTEGER NOT NULL DEFAULT 0,
  last_page_done        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS documents (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  status         TEXT NOT NULL,
  creation_date  TEXT,
  archive_date   TEXT,
  folder         TEXT,
  signers        TEXT,
  detail_json    TEXT,
  state          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL,
  name         TEXT NOT NULL,
  digest       TEXT NOT NULL,
  ord          INTEGER NOT NULL,
  pdf_path     TEXT NOT NULL,
  pdf_state    TEXT NOT NULL,
  pdf_bytes    INTEGER NOT NULL DEFAULT 0,
  cert_path    TEXT NOT NULL,
  cert_state   TEXT NOT NULL,
  cert_bytes   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS failures (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  TEXT,
  file_id      TEXT,
  kind         TEXT NOT NULL,
  message      TEXT NOT NULL,
  at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_state ON documents(state);
CREATE INDEX IF NOT EXISTS idx_files_pdf_state ON files(pdf_state);
CREATE INDEX IF NOT EXISTS idx_files_cert_state ON files(cert_state);
`;

export function stateDbPath(destinationRoot) {
  return path.join(destinationRoot, STATE_DIR_NAME, 'state.db');
}

/** True when the folder holds an interrupted run to resume (spec 3.10). */
export function hasExistingRun(destinationRoot) {
  return fs.existsSync(stateDbPath(destinationRoot));
}

/**
 * All resume state, kept in the destination so the archive is self-contained
 * (spec 3.10). Schema-compatible with the Flutter app: either tool can resume
 * the other's run.
 */
export class StateDb {
  #db;
  #run = null;

  constructor(db) {
    this.#db = db;
  }

  static openIn(destinationRoot) {
    fs.mkdirSync(path.join(destinationRoot, STATE_DIR_NAME), { recursive: true });
    const db = new DatabaseSync(stateDbPath(destinationRoot));
    // Opening accepts a non-database; the first statement throws. Close on
    // failure, or on Windows the leaked handle locks a corrupt state.db.
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec(SCHEMA);
    } catch (error) {
      db.close();
      throw error;
    }
    return new StateDb(db);
  }

  /**
   * Creates the run row and pins `created_before`. On resume the stored pin
   * wins: re-pinning would shift pagination and skip documents (spec 3.5).
   */
  startOrResume(createdBeforeMs) {
    const existing = this.#db.prepare('SELECT id FROM run WHERE id = 1;').get();
    if (existing === undefined) {
      this.#db
        .prepare('INSERT INTO run (id, created_before, started_at) VALUES (1, ?, ?);')
        .run(new Date(createdBeforeMs).toISOString(), new Date().toISOString());
    }
    return (this.#run = this.#loadRun());
  }

  get run() {
    return (this.#run ??= this.#loadRun());
  }

  #loadRun() {
    const row = this.#db.prepare('SELECT * FROM run WHERE id = 1;').get();
    return {
      createdBeforeIso: row.created_before,
      enumerationComplete: row.enumeration_complete === 1,
      lastPageDone: Number(row.last_page_done),
      totalDocuments: row.total_documents === null ? null : Number(row.total_documents),
    };
  }

  #transaction(body) {
    this.#db.exec('BEGIN;');
    try {
      body();
      this.#db.exec('COMMIT;');
    } catch (error) {
      this.#db.exec('ROLLBACK;');
      throw error;
    }
  }

  insertListed(documents) {
    const stmt = this.#db.prepare(
      'INSERT OR IGNORE INTO documents (id, title, status, state) VALUES (?, ?, ?, ?);',
    );
    this.#transaction(() => {
      for (const doc of documents) stmt.run(doc.id, doc.title, doc.status, 'listed');
    });
  }

  setLastPageDone(page) {
    this.#db.prepare('UPDATE run SET last_page_done = ? WHERE id = 1;').run(page);
    this.#run = this.#loadRun();
  }

  markEnumerationComplete(total) {
    this.#db
      .prepare('UPDATE run SET enumeration_complete = 1, total_documents = ? WHERE id = 1;')
      .run(total);
    this.#run = this.#loadRun();
  }

  /** How many of `ids` are already in the documents table. */
  countKnownDocuments(ids) {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM documents WHERE id IN (${placeholders});`)
      .get(...ids);
    return Number(row.n);
  }

  documentsNeedingDetail(limit) {
    return this.#db
      .prepare("SELECT id, title, status FROM documents WHERE state = 'listed' LIMIT ?;")
      .all(limit)
      .map((r) => ({ id: r.id, title: r.title, status: r.status }));
  }

  /**
   * Stores the detail and expands `files[]` into download work items.
   * Idempotent: a replay must not duplicate rows or undo completed downloads.
   */
  saveDetail(doc, rawJson) {
    const folder = documentFolder(doc);
    const wantsCertificate = doc.status === 'CO';

    this.#transaction(() => {
      this.#db
        .prepare(
          `UPDATE documents
              SET status = ?, creation_date = ?, archive_date = ?, folder = ?,
                  signers = ?, detail_json = ?, state = 'detailed'
            WHERE id = ?;`,
        )
        .run(
          doc.status,
          doc.creationDateIso,
          doc.archiveDateStamp,
          folder,
          doc.signers.join(', '),
          rawJson,
          doc.id,
        );

      const stmt = this.#db.prepare(`
        INSERT OR IGNORE INTO files
          (id, document_id, name, digest, ord, pdf_path, pdf_state, cert_path, cert_state)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?);`);
      for (const file of doc.files) {
        stmt.run(
          file.id,
          doc.id,
          file.name,
          file.digest,
          file.order,
          `${folder}/${pdfFileName(file, doc.isMultiFile)}`,
          `${folder}/${certificateFileName(file, doc.isMultiFile)}`,
          wantsCertificate ? 'pending' : 'skipped',
        );
      }
    });
  }

  filesNeedingPdf(limit) {
    return this.#queryFiles("f.pdf_state = 'pending'", limit);
  }

  filesNeedingCertificate(limit) {
    return this.#queryFiles("f.cert_state = 'pending'", limit);
  }

  #queryFiles(where, limit) {
    return this.#db
      .prepare(
        `SELECT f.id, f.document_id, f.name, f.digest, f.pdf_path, f.cert_path,
                d.title AS doc_title, d.status AS doc_status
           FROM files f
           JOIN documents d ON d.id = f.document_id
          WHERE ${where}
          LIMIT ?;`,
      )
      .all(limit)
      .map((r) => ({
        id: r.id,
        documentId: r.document_id,
        documentTitle: r.doc_title,
        originalName: r.name,
        digest: r.digest,
        /** Both relative to the destination root, '/'-joined. */
        pdfPath: r.pdf_path,
        certPath: r.cert_path,
        status: r.doc_status,
      }));
  }

  markPdfDone(fileId, bytes) {
    this.#db.prepare("UPDATE files SET pdf_state = 'done', pdf_bytes = ? WHERE id = ?;").run(bytes, fileId);
  }

  markPdfFailed(fileId) {
    this.#db.prepare("UPDATE files SET pdf_state = 'failed' WHERE id = ?;").run(fileId);
  }

  markDocumentFailed(documentId) {
    this.#db.prepare("UPDATE documents SET state = 'failed' WHERE id = ?;").run(documentId);
  }

  /** `state` is one of `done`, `unavailable`, `skipped`, `failed`. */
  markCertState(fileId, state, bytes = 0) {
    this.#db.prepare('UPDATE files SET cert_state = ?, cert_bytes = ? WHERE id = ?;').run(state, bytes, fileId);
  }

  recordFailure({ documentId = null, fileId = null, kind, message }) {
    this.#db
      .prepare('INSERT INTO failures (document_id, file_id, kind, message, at) VALUES (?, ?, ?, ?, ?);')
      // Redacted like the log: these rows reach errores.csv, which customers
      // send to support.
      .run(documentId, fileId, kind, redact(message), new Date().toISOString());
  }

  detailJson(documentId) {
    const row = this.#db.prepare('SELECT detail_json FROM documents WHERE id = ?;').get(documentId);
    return row === undefined ? null : row.detail_json;
  }

  counts() {
    const scalar = (sql) => Number(Object.values(this.#db.prepare(sql).get())[0]);
    return {
      documentsListed: scalar('SELECT COUNT(*) FROM documents;'),
      /** Documents successfully detailed. */
      documentsDetailed: scalar("SELECT COUNT(*) FROM documents WHERE state = 'detailed';"),
      /** Done or permanently failed; the ETA uses this so it can reach zero. */
      documentsSettled: scalar("SELECT COUNT(*) FROM documents WHERE state <> 'listed';"),
      filesTotal: scalar('SELECT COUNT(*) FROM files;'),
      pdfsDone: scalar("SELECT COUNT(*) FROM files WHERE pdf_state = 'done';"),
      pdfsSettled: scalar("SELECT COUNT(*) FROM files WHERE pdf_state <> 'pending';"),
      certsSettled: scalar("SELECT COUNT(*) FROM files WHERE cert_state <> 'pending';"),
      bytesWritten: scalar('SELECT COALESCE(SUM(pdf_bytes + cert_bytes), 0) FROM files;'),
      failures: scalar('SELECT COUNT(*) FROM failures;'),
    };
  }

  *manifestRows() {
    const stmt = this.#db.prepare(`
        SELECT d.archive_date, d.title, d.status, d.signers, d.folder,
               f.name, f.digest, f.pdf_path, f.cert_path, f.cert_state
          FROM files f
          JOIN documents d ON d.id = f.document_id
         WHERE f.pdf_state = 'done'
         ORDER BY d.archive_date, d.title, f.ord;`);
    for (const r of stmt.iterate()) {
      yield {
        creationDate: r.archive_date ?? '',
        title: r.title,
        statusLabel: statusLabel(r.status),
        signers: r.signers ?? '',
        folder: r.folder ?? '',
        fileName: r.pdf_path.split('/').at(-1),
        originalName: r.name,
        certificateName: r.cert_state === 'done' ? r.cert_path.split('/').at(-1) : 'No disponible',
        digest: r.digest,
      };
    }
  }

  *failureRows() {
    const stmt = this.#db.prepare(
      'SELECT document_id, file_id, kind, message, at FROM failures ORDER BY id;',
    );
    for (const r of stmt.iterate()) {
      yield {
        documentId: r.document_id ?? '',
        fileId: r.file_id ?? '',
        kind: r.kind,
        message: r.message,
        at: r.at,
      };
    }
  }

  /** Backs `--retry-failed` (spec 3.7). */
  requeueFailures() {
    this.#transaction(() => {
      this.#db.exec("UPDATE files SET pdf_state = 'pending' WHERE pdf_state = 'failed';");
      this.#db.exec("UPDATE files SET cert_state = 'pending' WHERE cert_state = 'failed';");
      this.#db.exec("UPDATE documents SET state = 'listed' WHERE state = 'failed';");
      this.#db.exec('DELETE FROM failures;');
    });
  }

  close() {
    this.#db.close();
  }
}
