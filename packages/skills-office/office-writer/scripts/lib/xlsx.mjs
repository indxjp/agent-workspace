// A .xlsx from the office-writer model: sheets of typed cells, a bold and frozen header row, and
// dates stored as serial days with a date format (ADR-0167 D6).
import { contentTypes, escapeXml, OOXML, relationships, XML_DECLARATION, zip } from './package.mjs';

const MAIN = `${OOXML}/spreadsheetml/2006/main`;
const SHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml';

/** The cell formats `styles.xml` defines, by index. */
const HEADER_STYLE = 1;
const DATE_STYLE = 2;

const STYLES = [
  `${XML_DECLARATION}<styleSheet xmlns="${MAIN}">`,
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>',
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>',
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>',
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>',
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>',
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
  '</styleSheet>',
].join('');

/** 26 → 'AA'. */
function columnLetters(index) {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

/** Days since Excel's epoch, 1899-12-30, for a checked `YYYY-MM-DD` from 1900-03-01. */
function serialDay(date) {
  const [year, month, day] = date.split('-').map(Number);
  return (Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/** Shared strings, each stored once, by first use; `count` is every cell that refers to one. */
function stringTable() {
  const indexes = new Map();
  let references = 0;
  return {
    index(text) {
      references += 1;
      if (!indexes.has(text)) indexes.set(text, indexes.size);
      return indexes.get(text);
    },
    xml() {
      const items = [...indexes.keys()]
        .map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`)
        .join('');
      return `${XML_DECLARATION}<sst xmlns="${MAIN}" count="${references}" uniqueCount="${indexes.size}">${items}</sst>`;
    },
  };
}

function cellXml(value, ref, strings, style) {
  const s = style === 0 ? '' : ` s="${style}"`;
  if (value === null) return '';
  if (typeof value === 'number') return `<c r="${ref}"${s}><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === 'string')
    return `<c r="${ref}"${s} t="s"><v>${strings.index(value)}</v></c>`;
  return `<c r="${ref}" s="${DATE_STYLE}"><v>${serialDay(value.date)}</v></c>`;
}

/** Roughly how many characters wide a value shows; a full-width character counts two. */
function displayWidth(value) {
  if (value === null) return 0;
  if (typeof value === 'object') return 10;
  let width = 0;
  for (const char of String(value)) width += char.codePointAt(0) > 0xff ? 2 : 1;
  return width;
}

/** Each column as wide as its widest value, from 8 to 60 characters, so no date shows as ###. */
function columnsXml(all) {
  const widths = [];
  for (const cells of all)
    cells.forEach((value, column) => {
      widths[column] = Math.max(widths[column] ?? 8, Math.min(60, displayWidth(value) + 2));
    });
  const columns = widths
    .map(
      (width, column) =>
        `<col min="${column + 1}" max="${column + 1}" width="${width}" customWidth="1"/>`,
    )
    .join('');
  return `<cols>${columns}</cols>`;
}

function sheetXml({ header, rows }, strings) {
  const all = header === undefined ? rows : [header, ...rows];
  const data = all
    .map((cells, row) => {
      const style = header !== undefined && row === 0 ? HEADER_STYLE : 0;
      const xml = cells
        .map((value, column) =>
          cellXml(value, `${columnLetters(column)}${row + 1}`, strings, style),
        )
        .join('');
      return `<row r="${row + 1}">${xml}</row>`;
    })
    .join('');
  const view =
    header === undefined
      ? '<sheetView workbookViewId="0"/>'
      : '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView>';
  return `${XML_DECLARATION}<worksheet xmlns="${MAIN}"><sheetViews>${view}</sheetViews>${columnsXml(all)}<sheetData>${data}</sheetData></worksheet>`;
}

/** The .xlsx bytes of a checked `xlsx` model. */
export function writeXlsx({ sheets }) {
  const strings = stringTable();
  const sheetParts = sheets.map((sheet, index) => [
    `xl/worksheets/sheet${index + 1}.xml`,
    sheetXml(sheet, strings),
  ]);
  const workbook = `${XML_DECLARATION}<workbook xmlns="${MAIN}" xmlns:r="${OOXML}/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`;
  return zip([
    [
      '[Content_Types].xml',
      contentTypes([
        ['xl/workbook.xml', `${SHEET}.sheet.main+xml`],
        ['xl/styles.xml', `${SHEET}.styles+xml`],
        ['xl/sharedStrings.xml', `${SHEET}.sharedStrings+xml`],
        ...sheetParts.map(([part]) => [part, `${SHEET}.worksheet+xml`]),
      ]),
    ],
    ['_rels/.rels', relationships([['officeDocument', 'xl/workbook.xml']])],
    ['xl/workbook.xml', workbook],
    [
      'xl/_rels/workbook.xml.rels',
      relationships([
        ...sheetParts.map(([part]) => ['worksheet', part.slice('xl/'.length)]),
        ['styles', 'styles.xml'],
        ['sharedStrings', 'sharedStrings.xml'],
      ]),
    ],
    ['xl/styles.xml', STYLES],
    ...sheetParts,
    ['xl/sharedStrings.xml', strings.xml()],
  ]);
}
