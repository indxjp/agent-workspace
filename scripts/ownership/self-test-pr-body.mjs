/* global console */
import { parseOwnership } from './body.mjs';
import { runAmbiguityCases } from './self-test-pr-body-ambiguity.mjs';
import { runAreaCoverageCases } from './self-test-pr-body-area-coverage.mjs';
import { runGlobNotationCases } from './self-test-pr-body-glob-notation.mjs';
import { runMarkdownLabelsCases } from './self-test-pr-body-markdown-labels.mjs';
import { runQuotedTemplateCases } from './self-test-pr-body-quoted-template.mjs';
import { runRepositorySpellingsCases } from './self-test-pr-body-repository-spellings.mjs';
import { runSectionsCases } from './self-test-pr-body-sections.mjs';
/** @param {Pick<import('./types.mjs').SelfTestContext,'check'|'noRoot'>} context */
export function runPrBodyCases({ check, noRoot }) {
  console.log('\nPR-body extraction');
  /** @param {string} b */
  const parses = (b) => {
    const r = parseOwnership(b);
    return r.ok ? r.globs : 'REJECTED';
  };
  const body = [
    '## Ownership',
    'Owns globs: `.github/**`, `scripts/check-file-ownership.mjs`',
    'Files touched outside Owns: none',
    '',
    '## Declared gaps',
    'None.',
  ].join('\n');
  runSectionsCases({ check, parses, body });
  const { quotedTemplate } = runQuotedTemplateCases({ check, parses });
  runAmbiguityCases({ check, parses });
  runRepositorySpellingsCases({ check, parses });
  const { areaGlobs, ownsLine } = runAreaCoverageCases({ check, parses });
  runGlobNotationCases({ check, parses, body, noRoot, areaGlobs, ownsLine });
  runMarkdownLabelsCases({ check, parses });
  return { parses, body, quotedTemplate, areaGlobs };
}
