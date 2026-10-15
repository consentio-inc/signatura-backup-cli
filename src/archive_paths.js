/**
 * The on-disk layout of spec 3.3, with the safety rules of 3.4.
 *
 * Folder slugs are ASCII (they end up in URLs, ZIPs and shells); filenames
 * keep their accents, since the customer reads them.
 */
export const MAX_SLUG_LENGTH = 40;
export const MAX_STEM_LENGTH = 60;

/** Characters Windows rejects outright, plus C0 control characters. */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\\/:*?"<>|\x00-\x1F]/g;

/** Windows reserved device names, with or without an extension. */
const RESERVED_STEM = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** ASCII, hyphen-joined, at most MAX_SLUG_LENGTH characters. */
export function slug(title) {
  let value = title
    // NFD splits a letter from its accent; dropping the combining marks is
    // the diacritic strip. Covers the table the Flutter app spells out.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  if (value.length > MAX_SLUG_LENGTH) {
    // Cut at the last word boundary, so no fragment of a cut word remains.
    value = value.slice(0, MAX_SLUG_LENGTH).replace(/-[^-]*$/, '');
  }
  return value === '' ? 'documento' : value;
}

/**
 * `YYYY/YYYY-MM/YYYY-MM-DD_<slug>_<shortid>`, relative to the destination root.
 *
 * Always '/'-joined: it is stored in SQLite and indice.csv, so it must stay
 * valid when an archive moves between platforms.
 */
export function documentFolder(doc) {
  const stamp = doc.archiveDateStamp;
  const year = stamp.slice(0, 4);
  const yearMonth = stamp.slice(0, 7);
  // The tail, not the head: ids are UUIDv7, whose leading bits are a
  // timestamp, so same-titled documents from the same few hours would share
  // a folder. The trailing bits are random.
  const hex = doc.id.replaceAll('-', '');
  const shortId = hex.slice(-6);
  return `${year}/${yearMonth}/${stamp}_${slug(doc.title)}_${shortId}`;
}

export function pdfFileName(file, multiFile) {
  return `${stem(file, multiFile)}.pdf`;
}

export function certificateFileName(file, multiFile) {
  return `${stem(file, multiFile)} [certificado].pdf`;
}

function stem(file, multiFile) {
  let name = file.name;
  if (name.toLowerCase().endsWith('.pdf')) name = name.slice(0, -4);

  name = name
    .replace(ILLEGAL, '-')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows silently drops trailing dots and spaces, which would make the
    // written path differ from the one recorded in indice.csv.
    .replace(/[. ]+$/, '');

  // All-illegal names become 'documento', not '---'. Tested rather than
  // rewritten, so names like 'Contrato--2024' survive.
  if (name === '' || /^-+$/.test(name)) name = 'documento';
  if (RESERVED_STEM.test(name)) name = `${name}_`;

  if (name.length > MAX_STEM_LENGTH) {
    name = name.slice(0, MAX_STEM_LENGTH).replace(/[. ]+$/, '');
  }

  return multiFile ? `${file.order + 1} - ${name}` : name;
}
