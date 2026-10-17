/**
 * Every runnable command and code sample the docs, the landing page and the READMEs show, and the
 * state each one is in (issue #880). The extractor is pure: text in, claims out. It reads no
 * network and runs nothing.
 *
 * A block is in exactly one of these states, marked at the block:
 *
 * - `run`: executed in the clean journey container against the packed packages;
 * - `compile`: type-checked against the packed packages;
 * - `file`: a copy of a repository file (`file=<path>`), compared with it;
 * - `illustrative`: labelled so on the page and listed, never run.
 *
 * In Markdown and MDX the marker is fence meta, written beside Mintlify's own `title="…"`:
 * ```` ```sh claim="run" ````, ```` ```ts file="tests/gallery/manual-search/agents/manual-search.ts" ````.
 * Mintlify drops a quoted `key="value"` it does not know from a block's title, but shows an unquoted
 * `claim=run` (or a bare `run`) as the title of a block without `title="…"`, so the value is quoted.
 * Every fence but `mermaid` is a claim; an unmarked `text` block is allowed only while no line of it
 * starts with a shell prompt or a command, so a command cannot hide in one.
 * A `run` block is written for every shell unless it says otherwise: `shell="posix"` or
 * `shell="powershell"` (`data-shell` in the landing page's HTML), or a `powershell`, `pwsh` or `ps1`
 * fence, which is PowerShell. The runner shows a block for another shell as `n/a`, not as a pass.
 * In the landing page's HTML the marker is `data-claim="run|compile|illustrative"` and optionally
 * `data-file="…"` on the `<pre>` (or on a one-line `cmd` element). An unmarked block throws, and so
 * does an `illustrative` block the reader is not told is one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** What the extractor throws; the message starts with `page:line`. */
export class ClaimError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ClaimError';
  }
}

/** A line that starts with a shell prompt or a command the docs tell a reader to run. */
const COMMAND_LINE = /^(?:[$%]\s|(?:npm|npx|pnpm|aw|docker|helm|curl|git)(?:\s|$))/u;
const MARKED_STATES = new Set(['run', 'compile', 'illustrative']);
const REFERENCE_PREFIX = 'docs/sdk/site/reference/';

/**
 * @typedef {'run' | 'compile' | 'file' | 'illustrative' | 'generated'} ClaimState
 * @typedef {'posix' | 'powershell'} ClaimShell
 * @typedef {{ page: string, line: number, state: ClaimState, lang: string, body: string,
 *   title: string, file?: string, shell?: ClaimShell }} Claim
 */

/**
 * The parts of a fence's info string: `sh title="aw" claim="run"` is language `sh`, title `aw`, claim
 * `run`. A bare word after the language is Mintlify's title.
 *
 * @param {string} info
 */
export function parseFenceInfo(info) {
  const tokens = info.trim().match(/[\w-]+=(?:"[^"]*"|'[^']*'|\{[^}]*\}|\S+)|"[^"]*"|\S+/gu) ?? [];
  const lang = (tokens.shift() ?? '').toLowerCase();
  /** @type {Record<string, string>} */
  const meta = {};
  const bare = [];
  for (const token of tokens) {
    const pair = /^([\w-]+)=(.*)$/u.exec(token);
    if (pair?.[1] === undefined || pair[2] === undefined) bare.push(token.replace(/^"|"$/gu, ''));
    else meta[pair[1]] = pair[2].replace(/^(["'])(.*)\1$/u, '$2');
  }
  return {
    lang,
    title: meta['title'] ?? bare.join(' '),
    claim: meta['claim'],
    file: meta['file'],
    shell: meta['shell'],
  };
}

/**
 * The shell a block is written for: its marker, else PowerShell for a PowerShell fence, else any.
 *
 * @param {string} where `page:line` @param {string | undefined} marker @param {string} lang
 * @returns {{ shell?: ClaimShell }}
 */
function shellOf(where, marker, lang) {
  if (marker !== undefined) {
    if (marker !== 'posix' && marker !== 'powershell') {
      throw new ClaimError(`${where}: unknown shell "${marker}"; use posix or powershell`);
    }
    return { shell: marker };
  }
  return ['powershell', 'pwsh', 'ps1'].includes(lang) ? { shell: 'powershell' } : {};
}

/**
 * The state a marker names, or a `ClaimError` for a block without one.
 *
 * @param {string} where `page:line` @param {string | undefined} claim @param {string | undefined} file
 * @param {string} title the block's visible title
 * @param {boolean} labelled whether the reader is told by other means that it is illustrative
 * @returns {ClaimState}
 */
function stateOf(where, claim, file, title, labelled) {
  if (file !== undefined) {
    if (claim !== undefined)
      throw new ClaimError(`${where}: a block has claim= or file=, not both`);
    if (file === '') throw new ClaimError(`${where}: file= names no file`);
    return 'file';
  }
  if (claim === undefined) {
    throw new ClaimError(
      `${where}: unmarked code block; mark it claim="run", claim="compile", claim="illustrative" or file="<path>"`,
    );
  }
  if (!MARKED_STATES.has(claim)) {
    throw new ClaimError(`${where}: unknown claim "${claim}"; use run, compile or illustrative`);
  }
  if (claim === 'illustrative' && !labelled && !/illustrative/iu.test(title)) {
    throw new ClaimError(
      `${where}: an illustrative block must say so on the page; put "illustrative" in its title`,
    );
  }
  return /** @type {ClaimState} */ (claim);
}

/**
 * The fenced blocks of a Markdown or MDX page, in order. A fence may be indented (inside a JSX
 * element); the body is dedented by the opening fence's indent.
 *
 * @param {string} page @param {string} text
 */
function fences(page, text) {
  const lines = text.split(/\r?\n/u);
  /** @type {{ line: number, info: string, body: string }[]} */
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^(\s*)(`{3,})([^`]*)$/u.exec(lines[index] ?? '');
    if (open?.[1] === undefined || open[2] === undefined) continue;
    const indent = open[1];
    const ticks = open[2].length;
    const body = [];
    let end = index + 1;
    for (; end < lines.length; end += 1) {
      const text = lines[end] ?? '';
      const close = /^\s*(`{3,})\s*$/u.exec(text);
      if (close?.[1] !== undefined && close[1].length >= ticks) break;
      body.push(text.startsWith(indent) ? text.slice(indent.length) : text.trimStart());
    }
    if (end >= lines.length)
      throw new ClaimError(`${page}:${String(index + 1)}: unclosed code fence`);
    found.push({ line: index + 1, info: open[3] ?? '', body: body.join('\n') });
    index = end;
  }
  return found;
}

/**
 * @param {string} page repository-relative path, forward slashes @param {string} text
 * @returns {Claim[]}
 */
function markdownClaims(page, text) {
  const generated = page.startsWith(REFERENCE_PREFIX);
  /** @type {Claim[]} */
  const claims = [];
  for (const fence of fences(page, text)) {
    const { lang, title, claim, file, shell } = parseFenceInfo(fence.info);
    if (lang === 'mermaid') continue;
    // An unmarked `text` block is prose; one holding a command is a claim like any other.
    const plainText = lang === 'text' && claim === undefined && file === undefined;
    if (plainText && !fence.body.split('\n').some((line) => COMMAND_LINE.test(line))) continue;
    const where = `${page}:${String(fence.line)}`;
    if (/(?:^|\s)(?:claim|file)=(?!")/u.test(fence.info)) {
      throw new ClaimError(
        `${where}: Mintlify shows an unquoted claim= or file= in the block's title; quote it, claim="run"`,
      );
    }
    if (generated) {
      claims.push({ page, line: fence.line, state: 'generated', lang, body: fence.body, title });
      continue;
    }
    const state = stateOf(where, claim, file, title, false);
    claims.push({
      page,
      line: fence.line,
      state,
      lang,
      body: fence.body,
      title,
      ...(file === undefined ? {} : { file }),
      ...shellOf(where, shell, lang),
    });
  }
  return claims;
}

/** @param {string} text */
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&nbsp;/gu, ' ')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

/** The text a reader sees in an HTML fragment. @param {string} html */
function visibleText(html) {
  return decodeEntities(html.replace(/<!--[\s\S]*?-->/gu, '').replace(/<[^>]+>/gu, ''));
}

/** @param {string} attributes @param {string} name */
function attribute(attributes, name) {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'u').exec(attributes)?.[1];
}

/** @param {string} lang @param {string | undefined} file */
const languageOf = (lang, file) =>
  lang !== '' ? lang : (/\.([a-z]+)$/u.exec(file ?? '')?.[1] ?? '');

/**
 * `<pre>` blocks and the one-line command elements (`class="cmd"`, `id="cmd-…"`) of an HTML page.
 *
 * @param {string} page @param {string} text
 * @returns {Claim[]}
 */
function htmlClaims(page, text) {
  const elements = [
    ...text.matchAll(/<(pre)\b([^>]*)>([\s\S]*?)<\/pre>/gu),
    ...text.matchAll(
      /<(div|code)\b([^>]*(?:class="cmd"|id="cmd-[^"]*")[^>]*)>((?:[^<]|<(?!\/\1>))*)<\/\1>/gu,
    ),
  ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  /** @type {Claim[]} */
  const claims = [];
  for (const element of elements) {
    const attributes = element[2] ?? '';
    const inner = element[3] ?? '';
    const body = visibleText(inner).replace(/^\n+|\s+$/gu, '');
    // A navigation chip (`<div class="cmd"><a …>`) and a block a script fills in are not claims.
    if (body.trim() === '' || (element[1] !== 'pre' && /<a\b/u.test(inner))) continue;
    const line = text.slice(0, element.index).split('\n').length;
    const where = `${page}:${String(line)}`;
    const claim = attribute(attributes, 'data-claim');
    const file = attribute(attributes, 'data-file');
    const state = stateOf(where, claim, file, '', true);
    const lang =
      languageOf(attribute(attributes, 'data-lang') ?? '', file) ||
      (state === 'run' ? 'sh' : state === 'compile' ? 'ts' : '');
    claims.push({
      page,
      line,
      state,
      lang,
      body,
      title: '',
      ...(file === undefined ? {} : { file }),
      ...shellOf(where, attribute(attributes, 'data-shell'), lang),
    });
  }
  return claims;
}

/**
 * The claims of one page.
 *
 * @param {string} page repository-relative path with forward slashes @param {string} text
 * @returns {Claim[]}
 */
export function extractClaims(page, text) {
  return page.endsWith('.html') ? htmlClaims(page, text) : markdownClaims(page, text);
}

/** @param {string} dir @param {(name: string) => boolean} keep @returns {string[]} */
function walk(dir, keep) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, keep);
    return keep(entry.name) ? [full] : [];
  });
}

/**
 * The pages whose blocks are claims: the docs site, the landing page, the README and each package's.
 *
 * @param {string} root repository root
 */
export function claimPages(root) {
  const pages = [
    ...walk(path.join(root, 'docs', 'sdk', 'site'), (name) => name.endsWith('.mdx')),
    ...readdirSync(path.join(root, 'sites', 'lp'))
      .filter((name) => name.endsWith('.html'))
      .map((name) => path.join(root, 'sites', 'lp', name)),
    path.join(root, 'README.md'),
    ...readdirSync(path.join(root, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, 'packages', entry.name, 'README.md')),
  ];
  return pages
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .filter((page) => {
      try {
        readFileSync(path.join(root, page));
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Every claim in the repository. The first unmarked block stops the run, naming `page:line`.
 *
 * @param {string} root repository root
 * @returns {Claim[]}
 */
export function extractRepositoryClaims(root) {
  return claimPages(root).flatMap((page) =>
    extractClaims(page, readFileSync(path.join(root, page), 'utf8')),
  );
}

/**
 * The commands a shell block tells the reader to run, in order: the `$ ` lines when it has any (the
 * rest is output), otherwise every line; trailing `# comments` and comment-only lines dropped,
 * `\` continuations joined, and each `a && b` split into `a` and `b`. `export NAME=<placeholder>`
 * where the placeholder ends in `...` is not a command: the runner supplies the real variable.
 *
 * @param {string} body
 */
export function shellCommands(body) {
  const lines = body.split(/\r?\n/u);
  const prompted = lines.some((line) => line.startsWith('$ '));
  const chosen = prompted
    ? lines.filter((line) => line.startsWith('$ ')).map((line) => line.slice(2))
    : lines;
  /** @type {string[]} */
  const joined = [];
  let carry = '';
  for (const line of chosen) {
    const stripped = line.replace(/(^|\s+)#.*$/u, '').trim();
    const text = carry === '' ? stripped : `${carry} ${stripped}`;
    if (text.endsWith('\\')) carry = text.slice(0, -1).trim();
    else {
      carry = '';
      if (text !== '') joined.push(text);
    }
  }
  return joined
    .filter((line) => !/^export \w+=\S*\.\.\.$/u.test(line))
    .flatMap((line) => splitAnd(line));
}

/** Split on `&&` outside quotes. @param {string} line */
function splitAnd(line) {
  /** @type {string[]} */
  const parts = [];
  let quote = '';
  let start = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (quote !== '') {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (line.startsWith('&&', index)) {
      parts.push(line.slice(start, index).trim());
      start = index + 2;
      index += 1;
    }
  }
  parts.push(line.slice(start).trim());
  return parts.filter((part) => part !== '');
}
