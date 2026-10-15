/** Spanish number and duration formatting. es-AR uses a decimal comma. */
export function formatBytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  if (unit === 0) return `${Math.trunc(size)} ${units[unit]}`;
  // Re-check the unit after rounding: 1023.95 MB must not print "1024,0 MB".
  let rounded = Number(size.toFixed(1));
  if (rounded >= 1024 && unit < units.length - 1) {
    rounded /= 1024;
    unit++;
  }
  return `${rounded.toFixed(1).replace('.', ',')} ${units[unit]}`;
}

export function formatDuration(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'menos de 1 min';
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `${minutes} min`;
  return `${hours} h ${minutes % 60} min`;
}
