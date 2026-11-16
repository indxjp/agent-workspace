/** @param {Pick<import('./types.mjs').SelfTestContext,'check'|'parses'>} context */
export function runMarkdownLabelsCases({ check, parses }) {
  // Markdown emphasis around the label. `**Owns globs**:` always worked; `**Owns globs:**` did
  // not — the closing run was captured as part of the first glob, producing a glob that matched
  // nothing and a failure that blamed the author's files.
  check(
    'a bold label with the colon inside is parsed',
    parses('## Ownership\n**Owns globs:** `docs/**`'),
    ['docs/**'],
  );

  check(
    'a bold label with the colon outside is parsed',
    parses('## Ownership\n**Owns globs**: `docs/**`'),
    ['docs/**'],
  );

  check('a bulleted bold label is parsed', parses('## Ownership\n- **Owns globs:** `docs/**`'), [
    'docs/**',
  ]);

  // ...and stripping it must never eat a leading `**` that is part of the glob.
  check(
    'a bold label does not swallow a leading ** glob',
    parses('## Ownership\n**Owns globs:** `apps/**`, `docs/**`'),
    ['apps/**', 'docs/**'],
  );

  check(
    'an unemphasised leading ** glob is untouched',
    parses('## Ownership\nOwns globs: `**/*.ts`'),
    ['**/*.ts'],
  );

  // The shipped template ships with a placeholder. Leaving it in is a fail either way, but it
  // must be reported as "you did not fill the template in", not as "your files are stolen".
  check(
    'an unfilled template placeholder is named as such',
    parses('## Ownership\nOwns globs: <globs from the task card>'),
    'REJECTED',
  );
}
