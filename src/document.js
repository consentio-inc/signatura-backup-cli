/**
 * Archive dates are in Argentina time, as in the Signatura dashboard (connect's
 * TIME_ZONE is America/Argentina/Buenos_Aires). No DST since 2009, so a fixed
 * offset is exact.
 */
export const ARCHIVE_UTC_OFFSET_MS = -3 * 60 * 60 * 1000;

/** API status codes with their indice.csv labels (Spanish-only, spec 3.0). */
export const STATUS_LABELS = Object.freeze({
  DR: 'Borrador',
  PE: 'Pendiente',
  CO: 'Completado',
  CA: 'Cancelado',
  EX: 'Expirado',
});

export function statusLabel(code) {
  const label = STATUS_LABELS[code];
  if (label === undefined) throw new Error(`Unknown document status: ${code}`);
  return label;
}

/** What `GET /documents` returns. */
export function summaryFromJson(json) {
  statusLabel(json.status); // validate
  return { id: json.id, title: json.title ?? '', status: json.status };
}

/**
 * One file inside a document. `digest` is the SHA256 of exactly the bytes
 * `/download/document?file=<id>` serves. The API exposes no file size.
 */
export function fileInfoFromJson(json) {
  const trimmed = typeof json.name === 'string' ? json.name.trim() : '';
  return {
    id: json.id,
    name: trimmed !== '' ? trimmed : 'documento.pdf',
    digest: json.digest ?? '',
    order: Number.isInteger(json.order) ? json.order : 0,
  };
}

/**
 * Calendar date in Argentina time, as `YYYY-MM-DD`, for folder names and
 * indice.csv. 22:00 in Buenos Aires is the next day in UTC.
 */
export function archiveDateStamp(creationDateMs) {
  const local = new Date(creationDateMs + ARCHIVE_UTC_OFFSET_MS);
  const year = String(local.getUTCFullYear()).padStart(4, '0');
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day = String(local.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function detailFromJson(json) {
  statusLabel(json.status); // validate
  const files = (Array.isArray(json.files) ? json.files : [])
    .map(fileInfoFromJson)
    // Total: connect makes (document, order) unique on DocumentFile.
    .sort((a, b) => a.order - b.order);

  const creationDateMs = Date.parse(json.creation_date);
  if (Number.isNaN(creationDateMs)) {
    throw new Error(`Invalid creation_date: ${json.creation_date}`);
  }

  return {
    id: json.id,
    title: json.title ?? '',
    status: json.status,
    /** Epoch ms (UTC instant), so the archive is the same whatever the machine's timezone. */
    creationDateMs,
    creationDateIso: new Date(creationDateMs).toISOString(),
    files,
    signers: extractSigners(json),
    isMultiFile: files.length > 1,
    archiveDateStamp: archiveDateStamp(creationDateMs),
  };
}

/**
 * `validations` is `{AF|EM|PH|BI: {value, validated}}`. Email is the most
 * recognisable identifier, then CUIT, then phone. BI carries no identifier.
 *
 * `value` is not always text: a completed AFIP validation sends the info_afip
 * dict, biometrics the provider's data. Unrecognised shapes are skipped -- a
 * bad value may cost a signer, never the document.
 */
function extractSigners(json) {
  const out = [];
  const signatures = Array.isArray(json.signatures) ? json.signatures : [];
  for (const signature of signatures) {
    if (!isObject(signature)) continue;
    const validations = signature.validations;
    if (!isObject(validations)) continue;
    for (const kind of ['EM', 'AF', 'PH']) {
      const entry = validations[kind];
      const identity = isObject(entry) ? identityFrom(entry.value) : null;
      if (identity !== null) {
        out.push(identity);
        break;
      }
    }
  }
  return out;
}

function identityFrom(value) {
  if (typeof value === 'string') return value === '' ? null : value;
  if (isObject(value)) {
    // AFIP: the legal name is the only signer name the API exposes.
    const cuit = value.CUIT;
    if (typeof cuit !== 'string' || cuit === '') return null;
    const fullName = value.full_name;
    const name =
      typeof fullName === 'string' && fullName.trim() !== ''
        ? fullName.trim()
        : [value.first_name, value.last_name]
            .filter((part) => typeof part === 'string' && part.trim() !== '')
            .join(' ');
    return name === '' ? cuit : `${cuit} (${name})`;
  }
  return null;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
