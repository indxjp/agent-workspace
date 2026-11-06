/** @param {Pick<import('./types.mjs').SelfTestContext,'check'|'parses'|'body'>} context */
export function runSectionsCases({ check, parses, body }) {
  check('globs read from the Ownership section', parses(body), [
    '.github/**',
    'scripts/check-file-ownership.mjs',
  ]);

  check('a body without the section is rejected', parses('## Task\nW0-INF-02'), 'REJECTED');

  check(
    'an Owns line in another section is ignored',
    parses('## Task\nOwns globs: `**`'),
    'REJECTED',
  );

  check(
    '"none" is an empty declaration, not a missing one',
    parses('## Ownership\nOwns globs: none'),
    [],
  );

  check(
    'the section ends at the next heading',
    parses('## Ownership\nOwns globs: `docs/**`\n\n## Declared gaps\nOwns globs: `**`'),
    ['docs/**'],
  );
}
