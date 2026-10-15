export class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

/** The API key was rejected: revoked, deactivated, or wrong. Aborts the run. */
export class UnauthorizedError extends ApiError {
  constructor(message, statusCode = 401) {
    super(statusCode, message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * The resource genuinely does not exist. For certificates this is expected:
 * `/download/pdf-certificate` 404s unless the document is COMPLETED and has at
 * least one completed signature.
 */
export class NotFoundError extends ApiError {
  constructor(message) {
    super(404, message);
    this.name = 'NotFoundError';
  }
}

/** HTTP 429. Treated as backpressure rather than a failure (spec 3.7). */
export class ThrottledError extends ApiError {
  constructor(retryAfterMs) {
    super(429, 'Throttled');
    this.name = 'ThrottledError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Downloaded bytes did not hash to the digest the API reported. */
export class DigestMismatchError extends Error {
  constructor(expected, actual) {
    super(`DigestMismatch(expected ${expected}, got ${actual})`);
    this.name = 'DigestMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

/** Out of disk space. Aborts the run. */
export class DiskFullError extends Error {
  constructor(path) {
    super(`DiskFull(${path})`);
    this.name = 'DiskFullError';
    this.path = path;
  }
}

/** ENOSPC on POSIX; ERROR_DISK_FULL (112) and ERROR_HANDLE_DISK_FULL (39) on Windows. */
export function isDiskFull(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.code === 'ENOSPC') return true;
  const errno = Math.abs(error.errno ?? 0);
  return process.platform === 'win32' && (errno === 39 || errno === 112);
}
