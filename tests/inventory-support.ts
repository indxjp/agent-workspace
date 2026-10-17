/**
 * What the two inventory gates share: the tracked-tree readers, the `pageExtensions` guard, the
 * specification's heading set, and the reader that turns a partitioned declaration file into data.
 *
 * This module exists because [ADR-0025](../docs/adr/0025-the-route-inventory-is-partitioned-by-owner.md)
 * splits one hand-maintained array into one file per owning task, and
 * [its final consequence](../docs/adr/0025-the-route-inventory-is-partitioned-by-owner.md) gives the
 * screen inventory the same treatment. Two gates now read a directory of declaration files, and the
 * reader is the part that must not be written twice: a second copy is a second set of failure modes,
 * and the ones this reader has are the ones ADR-0025 §3 requires to fail closed.
 *
 * ## Why the declarations are read as text and not imported
 *
 * The obvious implementation of "read the union of the tracked declaration files" is a dynamic
 * import of each file in a loop. It is not available here. `tests/no-sdk-import.test.ts` scans the
 * whole tracked tree and reports, as a hard failure, any module reference it cannot resolve to a
 * string literal — *"a resolver call whose argument is not a plain quoted string … could name
 * anything at run time"*. A loop importing a computed path is exactly that construct, and it is the
 * same objection that made `tests/route-inventory.test.ts` stop importing `apps/web/next.config.ts`
 * (`docs/adr/W1-INT-02-the-page-extension-knob-is-asserted-unset-not-read.md`). A gate that another
 * gate must be weakened to accept is not a gate.
 *
 * That is not a theory: the first draft of this comment spelled the construct out with its opening
 * parenthesis, and `tests/no-sdk-import.test.ts` reported this file and `route-inventory.test.ts` as
 * two undecidable module references. It scans its own source and everyone else's, so the construct
 * cannot be named here even in prose — the same reason that gate writes its own tables as joined
 * fragments.
 *
 * So a declaration file is read the way a route file is read: as source text, by a reader that
 * accepts a small, total grammar and **throws on everything else**. {@link declarationArrayToJson}
 * has no fall-through — every character is either part of a construct it understands or the reason
 * it refuses. That is the ADR-0015 shape, and it is also what makes "a declaration file exporting
 * nothing readable is a hard failure" implementable at all: the reader knows the difference between
 * "no entries" and "I could not read this".
 *
 * ## Nothing here writes to the tree
 *
 * `readFileSync`, `existsSync` and `git ls-files` are the whole of its access to the repository.
 * That is asserted mechanically by both gates, over every module their imports reach rather than
 * over a pair of file names written next to the assertion — see {@link gateModules} and
 * {@link nonReadingFsAccess} — because moving code out of a file that promised not to plant
 * fixtures would otherwise be a way to get the promise back for free.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIR = path.join(REPO_ROOT, 'apps/web');
/** Repo-relative, forward-slashed: the prefix every route and page file's tracked path carries. */
export const APP_PREFIX = 'apps/web/app';
export const SPEC_PATH = path.join(REPO_ROOT, 'docs/spec.md');

// ── The pageExtensions knob ─────────────────────────────────────────────────────────────────

/**
 * Next.js's documented default `pageExtensions`.
 *
 * Established by experiment against this repository's own pinned Next, not inherited: six probe
 * routes named `route.{tsx,ts,jsx,js,mjs,cjs}` were planted under `apps/web/app/api/` and
 * `next typegen` put exactly the first four into `AppRouteHandlerRoutes`. The transcript is on
 * W1-INT-02's PR. Used only after {@link pageExtensions} has established that the application
 * configures no `pageExtensions` of its own — which is what keeps this constant from being a
 * guess about a knob somebody has since turned.
 */
export const DEFAULT_PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js'] as const;

/** The names `next.config.*` may take. More than one on disk is ambiguous and is rejected. */
export const NEXT_CONFIG_FILENAMES = [
  'next.config.ts',
  'next.config.mjs',
  'next.config.js',
] as const;

/** The knob whose presence these gates refuse to interpret. */
export const PAGE_EXTENSIONS_KNOB = 'pageExtensions';

/**
 * The extensions this application serves a `route.<ext>` or `page.<ext>` file at.
 *
 * Every way this can fail to establish the real set throws: no config, more than one config, or a
 * config that mentions the knob at all. It is deliberately *not* an import of the config — see the
 * header of `tests/route-inventory.test.ts` — so the set it returns is the documented default,
 * guarded by the assertion that the application has not moved off it.
 *
 * It decides both inventories, because Next.js resolves `page.<ext>` from the same setting it
 * resolves `route.<ext>` from. A screen inventory reading a different set from the route inventory
 * would be two answers to one question.
 */
export function pageExtensions(): ReadonlySet<string> {
  const present = NEXT_CONFIG_FILENAMES.map((name) => path.join(WEB_DIR, name)).filter((file) =>
    existsSync(file),
  );
  if (present.length === 0) {
    throw new Error(
      `apps/web has none of ${NEXT_CONFIG_FILENAMES.join(', ')}; this gate cannot establish which ` +
        `route.<ext> files Next.js serves, so it must not report a surface.`,
    );
  }
  if (present.length > 1) {
    throw new Error(
      `apps/web has more than one Next config (${present
        .map((file) => path.basename(file))
        .join(', ')}); which one Next loads is not something this gate may guess.`,
    );
  }
  const configFile = present[0] as string;
  const source = readFileSync(configFile, 'utf8');
  if (source.includes(PAGE_EXTENSIONS_KNOB)) {
    throw new Error(
      `${path.basename(configFile)} mentions ${PAGE_EXTENSIONS_KNOB}. This gate does not read that ` +
        `setting — it asserts it is unset and uses Next's documented default ` +
        `(${DEFAULT_PAGE_EXTENSIONS.join(', ')}). Whoever set it must teach this gate the new set ` +
        `and say how it was established; until then the gate cannot tell which route.<ext> files ` +
        `Next.js serves and refuses to report a surface.`,
    );
  }
  return new Set(DEFAULT_PAGE_EXTENSIONS);
}

// ── The tracked tree ────────────────────────────────────────────────────────────────────────

/**
 * The tracked files under one repo-relative prefix.
 *
 * Throws rather than returning an empty list: every assertion either inventory makes is quantified
 * over one of these lists, and an empty one satisfies them vacuously. A gate that cannot run must
 * fail (ADR-0015). It is `git ls-files` rather than a directory walk for the reason
 * `docs/adr/W0-INF-02-probe-set-derived-from-the-tracked-tree.md` gives, and for the second reason
 * `tests/route-inventory.test.ts`'s header gives: a sibling test writes a real route handler into
 * the working tree while this one runs, and a file that is not committed is a file this repository
 * does not ship.
 */
export function trackedFiles(prefix: string): string[] {
  const stdout = execFileSync('git', ['ls-files', '-z', '--', prefix], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const files = stdout
    .split('\0')
    .filter((f) => f.length > 0)
    .map((f) => f.split(path.sep).join('/'));
  if (files.length === 0) {
    throw new Error(
      `\`git ls-files -- ${prefix}\` returned nothing, so this gate has no tree to read. It must ` +
        `fail rather than report an empty inventory.`,
    );
  }
  return files;
}

// ── The specification's sections ────────────────────────────────────────────────────────────

/**
 * Every section number `docs/spec.md` actually prints as a heading — `34`, `19.5`, `20.6`.
 *
 * This is what makes a `mandate` citation checkable rather than decorative
 * ([ADR-0026](../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2: *"fails if the cited section does not exist in `docs/spec.md`, checked by parsing the
 * headings, so a citation cannot be invented"*). Both heading forms the specification uses are
 * matched — `# 34. API Design` and `# 19.5 Home — One General Chat Screen` — and an empty result
 * throws, because a citation checked against an empty set is a citation that is never wrong.
 */
export function specSections(): ReadonlySet<string> {
  const spec = readFileSync(SPEC_PATH, 'utf8');
  const sections = new Set<string>();
  const heading = /^#\s+(\d+(?:\.\d+)*)\.?\s+\S/gm;
  for (;;) {
    const match = heading.exec(spec);
    if (match === null) break;
    sections.add(match[1] as string);
  }
  if (sections.size === 0) {
    throw new Error(
      `docs/spec.md yielded no numbered headings, so no mandate citation could ever be wrong. ` +
        `The heading parser and the specification disagree.`,
    );
  }
  return sections;
}

// ── What a declaration file declares ────────────────────────────────────────────────────────

/** The methods Next.js recognises in a route handler. Anything else exported is not a route. */
export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * The citation a route spec §34 does not print must carry (ADR-0026 decision 2).
 *
 * `section` is the section number as `docs/spec.md` prints it — `16`, `22`, `20.6` — and is checked
 * against {@link specSections}, so it cannot be invented. `because` is the sentence that requires
 * the capability, in one line, for the reader who wants to know without opening the spec.
 */
export interface RouteMandate {
  readonly section: string;
  readonly because: string;
}

/**
 * One route, declared by the task that owns the file implementing it.
 *
 * The annotation is not decoration: an entry with a misspelt field fails `pnpm typecheck` in the
 * declaring task's own PR, before the gate is reached. The gate re-checks every field anyway,
 * because it reads these files as text and a type annotation is not evidence about what is in the
 * tracked tree.
 */
export interface RouteDeclaration {
  readonly method: HttpMethod;
  /** The path in the specification's own notation: `:id`, not `[id]`. */
  readonly path: string;
  /** The task that owns the file implementing it. Must equal the declaration file's stem. */
  readonly owner: string;
  /** `true` once the route file exists in the tracked tree. */
  readonly landed: boolean;
  /** Required if and only if spec §34 does not print this `METHOD /path` — ADR-0026. */
  readonly mandate?: RouteMandate;
}

/**
 * One `ui/*.html` mockup, and what this repository has done about it.
 *
 * `status` is the whole of the distinction plan §9.1 asks for — *"every `ui/*.html` page has a
 * route"* — held open honestly. There are four values, no default, and no fall-through, so a mockup
 * nobody has decided about fails the gate rather than passing quietly:
 *
 *   * `shipped` — a page serves it now. Names the page file and the URL, and both are checked
 *     against the tracked tree.
 *   * `planned` — a task card in the development plan names this mockup, in a wave that has
 *     not run. Names the wave and quotes the card.
 *   * `unplanned` — no task card in the plan names this mockup. This is a *finding*, recorded where
 *     a reader will trip over it, and it is deliberately not the same value as `planned`: a wave
 *     number nobody has committed to would be a measured claim with no measurement behind it
 *     ([ADR-0016](../docs/adr/0016-measured-numbers-do-not-live-in-prose.md)).
 *   * `not-a-screen` — the file is in `ui/` but is not a product screen: the mockup index, and the
 *     marketing site the plan tracks separately. Checked against the plan like the two above:
 *     `scheduleFaults` reports it when a wave section schedules a screen from the file, because a
 *     task card that builds a screen from a mockup is the plan calling it one.
 */
export interface ScreenDeclaration {
  /** The mockup's tracked path, e.g. `ui/files.html`. */
  readonly mockup: string;
  readonly owner: string;
  readonly status: 'shipped' | 'planned' | 'unplanned' | 'not-a-screen';
  /** `shipped` only: the URL path the screen is served at, e.g. `/agents/new`. */
  readonly route?: string;
  /** `shipped` only: the tracked page file that serves it. */
  readonly page?: string;
  /** `planned` only: the wave that will build it, e.g. `W5`. */
  readonly wave?: string;
  /** Everything but `shipped`: the evidence, in one line. */
  readonly because?: string;
}

// ── App-directory paths ─────────────────────────────────────────────────────────────────────

/**
 * Does Next.js serve nothing at all beneath this path?
 *
 * A folder whose name begins `_` is private: Next serves no route handler and no page from under
 * it. Both halves are established by experiment against this repository's pinned Next, not
 * inherited. W1-INT-02 ran the route half: a `route.ts` under `app/api/_hidden/leak/` leaves
 * `AppRouteHandlerRoutes` unchanged. W2-INT-00 ran the page half when it applied this rule to pages
 * — `app/_wip/page.tsx` and `app/typegenprobe/page.tsx` planted together, and `next typegen` emitted
 * `type AppRoutes = "/" | "/agents" | "/agents/new" | "/signin" | "/typegenprobe"`, with no `/_wip`.
 *
 * It lives here rather than in either gate because both gates ask it of the same tree, and two
 * answers to one question is one answer too many: while the route inventory skipped these folders
 * and the screen inventory did not, a `page.tsx` under `app/_wip/` was required to be declared as a
 * screen served at a URL Next.js serves nothing from.
 *
 * @param segments the file's path segments relative to {@link APP_PREFIX}, the file name last.
 */
export function underPrivateFolder(segments: readonly string[]): boolean {
  return segments.slice(0, -1).some((segment) => segment.startsWith('_'));
}

/**
 * Classify one file sitting in the app directory as a page.
 *
 * The twin of `classifyAppFile` in `tests/route-inventory.test.ts`, and total in the same way: the
 * fall-through rejects. `page` means Next serves it as a screen; `ignore` means the name has
 * nothing to do with pages (`route.ts`, `layout.tsx`, `globals.css`); anything named
 * `page.something-else` throws, because a reader that skipped it would be deciding "this is not a
 * screen" from the absence of a match. A filter here — which is what this used to be — drops what
 * it does not match and leaves the gate green (ADR-0027 §3), so a `page.mdx` was invisible to the
 * screen inventory rather than refused by it.
 */
export function classifyPageFile(
  name: string,
  extensions: ReadonlySet<string>,
  file: string,
): 'page' | 'ignore' {
  const prefix = 'page.';
  if (!name.startsWith(prefix)) return 'ignore';
  const extension = name.slice(prefix.length);
  if (extensions.has(extension)) return 'page';
  throw new Error(
    `${file}: this file is named "${name}", but "${extension}" is not one of the pageExtensions ` +
      `this application configures (${[...extensions].sort().join(', ')}). The screen inventory ` +
      `cannot tell whether Next.js serves it as a screen. If it does, the config and this gate ` +
      `disagree; if it does not, rename the file so it is not called page.*.`,
  );
}

/**
 * Reduce a list of repo-relative paths to the ones Next.js serves as pages.
 *
 * Pure, so a proof can hand it a file that is not on disk. The same two rules `filterRouteFiles`
 * applies to route handlers, applied to pages by the same code: a path segment beginning `_` means
 * Next serves nothing beneath it, and the file name is put through {@link classifyPageFile}, which
 * throws rather than skipping what it cannot decide.
 */
export function filterPageFiles(
  paths: readonly string[],
  extensions: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const file of paths) {
    if (!file.startsWith(`${APP_PREFIX}/`)) continue;
    const segments = file.slice(APP_PREFIX.length + 1).split('/');
    const name = segments[segments.length - 1] ?? '';
    if (underPrivateFolder(segments)) continue;
    if (classifyPageFile(name, extensions, file) === 'ignore') continue;
    out.push(file);
  }
  return out.sort();
}

/**
 * Turn one Next.js app-directory segment into its URL equivalent.
 *
 * Total by construction. Every segment shape Next.js gives meaning to is either mapped or
 * rejected by name; nothing falls through to "treat it as a literal", because a parallel route
 * (`@slot`) or a catch-all (`[...rest]`) silently treated as a literal segment would put an entry
 * into an inventory under a path that does not exist, and the equality assertions would then be
 * comparing fiction.
 *
 * Both inventories go through it: a route handler's directory and a page's directory are the same
 * grammar, and answering the question twice would be answering it twice differently one day.
 */
export function mapSegment(
  segment: string,
  file: string,
): { kind: 'path'; value: string } | { kind: 'drop' } {
  if (segment.startsWith('(') && segment.endsWith(')')) return { kind: 'drop' }; // route group
  if (segment.startsWith('@')) {
    throw new Error(`${file}: parallel routes (@${segment.slice(1)}) are not read by this gate.`);
  }
  if (segment.startsWith('[[') && segment.endsWith(']]')) {
    throw new Error(`${file}: optional catch-all segments are not read by this gate.`);
  }
  if (segment.startsWith('[...') && segment.endsWith(']')) {
    throw new Error(`${file}: catch-all segments are not read by this gate.`);
  }
  if (segment.startsWith('[') && segment.endsWith(']')) {
    const name = segment.slice(1, -1);
    if (name === '' || /[[\]().@]/.test(name)) {
      throw new Error(`${file}: "${segment}" is not a dynamic segment this inventory can read.`);
    }
    return { kind: 'path', value: `:${name}` };
  }
  if (/^[A-Za-z0-9._-]+$/.test(segment)) return { kind: 'path', value: segment };
  throw new Error(`${file}: "${segment}" is not a segment shape this inventory can read.`);
}

/** The URL path a `route.<ext>` or `page.<ext>` file serves, in the specification's notation. */
export function urlPathOf(relativeDir: string, file: string): string {
  const segments = relativeDir.split('/').filter((s) => s !== '' && s !== '.');
  const mapped: string[] = [];
  for (const segment of segments) {
    const result = mapSegment(segment, file);
    if (result.kind === 'path') mapped.push(result.value);
  }
  return `/${mapped.join('/')}`;
}

// ── The declaration files ───────────────────────────────────────────────────────────────────

/**
 * A task id, and therefore a legal declaration filename stem.
 *
 * Positive: at least two dash-separated alphanumeric parts, first part starting with a letter —
 * `W1-CP-04`, `W2-INT-00`, `W2-UI-08`. A `types.ts`, a `README.ts` or an `index.ts` in a
 * declaration directory fails, because the directory's whole contract is "one file per owning
 * task" and a file that is not a task's is a file the union would silently absorb.
 */
const TASK_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;

/** One declaration file, read. */
export interface DeclarationFile {
  /** Repo-relative and forward-slashed, e.g. `tests/route-declarations/W1-CP-05.ts`. */
  readonly repoPath: string;
  /** The task that owns it — the filename stem, which is also what every entry must name. */
  readonly owner: string;
  /** The raw entries, still unvalidated: each gate decides what a legal entry of its kind is. */
  readonly entries: readonly Record<string, unknown>[];
}

/**
 * The task a tracked path under a declaration directory speaks for — or a hard failure naming it.
 *
 * This is the *shape rule* of ADR-0027 §1: a declaration directory holds one `<TASK-ID>.ts` per
 * owning task and nothing else, so the contributing set of either inventory is
 * `git ls-files -- <dir>` put through this classifier, never a literal list of member paths. A
 * literal is what ADR-0025 was written to remove — five of Wave 2b's six tracks add
 * `tests/route-declarations/<TASK-ID>.ts`, a file outside every one of their `Owns` globs, and a
 * gate that enumerated its own inputs by hand would be red on every one of those branches with no
 * branch able to turn it green.
 *
 * Total, and the fall-through rejects (ADR-0027 §2). A path in the right directory with the wrong
 * shape — a `README.md`, a `types.ts`, a file in a subdirectory — is a failure naming the file,
 * never a skip: the directory's whole contract is "one file per owning task", and a file that is
 * not a task's is a file the union would otherwise silently absorb or silently drop.
 */
export function declarationOwner(repoPath: string, dirPrefix: string): string {
  if (!repoPath.startsWith(`${dirPrefix}/`)) {
    throw new Error(
      `${repoPath}: this path is not under ${dirPrefix}/, so it declares nothing this reader may ` +
        `attribute to a task.`,
    );
  }
  const rest = repoPath.slice(dirPrefix.length + 1);
  if (rest.includes('/')) {
    throw new Error(
      `${repoPath}: ${dirPrefix} is one flat directory of <TASK-ID>.ts files (ADR-0025 §1). A ` +
        `declaration in a subdirectory is one this gate's enumeration would not attribute to any ` +
        `task, so it is refused rather than skipped.`,
    );
  }
  if (!rest.endsWith('.ts')) {
    throw new Error(
      `${repoPath}: ${dirPrefix} holds one TypeScript declaration file per owning task and ` +
        `nothing else. This reader will not decide what a "${rest}" contributes.`,
    );
  }
  const owner = rest.slice(0, -'.ts'.length);
  if (!TASK_ID.test(owner)) {
    throw new Error(
      `${repoPath}: "${owner}" is not a task id, and a declaration file is named for the task ` +
        `that owns it (ADR-0025 §1). Rename it to <TASK-ID>.ts or delete it.`,
    );
  }
  return owner;
}

/**
 * The declaration files the tracked tree holds under `dirPrefix`, derived a second time.
 *
 * Each gate asserts that what it read equals this, which is the ADR-0027 §1 replacement for the
 * literal list of member paths that used to sit in both gates. It is derived from a **wider**
 * pathspec than {@link readDeclarationFiles} enumerates with, because the failure the assertion
 * exists to catch is the enumerating call itself going narrow: a `git ls-files` that returned a
 * shorter list would satisfy every assertion in either gate by having nothing left to compare.
 *
 * The location rule selects the partition; the filename rule is {@link declarationOwner}, which
 * throws. A regex used to *filter* this listing would drop what it did not match and leave the gate
 * green — the difference is one `else` (ADR-0027 §3).
 */
export function declarationPaths(dirPrefix: string, widerPrefix: string): string[] {
  const inside = trackedFiles(widerPrefix).filter((file) => file.startsWith(`${dirPrefix}/`));
  if (inside.length === 0) {
    throw new Error(
      `\`git ls-files -- ${widerPrefix}\` tracks nothing under ${dirPrefix}/, so this gate has no ` +
        `declarations to read and must fail rather than report an empty inventory.`,
    );
  }
  for (const repoPath of inside) declarationOwner(repoPath, dirPrefix);
  return [...inside].sort();
}

/** Read one string literal starting at `start`; returns the value and the index just past it. */
function readString(text: string, start: number, file: string): [string, number] {
  const quote = text[start] as string;
  let out = '';
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '\\') {
      const escaped = text[i + 1];
      if (escaped === undefined) break;
      const simple: Record<string, string> = {
        '\\': '\\',
        "'": "'",
        '"': '"',
        n: '\n',
        t: '\t',
        r: '\r',
      };
      const value = simple[escaped];
      if (value === undefined) {
        throw new Error(
          `${file}: the escape "\\${escaped}" is not one this reader understands. A declaration ` +
            `file's strings may use \\\\ \\' \\" \\n \\t \\r and nothing else.`,
        );
      }
      out += value;
      i += 2;
      continue;
    }
    if (ch === quote) return [out, i + 1];
    if (ch === '\n') break;
    out += ch;
    i += 1;
  }
  throw new Error(`${file}: a string literal is not closed before the end of the line or file.`);
}

/**
 * Rewrite one TypeScript array literal of plain data as JSON.
 *
 * Total, and the fall-through rejects. It understands: whitespace, `//` and block comments,
 * single- and double-quoted strings, the six structural characters, numbers, `true`/`false`/`null`,
 * bare property keys, and trailing commas. Anything else — an identifier that is not a key or a
 * keyword, a template literal, a spread, a function call, an arithmetic expression — throws with
 * the construct named. A declaration file is data, and a reader that guessed at an expression
 * would be inventing routes.
 */
export function declarationArrayToJson(text: string, file: string): string {
  const out: string[] = [];
  const dropTrailingComma = (): void => {
    if (out[out.length - 1] === ',') out.pop();
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error(`${file}: a block comment is not closed.`);
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const [value, next] = readString(text, i, file);
      out.push(JSON.stringify(value));
      i = next;
      continue;
    }
    if (ch === '`') {
      throw new Error(
        `${file}: template literals are not readable by this reader; a declaration file is data. ` +
          `Use a quoted string.`,
      );
    }
    if (ch === '}' || ch === ']') {
      dropTrailingComma();
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === ':' || ch === ',') {
      out.push(ch);
      i += 1;
      continue;
    }
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i));
    if (word !== null) {
      const name = word[0];
      const rest = text.slice(i + name.length);
      if (/^\s*:/.test(rest)) {
        out.push(JSON.stringify(name));
        i += name.length;
        continue;
      }
      if (name === 'true' || name === 'false' || name === 'null') {
        out.push(name);
        i += name.length;
        continue;
      }
      throw new Error(
        `${file}: "${name}" is not a value this reader can read. A declaration file holds data ` +
          `only — quoted strings, numbers, true, false, null, objects and arrays.`,
      );
    }
    const number = /^-?\d+(?:\.\d+)?/.exec(text.slice(i));
    if (number !== null) {
      out.push(number[0]);
      i += number[0].length;
      continue;
    }
    throw new Error(
      `${file}: ${JSON.stringify(ch)} is not part of any construct this reader understands, so the ` +
        `declaration cannot be read. It must fail rather than contribute nothing.`,
    );
  }
  return out.join('');
}

/**
 * The array a declaration file exports under `exportName`, or a hard failure.
 *
 * ADR-0025 §3: *"a declaration file that exports nothing readable is a **hard failure**, not an
 * empty contribution — an unreadable declaration is not an absence of routes"*. Four ways to
 * export nothing readable, and each throws with the file named: no `export const <name> = [` at
 * all, an unbalanced array literal, a body this reader cannot parse, and an array with no entries.
 */
export function readDeclarationArray(
  source: string,
  file: string,
  exportName: string,
): readonly Record<string, unknown>[] {
  const opening = new RegExp(`export\\s+const\\s+${exportName}\\b[^=;]*=\\s*\\[`).exec(source);
  if (opening === null) {
    throw new Error(
      `${file}: this declaration file exports no readable "${exportName}" array. An unreadable ` +
        `declaration is not an absence of entries (ADR-0025 §3), so the inventory refuses to run ` +
        `rather than treat it as an empty contribution. Write ` +
        `"export const ${exportName} = [ … ];".`,
    );
  }
  const open = opening.index + opening[0].length - 1;
  let depth = 0;
  let end = -1;
  let quote = '';
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i] as string;
    if (quote !== '') {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    // Comments are skipped before quotes are noticed, because a comment is prose and prose holds
    // apostrophes. A scanner that read the `'` in "W2-plan.md's" as an opening quote ran to the end
    // of the file looking for its partner and reported an array that is never closed — which is a
    // true sentence about the wrong thing, and the kind of message that costs an afternoon.
    if (ch === '/' && source[i + 1] === '/') {
      const lineEnd = source.indexOf('\n', i);
      i = lineEnd === -1 ? source.length : lineEnd;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const blockEnd = source.indexOf('*/', i + 2);
      if (blockEnd === -1) break;
      i = blockEnd + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error(
      `${file}: the "${exportName}" array literal is never closed, so this reader cannot tell what ` +
        `it declares.`,
    );
  }
  const json = declarationArrayToJson(source.slice(open, end), file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(
      `${file}: the "${exportName}" array was read but is not well-formed data ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${file}: "${exportName}" is not an array.`);
  }
  const entries: Record<string, unknown>[] = [];
  for (const raw of parsed as unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`${file}: every "${exportName}" entry must be an object; got ${typeof raw}.`);
    }
    entries.push(raw as Record<string, unknown>);
  }
  if (entries.length === 0) {
    throw new Error(
      `${file}: this declaration file declares no entries. A task with nothing to declare has no ` +
        `declaration file; an empty one is indistinguishable from one whose contents were lost.`,
    );
  }
  return entries;
}

/**
 * Every tracked declaration file under one directory, read.
 *
 * The union ADR-0025 §2 describes: enumerated with `git ls-files`, so an untracked file in a
 * working tree contributes nothing and a tracked one always does. Every file in the directory is
 * put through {@link declarationOwner} — the one shape rule, which throws rather than skipping —
 * and each gate asserts that this enumeration equals {@link declarationPaths}, the same rule
 * applied to a wider pathspec.
 */
export function readDeclarationFiles(dirPrefix: string, exportName: string): DeclarationFile[] {
  const files = trackedFiles(dirPrefix);
  const out: DeclarationFile[] = [];
  for (const repoPath of files) {
    const owner = declarationOwner(repoPath, dirPrefix);
    const absolute = path.join(REPO_ROOT, repoPath);
    if (!existsSync(absolute)) {
      throw new Error(
        `${repoPath} is tracked by git but absent from the working tree, so this gate could not ` +
          `read the entries it declares.`,
      );
    }
    out.push({
      repoPath,
      owner,
      entries: readDeclarationArray(readFileSync(absolute, 'utf8'), repoPath, exportName),
    });
  }
  return out.sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

// ── Field validation, shared by both kinds of entry ─────────────────────────────────────────

/** The value of `field`, asserted to be a non-empty string. Throws with the entry named. */
export function requireString(
  entry: Record<string, unknown>,
  field: string,
  where: string,
): string {
  const value = entry[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `${where}: "${field}" must be a non-empty string; got ${JSON.stringify(value)}. A field that ` +
        `is absent is not a field that is satisfied.`,
    );
  }
  return value;
}

/** The value of `field`, asserted to be a boolean. Throws with the entry named. */
export function requireBoolean(
  entry: Record<string, unknown>,
  field: string,
  where: string,
): boolean {
  const value = entry[field];
  if (typeof value !== 'boolean') {
    throw new Error(`${where}: "${field}" must be true or false; got ${JSON.stringify(value)}.`);
  }
  return value;
}

/** Every key of `entry` that `allowed` does not name. A declaration may not carry a field nobody reads. */
export function unknownFields(
  entry: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  return Object.keys(entry)
    .filter((key) => !allowed.includes(key))
    .sort();
}

// ── The "this gate plants nothing" assertion ────────────────────────────────────────────────

/**
 * Every module a gate loads, as repo-relative forward-slashed paths, found by following relative
 * import specifiers out of `entry` until nothing new appears.
 *
 * ADR-0019 §4's promise is about the code that runs, and the code that runs is the gate's module
 * graph. Round 2 wrote that graph down instead — a two-element array of paths next to the
 * assertion — which is the literal list of member paths ADR-0027 §1 forbids by name, and a
 * verifier walked out of it: a tracked `tests/inventory-extra.ts` holding a `mkdirSync` call,
 * imported from this file, left both gates at 61 passed. The list is a traversal now, so a helper
 * module is inside the promise the moment a gate imports it.
 *
 * Fails closed twice. A specifier that resolves to no file on disk throws rather than being
 * dropped, because a module reference this reader cannot follow is one it cannot vouch for. And
 * only relative specifiers are followed: a package specifier names no file in this repository, and
 * the one package that matters here is decided by {@link nonReadingFsAccess} instead.
 */
export function gateModules(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    if (seen.has(current)) continue;
    const absolute = path.join(REPO_ROOT, current);
    if (!existsSync(absolute)) {
      throw new Error(
        `${current}: this gate's import graph names a module that is not on disk, so the ` +
          `"writes nothing into the tree" assertion cannot cover it.`,
      );
    }
    seen.add(current);
    const source = readFileSync(absolute, 'utf8');
    for (const specifier of relativeSpecifiers(source)) {
      pending.push(resolveSpecifier(current, specifier));
    }
  }
  return [...seen].sort();
}

/**
 * Every relative module specifier a source file names — the `from` form, the bare one, and the
 * resolver-call form.
 *
 * The first two are anchored at a line-start `import` or `export`, and bounded: the text between
 * the keyword and the `from` may hold only what an import clause holds — no quote, no semicolon —
 * so a match cannot cross out of one statement into a later line. Both bounds are load-bearing.
 * These gates carry fixture strings that spell a module reference, to prove the readers below
 * reject one, and an unanchored scan read such a fixture as an import of a module that is not on
 * disk and threw; an anchored but unbounded scan then reached the same fixture from an unrelated
 * import above it. The clause may still span lines, because a multi-line import is how both gates
 * spell their own.
 *
 * The third is neither anchored nor line-oriented, because a resolver call is an expression and
 * sits wherever an expression may. A verifier reached a helper module through a top-level one of
 * those — a call form none of the anchored patterns is shaped to see — and its `mkdirSync` stayed
 * outside the ADR-0019 §4 scan while every gate was green. `tests/no-sdk-import.test.ts` refuses
 * any resolver call in the tracked tree whose argument is not a plain quoted string, so reading
 * the literal covers every such call this repository accepts at all.
 *
 * All three read either quoting. Prettier rewrites a double-quoted specifier and
 * `tests/sdk-surface.test.ts` fails a `tests/` tree it has not run over, which is why the verifier
 * could not land that variant; this reader is the wrong place to depend on that, and reading both
 * quotes is cheaper than the argument. Both forms were run against a planted
 * `tests/inventory-extra.ts`, and each now fails both gates by name.
 */
export function relativeSpecifiers(source: string): string[] {
  const out = new Set<string>();
  const fromClause = /^[ \t]*(?:import|export)\b[^;'"]*?\bfrom\s*(['"])(\.\.?\/[^'"\n]+)\1/gm;
  const bareImport = /^[ \t]*import\s*(['"])(\.\.?\/[^'"\n]+)\1/gm;
  // The call keywords are joined at run time for the reason the tables in
  // `tests/route-inventory.test.ts` and `tests/no-sdk-import.test.ts` are: this module is inside
  // both gates' own scans, and a pattern written whole is a call site to the reader in
  // `tests/no-sdk-import.test.ts`, which then reports a module reference it cannot resolve.
  const resolverCall = new RegExp(
    // Longest alternative first: with the bare keyword leading, a dotted resolver matches the
    // keyword and then fails on the `.` where the parenthesis was required, and the call is missed.
    `\\b(?:imp${'ort'}\\.meta\\.resolve|requ${'ire'}\\.resolve|imp${'ort'}|requ${'ire'})` +
      `\\s*\\(\\s*(['"])(\\.\\.?/[^'"\\n]+)\\1`,
    'g',
  );
  for (const pattern of [fromClause, bareImport, resolverCall]) {
    for (const match of source.matchAll(pattern)) out.add(match[2] as string);
  }
  return [...out];
}

/**
 * The repo-relative path one relative specifier names, or a throw.
 *
 * TypeScript's `NodeNext` resolution spells a sibling module `./x.js` while the file on disk is
 * `./x.ts`, so both are tried. Nothing else is guessed, and a specifier matching neither throws.
 */
function resolveSpecifier(from: string, specifier: string): string {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const candidates = joined.endsWith('.js') ? [`${joined.slice(0, -3)}.ts`, joined] : [joined];
  for (const candidate of candidates) {
    if (existsSync(path.join(REPO_ROOT, candidate))) return candidate;
  }
  throw new Error(
    `${from}: imports "${specifier}", which is none of ${candidates.join(', ')}. A module ` +
      `reference this reader cannot follow is one the ADR-0019 §4 scan cannot cover.`,
  );
}

/**
 * The `fs` bindings a gate may hold: the ones that only read.
 *
 * An allowlist, because the polarity is the whole point. Round 2 wrote the other one — seven
 * mutator verbs, the `Sync` spellings of write-file, mkdtemp, mkdir, rm, cp, rename and
 * append-file — and `unlinkSync` and `copyFileSync` sat outside it: a verifier put both in this
 * file and the two gates stayed at 61 passed. A name absent from the list below is reported
 * whether or not anyone has thought about it.
 */
const FS_READERS = new Set([
  'existsSync',
  'readFileSync',
  'readdirSync',
  'statSync',
  'lstatSync',
  'realpathSync',
  'accessSync',
]);

/** A static `import { … } from` the fs module — the only form this reader can decide. */
const STATIC_FS_IMPORT = /\bimport\s+(\{[^}]*\})\s+from\s+(['"])(?:node:)?fs(?:\/promises)?\2/g;
/** The same module named anywhere at all, in either quoting. */
const FS_SPECIFIER = /(['"])(?:node:)?fs(?:\/promises)?\1/g;

/**
 * Every way a source file reaches `fs` that is not a read.
 *
 * The Wave 1a race was `tests/route-inventory.test.ts` planting a fixture under `apps/web/app`
 * while a sibling walked it; ADR-0019 §4 made the repair structural, and this is the assertion that
 * keeps it structural across a refactor — including a refactor that moves the offending call into a
 * helper module, which is why both gates run it over every module {@link gateModules} finds.
 *
 * Two kinds of answer, and both are failures. A named binding {@link FS_READERS} does not carry is
 * reported by name. A mention of the module in any other position is reported as undecodable,
 * because this reader cannot tell what such a form binds; the four forms that reach it that way —
 * a namespace import, a re-export, a `require`, a dynamic import of the literal — are run as a
 * table in `tests/route-inventory.test.ts`. A reference whose specifier is *computed* is outside
 * this scan and inside `tests/no-sdk-import.test.ts`, which refuses any module reference in the
 * tracked tree that it cannot resolve to a string literal. Matching is over raw text, comments
 * included, which is the
 * over-eager direction `tests/no-sdk-import.test.ts` argues for: a false positive fails loudly and
 * is fixed by looking at the file, a false negative is a gate quietly writing into the tree.
 */
export function nonReadingFsAccess(source: string): string[] {
  const out = new Set<string>();
  const remainder = source.replace(STATIC_FS_IMPORT, (match: string, clause: string) => {
    for (const binding of clause.replace(/[{}]/g, '').split(',')) {
      const name = (binding.trim().split(/\s+as\s+/)[0] ?? '').trim();
      if (name !== '' && !FS_READERS.has(name)) out.add(name);
    }
    return ' '.repeat(match.length);
  });
  for (const match of remainder.matchAll(FS_SPECIFIER)) {
    out.add(`${match[0]} reached by a form this reader cannot decode`);
  }
  return [...out].sort();
}
