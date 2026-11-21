// An Office file is an Open Packaging Conventions package: a zip of XML parts, a content-type list
// and relationship parts. This writes one with node:zlib alone. A skill is installed on its own, so
// office-writer cannot import office-reader's zip code (ADR-0167 D6).
import { Buffer } from 'node:buffer';
import { crc32, deflateRawSync } from 'node:zlib'; // crc32: Node 22.2 and later

export const OOXML = 'http://schemas.openxmlformats.org';
export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const RELATIONSHIPS = `${OOXML}/package/2006/relationships`;
export const RELATIONSHIP_TYPE = `${OOXML}/officeDocument/2006/relationships`;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** Text or an attribute value, escaped for XML. The model has already refused what XML cannot hold. */
export const escapeXml = (text) => String(text).replace(/[&<>"]/gu, (char) => ESCAPES[char]);

/** `[Content_Types].xml`: `xml` and `rels` by extension, and each named part's type. */
export function contentTypes(overrides) {
  const parts = overrides
    .map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`)
    .join('');
  return `${XML_DECLARATION}<Types xmlns="${OOXML}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${parts}</Types>`;
}

/** A relationship part; each target is `[type, target]` and gets `rId<n>` in order. */
export function relationships(targets) {
  const items = targets
    .map(
      ([type, target], index) =>
        `<Relationship Id="rId${index + 1}" Type="${RELATIONSHIP_TYPE}/${type}" Target="${target}"/>`,
    )
    .join('');
  return `${XML_DECLARATION}<Relationships xmlns="${RELATIONSHIPS}">${items}</Relationships>`;
}

// ---------- zip ----------

/** Little-endian fields, each `[bytes, value]` with `bytes` 2 or 4. */
function record(fields) {
  const buffer = Buffer.alloc(fields.reduce((total, [bytes]) => total + bytes, 0));
  let offset = 0;
  for (const [bytes, value] of fields) {
    offset =
      bytes === 2 ? buffer.writeUInt16LE(value, offset) : buffer.writeUInt32LE(value, offset);
  }
  return buffer;
}

const VERSION = 20; // 2.0: deflate
const UTF8_NAMES = 0x0800;
const DEFLATE = 8;
const DOS_DATE_1980_01_01 = 0x21; // a fixed stamp, so the same model always gives the same bytes

/** A zip of `parts` (`[name, text]`, in order), every part deflated, names in UTF-8. */
export function zip(parts) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const [name, text] of parts) {
    const label = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const deflated = deflateRawSync(data);
    const common = [
      [2, UTF8_NAMES],
      [2, DEFLATE],
      [2, 0],
      [2, DOS_DATE_1980_01_01],
      [4, crc32(data)],
      [4, deflated.length],
      [4, data.length],
      [2, label.length],
      [2, 0],
    ];
    const local = record([[4, 0x04034b50], [2, VERSION], ...common]);
    locals.push(local, label, deflated);
    directory.push(
      record([
        [4, 0x02014b50],
        [2, VERSION],
        [2, VERSION],
        ...common,
        [2, 0],
        [2, 0],
        [2, 0],
        [4, 0],
        [4, offset],
      ]),
      label,
    );
    offset += local.length + label.length + deflated.length;
  }
  const central = Buffer.concat(directory);
  const end = record([
    [4, 0x06054b50],
    [2, 0],
    [2, 0],
    [2, parts.length],
    [2, parts.length],
    [4, central.length],
    [4, offset],
    [2, 0],
  ]);
  return Buffer.concat([...locals, central, end]);
}
