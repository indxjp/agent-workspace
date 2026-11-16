// `renderTemplateDirectory` reads a template directory with `node:fs` (typed by `node-fs.d.ts`):
// `./project` is the Node-side subpath, used by aw and create, and this package carries no Node types.
import { readdirSync, readFileSync, statSync } from 'node:fs';

import { ProjectRenderError } from './errors.js';

/** One file of a rendered project: its path relative to the project root, and its text. */
export interface ProjectFile {
  readonly path: string;
  readonly contents: string;
}

/** A placeholder in a template file's text: `{{key}}`, the key a letter then letters or digits. */
const TEXT_PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/gu;

/** The suffix that keeps a template file inert in the repository; it is dropped from the path. */
const INERT_SUFFIX = /\.template\.txt$/u;

/**
 * Renders a directory of real files with placeholders into project files (issue #1488): every
 * file under `root`, recursively, sorted by path. `{{key}}` in a file's text and `__key__` in its
 * path become `values[key]`; a trailing `.template.txt` is dropped from the path (the file stays
 * inert in the repository); a `README.md`'s file maps are re-aligned after the substitution.
 * Nothing else is changed.
 *
 * `aw init` and `create` render their setup starters through this, so identical values give
 * identical files.
 *
 * @param root - The template directory, a `file:` URL ending in `/`.
 * @param values - The value of each placeholder key.
 * @param subject - What is rendered, named in a refusal (for example `the project`).
 * @param options - `optional`: a missing `root` renders no files instead of throwing.
 *   `missingMessage`: the refusal message for a key the template uses but `values` lacks.
 * @returns The rendered files, frozen.
 * @throws {ProjectRenderError} when a file uses a `{{key}}` that `values` has no value for: the
 *   issue's path is the key.
 * @throws The file-system error when `root` cannot be read (a missing `root` only without
 *   `optional`).
 */
export function renderTemplateDirectory(
  root: URL,
  values: Readonly<Record<string, string>>,
  subject: string,
  options: {
    readonly optional?: boolean;
    readonly missingMessage?: (key: string) => string;
  } = {},
): readonly ProjectFile[] {
  let paths: string[];
  try {
    paths = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((path) => path.replaceAll('\\', '/'))
      .filter((path) => statSync(new URL(path, root)).isFile())
      .sort();
  } catch (error) {
    if (options.optional === true && (error as { readonly code?: unknown }).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const missingMessage = options.missingMessage ?? (() => 'is required: the template uses it');
  const files = paths.map((path) => {
    const text = readFileSync(new URL(path, root), 'utf8');
    const contents = text.replace(TEXT_PLACEHOLDER, (_placeholder, key: string) => {
      const value = Object.hasOwn(values, key) ? values[key] : undefined;
      if (value === undefined) {
        throw new ProjectRenderError(subject, [{ path: key, message: missingMessage(key) }]);
      }
      return value;
    });
    return Object.freeze({
      path: renderedPath(path, values),
      contents: path.endsWith('README.md') ? alignFileMaps(contents) : contents,
    });
  });
  return Object.freeze(files);
}

/** A template file's project path: each `__key__` replaced, the inert suffix dropped. */
function renderedPath(path: string, values: Readonly<Record<string, string>>): string {
  let rendered = path;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`__${key}__`, value);
  }
  return rendered.replace(INERT_SUFFIX, '');
}

/**
 * A README's file map (a `text` block of `path   description` rows) is aligned for the
 * `{{agentName}}` placeholder; once the name replaces it, the descriptions are re-padded so they
 * start in one column again (BH061-075).
 */
function alignFileMaps(text: string): string {
  return text.replace(
    /(```text\n)([\s\S]*?)(```)/gu,
    (_block, open: string, body: string, close: string) => {
      const lines = body.split('\n');
      const rows = lines.map((line) => /^(\S+) +(\S.*)$/u.exec(line));
      const width = Math.max(0, ...rows.map((row) => (row?.[1]?.length ?? 0) + 2));
      const aligned = lines.map((line, index) => {
        const row = rows[index];
        return row === null || row === undefined
          ? line
          : `${(row[1] ?? '').padEnd(width)}${row[2] ?? ''}`;
      });
      return `${open}${aligned.join('\n')}${close}`;
    },
  );
}

export function frozenFiles(files: readonly ProjectFile[]): readonly ProjectFile[] {
  return Object.freeze(files.map((file) => Object.freeze({ ...file })));
}
