/**
 * The records of a pax extended header body: `<length> <key>=<value>\n`, where `length` counts
 * the bytes of the whole record. A malformed record fails, because a misread header would name the
 * next entry wrongly and the checks would scan it under the wrong path.
 * @param {Buffer} body
 * @returns {Map<string, string>}
 */
function paxRecords(body) {
  /** @type {Map<string, string>} */
  const records = new Map();
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const space = body.indexOf(0x20, offset);
    const lengthText = space < 0 ? '' : body.subarray(offset, space).toString('utf8');
    const length = /^[1-9]\d*$/u.test(lengthText) ? Number.parseInt(lengthText, 10) : 0;
    if (length === 0 || offset + length > body.length || body[offset + length - 1] !== 0x0a) {
      throw new Error(`a pax extended header holds a malformed record at byte ${offset}`);
    }
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) throw new Error(`a pax extended header record has no key: ${record}`);
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

/** The tar entry types that hold a regular file: `0`, the pre-POSIX empty type, and contiguous `7`. */
const REGULAR_FILE_TYPES = new Set(['0', '', '7']);

/** @param {Buffer} header */
function tarHeader(header) {
  const field = (/** @type {number} */ start, /** @type {number} */ length) =>
    header
      .subarray(start, start + length)
      .toString('utf8')
      .replace(/\0.*$/su, '');
  const prefix = field(345, 155);
  return {
    name: prefix === '' ? field(0, 100) : `${prefix}/${field(0, 100)}`,
    size: Number.parseInt(field(124, 12).trim() || '0', 8),
    type: field(156, 1),
  };
}

/**
 * @param {{ path?: string, size?: number }} next
 * @param {Buffer} bytes
 * @param {string} type
 */
function extendedHeader(next, bytes, type) {
  if (type === 'L') return { ...next, path: bytes.toString('utf8').replace(/\0.*$/su, '') };
  const records = paxRecords(bytes);
  const path = records.get('path');
  const size = records.get('size');
  const named = path === undefined ? next : { ...next, path };
  if (size === undefined) return named;
  if (!/^\d+$/u.test(size)) throw new Error(`a pax size record is ${size}`);
  return { ...named, size: Number.parseInt(size, 10) };
}

/**
 * The entries of an uncompressed tar archive, with the contents of the ones `keep` selects. A
 * ustar name is `prefix/name`; a pax extended header (`x`) `path` record or a GNU long name (`L`)
 * overrides the name of the entry that follows it, and a pax `size` record its size, so an entry
 * whose path does not fit the ustar fields (a deep `dist/web/` path) is named and scanned by its
 * real path. A pax global header (`g`) and a GNU long link name (`K`) name no file. Every other
 * entry is named in `names`; one that is not a regular file (a hard or symbolic link, a directory,
 * a device) is also named in `special`, so the checks refuse it rather than miss it.
 * @param {Buffer} archive
 * @param {(name: string) => boolean} keep
 */
export function readTar(archive, keep) {
  /** @type {string[]} */
  const names = [];
  /** @type {string[]} */
  const special = [];
  /** @type {Map<string, Buffer>} */
  const contents = new Map();
  /** @type {{ path?: string, size?: number }} */
  let next = {};
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const { name: headerName, size: headerSize, type } = tarHeader(header);
    const body = offset + 512;
    if (type === 'x' || type === 'L') {
      const bytes = archive.subarray(body, body + headerSize);
      next = extendedHeader(next, bytes, type);
      offset = body + Math.ceil(headerSize / 512) * 512;
      continue;
    }
    const size = type === 'g' || type === 'K' ? headerSize : (next.size ?? headerSize);
    offset = body + Math.ceil(size / 512) * 512;
    if (type === 'g' || type === 'K') continue;
    const name = next.path ?? headerName;
    next = {};
    names.push(name);
    if (!REGULAR_FILE_TYPES.has(type)) {
      special.push(name);
      continue;
    }
    if (keep(name)) contents.set(name, archive.subarray(body, body + size));
  }
  return { names, contents, special };
}
