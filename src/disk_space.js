import fsp from 'node:fs/promises';

/**
 * Free-space probe for the low-space warning (spec 3.9). A wrong answer is
 * worse than none: every failure path returns null and the warning is skipped.
 */
export async function freeBytes(dir) {
  try {
    const stats = await fsp.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}
