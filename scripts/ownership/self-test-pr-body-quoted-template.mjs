/** @param {Pick<import('./types.mjs').SelfTestContext,'check'|'parses'>} context */
export function runQuotedTemplateCases({ check, parses }) {
  // THE BYPASS FIXTURE. Verified against a real GITHUB_EVENT_PATH payload before this
  // guard existed: the gate read the QUOTED `**` and passed every changed file. The plan
  // documents quote the ownership template in exactly this shape, so any author who
  // copies it into their PR body reproduces it. This must never regress.
  const quotedTemplate = [
    'The Ownership section of CONTRIBUTING.md says a PR body must look like this:',
    '',
    '```markdown',
    '## Ownership',
    'Owns globs: `**`',
    'Files touched outside Owns: none',
    '```',
    '',
    '## Ownership',
    'Owns globs: `.github/**`',
    'Files touched outside Owns: none',
    '',
    '## Declared gaps',
    'None.',
  ].join('\n');

  check('a fenced quote of the template cannot supply the globs', parses(quotedTemplate), [
    '.github/**',
  ]);

  check('a tilde-fenced quote is stripped too', parses(quotedTemplate.replace(/```/g, '~~~~')), [
    '.github/**',
  ]);

  check(
    'an indented quote is stripped too',
    parses(
      [
        '    ## Ownership',
        '    Owns globs: `**`',
        '',
        '## Ownership',
        'Owns globs: `apps/web/**`',
      ].join('\n'),
    ),
    ['apps/web/**'],
  );

  check(
    'a body whose ONLY Ownership section is fenced is rejected',
    parses(['```markdown', '## Ownership', 'Owns globs: `**`', '```'].join('\n')),
    'REJECTED',
  );

  check(
    'an unterminated fence fails closed',
    parses(['```markdown', '## Ownership', 'Owns globs: `**`'].join('\n')),
    'REJECTED',
  );
  return { quotedTemplate };
}
