/**
 * The comparison half of `generate-api-reports.mjs --check`: which committed API reports differ
 * from the ones just rendered. Kept apart from the renderer so it can be tested on small trees,
 * without emitting declarations or running API Extractor (tests/docs/api-reports.test.ts); the
 * real tree is compared by `pnpm docs:check`.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** @param {string} directory @returns {Promise<string[]>} every file under it, relative, sorted */
export async function listFiles(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .map((file) => file.split(path.sep).join('/'))
    .sort();
}

/**
 * The reports that are stale: rendered but not committed, committed but no longer rendered, or
 * committed with content other than the normalised rendering.
 *
 * @param {{ rendered: string; committed: string; normalise: (text: string) => string; label: string }} input
 *   `rendered` and `committed` are directories; `label` is the repository path the committed
 *   reports live under, which each returned path is named by.
 * @returns {Promise<string[]>} `<label>/<file>` for every stale report, sorted
 */
export async function staleReports({ rendered, committed, normalise, label }) {
  const renderedFiles = await listFiles(rendered);
  const committedFiles = await listFiles(committed);
  const stale = [];
  for (const file of new Set([...renderedFiles, ...committedFiles])) {
    const want = renderedFiles.includes(file)
      ? normalise(await readFile(path.join(rendered, file), 'utf8'))
      : undefined;
    const have = committedFiles.includes(file)
      ? await readFile(path.join(committed, file), 'utf8')
      : undefined;
    if (want !== have) stale.push(`${label}/${file}`);
  }
  return stale.sort();
}
