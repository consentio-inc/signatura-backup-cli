import http from 'node:http';

export const PAGE_SIZE = 50;

/**
 * An in-process stand-in for the Signatura v2 API with deliberate faults.
 * It honours `created_before`, so tests can add a document mid-enumeration
 * and assert it is excluded.
 */
export class FakeSignaturaServer {
  documents = [];
  requestLog = [];
  /** Emit HTTP 429 on every Nth request. 0 disables. */
  throttleEvery = 0;
  throttledCount = 0;
  /** Fail the list endpoint from this page number onward. 0 disables. */
  failListPagesFrom = 0;
  /** Number of PDF downloads that should fail with 500 before succeeding. */
  failNextPdf = 0;
  /** Reject every request with this status when set (401/403). */
  rejectAllWith = 0;
  #server = null;
  #requestCount = 0;

  get baseUrl() {
    return `http://127.0.0.1:${this.#server.address().port}/api/v2`;
  }

  async start() {
    this.#server = http.createServer((req, res) => this.#handle(req, res));
    await new Promise((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
  }

  async stop() {
    await new Promise((resolve) => this.#server.close(resolve));
  }

  addDocument({ id, title, status = 'CO', createdAt, fileNames = ['Contrato.pdf'], contents = '%PDF contenido' }) {
    this.documents.push({ id, title, status, createdAt, fileNames, contents });
  }

  #handle(req, res) {
    const url = new URL(req.url, 'http://x');
    this.requestLog.push(url);
    this.#requestCount++;

    if (this.rejectAllWith) {
      res.writeHead(this.rejectAllWith);
      res.end('{"detail":"rejected"}');
      return;
    }
    if (this.throttleEvery > 0 && this.#requestCount % this.throttleEvery === 0) {
      this.throttledCount++;
      res.writeHead(429, { 'Retry-After': '1' });
      res.end();
      return;
    }

    const p = url.pathname;
    if (p.endsWith('/documents')) return this.#list(url, res);
    if (p.includes('/download/document')) return this.#downloadPdf(url, res);
    if (p.includes('/download/pdf-certificate')) return this.#downloadCertificate(url, res);
    return this.#detail(url, res);
  }

  #visible(url) {
    const raw = url.searchParams.get('created_before');
    const sorted = [...this.documents].sort((a, b) => b.createdAt - a.createdAt);
    if (raw === null) return sorted;
    const bound = Date.parse(raw);
    return sorted.filter((d) => d.createdAt < bound);
  }

  #list(url, res) {
    const visible = this.#visible(url);
    const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    if (this.failListPagesFrom > 0 && page >= this.failListPagesFrom) {
      res.writeHead(500);
      res.end();
      return;
    }
    const start = (page - 1) * PAGE_SIZE;
    const slice = start >= visible.length ? [] : visible.slice(start, start + PAGE_SIZE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        count: visible.length,
        next: start + PAGE_SIZE < visible.length ? `http://x/?page=${page + 1}` : null,
        previous: null,
        results: slice.map((d) => ({ id: d.id, title: d.title, status: d.status })),
      }),
    );
  }

  #detail(url, res) {
    const id = url.pathname.split('/').at(-1);
    const doc = this.documents.find((d) => d.id === id);
    if (!doc) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: doc.id,
        title: doc.title,
        status: doc.status,
        creation_date: new Date(doc.createdAt).toISOString(),
        files: doc.fileNames.map((name, i) => ({ id: `${doc.id}-f${i}`, name, digest: '', order: i })),
        signatures: [{ validations: { EM: { value: 'firmante@acme.com', validated: true } } }],
      }),
    );
  }

  #downloadPdf(url, res) {
    if (this.failNextPdf > 0) {
      this.failNextPdf--;
      res.writeHead(500);
      res.end();
      return;
    }
    const id = url.pathname.split('/').at(-3);
    const doc = this.documents.find((d) => d.id === id);
    res.writeHead(200);
    res.end(doc?.contents ?? '%PDF contenido');
  }

  #downloadCertificate(url, res) {
    const id = url.pathname.split('/').at(-3);
    const doc = this.documents.find((d) => d.id === id);
    if (!doc || doc.status !== 'CO') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end('%PDF certificado');
  }
}
