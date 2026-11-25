// A .docx from the office-writer model: a title, headings, paragraphs, lists and tables, with the
// styles and numbering parts Word and LibreOffice need to show them as such (ADR-0167 D6).
import { contentTypes, escapeXml, OOXML, relationships, XML_DECLARATION, zip } from './package.mjs';

const W = `${OOXML}/wordprocessingml/2006/main`;
const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml';

/** A4 with 2.54 cm margins, in twentieths of a point; the text is 9,026 wide. */
const PAGE = { width: 11_906, height: 16_838, margin: 1_440 };
const TEXT_WIDTH = PAGE.width - 2 * PAGE.margin;

/** Runs of `text`, a line break kept as a `<w:br/>`. */
function runs(text, properties) {
  return String(text)
    .split(/\r\n|\r|\n/u)
    .map((line) => `<w:r>${properties}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`)
    .join(`<w:r><w:br/></w:r>`);
}

function paragraph(text, { style = '', numbering = '', align = '', bold = false }) {
  const pStyle = style === '' ? '' : `<w:pStyle w:val="${style}"/>`;
  const jc = align === '' ? '' : `<w:jc w:val="${align}"/>`;
  const pPr = `${pStyle}${numbering}${jc}`;
  return `<w:p>${pPr === '' ? '' : `<w:pPr>${pPr}</w:pPr>`}${runs(text, bold ? '<w:rPr><w:b/></w:rPr>' : '')}</w:p>`;
}

function cell(value, width, bold) {
  const align = typeof value === 'number' ? 'right' : '';
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${paragraph(value, { align, bold })}</w:tc>`;
}

/** A grid table at the text width, its header row repeated on every page, then an empty paragraph. */
function table({ header, rows }) {
  const columns = (header ?? rows[0]).length;
  const width = Math.floor(TEXT_WIDTH / columns);
  const row = (cells, bold) =>
    `<w:tr>${bold ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.map((value) => cell(value, width, bold)).join('')}</w:tr>`;
  const grid = `<w:gridCol w:w="${width}"/>`.repeat(columns);
  return [
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${width * columns}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>`,
    header === undefined ? '' : row(header, true),
    ...rows.map((cells) => row(cells, false)),
    '</w:tbl><w:p/>',
  ].join('');
}

const BULLETS = 1;

function body(model) {
  const lists = [];
  const blocks = model.blocks.map((block) => {
    if (block.type === 'heading') return paragraph(block.text, { style: `Heading${block.level}` });
    if (block.type === 'paragraph') return paragraph(block.text, {});
    if (block.type === 'table') return table(block);
    // Each numbered list is its own numbering instance, so it starts again at 1.
    const numId = block.ordered === true ? BULLETS + lists.push(block) : BULLETS;
    const numbering = `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`;
    return block.items
      .map((item) => paragraph(item, { style: 'ListParagraph', numbering }))
      .join('');
  });
  const title = model.title === undefined ? '' : paragraph(model.title, { style: 'Title' });
  return { xml: `${title}${blocks.join('')}`, numberedLists: lists.length };
}

const HEADING_SIZES = [32, 28, 26, 24, 22, 21];

const STYLES = [
  `${XML_DECLARATION}<w:styles xmlns:w="${W}">`,
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Yu Gothic" w:cs="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="ja-JP"/></w:rPr></w:rPrDefault>',
  '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>',
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>',
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>',
  ...HEADING_SIZES.map(
    (size, index) =>
      `<w:style w:type="paragraph" w:styleId="Heading${index + 1}"><w:name w:val="heading ${index + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${index}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`,
  ),
  '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>',
  '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>',
  `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join('')}</w:tblBorders></w:tblPr></w:style>`,
  '</w:styles>',
].join('');

/** One abstract bullet list and one abstract numbered list; `numberedLists` instances restart at 1. */
function numbering(numberedLists) {
  const level = (format, text) =>
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>`;
  const numbered = Array.from(
    { length: numberedLists },
    (_, index) =>
      `<w:num w:numId="${BULLETS + 1 + index}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`,
  ).join('');
  return [
    `${XML_DECLARATION}<w:numbering xmlns:w="${W}">`,
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>${level('bullet', '•')}</w:abstractNum>`,
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>${level('decimal', '%1.')}</w:abstractNum>`,
    `<w:num w:numId="${BULLETS}"><w:abstractNumId w:val="0"/></w:num>${numbered}`,
    '</w:numbering>',
  ].join('');
}

/** The .docx bytes of a checked `docx` model. */
export function writeDocx(model) {
  const { xml, numberedLists } = body(model);
  const section = `<w:sectPr><w:pgSz w:w="${PAGE.width}" w:h="${PAGE.height}"/><w:pgMar w:top="${PAGE.margin}" w:right="${PAGE.margin}" w:bottom="${PAGE.margin}" w:left="${PAGE.margin}" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
  return zip([
    [
      '[Content_Types].xml',
      contentTypes([
        ['word/document.xml', `${WORD}.document.main+xml`],
        ['word/styles.xml', `${WORD}.styles+xml`],
        ['word/numbering.xml', `${WORD}.numbering+xml`],
      ]),
    ],
    ['_rels/.rels', relationships([['officeDocument', 'word/document.xml']])],
    [
      'word/document.xml',
      `${XML_DECLARATION}<w:document xmlns:w="${W}"><w:body>${xml}${section}</w:body></w:document>`,
    ],
    [
      'word/_rels/document.xml.rels',
      relationships([
        ['styles', 'styles.xml'],
        ['numbering', 'numbering.xml'],
      ]),
    ],
    ['word/styles.xml', STYLES],
    ['word/numbering.xml', numbering(numberedLists)],
  ]);
}
