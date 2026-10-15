/** Semicolon-delimited CSV, which is what Excel expects in es-AR locales. */
export const DELIMITER = ';';
export const LINE_ENDING = '\r\n';

/** Leading characters that make Excel and LibreOffice treat a cell as a formula. */
const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r']);

export function csvRow(fields) {
  return fields.map(escape).join(DELIMITER);
}

function escape(value) {
  // Formula-injection guard: titles may come from a counterparty. The
  // apostrophe forces literal text; the raw value stays in state.db.
  if (value !== '' && FORMULA_LEADERS.has(value[0])) return quoteIfNeeded(`'${value}`);
  return quoteIfNeeded(value);
}

function quoteIfNeeded(value) {
  const needsQuoting =
    value.includes(DELIMITER) || value.includes('"') || value.includes('\n') || value.includes('\r');
  if (!needsQuoting) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
