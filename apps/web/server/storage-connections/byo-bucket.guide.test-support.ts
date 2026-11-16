/** The tutorial commands and fenced guide examples shared by all storage-provider lanes. */
import { readFileSync } from 'node:fs';

const GUIDE_URL = new URL(
  '../../../../docs/sdk/site/guides/storage-connections.mdx',
  import.meta.url,
);

/**
 * The guide's steps, in the order a reader runs them. `$STORAGE_URL`, `$AGENT_ID` and the
 * `.json` name are the lane's values.
 */
export const TUTORIAL = {
  create:
    'aw storage connections create --name acme-data --storage-url "$STORAGE_URL" --allow reports --credential-file credential.json',
  test: 'aw storage connections test acme-data',
  ls: 'aw storage ls acme-data/reports/',
  allowWrites: 'aw storage connections update acme-data --write-allowed',
  grant: "files('storage://acme-data/reports', 'read-write')",
  permissions: 'permissions: { readFiles: true, writeFiles: true },',
  push: 'aw push --yes',
  promote: 'aw promote --yes',
  run: 'aw runs start "$AGENT_ID" --prompt "Summarise the Q3 reports into summary.md"',
} as const;

/** `aw <line>` with the lane's values in place of the guide's placeholders. */
export const argvOf = (line: string, values: Readonly<Record<string, string>>): string[] =>
  Array.from(line.matchAll(/"([^"]*)"|(\S+)/gu), (token) => token[1] ?? token[2] ?? '')
    .slice(1)
    .map((token) => values[token] ?? token);

/** The bodies of the guide's fenced code blocks, tabs included, in page order. */
export const guideCode = (): string =>
  Array.from(
    readFileSync(GUIDE_URL, 'utf8').matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gmu),
    (block) => block[1] ?? '',
  ).join('\n');

/** Every storage URL the guide's code blocks give `--storage-url`, directly or as `STORAGE_URL`. */
export const guideStorageUrls = (code: string): string[] =>
  Array.from(
    code.matchAll(/(?:--storage-url\s+|STORAGE_URL=)"?([^"\s$][^"\s]*)/gu),
    (url) => url[1] ?? '',
  );

export const queryNames = (url: string): string[] =>
  [...new URLSearchParams(url.split('?')[1] ?? '').keys()].sort();

export const CSV = 'quarter,total\nq3,42\n';
export const SUMMARY = '# Q3\nTotal: 42\n';
