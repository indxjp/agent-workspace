// A .pptx from the office-writer model: 16:9 slides, each a title placeholder with bullets and a
// table below it, plus the slide master, layout and theme the format requires (ADR-0167 D6).
import {
  contentTypes,
  escapeXml,
  OOXML,
  RELATIONSHIP_TYPE,
  relationships,
  XML_DECLARATION,
  zip,
} from './package.mjs';

const PRESENTATION = 'application/vnd.openxmlformats-officedocument.presentationml';
const NAMESPACES = `xmlns:a="${OOXML}/drawingml/2006/main" xmlns:r="${RELATIONSHIP_TYPE}" xmlns:p="${OOXML}/presentationml/2006/main"`;

/** 16:9 in EMU, the area below the title, and the gap between bullets and a table. */
const SLIDE = { width: 12_192_000, height: 6_858_000 };
const MARGIN = 609_600;
const CONTENT = { x: MARGIN, y: 1_463_040, width: SLIDE.width - 2 * MARGIN, bottom: 6_400_800 };
const GAP = 182_880;
/** A table row's height when the rows fit: 0.45 inch, enough for one line at 14 pt. */
const ROW_HEIGHT = 411_480;

const GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const xfrm = (tag, { x, y, width, height }) =>
  `<${tag}><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></${tag}>`;

/** Runs of `text` at `size` hundredths of a point, a line break kept as an `<a:br/>`. */
function runs(text, size, bold) {
  const properties = `<a:rPr lang="ja-JP" sz="${size}"${bold ? ' b="1"' : ''}/>`;
  return String(text)
    .split(/\r\n|\r|\n/u)
    .map((line) => `<a:r>${properties}<a:t>${escapeXml(line)}</a:t></a:r>`)
    .join(`<a:br>${properties}</a:br>`);
}

function titleShape(title) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>${runs(title, 3200, true)}</a:p></p:txBody></p:sp>`;
}

function bulletShape(bullets, area) {
  const paragraphs = bullets
    .map(
      (bullet) =>
        `<a:p><a:pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>${runs(bullet, 2000, false)}</a:p>`,
    )
    .join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Bullets"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm('a:xfrm', area)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

const LINE = '<a:solidFill><a:srgbClr val="808080"/></a:solidFill>';
const BORDERS = ['lnL', 'lnR', 'lnT', 'lnB']
  .map((side) => `<a:${side} w="12700">${LINE}</a:${side}>`)
  .join('');

function tableShape({ header, rows }, area) {
  const all = header === undefined ? rows : [header, ...rows];
  const columns = all[0].length;
  const width = Math.floor(area.width / columns);
  const height = Math.min(ROW_HEIGHT, Math.floor(area.height / all.length));
  const cell = (value, bold) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${typeof value === 'number' ? '<a:pPr algn="r"/>' : ''}${runs(value, 1400, bold)}</a:p></a:txBody><a:tcPr>${BORDERS}${bold ? '<a:solidFill><a:srgbClr val="D9E2F3"/></a:solidFill>' : ''}</a:tcPr></a:tc>`;
  const tableRows = all
    .map(
      (cells, index) =>
        `<a:tr h="${height}">${cells.map((value) => cell(value, header !== undefined && index === 0)).join('')}</a:tr>`,
    )
    .join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>${xfrm('p:xfrm', { ...area, width: width * columns, height: height * all.length })}<a:graphic><a:graphicData uri="${OOXML}/drawingml/2006/table"><a:tbl><a:tblPr firstRow="${header === undefined ? 0 : 1}"/><a:tblGrid>${`<a:gridCol w="${width}"/>`.repeat(columns)}</a:tblGrid>${tableRows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

/** Bullets take the area below the title, a table the rest; with both, the bullets take 40%. */
function slideXml({ title, bullets, table }) {
  const full = {
    x: CONTENT.x,
    y: CONTENT.y,
    width: CONTENT.width,
    height: CONTENT.bottom - CONTENT.y,
  };
  const split = bullets !== undefined && table !== undefined;
  const bulletArea = split ? { ...full, height: Math.floor(full.height * 0.4) } : full;
  const tableTop = split ? bulletArea.y + bulletArea.height + GAP : full.y;
  const tableArea = { ...full, y: tableTop, height: CONTENT.bottom - tableTop };
  const shapes = [
    titleShape(title),
    bullets === undefined ? '' : bulletShape(bullets, bulletArea),
    table === undefined ? '' : tableShape(table, tableArea),
  ].join('');
  return `${XML_DECLARATION}<p:sld ${NAMESPACES}><p:cSld><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const TITLE_PLACEHOLDER = (frame) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${frame}</p:spPr><p:txBody><a:bodyPr anchor="b"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:endParaRPr lang="ja-JP"/></a:p></p:txBody></p:sp>`;

const MASTER = `${XML_DECLARATION}<p:sldMaster ${NAMESPACES}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}${TITLE_PLACEHOLDER(`${xfrm('a:xfrm', { x: MARGIN, y: 365_760, width: CONTENT.width, height: 914_400 })}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`)}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const LAYOUT = `${XML_DECLARATION}<p:sldLayout ${NAMESPACES} type="titleOnly" preserve="1"><p:cSld name="Title Only"><p:spTree>${GROUP}${TITLE_PLACEHOLDER('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const SCHEME_COLOURS = [
  ['dk1', '<a:sysClr val="windowText" lastClr="000000"/>'],
  ['lt1', '<a:sysClr val="window" lastClr="FFFFFF"/>'],
  ...[
    ['dk2', '44546A'],
    ['lt2', 'E7E6E6'],
    ['accent1', '4472C4'],
    ['accent2', 'ED7D31'],
    ['accent3', 'A5A5A5'],
    ['accent4', 'FFC000'],
    ['accent5', '5B9BD5'],
    ['accent6', '70AD47'],
    ['hlink', '0563C1'],
    ['folHlink', '954F72'],
  ].map(([name, rgb]) => [name, `<a:srgbClr val="${rgb}"/>`]),
];
const PLACEHOLDER_FILL = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
const font = (latin, japanese) =>
  `<a:latin typeface="${latin}"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Jpan" typeface="${japanese}"/>`;

const THEME = [
  `${XML_DECLARATION}<a:theme xmlns:a="${OOXML}/drawingml/2006/main" name="Office Theme"><a:themeElements>`,
  `<a:clrScheme name="Office">${SCHEME_COLOURS.map(([name, colour]) => `<a:${name}>${colour}</a:${name}>`).join('')}</a:clrScheme>`,
  `<a:fontScheme name="Office"><a:majorFont>${font('Calibri Light', 'Yu Gothic Light')}</a:majorFont><a:minorFont>${font('Calibri', 'Yu Gothic')}</a:minorFont></a:fontScheme>`,
  `<a:fmtScheme name="Office"><a:fillStyleLst>${PLACEHOLDER_FILL.repeat(3)}</a:fillStyleLst>`,
  `<a:lnStyleLst>${`<a:ln w="6350">${PLACEHOLDER_FILL}</a:ln>`.repeat(3)}</a:lnStyleLst>`,
  `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>`,
  `<a:bgFillStyleLst>${PLACEHOLDER_FILL.repeat(3)}</a:bgFillStyleLst></a:fmtScheme>`,
  '</a:themeElements></a:theme>',
].join('');

/** The .pptx bytes of a checked `pptx` model. */
export function writePptx({ slides }) {
  const slideParts = slides.map((_, index) => `ppt/slides/slide${index + 1}.xml`);
  // rId1 master, rId2 theme, rId3 presentation properties, then the slides from rId4.
  const presentation = `${XML_DECLARATION}<p:presentation ${NAMESPACES} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${4 + index}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${SLIDE.width}" cy="${SLIDE.height}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  return zip([
    [
      '[Content_Types].xml',
      contentTypes([
        ['ppt/presentation.xml', `${PRESENTATION}.presentation.main+xml`],
        ['ppt/presProps.xml', `${PRESENTATION}.presProps+xml`],
        ['ppt/slideMasters/slideMaster1.xml', `${PRESENTATION}.slideMaster+xml`],
        ['ppt/slideLayouts/slideLayout1.xml', `${PRESENTATION}.slideLayout+xml`],
        ['ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
        ...slideParts.map((part) => [part, `${PRESENTATION}.slide+xml`]),
      ]),
    ],
    ['_rels/.rels', relationships([['officeDocument', 'ppt/presentation.xml']])],
    ['ppt/presentation.xml', presentation],
    [
      'ppt/_rels/presentation.xml.rels',
      relationships([
        ['slideMaster', 'slideMasters/slideMaster1.xml'],
        ['theme', 'theme/theme1.xml'],
        ['presProps', 'presProps.xml'],
        ...slideParts.map((part) => ['slide', part.slice('ppt/'.length)]),
      ]),
    ],
    ['ppt/presProps.xml', `${XML_DECLARATION}<p:presentationPr ${NAMESPACES}/>`],
    ['ppt/slideMasters/slideMaster1.xml', MASTER],
    [
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      relationships([
        ['slideLayout', '../slideLayouts/slideLayout1.xml'],
        ['theme', '../theme/theme1.xml'],
      ]),
    ],
    ['ppt/slideLayouts/slideLayout1.xml', LAYOUT],
    [
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      relationships([['slideMaster', '../slideMasters/slideMaster1.xml']]),
    ],
    ['ppt/theme/theme1.xml', THEME],
    ...slides.flatMap((slide, index) => [
      [slideParts[index], slideXml(slide)],
      [
        `ppt/slides/_rels/slide${index + 1}.xml.rels`,
        relationships([['slideLayout', '../slideLayouts/slideLayout1.xml']]),
      ],
    ]),
  ]);
}
