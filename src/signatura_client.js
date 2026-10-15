import { ApiError, NotFoundError, ThrottledError, UnauthorizedError } from './errors.js';
import { summaryFromJson } from './document.js';

/** Server maximum (`DocumentsPagination.max_page_size`). */
export const PAGE_SIZE = 50;

const CONNECT_TIMEOUT_MS = 30_000;
const RECEIVE_TIMEOUT_MS = 5 * 60_000;

/**
 * Thin typed wrapper over the Signatura v2 API.
 *
 * Every outbound call passes through `limiter` first, so concurrency in the
 * phases above cannot exceed the global request rate.
 */
export class SignaturaClient {
  #baseUrl;
  #apiKey;
  #fetch;

  constructor({ baseUrl, apiKey, limiter, fetchImpl = globalThis.fetch }) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#apiKey = apiKey;
    this.limiter = limiter;
    this.#fetch = fetchImpl;
  }

  async listDocuments({ page, createdBeforeIso }) {
    const json = await this.#getJson('/documents', {
      page: String(page),
      page_size: String(PAGE_SIZE),
      created_before: createdBeforeIso,
    });
    return {
      count: Number(json.count),
      items: json.results.map(summaryFromJson),
      hasNext: json.next !== null && json.next !== undefined,
    };
  }

  fetchDetailJson(documentId) {
    return this.#getJson(`/documents/${encodeURIComponent(documentId)}`, {});
  }

  downloadDocument(documentId, fileId) {
    return this.#getStream(`/documents/${encodeURIComponent(documentId)}/download/document`, { file: fileId });
  }

  downloadCertificate(documentId, fileId) {
    return this.#getStream(`/documents/${encodeURIComponent(documentId)}/download/pdf-certificate`, { file: fileId });
  }

  /**
   * Validates the key and returns the workspace's document count. There is no
   * /me endpoint, so a one-item listing is the probe (spec 3.11).
   */
  async verifyKey() {
    const json = await this.#getJson('/documents', { page_size: '1' });
    return Number(json.count);
  }

  #url(path, query) {
    const url = new URL(this.#baseUrl + path);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  async #get(path, query) {
    await this.limiter.acquire();
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(new Error('Connect timeout')), CONNECT_TIMEOUT_MS);
    let response;
    try {
      response = await this.#fetch(this.#url(path, query), {
        headers: { Authorization: `Bearer ${this.#apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(connectTimer);
    }
    // Status codes map to typed errors; fetch never throws on non-2xx.
    return { response, controller };
  }

  async #getJson(path, query) {
    const { response } = await this.#get(path, query);
    const text = await response.text();
    check(response, text);
    return JSON.parse(text);
  }

  /** Resolves to an async iterable of Buffers; the receive timeout covers the whole body. */
  async #getStream(path, query) {
    const { response, controller } = await this.#get(path, query);
    if (response.status !== 200) {
      const text = await response.text().catch(() => '');
      check(response, text);
    }
    const receiveTimer = setTimeout(() => controller.abort(new Error('Receive timeout')), RECEIVE_TIMEOUT_MS);
    const body = response.body;
    return (async function* () {
      try {
        for await (const chunk of body) yield chunk;
      } finally {
        clearTimeout(receiveTimer);
      }
    })();
  }
}

function check(response, body) {
  const status = response.status;
  if (status === 200) return;
  if (status === 401 || status === 403) throw new UnauthorizedError(body, status);
  if (status === 404) throw new NotFoundError(body);
  if (status === 429) throw new ThrottledError(retryAfterMs(response.headers));
  throw new ApiError(status, body || `HTTP ${status}`);
}

function retryAfterMs(headers) {
  const seconds = Number.parseInt(headers.get('retry-after') ?? '', 10);
  return (Number.isNaN(seconds) ? 60 : seconds) * 1000;
}
