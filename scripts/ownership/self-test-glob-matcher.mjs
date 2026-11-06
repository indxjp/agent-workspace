/* global console */
import { matchAny } from './globs.mjs';

/** @param {Pick<import('./types.mjs').SelfTestContext,'check'|'noRoot'|'m'>} context */
export function runGlobMatcherCases({ check, noRoot, m }) {
  console.log('glob matcher');

  check('** matches a nested file', m('.github/**', '.github/workflows/ci.yml'), true);

  check('** matches a direct child', m('.github/**', '.github/x.md'), true);

  check('** does not escape its prefix', m('.github/**', 'scripts/x.mjs'), false);

  check(
    'exact path matches itself',
    m('scripts/check-file-ownership.mjs', 'scripts/check-file-ownership.mjs'),
    true,
  );

  check(
    'exact path matches nothing else',
    m('scripts/check-file-ownership.mjs', 'scripts/check-licenses.mjs'),
    false,
  );

  check(
    '* stays inside one segment',
    m('packages/*/package.json', 'packages/core/package.json'),
    true,
  );

  check(
    '* does not cross a slash',
    m('packages/*/package.json', 'packages/core/src/package.json'),
    false,
  );

  check(
    '? matches exactly one character',
    m('apps/we?/next.config.ts', 'apps/web/next.config.ts'),
    true,
  );

  check(
    '? does not match two characters',
    m('apps/we?/next.config.ts', 'apps/webx/next.config.ts'),
    false,
  );

  check(
    '? does not match zero characters',
    m('apps/we?/next.config.ts', 'apps/we/next.config.ts'),
    false,
  );

  check('brace list, first branch', m('*.{json,mjs}', 'package.json'), true);

  check('brace list, second branch', m('*.{json,mjs}', 'eslint.config.mjs'), true);

  check('brace list rejects others', m('*.{json,mjs}', 'index.ts'), false);

  check('mid-path ** spans segments', m('apps/**/index.ts', 'apps/web/server/index.ts'), true);

  check('mid-path ** spans zero segments', m('apps/**/index.ts', 'apps/index.ts'), true);

  check('leading dot is literal', m('a.b/**', 'axb/c'), false);

  check(
    'matchAny over a glob list',
    matchAny(['.github/**', 'scripts/a.mjs'], 'scripts/a.mjs', noRoot),
    true,
  );
}
