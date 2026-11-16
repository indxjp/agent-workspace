/** @param {Pick<import('./types.mjs').SelfTestContext,'check'|'parses'>} context */
export function runAmbiguityCases({ check, parses }) {
  check(
    'two real Ownership sections are ambiguous, not first-wins',
    parses('## Ownership\nOwns globs: `**`\n\n## Ownership\nOwns globs: `.github/**`'),
    'REJECTED',
  );

  check(
    'two Owns lines in one section are ambiguous',
    parses('## Ownership\nOwns globs: `**`\nOwns globs: `.github/**`'),
    'REJECTED',
  );

  check(
    'a section with no Owns line is rejected',
    parses('## Ownership\nFiles touched outside Owns: none'),
    'REJECTED',
  );
}
