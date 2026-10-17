/**
 * MDX rendering primitives shared by every page renderer: escaping, front matter, the generated
 * banner, and Markdown table assembly. Kept free of any TypeScript-compiler-API dependency so it
 * can be unit-exercised on plain strings.
 */

const GENERATOR_PATH = 'scripts/docs/generate-sdk-reference.mjs';

/**
 * Escape the characters MDX reads as syntax (`<`, `>`, `{`, `}`) outside backtick-delimited inline
 * code, which MDX (like CommonMark) never reinterprets. Used for prose: headings, paragraphs.
 * @param {string} text
 */
export function mdxProse(text) {
  let cursor = 0;
  let out = '';
  for (const span of text.matchAll(CODE_SPAN)) {
    out += escapeProse(text.slice(cursor, span.index)) + span[0];
    cursor = span.index + span[0].length;
  }
  return out + escapeProse(text.slice(cursor));
}

/**
 * A CommonMark code span: a backtick run, content, and a closing run of the same length. The run
 * is longer than one backtick when the content itself contains backticks (see `inlineCode`).
 */
const CODE_SPAN = /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/gu;

/** @param {string} text */
function escapeProse(text) {
  return text.replaceAll(/[<>{}]/gu, (ch) => `\\${ch}`);
}

/**
 * Wrap text as inline code whatever it contains: the delimiter is one backtick longer than the
 * longest backtick run inside, and a leading or trailing backtick is padded with a space, as
 * CommonMark requires. A template-string literal from the source is the case that needs this —
 * a single-backtick span would end at its first backtick and hand `${…}` to MDX as an expression.
 * @param {string} text
 */
export function inlineCode(text) {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/gu)].map((run) => run[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

/**
 * `mdxProse`, plus escaping every `|` (inside and outside backticks alike, since a bare pipe
 * breaks a Markdown table row regardless of code formatting) and collapsing internal newlines to
 * spaces, because a table cell is one physical line.
 * @param {string} text
 */
export function mdxTableCell(text) {
  const collapsed = text.replaceAll(/\s*\r?\n\s*/gu, ' ').trim();
  return mdxProse(collapsed).replaceAll('|', '\\|');
}

/**
 * A type string rendered as inline code for a table cell: backticked, pipes escaped inside.
 * @param {string} typeText
 */
export function typeCell(typeText) {
  return mdxTableCell(inlineCode(typeText));
}

/**
 * Front matter, then the "generated — do not edit" banner every reference page carries.
 * @param {{ readonly title: string, readonly description: string, readonly sources: readonly string[] }} input
 */
export function pageHeader({ title, description, sources }) {
  const sourceList = sources.map((source) => `\`${source}\``).join(', ');
  return [
    '---',
    `title: "${title.replaceAll('"', "'")}"`,
    `description: "${description.replaceAll('"', "'")}"`,
    '---',
    '',
    `<Note>This page is generated from ${sourceList} by \`${GENERATOR_PATH}\`. Do not edit it by hand — run \`pnpm docs:generate\`.</Note>`,
    '',
  ].join('\n');
}

/**
 * A Markdown table. `rows` are already-escaped cell text; header cells are escaped here.
 * @param {readonly string[]} headers @param {readonly (readonly string[])[]} rows
 */
export function table(headers, rows) {
  if (rows.length === 0) return '';
  const headerRow = `| ${headers.map(mdxTableCell).join(' | ')} |`;
  const rule = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return `${headerRow}\n${rule}\n${body}`;
}

/**
 * A fenced code block.
 * @param {string} language @param {string} code
 */
export function codeBlock(language, code) {
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

/**
 * The `packages/<pkg>/src/...` tail of an absolute source path, for a page's generated banner.
 * @param {string} fileName
 */
export function packageRelativePath(fileName) {
  const marker = 'packages/';
  const index = fileName.lastIndexOf(marker);
  return index === -1 ? fileName : fileName.slice(index);
}

/**
 * Normalise a rendered page: LF endings, no trailing whitespace lines, exactly one final `\n`.
 * @param {string} content
 */
export function finalizePage(content) {
  const normalised = content.replaceAll('\r\n', '\n').replace(/\n{3,}/gu, '\n\n');
  return `${normalised.trimEnd()}\n`;
}
