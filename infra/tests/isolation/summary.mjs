/**
 * Merge the per-lane result files into one `check | docker | kind` Markdown table.
 *
 *   node summary.mjs docker=results-docker.json kind=results-kind.json
 *
 * A lane whose file is absent or unreadable shows `missing`, never a pass. The exit code is 1 when
 * any cell is not pass, n/a or pending, so the summary job cannot read green over a red lane.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CLEAN = new Set(['pass', 'n/a', 'pending']);

function load(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed?.results === 'object' && parsed.results !== null ? parsed.results : undefined;
  } catch {
    return undefined;
  }
}

/** @param {Record<string, Record<string, { title: string; outcome: string }> | undefined>} lanes */
export function renderSummary(lanes) {
  const names = Object.keys(lanes);
  const checks = new Map();
  for (const results of Object.values(lanes)) {
    for (const [id, { title }] of Object.entries(results ?? {})) if (!checks.has(id)) checks.set(id, title);
  }
  let clean = true;
  const cell = (results, id) => {
    const outcome = results === undefined ? 'missing' : (results[id]?.outcome ?? 'missing');
    if (!CLEAN.has(outcome)) clean = false;
    return outcome;
  };
  const rows = [...checks].map(
    ([id, title]) => `| ${title} (\`${id}\`) | ${names.map((name) => cell(lanes[name], id)).join(' | ')} |`,
  );
  for (const name of names) if (lanes[name] === undefined) clean = false;
  const lines = [
    '| check | ' + names.join(' | ') + ' |',
    '| --- | ' + names.map(() => '---').join(' | ') + ' |',
    ...rows,
  ];
  return { markdown: `${lines.join('\n')}\n`, clean };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lanes = {};
  for (const argument of process.argv.slice(2)) {
    const [name, file] = argument.split('=');
    if (name === undefined || file === undefined) throw new Error(`expected lane=file, got ${argument}`);
    lanes[name] = load(file);
  }
  const { markdown, clean } = renderSummary(lanes);
  process.stdout.write(markdown);
  process.exitCode = clean ? 0 : 1;
}
