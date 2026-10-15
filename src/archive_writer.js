import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { DigestMismatchError, DiskFullError, isDiskFull } from './errors.js';

/**
 * Streams `source` (an async iterable of byte chunks) into `<targetPath>.part`,
 * hashing incrementally, and renames to `targetPath` only once the digest is
 * confirmed.
 *
 * The rename is atomic, so any file at `targetPath` is complete and good;
 * resume relies on that instead of re-verifying the archive.
 */
export async function writeArchiveFile(source, targetPath, { expectedSha256 = null } = {}) {
  const part = `${targetPath}.part`;
  const hasher = createHash('sha256');
  let bytes = 0;
  let handle = null;

  try {
    // Inside the try: on a full disk this is usually the first write to fail,
    // and it must become a DiskFullError (spec 3.7).
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    handle = await fsp.open(part, 'w');
    for await (const chunk of source) {
      hasher.update(chunk);
      await handle.write(chunk);
      bytes += chunk.length;
    }
    await handle.sync().catch(() => {});
    await handle.close();
    handle = null;
  } catch (error) {
    await quietlyClose(handle);
    await quietlyDelete(part);
    if (isDiskFull(error)) throw new DiskFullError(targetPath);
    throw error;
  }

  const actual = hasher.digest('hex');
  // Empty means "no digest available" (API omitted it, or a certificate).
  if (expectedSha256 && actual !== expectedSha256.toLowerCase()) {
    await quietlyDelete(part);
    throw new DigestMismatchError(expectedSha256, actual);
  }

  // The rename can fail too (permissions, a directory in the way, disk full).
  try {
    await fsp.rename(part, targetPath);
  } catch (error) {
    await quietlyDelete(part);
    if (isDiskFull(error)) throw new DiskFullError(targetPath);
    throw error;
  }

  return { bytes, sha256Hex: actual };
}

async function quietlyClose(handle) {
  if (handle === null) return;
  try {
    await handle.close();
  } catch {
    // Already broken.
  }
}

async function quietlyDelete(file) {
  try {
    if (fs.existsSync(file)) await fsp.unlink(file);
  } catch {
    // A stale .part is harmless; it is never read back.
  }
}
