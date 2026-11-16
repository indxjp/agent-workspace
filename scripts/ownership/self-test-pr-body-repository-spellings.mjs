/** @param {Pick<import('./types.mjs').SelfTestContext,'check'|'parses'>} context */
export function runRepositorySpellingsCases({ check, parses }) {
  check('a bare ** declaration is refused', parses('## Ownership\nOwns globs: `**`'), 'REJECTED');

  check(
    'an unquoted ** declaration is refused',
    parses('## Ownership\nOwns globs: **'),
    'REJECTED',
  );

  check(
    'a ** hidden among real globs is refused',
    parses('## Ownership\nOwns globs: `.github/**`, `**`'),
    'REJECTED',
  );

  check(
    'the ./** and **/* spellings are refused too',
    parses('## Ownership\nOwns globs: `./**`, `**/*`'),
    'REJECTED',
  );

  check('a single * is refused', parses('## Ownership\nOwns globs: `*`'), 'REJECTED');

  check(
    'a legitimate ** suffix is still allowed',
    parses('## Ownership\nOwns globs: `.github/**`'),
    ['.github/**'],
  );

  // ROUND-2 FIXTURES — the whole-repo guard used to be a blacklist of spellings, so these two
  // synonyms walked straight through it while matchGlob resolved them as whole-repo claims.
  // `**/**` matches every path; `**/*.*` matches every path whose last segment contains a dot,
  // which is every tracked path here bar extensionless LICENSE — not literally every path, but
  // a file in every area of the tree, which is question (a) answered yes. The guard is now
  // semantic (ownsEverything), and these pin that it stays semantic.
  check('the **/** spelling is refused', parses('## Ownership\nOwns globs: `**/**`'), 'REJECTED');

  check('the **/*.* spelling is refused', parses('## Ownership\nOwns globs: `**/*.*`'), 'REJECTED');

  check(
    'the **/**/** spelling is refused',
    parses('## Ownership\nOwns globs: `**/**/**`'),
    'REJECTED',
  );

  check(
    'a **/** hidden among real globs is refused',
    parses('## Ownership\nOwns globs: `docs/**`, `**/**`'),
    'REJECTED',
  );

  // A brace list is one glob, so `**` can be hidden inside one. Splitting the line correctly
  // (splitTopLevel) is what lets ownsEverything see the `**` branch at all.
  // ROUND-3 FIXTURES — these two answer questions (a) and (b) NO, because no root probe
  // matches them, yet each owns every file in every subdirectory at any depth. The guard let
  // them through until question (c) was added. Question (c) is the narrow one: a `*/**`
  // declaration would still fail a diff that touches package.json, so it is not "no gate at
  // all" the way `**` is — it is an author owning everything but the root.
  check('the */** spelling is refused', parses('## Ownership\nOwns globs: `*/**`'), 'REJECTED');

  check(
    'the **/*/** spelling is refused',
    parses('## Ownership\nOwns globs: `**/*/**`'),
    'REJECTED',
  );

  check(
    'a ** hidden inside a brace list is refused',
    parses('## Ownership\nOwns globs: `{**,docs}`'),
    'REJECTED',
  );

  check(
    'a ** branch beside a real one is refused',
    parses('## Ownership\nOwns globs: `{docs,**}/**`'),
    'REJECTED',
  );
}
